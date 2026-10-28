import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeReleasePresetManifests(root, imageInputs) {
  assert([1, 2].includes(imageInputs?.schemaVersion) && typeof imageInputs.version === 'string',
    'Release preset manifests require versioned image input evidence.');
  const { CURATED_PRESETS, buildComputerManifest } = await import('../packages/core/dist/index.js');
  for (const preset of CURATED_PRESETS) {
    const origin = imageInputs.images?.[preset];
    assert(typeof origin?.version === 'string' && (imageInputs.schemaVersion >= 2 || origin.version === imageInputs.version) && /^[a-f0-9]{40}$/u.test(origin.revision ?? ''),
      `Release preset ${preset} has no exact image origin.`);
    const manifest = buildComputerManifest(preset, origin.version, origin.revision);
    await writeFile(join(root, 'packages', 'cli', 'dist', 'assets', 'computer', 'manifests', `${preset}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

function assert(value, message) { if (!value) throw new Error(message); }
