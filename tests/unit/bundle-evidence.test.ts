import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = process.cwd();
const evidenceModule = pathToFileURL(join(root, 'scripts', 'bundle-evidence.mjs')).href;

test('bundle evidence is deterministic, scoped, and derived only from metafile inputs', async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), 'qubicl-bundle-evidence-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await packageFixture(temporary, 'alpha', '1.2.3', 'MIT');
  await packageFixture(temporary, '@scope/bravo', '4.5.6', 'Apache-2.0');

  const evidence = await import(evidenceModule);
  const packages = await evidence.collectBundledPackages(temporary, [
    {
      bundle: 'cli',
      metafile: {
        inputs: {
          'node_modules/alpha/index.js': {},
          'node_modules/@scope/bravo/index.js': {},
        },
      },
    },
    {
      bundle: 'gateway',
      metafile: {
        inputs: {
          'node_modules/alpha/other.js': {},
        },
      },
    },
  ]);

  assert.deepEqual(packages.map((entry: { key: string }) => entry.key), ['@scope/bravo@4.5.6', 'alpha@1.2.3']);
  assert.deepEqual(packages.find((entry: { key: string }) => entry.key === 'alpha@1.2.3').bundles, ['cli', 'gateway']);

  const document = evidence.generateSpdxDocument({
    name: 'qubicl-cli',
    version: '1.0.0',
    revision: 'abc123',
    created: '2026-08-19T00:00:00Z',
    source: 'https://github.com/example/qubicl',
    artifactKind: 'npm-application',
    packages,
  });
  evidence.assertSpdxPackages(document, packages);
  assert.equal(document.spdxVersion, 'SPDX-2.3');
  assert.deepEqual(evidence.spdxPackageKeys(document), ['@scope/bravo@4.5.6', 'alpha@1.2.3']);
  const bravo = document.packages.find((entry: { name: string }) => entry.name === '@scope/bravo');
  assert.equal(bravo.externalRefs[0].referenceLocator, 'pkg:npm/%40scope/bravo@4.5.6');
  assert.doesNotMatch(JSON.stringify(document), /node_modules|qubicl-bundle-evidence-/);
});

async function packageFixture(rootPath: string, name: string, version: string, license: string): Promise<void> {
  const directory = join(rootPath, 'node_modules', ...name.split('/'));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name, version, license })}\n`);
  await writeFile(join(directory, 'LICENSE'), `${license} fixture\n`);
}
