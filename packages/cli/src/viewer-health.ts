import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';

export async function checkViewerHealth(baseUrl: string, token: string, timeoutMs = 3_000): Promise<string> {
  const base = new URL(baseUrl);
  const ticketResponse = await fetchWithTimeout(`${baseUrl}/view-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    redirect: 'manual',
  }, timeoutMs);
  if (!ticketResponse.ok) throw new Error(`viewer ticket returned HTTP ${ticketResponse.status}`);
  const ticket = await ticketResponse.json() as { url?: unknown };
  if (typeof ticket.url !== 'string') throw new Error('viewer ticket response did not contain a URL');

  const ticketUrl = sameOriginUrl(ticket.url, base, 'viewer ticket');
  const exchange = await fetchWithTimeout(ticketUrl, { redirect: 'manual' }, timeoutMs);
  if (exchange.status !== 302) throw new Error(`viewer ticket exchange returned HTTP ${exchange.status}`);
  const location = exchange.headers.get('location');
  const setCookie = exchange.headers.get('set-cookie');
  if (!location || !setCookie) throw new Error('viewer ticket exchange omitted its redirect or session cookie');
  const cookie = setCookie.split(';', 1)[0]!;
  const viewerUrl = sameOriginUrl(location, base, 'viewer redirect');

  const viewerResponse = await fetchWithTimeout(viewerUrl, { headers: { cookie }, redirect: 'manual' }, timeoutMs);
  if (!viewerResponse.ok) throw new Error(`viewer page returned HTTP ${viewerResponse.status}`);
  const frameSource = viewerFrameSource(await viewerResponse.text());
  const frameUrl = sameOriginUrl(frameSource, viewerUrl, 'viewer desktop frame');
  const configuredPath = frameUrl.searchParams.get('path');
  if (!configuredPath) throw new Error('viewer page did not configure a WebSocket path');
  const webSocketUrl = sameOriginUrl(configuredPath, frameUrl, 'viewer WebSocket');
  await requireWebSocketUpgrade(webSocketUrl, cookie, timeoutMs);
  return `viewer page HTTP ${viewerResponse.status}; WebSocket HTTP 101 at ${webSocketUrl.pathname}`;
}

function fetchWithTimeout(url: string | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function sameOriginUrl(value: string, base: URL, description: string): URL {
  const parsed = new URL(value, base);
  if (parsed.origin !== base.origin) throw new Error(`${description} escaped the local gateway origin`);
  return parsed;
}

function viewerFrameSource(html: string): string {
  const match = html.match(/<iframe\b[^>]*\bid=["']desktop["'][^>]*\bsrc=["']([^"']+)["']/i)
    ?? html.match(/<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*\bid=["']desktop["']/i);
  if (!match?.[1]) throw new Error('viewer page did not contain the desktop frame');
  return match[1].replaceAll('&amp;', '&');
}

function requireWebSocketUpgrade(url: URL, cookie: string, timeoutMs: number): Promise<void> {
  if (url.protocol !== 'http:') throw new Error(`viewer WebSocket uses unsupported protocol ${url.protocol}`);
  const port = url.port ? Number(url.port) : 80;
  const webSocketKey = randomBytes(16).toString('base64');
  return new Promise<void>((resolve, reject) => {
    const socket = connect({ host: url.hostname, port });
    let response = '';
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(new Error(`viewer WebSocket did not respond within ${timeoutMs}ms`)), timeoutMs);
    socket.once('connect', () => socket.write([
      `GET ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${webSocketKey}`,
      `Origin: ${url.origin}`,
      `Cookie: ${cookie}`,
      '',
      '',
    ].join('\r\n')));
    socket.on('data', (chunk) => {
      response += chunk.toString();
      if (response.length > 16_384) {
        finish(new Error('viewer WebSocket returned an oversized handshake response'));
        return;
      }
      const headerEnd = response.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const statusLine = response.slice(0, response.indexOf('\r\n'));
      if (!/^HTTP\/1\.1 101(?:\s|$)/.test(statusLine)) {
        finish(new Error(`viewer WebSocket returned ${statusLine || 'an invalid response'}`));
        return;
      }
      finish();
    });
    socket.once('error', (error) => finish(error));
    socket.once('end', () => finish(new Error('viewer WebSocket closed before completing its handshake')));
  });
}
