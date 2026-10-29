import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerDefaultsSchema, SoftwareRecipeSchema, type ComputerConfig, type ComputerDefaults, type QubiclManifest, type SoftwareRecipe } from '@qubicl/core';
import { acquireCustomImage, docker } from './docker.js';

export interface SoftwareChanges {
  add?: string[];
  remove?: string[];
  refresh?: boolean;
}

export function softwareRecipe(computer: ComputerConfig, additions: string[] = [], removals: string[] = []): SoftwareRecipe | undefined {
  // Validate both lists before using them, including removal names.
  for (const packages of [additions, removals]) {
    if (packages.length) SoftwareRecipeSchema.parse({ baseImage: computer.image.requested, aptPackages: packages });
  }
  const packageKey = (value: string) => value.split('=')[0]!;
  const removed = new Set(removals.map(packageKey));
  const packages = new Map((computer.software?.aptPackages ?? [])
    .filter((value) => !removed.has(packageKey(value))).map((value) => [packageKey(value), value]));
  for (const value of additions) {
    if (removed.has(packageKey(value))) throw new Error(`Package ${packageKey(value)} cannot be added and removed together.`);
    packages.set(packageKey(value), value);
  }
  if (!packages.size) return undefined;
  return SoftwareRecipeSchema.parse({
    baseImage: computer.software?.baseImage ?? computer.image.requested,
    ...(computer.software?.baseIdentity ? { baseIdentity: computer.software.baseIdentity } : {}),
    ...(computer.software?.basePreset ? { basePreset: computer.software.basePreset }
      : computer.preset !== 'custom' ? { basePreset: computer.preset } : {}),
    aptPackages: [...packages.values()].sort(),
  });
}

/** The base is a locally inspected immutable image ID; package names cannot inject Dockerfile or shell syntax. */
export function softwareDockerfile(base: string, recipe: SoftwareRecipe): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(base)) throw new Error('Software builds require an inspected immutable base image ID.');
  const { aptPackages } = SoftwareRecipeSchema.parse(recipe);
  return `FROM qubicl-software-base:${base.slice(7)}\nUSER root\nRUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
}

export async function buildSoftwareImage(base: string, recipe: SoftwareRecipe, computerId: string, offline: boolean, refresh = false): Promise<string> {
  if (offline && refresh) throw new Error('--refresh cannot be combined with --offline.');
  const details = JSON.parse(await docker(['image', 'inspect', base])) as Array<{ Id: string; Config?: { User?: string } }>;
  const inspected = details[0];
  if (!inspected) throw new Error('Software base image was not found.');
  // Qubicl's entrypoint needs its existing root startup to drop to the workload UID.
  // A custom image with a different USER must use its own Dockerfile.
  if (inspected.Config?.User && !['root', '0', '0:0'].includes(inspected.Config.User)) throw new Error('Managed apt recipes require a Qubicl base with root startup; use image build for this custom image.');
  const dockerfile = softwareDockerfile(inspected.Id, recipe);
  const identity = createHash('sha256').update(dockerfile).digest('hex').slice(0, 20);
  const tag = `qubicl-software-${computerId}:${identity}`;
  if (offline) {
    await docker(['image', 'inspect', tag]);
    return tag;
  }
  // BuildKit parses a bare sha256:ID in FROM as a registry tag. Give the
  // inspected bytes a content-addressed local alias; never resolve a mutable
  // upstream tag again during this build.
  await docker(['tag', inspected.Id, `qubicl-software-base:${inspected.Id.slice(7)}`]);
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-software-'));
  try {
    await writeFile(join(directory, 'Dockerfile'), dockerfile, { mode: 0o600 });
    await docker(['build', ...(refresh ? ['--no-cache'] : []), '--tag', tag, directory], { inherit: true });
    return tag;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export interface PreparedSoftwareImage {
  defaults: ComputerDefaults;
  recipe: SoftwareRecipe;
}

export async function prepareSoftwareImage(
  recipe: SoftwareRecipe,
  base: ComputerDefaults,
  computerId: string,
  offline: boolean,
  refresh = false,
): Promise<PreparedSoftwareImage> {
  const saved = SoftwareRecipeSchema.parse({
    ...recipe,
    baseImage: base.image.requested,
    baseIdentity: base.image,
  });
  const tag = await buildSoftwareImage(base.image.contentId ?? base.image.resolved, saved, computerId, offline, refresh);
  const acquired = await acquireCustomImage(tag, { offline: true });
  if (acquired.manifest.compatibility !== base.compatibility
    || JSON.stringify(acquired.manifest.capabilities) !== JSON.stringify(base.capabilities)) {
    throw new Error('Software image changed its base capability contract.');
  }
  return {
    defaults: ComputerDefaultsSchema.parse({ ...base, preset: 'custom', image: acquired.identity }),
    recipe: saved,
  };
}

/** Rebuild a portable recipe from its recorded base, not the sender's derived tag. */
export async function prepareManifestSoftware(
  declared: QubiclManifest['computers'][number],
  computerId: string,
  offline: boolean,
  dependencies = { acquire: acquireCustomImage, prepare: prepareSoftwareImage },
): Promise<PreparedSoftwareImage> {
  const recipe = declared.software;
  if (!recipe) throw new Error('Manifest computer has no software recipe.');
  const inspected = await dependencies.acquire(recipe.baseImage, { offline }, recipe.baseIdentity?.resolved ?? recipe.baseImage);
  if (inspected.manifest.compatibility !== declared.compatibility
    || JSON.stringify(inspected.manifest.capabilities) !== JSON.stringify(declared.capabilities)
    || (recipe.baseIdentity?.manifestSha256 && recipe.baseIdentity.manifestSha256 !== inspected.identity.manifestSha256)) {
    throw new Error(`Recipe base for ${declared.name} differs from its exported capability contract.`);
  }
  const base = ComputerDefaultsSchema.parse({
    preset: recipe.basePreset ?? 'custom', compatibility: inspected.manifest.compatibility,
    capabilities: inspected.manifest.capabilities, capabilityContractVersion: declared.capabilityContractVersion,
    cpus: declared.cpus, memory: declared.memory, image: inspected.identity,
  });
  return dependencies.prepare(recipe, base, computerId, offline);
}
