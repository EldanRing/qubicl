import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoftwareRecipeSchema, type ComputerConfig, type SoftwareRecipe } from '@qubicl/core';
import { docker } from './docker.js';

export function softwareRecipe(computer: ComputerConfig, additions: string[] = []): SoftwareRecipe {
  return SoftwareRecipeSchema.parse({
    baseImage: computer.software?.baseImage ?? computer.image.requested,
    ...(computer.software?.basePreset ? { basePreset: computer.software.basePreset }
      : computer.preset !== 'custom' ? { basePreset: computer.preset } : {}),
    aptPackages: [...new Set([...(computer.software?.aptPackages ?? []), ...additions])].sort(),
  });
}

/** The base is a locally inspected immutable image ID; package names cannot inject Dockerfile or shell syntax. */
export function softwareDockerfile(base: string, recipe: SoftwareRecipe): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(base)) throw new Error('Software builds require an inspected immutable base image ID.');
  const { aptPackages } = SoftwareRecipeSchema.parse(recipe);
  return `FROM qubicl-software-base:${base.slice(7)}\nUSER root\nRUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
}

export async function buildSoftwareImage(base: string, recipe: SoftwareRecipe, computerId: string, offline: boolean): Promise<string> {
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
    await docker(['build', '--tag', tag, directory], { inherit: true });
    return tag;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
