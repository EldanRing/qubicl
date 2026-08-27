import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { collectBundledPackages, generateSpdxDocument } from './bundle-evidence.mjs';
import { generateThirdPartyNoticesFromPackages } from './licenses.mjs';
import { buildMetadata, metadataDefines } from './build-metadata.mjs';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const defaultComputerImage = process.env.QUBICL_DEFAULT_COMPUTER_IMAGE ?? 'qubicl/computer:dev';
const defaultGatewayImage = process.env.QUBICL_DEFAULT_GATEWAY_IMAGE ?? 'qubicl/gateway:dev';
const metadata = await buildMetadata(rootPath);
const commonDefines = metadataDefines(metadata);
const workspace = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const cliManifest = JSON.parse(await readFile(new URL('../packages/cli/package.json', import.meta.url), 'utf8'));
const source = normalizeRepository(workspace.repository?.url);
const upstreamSkillsCommit = '7d6db4efb885856078e4d19f804035226df81e0d';

await command(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-b'], root);
await command(process.execPath, [fileURLToPath(new URL('./verify-skill-catalog.mjs', import.meta.url))], root);

const assets = new URL('../packages/cli/dist/assets/', import.meta.url);
await rm(assets, { recursive: true, force: true });
await mkdir(new URL('gateway/', assets), { recursive: true });
await mkdir(new URL('computer/', assets), { recursive: true });
await mkdir(new URL('computer/manifests/', assets), { recursive: true });
await mkdir(new URL('computer/node_modules/playwright-core/lib/', assets), { recursive: true });
await mkdir(new URL('computer/skills/', assets), { recursive: true });

const contracts = await import(new URL('../packages/core/dist/presets.js', import.meta.url));
const catalog = process.env.QUBICL_IMAGE_CATALOG_PATH
  ? JSON.parse(await readFile(process.env.QUBICL_IMAGE_CATALOG_PATH, 'utf8'))
  : contracts.createDevelopmentCatalog(metadata.version, metadata.revision);
for (const preset of contracts.CURATED_PRESETS) {
  const manifest = contracts.buildComputerManifest(preset, metadata.version, metadata.revision);
  await writeFile(new URL(`computer/manifests/${preset}.json`, assets), `${JSON.stringify(manifest, null, 2)}\n`);
}
await writeFile(new URL('image-catalog.json', assets), `${JSON.stringify(catalog, null, 2)}\n`);

const [cliBuild, gatewayBuild, controlBuild] = await Promise.all([
  build({
    entryPoints: [fileURLToPath(new URL('../packages/cli/src/main.ts', import.meta.url))],
    outfile: fileURLToPath(new URL('../packages/cli/dist/qubicl.mjs', import.meta.url)),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: true,
    sourcemap: false,
    metafile: true,
    define: {
      ...commonDefines,
      __QUBICL_BUILD_DEFAULT_COMPUTER_IMAGE__: JSON.stringify(defaultComputerImage),
      __QUBICL_BUILD_DEFAULT_GATEWAY_IMAGE__: JSON.stringify(defaultGatewayImage),
      __QUBICL_BUILD_IMAGE_CATALOG__: JSON.stringify(JSON.stringify(catalog)),
    },
    banner: { js: "import { createRequire as __qubiclCreateRequire } from 'node:module'; const require = __qubiclCreateRequire(import.meta.url);" },
  }),
  build({
    entryPoints: [fileURLToPath(new URL('../packages/gateway/src/main.ts', import.meta.url))],
    outfile: fileURLToPath(new URL('gateway/gateway.mjs', assets)),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: true,
    sourcemap: false,
    metafile: true,
    define: commonDefines,
  }),
  build({
    entryPoints: [fileURLToPath(new URL('../packages/control/src/main.ts', import.meta.url))],
    outfile: fileURLToPath(new URL('computer/control.mjs', assets)),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: true,
    sourcemap: false,
    metafile: true,
    // Playwright loads generated scripts and browser metadata relative to its
    // package root. Ship it intact beside control.mjs instead of flattening it
    // into the executable bundle.
    external: ['playwright-core'],
    define: commonDefines,
  }),
]);

await Promise.all([
  cp(new URL('../packages/cli/assets/chromium-seccomp.json', import.meta.url), new URL('chromium-seccomp.json', assets)),
  cp(new URL('../images/gateway/Dockerfile', import.meta.url), new URL('gateway/Dockerfile', assets)),
  cp(new URL('../images/computer/Dockerfile', import.meta.url), new URL('computer/Dockerfile', assets)),
  cp(new URL('../images/computer/entrypoint.sh', import.meta.url), new URL('computer/entrypoint.sh', assets)),
  cp(new URL('../images/computer/chromium-wrapper.sh', import.meta.url), new URL('computer/chromium-wrapper.sh', assets)),
  cp(new URL('../images/computer/qubicl_viewer_auth.py', import.meta.url), new URL('computer/qubicl_viewer_auth.py', assets)),
  cp(new URL('../images/computer/x11vnc-relay.sh', import.meta.url), new URL('computer/x11vnc-relay.sh', assets)),
  cp(new URL('../images/computer/libreoffice-registrymodifications.xcu', import.meta.url), new URL('computer/libreoffice-registrymodifications.xcu', assets)),
  cp(new URL('../packages/control/src/web-provider.py', import.meta.url), new URL('computer/web-provider.py', assets)),
  cp(new URL('../images/computer/web-requirements.txt', import.meta.url), new URL('computer/web-requirements.txt', assets)),
  cp(new URL('../images/computer/WEB_THIRD_PARTY_NOTICES.txt', import.meta.url), new URL('computer/WEB_THIRD_PARTY_NOTICES.txt', assets)),
  cp(new URL('../images/computer/browser-skills-requirements.txt', import.meta.url), new URL('computer/browser-skills-requirements.txt', assets)),
  cp(new URL('../images/computer/BROWSER_SKILLS_THIRD_PARTY_NOTICES.txt', import.meta.url), new URL('computer/BROWSER_SKILLS_THIRD_PARTY_NOTICES.txt', assets)),
  cp(new URL('../images/computer/skills-requirements.txt', import.meta.url), new URL('computer/skills-requirements.txt', assets)),
  cp(new URL('../images/computer/SKILLS_THIRD_PARTY_NOTICES.txt', import.meta.url), new URL('computer/SKILLS_THIRD_PARTY_NOTICES.txt', assets)),
  cp(new URL('../skills/core/', import.meta.url), new URL('computer/skills/core/', assets), { recursive: true }),
  cp(new URL('../skills/core-catalog.json', import.meta.url), new URL('computer/skills/core-catalog.json', assets)),
  ...[
    'LICENSE', 'NOTICE', 'ThirdPartyNotices.txt', 'browsers.json', 'package.json', 'index.js', 'index.mjs',
    'lib/bootstrap.js', 'lib/coreBundle.js', 'lib/utilsBundle.js', 'lib/utilsBundle.js.LICENSE',
    'lib/webp_codec.wasm', 'lib/webp_codec.LICENSE', 'lib/xdg-open',
  ].map((path) => cp(
    new URL(`../node_modules/playwright-core/${path}`, import.meta.url),
    new URL(`computer/node_modules/playwright-core/${path}`, assets),
  )),
  cp(new URL('../LICENSE', import.meta.url), new URL('../packages/cli/dist/LICENSE', import.meta.url)),
  cp(new URL('../LICENSE', import.meta.url), new URL('gateway/LICENSE', assets)),
  cp(new URL('../LICENSE', import.meta.url), new URL('computer/LICENSE', assets)),
]);

const [bundledCliPackages, gatewayPackages, bundledControlPackages] = await Promise.all([
  collectBundledPackages(rootPath, [
    { bundle: 'cli', metafile: cliBuild.metafile },
    { bundle: 'gateway', metafile: gatewayBuild.metafile },
    { bundle: 'control', metafile: controlBuild.metafile },
  ]),
  collectBundledPackages(rootPath, [{ bundle: 'gateway', metafile: gatewayBuild.metafile }]),
  collectBundledPackages(rootPath, [{ bundle: 'control', metafile: controlBuild.metafile }]),
]);
const playwrightRuntime = await packagedRuntimeDependency(new URL('../node_modules/playwright-core/', import.meta.url), ['control-runtime']);
const cliPackages = [...bundledCliPackages, playwrightRuntime].sort((left, right) => left.key.localeCompare(right.key));
const [cliNotices, gatewayNotices, controlNotices, playwrightNotices] = await Promise.all([
  generateThirdPartyNoticesFromPackages(cliPackages),
  generateThirdPartyNoticesFromPackages(gatewayPackages),
  generateThirdPartyNoticesFromPackages(bundledControlPackages),
  generateThirdPartyNoticesFromPackages([playwrightRuntime]),
]);
const coreSkillsLicense = await readFile(new URL('../skills/core/plan/LICENSE', import.meta.url), 'utf8');
const coreSkillsNotice = `\n---\nqubicl-core-skill-adaptations@${metadata.version}\nDeclared license: MIT\nIncludes material adapted from https://github.com/NousResearch/hermes-agent/tree/${upstreamSkillsCommit}\n\n--- LICENSE ---\n${coreSkillsLicense.trim()}\n`;
const applicationSbom = generateSpdxDocument({
  name: cliManifest.name,
  version: metadata.version,
  revision: metadata.revision,
  created: metadata.date,
  source,
  artifactKind: 'npm-application',
  packages: cliPackages,
  extraPackages: [{
    name: 'qubicl-core-skill-adaptations',
    version: metadata.version,
    license: 'MIT',
    downloadLocation: source,
    purl: `pkg:github/EldanRing/qubicl@${metadata.revision}`,
    comment: `Six Qubicl-native core skills, with selected MIT-licensed helpers adapted from hermes-agent@${upstreamSkillsCommit}; Hermes Agent is not installed.`,
  }],
});
await Promise.all([
  writeFile(new URL('../packages/cli/dist/THIRD_PARTY_NOTICES.txt', import.meta.url), `${cliNotices}${coreSkillsNotice}`),
  writeFile(new URL('../packages/cli/dist/SBOM.spdx.json', import.meta.url), `${JSON.stringify(applicationSbom, null, 2)}\n`),
  writeFile(new URL('gateway/THIRD_PARTY_NOTICES.txt', assets), gatewayNotices),
  writeFile(new URL('computer/THIRD_PARTY_NOTICES.txt', assets), `${controlNotices}${coreSkillsNotice}`),
  writeFile(new URL('computer/PLAYWRIGHT_THIRD_PARTY_NOTICES.txt', assets), playwrightNotices),
]);
await chmod(new URL('computer/entrypoint.sh', assets), 0o755);
await chmod(new URL('computer/chromium-wrapper.sh', assets), 0o755);

async function command(program, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${program} exited with ${code}`)));
  });
}

function normalizeRepository(repository) {
  if (typeof repository !== 'string' || !repository) throw new Error('package.json repository URL is required for bundle evidence.');
  return repository.replace(/^git\+/, '').replace(/\.git$/, '');
}

async function packagedRuntimeDependency(directoryUrl, bundles) {
  const directory = fileURLToPath(directoryUrl);
  const manifest = JSON.parse(await readFile(new URL('package.json', directoryUrl), 'utf8'));
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(`${directory}/package.json has no valid package identity.`);
  }
  return { key: `${manifest.name}@${manifest.version}`, directory, manifest, bundles };
}
