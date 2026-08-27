import { createHash } from 'node:crypto';
import { access, chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { collectBundledPackages, spdxPackageKeys } from './bundle-evidence.mjs';
import { buildMetadata, metadataDefines } from './build-metadata.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const target = `${process.platform}-${process.arch}`;
const output = join(root, 'release', `qubicl-${target}`);
const work = join(root, 'release', `.build-${target}`);
const binary = join(output, 'qubicl');
const metadata = await buildMetadata(root);
const imageCatalog = await readFile(join(root, 'packages/cli/dist/assets/image-catalog.json'), 'utf8');
const applicationSbom = JSON.parse(await readFile(join(root, 'packages/cli/dist/SBOM.spdx.json'), 'utf8'));

await rm(output, { recursive: true, force: true });
await rm(work, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(work, { recursive: true });

const bundle = join(work, 'qubicl.cjs');
const blob = join(work, 'qubicl.blob');
const config = join(work, 'sea-config.json');
const nativeBuild = await build({
  entryPoints: [join(root, 'packages/cli/src/main.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minify: true,
  sourcemap: false,
  metafile: true,
  define: {
    ...metadataDefines(metadata),
    'import.meta.url': 'undefined',
    __QUBICL_BUILD_DEFAULT_COMPUTER_IMAGE__: JSON.stringify(process.env.QUBICL_DEFAULT_COMPUTER_IMAGE ?? 'qubicl/computer:dev'),
    __QUBICL_BUILD_DEFAULT_GATEWAY_IMAGE__: JSON.stringify(process.env.QUBICL_DEFAULT_GATEWAY_IMAGE ?? 'qubicl/gateway:dev'),
    __QUBICL_BUILD_IMAGE_CATALOG__: JSON.stringify(imageCatalog),
  },
});
const nativePackages = await collectBundledPackages(root, [{ bundle: 'native-cli', metafile: nativeBuild.metafile }]);
const applicationKeys = new Set(spdxPackageKeys(applicationSbom));
for (const dependency of nativePackages) {
  if (!applicationKeys.has(dependency.key)) throw new Error(`Native bundle dependency ${dependency.key} is absent from the application SBOM.`);
}

await writeFile(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
await run(process.execPath, ['--experimental-sea-config', config]);
await copyFile(process.execPath, binary);
if (process.platform === 'darwin') await run('codesign', ['--remove-signature', binary], true);
const postject = join(root, 'node_modules', '.bin', 'postject');
const postjectArgs = [binary, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
await run(postject, postjectArgs);
if (process.platform === 'darwin') await run('codesign', ['--sign', '-', binary]);
await chmod(binary, 0o755);
await cp(join(root, 'packages/cli/dist/assets'), join(output, 'assets'), { recursive: true });
await copyFile(join(root, 'LICENSE'), join(output, 'LICENSE'));
await copyFile(await nodeLicense(), join(output, 'NODE_LICENSE'));
await copyFile(join(root, 'packages/cli/dist/THIRD_PARTY_NOTICES.txt'), join(output, 'THIRD_PARTY_NOTICES.txt'));
await copyFile(join(root, 'packages/cli/README.md'), join(output, 'README.md'));
await writeFile(join(output, 'SBOM.spdx.json'), `${JSON.stringify(nativeSbom(applicationSbom), null, 2)}\n`);
await run(binary, ['--help'], false, output);
await rm(work, { recursive: true, force: true });
console.log(output);

function nativeSbom(application) {
  const document = structuredClone(application);
  const rootId = document.documentDescribes?.[0];
  if (!rootId) throw new Error('Application SBOM does not describe a root package.');
  const nodeVersion = process.versions.node;
  const nodeId = `SPDXRef-Package-node-${createHash('sha256').update(`node@${nodeVersion}`).digest('hex').slice(0, 12)}`;
  document.name = `qubicl-cli-${metadata.version}-native-${target}`;
  document.documentNamespace = document.documentNamespace.replace(/\/npm-application$/, `/native-${target}`);
  document.packages.push({
    name: 'node',
    SPDXID: nodeId,
    versionInfo: nodeVersion,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'MIT',
    licenseDeclared: 'MIT',
    copyrightText: 'NOASSERTION',
    externalRefs: [{
      referenceCategory: 'PACKAGE-MANAGER',
      referenceType: 'purl',
      referenceLocator: `pkg:generic/node@${encodeURIComponent(nodeVersion)}`,
    }],
    comment: 'Exact Node.js runtime embedded in the native single-executable application.',
  });
  document.relationships.push({
    spdxElementId: rootId,
    relationshipType: 'DEPENDS_ON',
    relatedSpdxElement: nodeId,
  });
  return document;
}

async function nodeLicense() {
  const candidates = [
    process.env.QUBICL_NODE_LICENSE,
    resolve(dirname(process.execPath), '..', 'LICENSE'),
    resolve(dirname(process.execPath), '..', 'share', 'doc', 'nodejs', 'LICENSE'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch { /* try the next exact-runtime license location */ }
  }
  throw new Error(`Could not locate the Node ${process.version} license. Set QUBICL_NODE_LICENSE to the matching LICENSE file.`);
}

async function run(command, args, allowFailure = false, cwd = root) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || allowFailure) resolvePromise();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}
