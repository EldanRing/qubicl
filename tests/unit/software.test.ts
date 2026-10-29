import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputerConfigSchema, SoftwareRecipeSchema, defaultConfig, manifestFromConfig, parseManifestDocument, reconcileManifest, type SoftwareRecipe, type ComputerDefaults } from '@qubicl/core';
import { buildSoftwareImage, softwareDockerfile, softwareRecipe, prepareManifestSoftware } from '../../packages/cli/dist/software.js';
import { workloadEnvironment } from '../../packages/control/dist/environments.js';

test('system package recipes require immutable bases and reject command injection', () => {
  const base = `sha256:${'a'.repeat(64)}`;
  const recipe = { baseImage: 'example/base:1', aptPackages: ['jq', 'ripgrep=14.1.1-1'] };
  assert.match(softwareDockerfile(base, recipe), /apt-get install -y --no-install-recommends jq ripgrep=14\.1\.1-1/);
  assert.throws(() => softwareDockerfile('example/base:latest', recipe), /immutable/);
  for (const packageName of ['jq; touch /host', '-oAPT::Update::Pre-Invoke=evil', 'jq\nRUN evil', '../package.deb']) {
    assert.equal(SoftwareRecipeSchema.safeParse({ ...recipe, aptPackages: [packageName] }).success, false);
  }
});

test('workload packages use durable locations without inheriting host credentials', () => {
  const env = workloadEnvironment({ PATH: '/host/bin', AWS_SECRET_ACCESS_KEY: 'secret', QUBICL_INTERNAL_KEY: 'private' }, '/home/test');
  assert.equal(env.npm_config_prefix, '/home/test/.local');
  assert.equal(env.VIRTUAL_ENV, '/home/test/.local/share/qubicl/python/current');
  assert(env.PATH?.includes(`${env.VIRTUAL_ENV}/bin`));
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.QUBICL_INTERNAL_KEY, undefined);
  assert.equal(ComputerConfigSchema.safeParse({
    ...defaultConfig().defaults, id: '00000000-0000-4000-8000-000000000001', name: 'environment',
    createdAt: new Date().toISOString(), environment: { APP_MODE: 'invalid\0value' },
  }).success, false);
});

test('software changes replace version pins, remove selected packages, and reset an empty recipe', async () => {
  const computer = ComputerConfigSchema.parse({ ...defaultConfig().defaults, id: '00000000-0000-4000-8000-000000000001', name: 'tools', createdAt: new Date().toISOString(), software: { baseImage: 'example/base:1', aptPackages: ['jq=1.6-1', 'ripgrep'] } });
  assert.deepEqual(softwareRecipe(computer, ['jq=1.7-1'], ['ripgrep'])?.aptPackages, ['jq=1.7-1']);
  assert.equal(softwareRecipe(computer, [], ['jq', 'ripgrep']), undefined);
  assert.throws(() => softwareRecipe(computer, ['jq'], ['jq']), /added and removed/);
  assert.throws(() => softwareRecipe(computer, [], ['jq;evil']));
  await assert.rejects(buildSoftwareImage('unused', computer.software!, computer.id, true, true), /refresh.*offline/);
});

test('recipe manifests round-trip without host identity or secrets and detect recipe-only changes', () => {
  const config = defaultConfig();
  const computer = ComputerConfigSchema.parse({ ...config.defaults, preset: 'custom', id: '00000000-0000-4000-8000-000000000001', name: 'tools', createdAt: new Date().toISOString(), environment: { PRIVATE_VALUE: 'not-exported' }, software: { baseImage: 'example/base:1', aptPackages: ['jq'] } });
  config.computers.push(computer);
  const manifest = manifestFromConfig(config);
  assert.deepEqual(parseManifestDocument(manifest).manifest.computers[0]?.software, computer.software);
  assert.doesNotMatch(JSON.stringify(manifest), /not-exported|createdAt|00000000-0000/);
  assert.equal(reconcileManifest(config, manifest, false).updates.length, 0);
  manifest.computers[0]!.software!.aptPackages.push('ripgrep');
  assert.equal(reconcileManifest(config, manifest, false).updates.length, 1);
  assert.deepEqual(computer.software?.aptPackages, ['jq']);
  delete manifest.computers[0]!.software;
  assert.equal(reconcileManifest(config, manifest, false).updates.length, 1);
});

test('portable recipe preparation acquires the recorded base and rejects incompatible bases before building', async () => {
  const config = defaultConfig();
  const declared = { name: 'tools', ...config.defaults, software: { baseImage: 'example/base:1', baseIdentity: { requested: 'example/base:1', resolved: 'example/base@sha256:' + 'a'.repeat(64) }, aptPackages: ['jq'] } };
  const calls: string[] = [];
  const defaults = { ...config.defaults, image: { ...declared.software.baseIdentity, manifestSha256: config.defaults.image.manifestSha256, contentId: `sha256:${'b'.repeat(64)}` as const } };
  const dependencies = {
    acquire: async (requested: string, options: { offline?: boolean } = {}, resolved?: string) => {
      calls.push(`acquire:${requested}:${resolved}:${options.offline}`);
      return { identity: defaults.image, manifest: { compatibility: defaults.compatibility, capabilities: defaults.capabilities }, compatibility: {} } as Awaited<ReturnType<typeof import('../../packages/cli/dist/docker.js')['acquireCustomImage']>>;
    },
    prepare: async (recipe: SoftwareRecipe, base: ComputerDefaults, id: string, offline: boolean) => {
      calls.push(`build:${id}:${offline}`);
      assert.equal(base.image.contentId, defaults.image.contentId);
      return { defaults: base, recipe };
    },
  };
  await prepareManifestSoftware(declared, 'new-computer', true, dependencies);
  assert.deepEqual(calls, [`acquire:example/base:1:${declared.software.baseIdentity.resolved}:true`, 'build:new-computer:true']);
  calls.length = 0;
  await assert.rejects(prepareManifestSoftware({ ...declared, capabilities: ['files'] }, 'new-computer', false, dependencies), /capability contract/);
  assert.equal(calls.length, 1);
});
