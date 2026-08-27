import { createHash, randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import {
  CONTENT_SECURITY_SCANNER_VERSION,
  COMPUTER_TOOL_NAMES,
  isRetiredCatalogSkillId,
  scanSkillFiles,
  verifyCatalogSkillDirectory,
  type CatalogSkillSecurity,
  type ComputerConfig,
  type Preset,
  type SkillSecurityFinding,
} from '@qubicl/core';
import { atomicWrite } from './state.js';
import { packagedAssetsPath } from './assets.js';

export interface CoreSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  compatiblePresets: Preset[];
  requiredTools: string[];
  requiredCommands: string[];
  license: string;
  files: string[];
  sha256: string;
  security: CatalogSkillSecurity;
}

export interface CoreCatalog {
  schemaVersion: 1;
  source: { owner: string; license: string; upstream?: { repository: string; commit: string } };
  review: { reviewedAt: string; reviewedBy: string; sourceAudit: string };
  skills: CoreSkill[];
}

export interface InstalledSkill {
  id: string;
  name: string;
  description: string;
  kind: 'core' | 'imported';
  baselineSha256: string;
  installedAt: string;
  updatedAt: string;
  source: { type: 'core'; catalogSha256: string } | { type: 'local'; directoryName: string } | { type: 'git'; repository: string; commit: string; path?: string };
  security: { scannerVersion: typeof CONTENT_SECURITY_SCANNER_VERSION; findings: SkillSecurityFinding[] };
  detectedRequirements?: { tools: string[]; commands: string[]; environment: string[]; urls: string[] };
  updateAvailableSha256?: string;
}

interface SkillRegistry {
  version: 2;
  packages: Record<string, InstalledSkill>;
}

export interface SkillStatus extends InstalledSkill {
  enabled: boolean;
  resourceRoot: string;
  currentSha256: string | null;
  drift: 'unchanged' | 'modified' | 'missing' | 'corrupt';
  resetAvailable: boolean;
}

const assetRoot = process.env.QUBICL_SKILLS_CATALOG_PATH
  ? resolve(process.env.QUBICL_SKILLS_CATALOG_PATH)
  : join(packagedAssetsPath(), 'computer', 'skills');
const nativeRoots = ['.agents', '.claude', '.hermes', '.codex'] as const;
const MAX_FILES = 256;
const MAX_ENTRIES = 512;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_PATH_BYTES = 240;
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;
let catalogPromise: Promise<CoreCatalog> | undefined;
interface PackageEntry { path: string; target: string; bytes: Buffer; mode: number }

export async function loadCoreCatalog(): Promise<CoreCatalog> {
  catalogPromise ??= readFile(join(assetRoot, 'core-catalog.json'), 'utf8').then((raw) => {
    const parsed = JSON.parse(raw) as CoreCatalog;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.skills) || parsed.skills.length !== 6) throw new Error('Packaged Qubicl core skill catalog is invalid.');
    return parsed;
  });
  return catalogPromise;
}

export function skillStorePaths(homeRoot: string): {
  root: string;
  installed: string;
  importedBaselines: string;
  custom: string;
  trash: string;
  registry: string;
} {
  const root = join(homeRoot, '.local', 'share', 'qubicl', 'skills');
  return {
    root,
    installed: join(root, 'installed'),
    importedBaselines: join(root, 'baselines', 'imported'),
    custom: join(root, 'custom'),
    trash: join(root, 'trash'),
    registry: join(root, 'registry.json'),
  };
}

export async function materializeSkills(computer: ComputerConfig, homeRoot: string): Promise<SkillStatus[]> {
  const catalog = await loadCoreCatalog();
  const paths = skillStorePaths(homeRoot);
  await ensureStore(paths);
  const registry = await loadRegistry(paths.registry);
  const enabled = new Set(computer.skillPolicy?.enabledCatalogSkills ?? []);
  const known = new Set([...catalog.skills.map(({ id }) => id), ...Object.keys(registry.packages)]);
  const unavailable = [...enabled].filter((id) => !known.has(id) && !isRetiredCatalogSkillId(id));
  if (unavailable.length) throw new Error(`Computer skill policy references unavailable skill IDs: ${unavailable.join(', ')}.`);

  for (const skill of catalog.skills) {
    const source = join(assetRoot, 'core', skill.name);
    await verifyCatalogSkillDirectory(source, skill);
    const target = join(paths.installed, skill.name);
    const existing = registry.packages[skill.id];
    if (!existing || !(await pathExists(target))) {
      if (await pathExists(target)) throw new Error(`Cannot install core skill ${skill.name}; an unmanaged directory already uses its working-copy name.`);
      await atomicCopy(source, target);
      const now = new Date().toISOString();
      registry.packages[skill.id] = {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        kind: 'core',
        baselineSha256: skill.sha256,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
        source: { type: 'core', catalogSha256: skill.sha256 },
        security: { scannerVersion: CONTENT_SECURITY_SCANNER_VERSION, findings: skill.security.findings },
      };
      continue;
    }
    if (existing.kind !== 'core' || existing.name !== skill.name) throw new Error(`Skill registry entry ${skill.id} conflicts with the packaged core skill.`);
    try {
      const inspected = await inspectEditableSkill(target);
      if (existing.baselineSha256 === inspected.sha256 && existing.baselineSha256 !== skill.sha256) {
        await atomicReplace(source, target);
        registry.packages[skill.id] = { ...existing, description: skill.description, baselineSha256: skill.sha256, updatedAt: new Date().toISOString(), source: { type: 'core', catalogSha256: skill.sha256 }, security: { scannerVersion: CONTENT_SECURITY_SCANNER_VERSION, findings: skill.security.findings } };
      } else if (existing.baselineSha256 !== skill.sha256) {
        registry.packages[skill.id] = { ...existing, updateAvailableSha256: skill.sha256 };
      }
    } catch {
      // Agent-owned working copies may be missing, oversized, or malformed.
      // Preserve them for explicit inspection/reset instead of making every
      // lifecycle command fail before the operator can recover the package.
      if (existing.baselineSha256 !== skill.sha256) registry.packages[skill.id] = { ...existing, updateAvailableSha256: skill.sha256 };
    }
  }

  await writeRegistry(paths.registry, registry);
  await synchronizeDiscovery(homeRoot, registry, enabled);
  return skillStatuses(paths, registry, enabled);
}

export async function materializeSkillsIfInitialized(computer: ComputerConfig, homeRoot: string): Promise<boolean> {
  try {
    const marker = await lstat(join(homeRoot, '.qubicl-owner'));
    if (!marker.isFile() || marker.isSymbolicLink()) return false;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  await materializeSkills(computer, homeRoot);
  return true;
}

export async function listInstalledSkills(homeRoot: string, enabledIds: readonly string[]): Promise<SkillStatus[]> {
  const paths = skillStorePaths(homeRoot);
  if (!(await assertStoreLayout(paths))) return [];
  const registry = await loadRegistry(paths.registry);
  return skillStatuses(paths, registry, new Set(enabledIds));
}

export async function importSkill(options: {
  homeRoot: string;
  source: string;
  gitRef?: string;
  sourcePath?: string;
}): Promise<InstalledSkill> {
  const paths = skillStorePaths(options.homeRoot);
  await ensureStore(paths);
  rejectNonHttpsUrl(options.source);
  const checkout = isHttpsUrl(options.source)
    ? await checkoutGitSkill(options.source, options.gitRef, options.sourcePath)
    : { root: await validatedLocalSource(options.source), expectedName: basename(resolve(options.source)), cleanup: async () => undefined, source: { type: 'local' as const, directoryName: basename(resolve(options.source)) } };
  try {
    const inspected = await inspectImport(checkout.root, checkout.expectedName);
    const registry = await loadRegistry(paths.registry);
    const id = `imported/${inspected.name}`;
    if (registry.packages[id] || Object.values(registry.packages).some(({ name }) => name === inspected.name)) throw new Error(`Skill ${inspected.name} is already installed; use update or remove it first.`);
    const catalog = await loadCoreCatalog();
    if (catalog.skills.some(({ name }) => name === inspected.name)) throw new Error(`Skill name ${inspected.name} is reserved by Qubicl core.`);
    if (await pathExists(join(paths.custom, inspected.name))) throw new Error(`Skill name ${inspected.name} is already used by an agent-created custom skill.`);
    const target = join(paths.installed, inspected.name);
    const baseline = join(paths.importedBaselines, inspected.name);
    if (await pathExists(target) || await pathExists(baseline)) throw new Error(`Skill storage for ${inspected.name} already exists but is not registered; inspect it before importing.`);
    let baselineCreated = false;
    let targetCreated = false;
    const now = new Date().toISOString();
    const metadata: InstalledSkill = {
      id,
      name: inspected.name,
      description: inspected.description,
      kind: 'imported',
      baselineSha256: inspected.sha256,
      installedAt: now,
      updatedAt: now,
      source: checkout.source,
      security: { scannerVersion: CONTENT_SECURITY_SCANNER_VERSION, findings: inspected.findings },
      detectedRequirements: inspected.detectedRequirements,
    };
    try {
      await atomicCopySnapshot(inspected.snapshot, baseline);
      baselineCreated = true;
      await atomicCopySnapshot(inspected.snapshot, target);
      targetCreated = true;
      registry.packages[id] = metadata;
      await writeRegistry(paths.registry, registry);
      return metadata;
    } catch (error) {
      delete registry.packages[id];
      if (targetCreated) await rm(target, { recursive: true, force: true });
      if (baselineCreated) await rm(baseline, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await checkout.cleanup();
  }
}

export async function updateImportedSkill(options: {
  homeRoot: string;
  idOrName: string;
  source: string;
  gitRef?: string;
  sourcePath?: string;
}): Promise<InstalledSkill> {
  const paths = skillStorePaths(options.homeRoot);
  await requireStoreLayout(paths);
  const registry = await loadRegistry(paths.registry);
  const existing = resolveInstalled(registry, options.idOrName);
  if (existing.kind !== 'imported') throw new Error('Packaged core skills update with Qubicl itself; use reset to discard local edits and adopt the packaged baseline.');
  const current = await inspectEditableSkill(join(paths.installed, existing.name));
  if (current.sha256 !== existing.baselineSha256) throw new Error(`Imported skill ${existing.name} has local edits. Reset or preserve them elsewhere before updating its baseline.`);
  rejectNonHttpsUrl(options.source);
  const checkout = isHttpsUrl(options.source)
    ? await checkoutGitSkill(options.source, options.gitRef, options.sourcePath)
    : { root: await validatedLocalSource(options.source), expectedName: basename(resolve(options.source)), cleanup: async () => undefined, source: { type: 'local' as const, directoryName: basename(resolve(options.source)) } };
  try {
    const inspected = await inspectImport(checkout.root, checkout.expectedName);
    if (inspected.name !== existing.name) throw new Error(`Updated package name ${inspected.name} does not match installed skill ${existing.name}.`);
    const updated: InstalledSkill = {
      ...existing,
      description: inspected.description,
      baselineSha256: inspected.sha256,
      updatedAt: new Date().toISOString(),
      source: checkout.source,
      security: { scannerVersion: CONTENT_SECURITY_SCANNER_VERSION, findings: inspected.findings },
      detectedRequirements: inspected.detectedRequirements,
    };
    delete updated.updateAvailableSha256;
    await replaceImportedSnapshots(
      inspected.snapshot,
      join(paths.importedBaselines, existing.name),
      join(paths.installed, existing.name),
      async () => {
        registry.packages[updated.id] = updated;
        await writeRegistry(paths.registry, registry);
      },
    );
    return updated;
  } finally {
    await checkout.cleanup();
  }
}

export async function resetInstalledSkill(homeRoot: string, idOrName: string): Promise<InstalledSkill> {
  const paths = skillStorePaths(homeRoot);
  await requireStoreLayout(paths);
  const registry = await loadRegistry(paths.registry);
  const skill = resolveInstalled(registry, idOrName);
  let source: string;
  if (skill.kind === 'core') {
    const catalog = await loadCoreCatalog();
    const core = catalog.skills.find(({ id }) => id === skill.id);
    if (!core) throw new Error(`Core baseline ${skill.id} is not packaged.`);
    source = join(assetRoot, 'core', core.name);
    await verifyCatalogSkillDirectory(source, core);
    skill.baselineSha256 = core.sha256;
    skill.description = core.description;
    skill.source = { type: 'core', catalogSha256: core.sha256 };
    skill.security = { scannerVersion: CONTENT_SECURITY_SCANNER_VERSION, findings: core.security.findings };
    delete skill.updateAvailableSha256;
  } else {
    source = join(paths.importedBaselines, skill.name);
    const inspected = await inspectEditableSkill(source);
    if (inspected.sha256 !== skill.baselineSha256) throw new Error(`Imported baseline for ${skill.name} changed; re-import from its reviewed source instead of resetting.`);
  }
  await atomicReplace(source, join(paths.installed, skill.name));
  skill.updatedAt = new Date().toISOString();
  registry.packages[skill.id] = skill;
  await writeRegistry(paths.registry, registry);
  return skill;
}

export async function removeImportedSkill(homeRoot: string, idOrName: string): Promise<{ id: string; trash: string }> {
  const paths = skillStorePaths(homeRoot);
  await requireStoreLayout(paths);
  const registry = await loadRegistry(paths.registry);
  const skill = resolveInstalled(registry, idOrName);
  if (skill.kind !== 'imported') throw new Error('Packaged core skills cannot be removed; disable them or reset their working copy.');
  await mkdir(paths.trash, { recursive: true, mode: 0o700 });
  const trashName = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${skill.name}`;
  const trash = join(paths.trash, trashName);
  await mkdir(trash, { recursive: true, mode: 0o700 });
  if (await pathExists(join(paths.installed, skill.name))) await rename(join(paths.installed, skill.name), join(trash, 'working'));
  if (await pathExists(join(paths.importedBaselines, skill.name))) await rename(join(paths.importedBaselines, skill.name), join(trash, 'baseline'));
  await writeFile(join(trash, 'metadata.json'), `${JSON.stringify(skill, null, 2)}\n`, { mode: 0o600 });
  delete registry.packages[skill.id];
  await writeRegistry(paths.registry, registry);
  return { id: skill.id, trash };
}

export async function restoreImportedSkill(homeRoot: string, idOrName: string): Promise<InstalledSkill> {
  const paths = skillStorePaths(homeRoot);
  await ensureStore(paths);
  const registry = await loadRegistry(paths.registry);
  if (Object.values(registry.packages).some(({ id, name }) => id === idOrName || name === idOrName)) throw new Error(`Skill ${idOrName} is already installed.`);
  const candidates: Array<{ directory: string; metadata: InstalledSkill }> = [];
  for (const entry of await readdir(paths.trash, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const metadataPath = join(paths.trash, entry.name, 'metadata.json');
      const metadataInfo = await lstat(metadataPath);
      if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink() || metadataInfo.size > 64 * 1024) continue;
      const metadata = validateInstalledSkill(JSON.parse(await readFile(metadataPath, 'utf8')));
      if (metadata.kind === 'imported' && (metadata.id === idOrName || metadata.name === idOrName)) candidates.push({ directory: join(paths.trash, entry.name), metadata });
    } catch { /* Ignore unrelated or incomplete trash entries. */ }
  }
  candidates.sort((left, right) => right.directory.localeCompare(left.directory));
  if (!candidates.length) throw new Error(`Removed imported skill ${idOrName} was not found in recoverable trash.`);
  const { directory, metadata } = candidates[0]!;
  const working = join(paths.installed, metadata.name);
  const baseline = join(paths.importedBaselines, metadata.name);
  if (await pathExists(working) || await pathExists(baseline) || await pathExists(join(paths.custom, metadata.name))) throw new Error(`Cannot restore ${metadata.name}; its skill storage name is already occupied.`);
  const trashedWorking = join(directory, 'working');
  const trashedBaseline = join(directory, 'baseline');
  if (!(await pathExists(trashedBaseline))) throw new Error(`Removed skill ${metadata.name} has no recoverable baseline.`);
  const verifiedBaseline = await inspectEditableSkill(trashedBaseline);
  if (verifiedBaseline.sha256 !== metadata.baselineSha256) throw new Error(`Removed skill ${metadata.name} has a changed recoverable baseline; re-import its reviewed source instead.`);
  if (await pathExists(trashedWorking)) await inspectEditableSkill(trashedWorking);
  const hadWorking = await pathExists(trashedWorking);
  let baselineMoved = false;
  let workingMoved = false;
  try {
    await rename(trashedBaseline, baseline);
    baselineMoved = true;
    if (hadWorking) await rename(trashedWorking, working);
    else await atomicCopy(baseline, working);
    workingMoved = true;
    registry.packages[metadata.id] = { ...metadata, updatedAt: new Date().toISOString() };
    await writeRegistry(paths.registry, registry);
  } catch (error) {
    delete registry.packages[metadata.id];
    if (workingMoved) {
      if (hadWorking) await rename(working, trashedWorking).catch(() => undefined);
      else await rm(working, { recursive: true, force: true });
    }
    if (baselineMoved) await rename(baseline, trashedBaseline).catch(() => undefined);
    throw error;
  }
  await rm(directory, { recursive: true, force: true });
  return registry.packages[metadata.id]!;
}

export async function synchronizeSkillDiscovery(homeRoot: string, enabledIds: readonly string[]): Promise<void> {
  const paths = skillStorePaths(homeRoot);
  await requireStoreLayout(paths);
  await synchronizeDiscovery(homeRoot, await loadRegistry(paths.registry), new Set(enabledIds));
}

export async function inspectEditableSkill(root: string): Promise<{ sha256: string; findings: SkillSecurityFinding[] }> {
  const entries = await enumeratePackage(root);
  return digestEntries(entries);
}

async function inspectImport(root: string, expectedName: string): Promise<{ name: string; description: string; sha256: string; findings: SkillSecurityFinding[]; detectedRequirements: { tools: string[]; commands: string[]; environment: string[]; urls: string[] }; snapshot: PackageEntry[] }> {
  const entries = await enumeratePackage(root);
  const skillFile = entries.find(({ path }) => path === 'SKILL.md');
  if (!skillFile) throw new Error('Imported skill must contain SKILL.md at its package root.');
  const raw = (await readFile(skillFile.target)).toString('utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) throw new Error('Imported SKILL.md must start with YAML frontmatter.');
  const frontmatter = YAML.parse(match[1]!) as Record<string, unknown>;
  if (!frontmatter || typeof frontmatter !== 'object') throw new Error('Imported SKILL.md frontmatter is invalid.');
  const name = frontmatter.name;
  const description = frontmatter.description;
  assertSkillName(name);
  if (name !== expectedName.replace(/\.git$/i, '')) throw new Error(`Imported skill name ${name} must match its package directory ${expectedName}.`);
  if (typeof description !== 'string' || !description.trim() || description.length > 1024) throw new Error('Imported skill description must be 1-1024 characters.');
  const inspected = await digestEntries(entries);
  const blocked = inspected.findings.filter(({ blockingForSkills }) => blockingForSkills);
  if (blocked.length) throw new Error(`Imported skill contains blocked prompt-injection or concealment patterns: ${[...new Set(blocked.map(({ id }) => id))].sort().join(', ')}.`);
  return { name, description: description.trim(), ...inspected, detectedRequirements: detectRequirements(entries), snapshot: entries };
}

async function enumeratePackage(root: string): Promise<PackageEntry[]> {
  const selected = await lstat(root);
  if (!selected.isDirectory() || selected.isSymbolicLink()) throw new Error('Skill package root must be a regular directory, not a symlink.');
  const canonical = await realpath(root);
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Skill source must be a regular directory.');
  const entries: PackageEntry[] = [];
  const pending: Array<{ directory: string; prefix: string }> = [{ directory: canonical, prefix: '' }];
  let total = 0;
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    const children = (await readdir(current.directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of children) {
      visited += 1;
      if (visited > MAX_ENTRIES) throw new Error(`Skill package exceeds the ${MAX_ENTRIES}-entry traversal limit.`);
      const path = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
      const target = join(current.directory, entry.name);
      if (path === '.git' || path.startsWith('.git/')) continue;
      if (path.split('/').includes('.git')) throw new Error(`Skill package contains a nested repository at ${path}.`);
      if (Buffer.byteLength(path) > MAX_PATH_BYTES) throw new Error(`Skill resource path exceeds ${MAX_PATH_BYTES} bytes: ${path}.`);
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) throw new Error(`Skill package contains unsupported symlink ${path}.`);
      if (stat.isDirectory()) { pending.push({ directory: target, prefix: path }); continue; }
      if (!stat.isFile() || stat.nlink > 1) throw new Error(`Skill resource ${path} must be an ordinary, non-hard-linked file.`);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`Skill resource ${path} exceeds the ${MAX_FILE_BYTES}-byte limit.`);
      const bytes = await readFile(target);
      if (!isTextResource(bytes) && !allowedBinaryResource(bytes)) throw new Error(`Skill resource ${path} has an unsupported binary format.`);
      total += bytes.length;
      if (total > MAX_TOTAL_BYTES) throw new Error(`Skill package exceeds the ${MAX_TOTAL_BYTES}-byte total limit.`);
      entries.push({ path, target, bytes, mode: stat.mode & 0o777 });
      if (entries.length > MAX_FILES) throw new Error(`Skill package exceeds the ${MAX_FILES}-file limit.`);
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

function digestEntries(entries: Array<Pick<PackageEntry, 'path' | 'bytes'>>): { sha256: string; findings: SkillSecurityFinding[] } {
  const digest = createHash('sha256');
  const textFiles: Record<string, string> = {};
  for (const { path, bytes } of entries) {
    digest.update(`${path}\0`);
    digest.update(bytes);
    digest.update('\0');
    if (isTextResource(bytes)) textFiles[path] = bytes.toString('utf8');
  }
  return { sha256: digest.digest('hex'), findings: scanSkillFiles(textFiles) };
}

function allowedBinaryResource(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString('ascii') === '%PDF-'
    || bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    || (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP');
}

function isTextResource(bytes: Buffer): boolean {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (const character of decoded) {
      const code = character.codePointAt(0)!;
      if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function detectRequirements(entries: Array<Pick<PackageEntry, 'path' | 'bytes'>>): { tools: string[]; commands: string[]; environment: string[]; urls: string[] } {
  const text = entries.filter(({ bytes }) => isTextResource(bytes)).map(({ bytes }) => bytes.toString('utf8')).join('\n');
  const tools = COMPUTER_TOOL_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
  const commands = new Set<string>();
  for (const match of text.matchAll(/(?:^|\n)\s*(?:[-*]\s+)?(?:`{1,3})?([a-z][a-z0-9._+-]{1,63})(?:\s|`)/gim)) {
    const command = match[1]!;
    if (!COMPUTER_TOOL_NAMES.includes(command as never) && !['the', 'this', 'when', 'then', 'use', 'for', 'from'].includes(command)) commands.add(command);
  }
  const environment = new Set<string>();
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9_]{2,63}\b/g)) if (!['HTTP', 'HTTPS', 'JSON', 'YAML', 'UTF', 'PDF', 'PNG', 'JPEG', 'HTML', 'XML', 'MIT', 'BSD', 'MPL', 'ISC'].includes(match[0])) environment.add(match[0]);
  const urls = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>()"']+/g)) urls.add(match[0]!.replace(/[.,;:]$/, ''));
  return { tools: [...tools].sort(), commands: [...commands].sort().slice(0, 64), environment: [...environment].sort().slice(0, 64), urls: [...urls].sort().slice(0, 64) };
}

async function skillStatuses(paths: ReturnType<typeof skillStorePaths>, registry: SkillRegistry, enabled: Set<string>): Promise<SkillStatus[]> {
  const result: SkillStatus[] = [];
  for (const skill of Object.values(registry.packages)) {
    const resourceRoot = join(paths.installed, skill.name);
    try {
      const inspected = await inspectEditableSkill(resourceRoot);
      result.push({ ...skill, enabled: enabled.has(skill.id), resourceRoot, currentSha256: inspected.sha256, drift: inspected.sha256 === skill.baselineSha256 ? 'unchanged' : 'modified', resetAvailable: skill.kind === 'core' || await pathExists(join(paths.importedBaselines, skill.name)) });
    } catch (error) {
      result.push({ ...skill, enabled: enabled.has(skill.id), resourceRoot, currentSha256: null, drift: isNotFound(error) ? 'missing' : 'corrupt', resetAvailable: skill.kind === 'core' || await pathExists(join(paths.importedBaselines, skill.name)) });
    }
  }
  return result.sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
}

async function synchronizeDiscovery(homeRoot: string, registry: SkillRegistry, enabled: Set<string>): Promise<void> {
  const paths = skillStorePaths(homeRoot);
  const enabledByName = new Map(Object.values(registry.packages).filter(({ id }) => enabled.has(id)).map((skill) => [skill.name, join(paths.installed, skill.name)]));
  const custom = await customSkillNames(paths.custom);
  for (const name of custom) enabledByName.set(name, join(paths.custom, name));
  for (const native of nativeRoots) {
    const root = join(homeRoot, native, 'skills');
    await ensurePlainDirectoryTree(homeRoot, root, `Native skill discovery root ${root}`);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const target = join(root, entry.name);
      if (entry.isSymbolicLink()) {
        const link = resolve(root, await readlink(target));
        if (isManagedTarget(paths, link)) await rm(target, { force: true });
      } else if (entry.isDirectory()) {
        try {
          const marker = JSON.parse(await readFile(join(target, '.qubicl-catalog.json'), 'utf8')) as { managed?: boolean };
          if (marker.managed) await rm(target, { recursive: true, force: true });
        } catch { /* Preserve agent-owned native discovery content. */ }
      }
    }
    for (const [name, source] of enabledByName) {
      const target = join(root, name);
      if (await pathExists(target)) throw new Error(`Cannot activate skill ${name}; an agent-owned discovery entry already uses that name in ${root}.`);
      await symlink(relative(root, source), target, 'dir');
    }
  }
}

function isManagedTarget(paths: ReturnType<typeof skillStorePaths>, target: string): boolean {
  return isWithin(paths.installed, target) || isWithin(paths.custom, target);
}

function isWithin(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

async function customSkillNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const result: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.tmp-')) continue;
      try {
        const metadataPath = join(root, entry.name, '.qubicl.json');
        const metadataInfo = await lstat(metadataPath);
        if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink() || metadataInfo.size > 64 * 1024) continue;
        const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { enabled?: boolean };
        if (metadata.enabled) result.push(entry.name);
      } catch { /* Ignore corrupt custom packages; skill_manage reports them. */ }
    }
    return result;
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function ensureStore(paths: ReturnType<typeof skillStorePaths>): Promise<void> {
  const directories = skillStoreDirectories(paths);
  const homeRoot = directories[0]!;
  const homeInfo = await lstat(homeRoot);
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) throw new Error(`Qubicl computer home ${homeRoot} must be a regular directory.`);
  for (const directory of directories.slice(1)) await ensurePlainDirectory(directory, `Qubicl skill store directory ${directory}`);
}

async function requireStoreLayout(paths: ReturnType<typeof skillStorePaths>): Promise<void> {
  if (!(await assertStoreLayout(paths))) throw new Error('Qubicl skill store is not initialized; start the computer once before managing installed skills.');
}

async function assertStoreLayout(paths: ReturnType<typeof skillStorePaths>): Promise<boolean> {
  for (const directory of skillStoreDirectories(paths)) {
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Qubicl skill store path ${directory} must be a regular directory, not a symlink.`);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
  return true;
}

function skillStoreDirectories(paths: ReturnType<typeof skillStorePaths>): string[] {
  const qubiclRoot = dirname(paths.root);
  const shareRoot = dirname(qubiclRoot);
  const localRoot = dirname(shareRoot);
  const homeRoot = dirname(localRoot);
  return [homeRoot, localRoot, shareRoot, qubiclRoot, paths.root, paths.installed, dirname(paths.importedBaselines), paths.importedBaselines, paths.custom, paths.trash];
}

async function ensurePlainDirectoryTree(root: string, target: string, label: string): Promise<void> {
  const relativeTarget = relative(resolve(root), resolve(target));
  if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`)) throw new Error(`${label} escapes the computer home.`);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`Qubicl computer home ${root} must be a regular directory.`);
  let current = resolve(root);
  for (const component of relativeTarget.split(sep)) {
    current = join(current, component);
    await ensurePlainDirectory(current, label);
  }
}

async function ensurePlainDirectory(path: string, label: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (!isAlreadyExists(error)) throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a regular directory, not a symlink.`);
}

async function loadRegistry(path: string): Promise<SkillRegistry> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('registry must be a bounded regular file');
    const parsed = JSON.parse(await readFile(path, 'utf8')) as SkillRegistry;
    if (parsed.version !== 2 || !parsed.packages || typeof parsed.packages !== 'object') throw new Error('invalid registry');
    const names = new Set<string>();
    for (const [id, value] of Object.entries(parsed.packages)) {
      const skill = validateInstalledSkill(value, id);
      if (names.has(skill.name)) throw new Error(`duplicate package name ${skill.name}`);
      names.add(skill.name);
    }
    return parsed;
  } catch (error) {
    if (isNotFound(error)) return { version: 2, packages: {} };
    throw new Error(`Qubicl skill registry is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateInstalledSkill(value: unknown, expectedId?: string): InstalledSkill {
  if (!value || typeof value !== 'object') throw new Error('invalid package metadata');
  const skill = value as InstalledSkill;
  if ((skill.kind !== 'core' && skill.kind !== 'imported') || typeof skill.id !== 'string') throw new Error('invalid package kind or ID');
  if (expectedId !== undefined && skill.id !== expectedId) throw new Error(`package key does not match ${expectedId}`);
  assertSkillName(skill.name);
  const id = `${skill.kind === 'core' ? 'qubicl-core' : 'imported'}/${skill.name}`;
  if (skill.id !== id) throw new Error(`package identity mismatch for ${skill.id}`);
  if (typeof skill.description !== 'string' || !skill.description.trim() || skill.description.length > 1024) throw new Error(`invalid package description for ${skill.id}`);
  if (!/^[a-f0-9]{64}$/.test(skill.baselineSha256)) throw new Error(`invalid baseline digest for ${skill.id}`);
  if (typeof skill.installedAt !== 'string' || typeof skill.updatedAt !== 'string') throw new Error(`invalid package timestamps for ${skill.id}`);
  if (!skill.source || typeof skill.source !== 'object' || !skill.security || typeof skill.security !== 'object' || !Array.isArray(skill.security.findings)) throw new Error(`invalid provenance or security metadata for ${skill.id}`);
  return skill;
}

async function writeRegistry(path: string, registry: SkillRegistry): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(registry, null, 2)}\n`, 0o600);
}

async function atomicCopy(source: string, target: string): Promise<void> {
  const staging = join(dirname(target), `.tmp-${basename(target)}-${randomBytes(6).toString('hex')}`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await cp(source, staging, { recursive: true, errorOnExist: true, preserveTimestamps: true });
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function atomicCopySnapshot(entries: PackageEntry[], target: string): Promise<void> {
  const staging = join(dirname(target), `.tmp-${basename(target)}-${randomBytes(6).toString('hex')}`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const entry of entries) {
      const output = join(staging, ...entry.path.split('/'));
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(output, entry.bytes, { flag: 'wx', mode: entry.mode & 0o755 });
    }
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function atomicReplace(source: string, target: string): Promise<void> {
  const staging = join(dirname(target), `.tmp-${basename(target)}-${randomBytes(6).toString('hex')}`);
  const previous = join(dirname(target), `.previous-${basename(target)}-${randomBytes(6).toString('hex')}`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await cp(source, staging, { recursive: true, errorOnExist: true, preserveTimestamps: true });
    if (await pathExists(target)) await rename(target, previous);
    try { await rename(staging, target); } catch (error) { if (await pathExists(previous)) await rename(previous, target); throw error; }
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(previous, { recursive: true, force: true });
  }
}

async function replaceImportedSnapshots(entries: PackageEntry[], baseline: string, working: string, commit: () => Promise<void>): Promise<void> {
  const nonce = randomBytes(6).toString('hex');
  const nextBaseline = join(dirname(baseline), `.next-${basename(baseline)}-${nonce}`);
  const nextWorking = join(dirname(working), `.next-${basename(working)}-${nonce}`);
  const previousBaseline = join(dirname(baseline), `.previous-${basename(baseline)}-${nonce}`);
  const previousWorking = join(dirname(working), `.previous-${basename(working)}-${nonce}`);
  let movedBaseline = false;
  let movedWorking = false;
  let installedBaseline = false;
  let installedWorking = false;
  try {
    await atomicCopySnapshot(entries, nextBaseline);
    await atomicCopySnapshot(entries, nextWorking);
    await rename(baseline, previousBaseline);
    movedBaseline = true;
    await rename(working, previousWorking);
    movedWorking = true;
    await rename(nextBaseline, baseline);
    installedBaseline = true;
    await rename(nextWorking, working);
    installedWorking = true;
    await commit();
    await rm(previousBaseline, { recursive: true, force: true });
    movedBaseline = false;
    await rm(previousWorking, { recursive: true, force: true });
    movedWorking = false;
  } catch (error) {
    if (installedWorking) await rm(working, { recursive: true, force: true });
    if (installedBaseline) await rm(baseline, { recursive: true, force: true });
    const rollbackErrors: string[] = [];
    if (movedWorking) {
      try { await rename(previousWorking, working); movedWorking = false; }
      catch (rollbackError) { rollbackErrors.push(`working copy: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
    }
    if (movedBaseline) {
      try { await rename(previousBaseline, baseline); movedBaseline = false; }
      catch (rollbackError) { rollbackErrors.push(`baseline: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
    }
    if (rollbackErrors.length) throw new Error(`Imported skill update failed and rollback was incomplete (${rollbackErrors.join('; ')}). Recovery copies were preserved beside the skill store. Original error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    await rm(nextBaseline, { recursive: true, force: true });
    await rm(nextWorking, { recursive: true, force: true });
  }
}

async function validatedLocalSource(source: string): Promise<string> {
  const selected = resolve(source);
  const selectedInfo = await lstat(selected);
  if (selectedInfo.isSymbolicLink()) throw new Error('Local skill source cannot itself be a symlink.');
  const root = await realpath(selected);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Local skill source must be a regular directory.');
  return root;
}

async function checkoutGitSkill(repository: string, gitRef: string | undefined, sourcePath: string | undefined): Promise<{ root: string; expectedName: string; cleanup: () => Promise<void>; source: Extract<InstalledSkill['source'], { type: 'git' }> }> {
  const url = new URL(repository);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Git skill imports require an HTTPS URL without embedded credentials.');
  if (!gitRef || !/^[a-f0-9]{40}$/i.test(gitRef)) throw new Error('Git skill imports require --ref with a full 40-character commit SHA.');
  if (sourcePath && (sourcePath.startsWith('/') || sourcePath.split('/').includes('..'))) throw new Error('--path must be a relative repository path without upward traversal.');
  const temporary = await mkdtemp(join(tmpdir(), 'qubicl-skill-import-'));
  const repositoryRoot = join(temporary, 'repository');
  const gitEnvironment = { GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', SSH_ASKPASS: '/bin/false' };
  try {
    await run('git', ['init', '--quiet', repositoryRoot], temporary);
    await run('git', ['-C', repositoryRoot, '-c', 'core.hooksPath=/dev/null', 'remote', 'add', 'origin', repository], temporary);
    await run('git', ['-C', repositoryRoot, '-c', 'protocol.file.allow=never', '-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'http.followRedirects=false', '-c', 'core.hooksPath=/dev/null', 'fetch', '--quiet', '--filter=blob:none', '--depth=1', 'origin', gitRef], temporary, gitEnvironment);
    const resolvedCommit = (await run('git', ['-C', repositoryRoot, 'rev-parse', 'FETCH_HEAD'], temporary)).trim();
    if (resolvedCommit.toLowerCase() !== gitRef.toLowerCase()) throw new Error('Fetched Git commit does not match the requested immutable revision.');
    const tree = await run('git', ['-C', repositoryRoot, 'ls-tree', '-r', 'FETCH_HEAD'], temporary);
    if (tree.split('\n').some((line) => line.startsWith('160000 '))) throw new Error('Git skill imports do not allow submodules.');
    if (sourcePath) {
      await run('git', ['-C', repositoryRoot, 'sparse-checkout', 'init', '--cone'], temporary, gitEnvironment);
      await run('git', ['-C', repositoryRoot, 'sparse-checkout', 'set', '--', sourcePath], temporary, gitEnvironment);
    }
    await run('git', ['-C', repositoryRoot, '-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], temporary, gitEnvironment);
    const root = sourcePath ? join(repositoryRoot, sourcePath) : repositoryRoot;
    await validatedLocalSource(root);
    const expectedName = sourcePath ? basename(sourcePath) : basename(url.pathname).replace(/\.git$/i, '');
    return { root, expectedName, cleanup: () => rm(temporary, { recursive: true, force: true }), source: { type: 'git', repository, commit: resolvedCommit, ...(sourcePath ? { path: sourcePath } : {}) } };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function run(command: string, args: string[], cwd: string, extraEnvironment: Record<string, string> = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...extraEnvironment }, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let terminalError: Error | undefined;
    let settled = false;
    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolvePromise(value ?? '');
    };
    const capture = (target: Buffer[]) => (chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
        terminalError ??= new Error(`${command} output exceeded ${MAX_GIT_OUTPUT_BYTES} bytes.`);
        child.kill('SIGKILL');
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.on('error', (error) => finish(error));
    child.on('close', (code) => terminalError
      ? finish(terminalError)
      : code === 0
        ? finish(undefined, Buffer.concat(stdout).toString('utf8'))
        : finish(new Error(`${command} failed (${code ?? 'signal'}): ${Buffer.concat(stderr).toString('utf8').trim()}`)));
    const timer = setTimeout(() => {
      terminalError = new Error(`${command} exceeded the ${GIT_TIMEOUT_MS}-millisecond import timeout.`);
      child.kill('SIGKILL');
    }, GIT_TIMEOUT_MS);
  });
}

function resolveInstalled(registry: SkillRegistry, idOrName: string): InstalledSkill {
  const matches = Object.values(registry.packages).filter(({ id, name }) => id === idOrName || name === idOrName);
  if (!matches.length) throw new Error(`Installed skill ${idOrName} was not found.`);
  if (matches.length > 1) throw new Error(`Skill name ${idOrName} is ambiguous; use its full ID.`);
  return matches[0]!;
}

function assertSkillName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 64) throw new Error('Skill name must be lowercase kebab-case and at most 64 characters.');
}

function isHttpsUrl(value: string): boolean {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

function rejectNonHttpsUrl(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('Remote skill imports require HTTPS. SSH, HTTP, Git, and file URLs are not allowed.');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Remote skill imports')) throw error;
    // Not a URL: it is handled as a local operator-selected directory.
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (isNotFound(error)) return false; throw error; }
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}
