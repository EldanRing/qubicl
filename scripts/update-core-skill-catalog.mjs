#!/usr/bin/env node
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  CONTENT_SECURITY_SCANNER_VERSION,
  COMPUTER_TOOL_NAMES,
  CURATED_PRESETS,
  inspectSkillDirectory,
  toolsForCapabilities,
  capabilitiesForCompatibility,
} from '../packages/core/dist/index.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const skillsRoot = join(root, 'skills');
const definitions = JSON.parse(await readFile(join(skillsRoot, 'core-definitions.json'), 'utf8'));
const reviews = JSON.parse(await readFile(join(skillsRoot, 'reviews', 'core-skills.json'), 'utf8'));
const outputPath = join(skillsRoot, 'core-catalog.json');

if (definitions.schemaVersion !== 1 || !Array.isArray(definitions.skills)) throw new Error('Core skill definitions are invalid.');
if (reviews.schemaVersion !== 1 || !Array.isArray(reviews.skills)) throw new Error('Core skill review record is invalid.');

const ids = new Set();
const names = new Set();
const toolNames = new Set(COMPUTER_TOOL_NAMES);
const reviewed = new Set(reviews.skills);
const skills = [];
for (const definition of definitions.skills) {
  assert(/^qubicl-core\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(definition.id), `Invalid core skill ID ${definition.id}.`);
  assert(definition.id === `qubicl-core/${definition.name}`, `Core skill ID and name differ for ${definition.id}.`);
  assert(!ids.has(definition.id) && !names.has(definition.name), `Duplicate core skill ${definition.id}.`);
  assert(reviewed.has(definition.name), `Core skill ${definition.id} lacks a review record.`);
  ids.add(definition.id);
  names.add(definition.name);
  for (const tool of definition.requiredTools) assert(toolNames.has(tool), `Core skill ${definition.id} references unknown tool ${tool}.`);
  for (const preset of definition.compatiblePresets) {
    assert(CURATED_PRESETS.includes(preset), `Core skill ${definition.id} references unknown preset ${preset}.`);
    const available = new Set(toolsForCapabilities(capabilitiesForCompatibility(preset)));
    for (const tool of definition.requiredTools) assert(available.has(tool), `Core skill ${definition.id} requires unavailable ${tool} on ${preset}.`);
  }
  const directory = join(skillsRoot, 'core', definition.name);
  const files = await regularFiles(directory);
  assert(files.includes('SKILL.md'), `Core skill ${definition.id} has no SKILL.md.`);
  const frontmatter = parseFrontmatter(await readFile(join(directory, 'SKILL.md'), 'utf8'));
  assert(frontmatter.name === definition.name, `Core skill ${definition.id} frontmatter name differs.`);
  assert(frontmatter.description === definition.description, `Core skill ${definition.id} frontmatter description differs.`);
  assert(Object.keys(frontmatter).sort().join(',') === 'description,name', `Core skill ${definition.id} frontmatter must contain only name and description.`);
  const inspected = await inspectSkillDirectory(directory, files);
  const blocking = inspected.findings.filter(({ blockingForSkills }) => blockingForSkills);
  assert(blocking.length === 0, `Core skill ${definition.id} has blocking content findings: ${blocking.map(({ id, file }) => `${id}:${file}`).join(', ')}.`);
  skills.push({
    ...definition,
    license: 'MIT',
    files,
    sha256: inspected.sha256,
    security: {
      scannerVersion: CONTENT_SECURITY_SCANNER_VERSION,
      verdict: 'no-blocking-findings',
      findings: inspected.findings,
    },
  });
}
assert(skills.length === 6, 'Qubicl must ship exactly six reviewed core skills.');
assert(reviews.skills.every((name) => names.has(name)), 'Core skill review record contains an unknown skill.');

const catalog = {
  schemaVersion: 1,
  source: definitions.source,
  review: {
    reviewedAt: reviews.reviewedAt,
    reviewedBy: reviews.reviewedBy,
    sourceAudit: reviews.sourceAudit,
  },
  skills,
};
const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
if (process.argv.includes('--write')) {
  await writeFile(outputPath, serialized, { mode: 0o644 });
  console.log(`Wrote ${relative(root, outputPath)} with ${skills.length} verified core skills.`);
} else {
  const current = await readFile(outputPath, 'utf8');
  assert(current === serialized, 'skills/core-catalog.json is stale; run npm run skills:catalog:update and review the diff.');
  console.log(`Verified ${skills.length} Qubicl core skill packages.`);
}

async function regularFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Core skill contains unsupported symlink ${relative(directory, path)}.`);
    if (entry.isFile()) files.push(relative(directory, path).split(sep).join('/'));
  }
  return files.sort();
}

function parseFrontmatter(contents) {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(contents);
  assert(match, 'SKILL.md requires YAML frontmatter.');
  const parsed = YAML.parse(match[1]);
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'SKILL.md frontmatter must be a mapping.');
  return parsed;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
