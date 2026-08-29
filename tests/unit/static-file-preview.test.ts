import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, serialize } from 'parse5';
import {
  INTERACTIVE_CONSENT_FILE_PREVIEW_CSP,
  STATIC_FILE_PREVIEW_CSP,
  hasExecutablePreviewContent,
  staticFilePreview,
  staticFilePreviewBundle,
} from '../../packages/control/dist/static-file-preview.js';

test('static HTML previews retain passive local assets and remove executable or navigable content', () => {
  const rendered = staticFilePreview('report.html', Buffer.from(`<!doctype html>
    <html><head>
      <base href="https://attacker.invalid/">
      <meta http-equiv="refresh" content="0;url=https://attacker.invalid/refresh">
      <link rel="stylesheet" href="styles/report.css">
      <link rel="preload" href="https://attacker.invalid/payload.js" as="script">
      <style>body { background-image: url(https://attacker.invalid/css); }</style>
    </head><body onload="fetch('/secret').then(() => location='https://attacker.invalid/')">
      <a href="https://attacker.invalid/link" target="_top">Rendered link text</a>
      <form action="https://attacker.invalid/form"><button formaction="https://attacker.invalid/button">Send</button></form>
      <iframe src="https://attacker.invalid/frame"></iframe>
      <object data="https://attacker.invalid/object"></object>
      <script src="payload.js"></script><script>window.location = 'https://attacker.invalid/script'</script>
      <img src="images/chart.png" srcset="https://attacker.invalid/chart.png 2x">
      <img src="../private/secret.png">
      <img src="https://qubicl.invalid/selected/deceptive.png">
      <img src="//qubicl.invalid/selected/deceptive.png">
      <img src="data:image/png;base64,AA==">
      <img src="data:image/svg+xml,<svg onload=alert(1)></svg>">
      <video src="media/demo.mp4" poster="images/poster.webp"></video>
    </body></html>`, 'utf8')).toString('utf8');

  assert.match(rendered, /<link rel="stylesheet" href="styles\/report\.css">/u);
  assert.match(rendered, /<img src="images\/chart\.png">/u);
  assert.match(rendered, /<img src="data:image\/png;base64,AA==">/u);
  assert.match(rendered, /<video src="media\/demo\.mp4" poster="images\/poster\.webp"><\/video>/u);
  assert.match(rendered, />Rendered link text<\/a>/u);
  assert.match(rendered, />Send<\/button><\/form>/u);
  assert.doesNotMatch(rendered, /<script|<iframe|<object|<base|<meta/iu);
  assert.doesNotMatch(rendered, /onload=|target=|action=|formaction=|srcset=/iu);
  assert.doesNotMatch(rendered, /href="https:\/\/attacker\.invalid|src="\.\.\/private|qubicl\.invalid|data:image\/svg\+xml/iu);
});

test('static SVG previews remove scripts, navigation, embedded documents, and href animation', () => {
  const rendered = staticFilePreview('diagram.svg', Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">
    <script>fetch('https://attacker.invalid/script')</script>
    <a href="https://attacker.invalid/link"><text>Label</text></a>
    <foreignObject><iframe src="https://attacker.invalid/frame"></iframe></foreignObject>
    <animate attributeName="href" to="https://attacker.invalid/animate" />
    <set attributeName="href" to="https://attacker.invalid/set" />
    <image href="images/chart.png" />
    <image href="https://attacker.invalid/image.png" />
    <use href="#local-symbol" />
    <use href="https://attacker.invalid/symbol.svg#id" />
    <circle cx="10" cy="10" r="4" />
  </svg>`, 'utf8')).toString('utf8');

  assert.match(rendered, /<text>Label<\/text>/u);
  assert.match(rendered, /<image href="images\/chart\.png"><\/image>/u);
  assert.match(rendered, /<use href="#local-symbol"><\/use>/u);
  assert.match(rendered, /<circle cx="10" cy="10" r="4"><\/circle>/u);
  assert.doesNotMatch(rendered, /<script|foreignObject|<iframe|<animate|<set/iu);
  assert.doesNotMatch(rendered, /https:\/\/attacker\.invalid/iu);
});

test('static HTML previews remove noscript markup before a scripting-disabled browser reparses it', () => {
  const rendered = staticFilePreview('noscript.html', Buffer.from(`<!doctype html><html><head>
    <noscript>
      <meta http-equiv="refresh" content="0;url=https://attacker.invalid/refresh">
      <a href="https://attacker.invalid/navigation">leave</a>
    </noscript>
  </head><body><p>safe content</p></body></html>`, 'utf8')).toString('utf8');
  const browserView = serialize(parse(rendered, { scriptingEnabled: false }));

  assert.match(browserView, /<p>safe content<\/p>/u);
  assert.doesNotMatch(browserView, /<noscript|<meta|<a\b|http-equiv=|href=|attacker\.invalid/iu);
});

test('non-active preview assets are not rewritten', () => {
  const source = Buffer.from('body { color: rebeccapurple; }', 'utf8');
  assert.equal(staticFilePreview('report.css', source), source);
});

test('self-contained static previews embed bounded passive assets without a browser-reachable origin', async () => {
  const assets = new Map([
    ['styles/report.css', { data: Buffer.from('body { color: rgb(1, 2, 3); background: url(https://attacker.invalid/tracker); }'), mimeType: 'text/css' }],
    ['images/chart.png', { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' }],
  ]);
  const rendered = (await staticFilePreviewBundle('report.html', Buffer.from(`<!doctype html><html><head>
    <link rel="stylesheet" href="styles/report.css">
  </head><body><img src="images/chart.png"><img src="images/missing.png"><script>fetch('https://attacker.invalid')</script></body></html>`), async (path) => assets.get(path))).toString('utf8');

  assert.match(rendered, /<style>body \{ color: rgb\(1, 2, 3\);/u);
  assert.match(rendered, /<img src="data:image\/png;base64,iVBORw==">/u);
  assert.match(rendered, /<img>/u);
  assert.doesNotMatch(rendered, /<link|<script|preview-|\.localhost/iu);
  assert.match(STATIC_FILE_PREVIEW_CSP, /(?:^|; )sandbox(?:;|$)/u);
  assert.match(STATIC_FILE_PREVIEW_CSP, /connect-src 'none'/u);
  assert.match(STATIC_FILE_PREVIEW_CSP, /script-src 'none'/u);
  assert.match(STATIC_FILE_PREVIEW_CSP, /img-src data:/u);
  assert.doesNotMatch(STATIC_FILE_PREVIEW_CSP, /'self'/u);
});

test('scripted HTML keeps the safe rendering and receives an in-document trusted-interactive action', async () => {
  const source = Buffer.from('<!doctype html><html><body><h1>Pagoda</h1><script type="module">render()</script></body></html>');
  assert.equal(hasExecutablePreviewContent('pagoda.html', source), true);
  assert.equal(hasExecutablePreviewContent('static.html', Buffer.from('<p>Static</p>')), false);
  assert.equal(hasExecutablePreviewContent('handler.htm', Buffer.from('<button onclick="render()">Run</button>')), true);
  assert.equal(hasExecutablePreviewContent('source.js', source), false);

  const rendered = (await staticFilePreviewBundle(
    'pagoda.html',
    source,
    async () => undefined,
    { interactiveSource: source },
  )).toString('utf8');
  assert.match(rendered, /data-qubicl-interactive-preview="true"/u);
  assert.match(rendered, /<button id="qubicl-run-interactive"[^>]*>Run interactive preview<\/button>/u);
  assert.match(rendered, /Trusted content only/u);
  assert.doesNotMatch(rendered, /href=|\/files\/interactive\//u);
  assert.match(rendered, /title="Safe static file preview" sandbox=""/u);
  assert.match(rendered, /&lt;h1&gt;Pagoda&lt;\/h1&gt;/u);
  assert.match(rendered, /setTimeout\(expire,300000\)/u);
  assert.doesNotMatch(rendered, /type="module"|render\(\)/u);
  const encoded = rendered.match(/id="qubicl-interactive-source" data-source="([A-Za-z0-9+/=]+)"/u)?.[1];
  assert.ok(encoded);
  const trusted = Buffer.from(encoded, 'base64').toString('utf8');
  assert.match(trusted, /Content-Security-Policy/u);
  assert.match(trusted, /<script type="module">render\(\)<\/script>/u);
  assert.match(INTERACTIVE_CONSENT_FILE_PREVIEW_CSP, /(?:^|; )sandbox allow-scripts(?:;|$)/u);
  assert.doesNotMatch(INTERACTIVE_CONSENT_FILE_PREVIEW_CSP, /allow-same-origin|allow-forms|allow-popups|allow-downloads|allow-top-navigation/u);
  assert.match(INTERACTIVE_CONSENT_FILE_PREVIEW_CSP, /script-src [^;]*'unsafe-inline'[^;]*https:/u);
  assert.match(INTERACTIVE_CONSENT_FILE_PREVIEW_CSP, /connect-src [^;]*https:[^;]*wss:/u);
});
