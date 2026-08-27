import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = process.cwd();
const moduleUrl = pathToFileURL(join(root, 'scripts', 'platform-support.mjs')).href;

test('version-1 platform matrix preserves current support and validation claims', async () => {
  const { assertPlatformSupportRequirements, loadPlatformSupportRequirements } = await import(moduleUrl);
  const requirements = await loadPlatformSupportRequirements();
  const claims = Object.fromEntries(requirements.acceptancePlatforms.map((entry: {
    id: string;
    supportLevel: string;
    validationLevel: string;
  }) => [entry.id, [entry.supportLevel, entry.validationLevel]]));
  assert.deepEqual(claims, {
    'linux-x64': ['supported', 'directly-tested'],
    'linux-arm64': ['best-effort', 'not-directly-tested'],
    'macos-intel': ['best-effort', 'not-directly-tested'],
    'macos-apple-silicon': ['supported', 'directly-tested'],
    'windows-wsl2-x64': ['supported', 'directly-tested'],
  });
  assert.deepEqual(
    requirements.additionalHostClaims.map(({ id, supportLevel }: { id: string; supportLevel: string }) => [id, supportLevel]),
    [
      ['windows-wsl2-x64-other-distribution', 'best-effort'],
      ['windows-wsl2-arm64', 'best-effort'],
    ],
  );
  assert.deepEqual(
    requirements.boundaries.map(({ id, supportLevel }: { id: string; supportLevel: string }) => [id, supportLevel]),
    [
      ['native-windows-cli', 'unsupported'],
      ['wsl1', 'unsupported'],
      ['computer-runtime-linux-container', 'supported'],
    ],
  );
  const runtime = requirements.boundaries.find(({ id }: { id: string }) => id === 'computer-runtime-linux-container');
  assert.deepEqual(
    { runtimeOs: runtime.runtimeOs, nativeHostWorkload: runtime.nativeHostWorkload, vmSecurityBoundary: runtime.vmSecurityBoundary },
    { runtimeOs: 'linux', nativeHostWorkload: false, vmSecurityBoundary: false },
  );

  const promoted = structuredClone(requirements);
  promoted.acceptancePlatforms.find(({ id }: { id: string }) => id === 'linux-arm64')!.supportLevel = 'supported';
  assert.throws(() => assertPlatformSupportRequirements(promoted), /version-1 contract/);
});

test('platform version evidence rejects floating and range-like values', async () => {
  const { exactRecordedVersion } = await import(moduleUrl);
  for (const value of ['Ubuntu 24.04.3 LTS', 'macOS 15.6.1 (24G90)', '6.6.87.2-microsoft-standard-WSL2']) {
    assert.equal(exactRecordedVersion(value), true, value);
  }
  for (const value of ['latest', 'current', '1.x', '>=4.29', '4.29 || 4.50', '4.29 - 4.50', 'unknown']) {
    assert.equal(exactRecordedVersion(value), false, value);
  }
});

test('public platform guidance stays aligned with the reviewed matrix and acceptance gate', async () => {
  const [readme, npmReadme, platforms, wsl, troubleshooting, verifying, releasing] = await Promise.all([
    readFile(join(root, 'README.md'), 'utf8'),
    readFile(join(root, 'packages/cli/README.md'), 'utf8'),
    readFile(join(root, 'docs/platforms.md'), 'utf8'),
    readFile(join(root, 'docs/wsl.md'), 'utf8'),
    readFile(join(root, 'docs/troubleshooting.md'), 'utf8'),
    readFile(join(root, 'VERIFYING.md'), 'utf8'),
    readFile(join(root, 'RELEASING.md'), 'utf8'),
  ]);
  for (const document of [readme, npmReadme, platforms]) {
    assert.match(document, /Linux\s+x64/);
    assert.match(document, /Apple\s+Silicon\s+macOS/);
    assert.match(document, /Windows\s+11\s+x64\s+through\s+Ubuntu\s+24\.04\s+on\s+WSL\s+2/);
    assert.match(document, /Linux\s+ARM64/);
    assert.match(document, /Intel\s+macOS/);
    assert.match(document, /best-effort/);
    assert.match(document, /Native Windows and WSL 1 are unsupported/);
    assert.match(document, /Linux\s+containers/);
  }
  assert.match(readme, /\[Platform support\]\(docs\/platforms\.md\)/);
  assert.match(npmReadme, /github\.com\/EldanRing\/qubicl\/blob\/main\/docs\/platforms\.md/);
  assert.match(platforms, /\| Linux x64 \| Supported \| Directly tested \|/);
  assert.match(platforms, /\| Linux ARM64 \| Best-effort \| Not directly tested \|/);
  assert.match(platforms, /\| Native Windows CLI \| Unsupported \| Not directly tested \|/);
  assert.match(wsl, /prints.*does not create or edit client configuration files/is);
  assert.match(wsl, /qubicl doctor --json/);
  assert.match(troubleshooting, /macOS and Docker Desktop/);
  assert.match(troubleshooting, /Review.*doctor.*JSON/is);
  for (const document of [verifying, releasing]) {
    assert.match(document, /platform-support-v1\.json/);
    assert.match(document, /schema 4/i);
  }
});
