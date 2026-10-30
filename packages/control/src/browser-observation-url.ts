/** Browser identity uses tab/document IDs; observation URLs are safe display values. */
const sensitiveName = (name: string): boolean => {
  const normalized = name.toLowerCase().replace(/[-_]/gu, '');
  return /token|secret|password|credential/iu.test(normalized)
    || ['key', 'apikey', 'auth', 'authorization', 'session', 'sessionid', 'sid', 'signature', 'sig', 'code'].includes(normalized);
};

function decode(value: string): string {
  try { return decodeURIComponent(value.replaceAll('+', ' ')); } catch { return value; }
}

function sensitiveValues(value: string): string[] {
  try {
    const url = new URL(value);
    const values = [...url.searchParams].filter(([name]) => sensitiveName(name)).map(([, content]) => content);
    for (const match of url.hash.matchAll(/(?:^#|[?&#;])([^=&#;]+)=([^&#;]*)/gu)) {
      if (sensitiveName(decode(match[1]!))) values.push(decode(match[2]!));
    }
    if (url.username) values.push(decode(url.username));
    if (url.password) values.push(decode(url.password));
    return values.filter(Boolean);
  } catch { return []; }
}

export function browserDisplayUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'about:'].includes(url.protocol)) return `${url.protocol}[redacted]`;
    url.username = ''; url.password = '';
    const keys = [...new Set([...url.searchParams.keys()])];
    let changed = false;
    for (const key of keys) if (sensitiveName(key)) { url.searchParams.set(key, '[redacted]'); changed = true; }
    const fragment = url.hash.replace(/(^#|[?&#;])([^=&#;]+)=([^&#;]*)/gu, (match, prefix: string, key: string) => {
      if (!sensitiveName(decode(key))) return match;
      changed = true; return `${prefix}${key}=[redacted]`;
    });
    if (fragment !== url.hash) url.hash = fragment;
    // Keep ordinary URL spelling intact, including navigation hash anchors.
    if (!changed && !new URL(value).username && !new URL(value).password) return value;
    return url.href;
  } catch { return 'invalid-url'; }
}

export function browserDisplayTitle(title: string, url: string): string {
  let result = title.replace(/https?:\/\/[^\s<>"']+/gu, browserDisplayUrl);
  for (const value of sensitiveValues(url).sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(value, '[redacted]').replaceAll(encodeURIComponent(value), '[redacted]');
  }
  return result;
}
