import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const requestedOutput = argumentValue('--out-dir');
const output = requestedOutput ? resolve(process.cwd(), requestedOutput) : resolve(root, 'packages/dashboard/dist');
const publicOutput = resolve(output, 'public');
await rm(output, { recursive: true, force: true });
await mkdir(resolve(publicOutput, 'assets'), { recursive: true });

const browser = await build({
  absWorkingDir: root,
  entryPoints: ['packages/dashboard/src/app.ts'],
  outdir: publicOutput,
  entryNames: 'assets/app-[hash]',
  assetNames: 'assets/[name]-[hash]',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  metafile: true,
  write: true,
});

const outputs = Object.entries(browser.metafile.outputs);
const script = outputs.find(([path, value]) => path.endsWith('.js') && value.entryPoint?.endsWith('packages/dashboard/src/app.ts') && value.bytes > 0)?.[0];
const css = outputs.find(([path]) => path.endsWith('.css'))?.[0];
if (!script || !css) throw new Error('Dashboard build did not emit its JavaScript and CSS entry points.');
const scriptUrl = `/${toPosix(relative(publicOutput, resolve(root, script)))}`;
const cssUrl = `/${toPosix(relative(publicOutput, resolve(root, css)))}`;

await cp(resolve(root, 'assets/brand/qubicl-mark.svg'), resolve(publicOutput, 'assets/qubicl-mark.svg'));
await writeFile(resolve(publicOutput, 'index.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#f7f4ee" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#090a0d" media="(prefers-color-scheme: dark)">
  <meta name="description" content="Manage local Qubicl computers.">
  <title>Qubicl</title>
  <link rel="icon" href="/assets/qubicl-mark.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${cssUrl}">
  <script type="module" src="${scriptUrl}"></script>
</head>
<body><div id="app"></div><noscript>Qubicl requires JavaScript for its local management dashboard.</noscript></body>
</html>
`);

const server = await build({
  absWorkingDir: root,
  entryPoints: ['packages/dashboard/src/server.ts'],
  outfile: resolve(output, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  sourcemap: false,
  metafile: true,
});

await Promise.all([
  writeFile(resolve(output, 'browser-metafile.json'), `${JSON.stringify(browser.metafile, null, 2)}\n`),
  writeFile(resolve(output, 'server-metafile.json'), `${JSON.stringify(server.metafile, null, 2)}\n`),
]);

const files = await listFiles(publicOutput);
const assets = await Promise.all(files.sort().map(async (path) => {
  const bytes = await readFile(path);
  const relativePath = `/${toPosix(relative(publicOutput, path))}`;
  return {
    path: relativePath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    contentType: contentType(path),
    cache: relativePath.startsWith('/assets/') ? 'immutable' : 'no-store',
  };
}));
await writeFile(resolve(output, 'asset-manifest.json'), `${JSON.stringify({ schemaVersion: 1, entrypoint: '/index.html', assets }, null, 2)}\n`);
process.stdout.write(`Built Qubicl dashboard: ${assets.length} verified assets in ${output}\n`);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

async function listFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await listFiles(path));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`Dashboard output contains unsupported entry ${path}.`);
  }
  return paths;
}

function contentType(path) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' })[extname(path)] ?? 'application/octet-stream';
}

function toPosix(path) { return sep === '/' ? path : path.split(sep).join('/'); }
