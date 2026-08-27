import { createHash, randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { CONTENT_SECURITY_SCANNER_VERSION, scanSkillFiles, type SkillSecurityFinding } from '@qubicl/core';
import { QubiclError } from './errors.js';

interface CoreSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  license: string;
  compatiblePresets: string[];
}

interface CoreCatalog {
  schemaVersion: 1;
  source: Record<string, unknown>;
  skills: CoreSkill[];
}

interface InstalledSkill {
  id: string;
  name: string;
  description: string;
  kind: 'core' | 'imported';
  baselineSha256: string;
  installedAt: string;
  updatedAt: string;
  source: Record<string, unknown>;
  security: { scannerVersion: string; findings: SkillSecurityFinding[] };
  detectedRequirements?: { tools: string[]; commands: string[]; environment: string[]; urls: string[] };
  updateAvailableSha256?: string;
}

interface SkillRegistry {
  version: 2;
  packages: Record<string, InstalledSkill>;
}

interface CustomSkillMetadata {
  schemaVersion: 1;
  name: string;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  baselineSha256?: string;
  security?: { scannerVersion: typeof CONTENT_SECURITY_SCANNER_VERSION; findings: SkillSecurityFinding[] };
}

const MAX_EDITABLE_SKILL_FILES = 256;
const MAX_EDITABLE_SKILL_ENTRIES = 512;
const MAX_EDITABLE_SKILL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EDITABLE_SKILL_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_EDITABLE_SKILL_PATH_BYTES = 240;

export interface SkillManagerOptions {
  durableRoot?: string;
  catalogRoot?: string;
  enabledCatalogSkills?: () => readonly string[];
  compatibility?: string;
  expectedRegistrySha256?: () => string | undefined;
  onRegistryIntegrityFailure?: () => Promise<void>;
}

export class SkillManager {
  private readonly durableRoot: string;
  private readonly catalogRoot: string;
  private readonly storeRoot: string;
  private readonly installedRoot: string;
  private readonly customRoot: string;
  private readonly registryPath: string;
  private readonly discoveryRoots: string[];
  private readonly enabledOperatorSkills: () => readonly string[];
  private readonly compatibility: string;
  private readonly expectedRegistrySha256: (() => string | undefined) | undefined;
  private readonly onRegistryIntegrityFailure: (() => Promise<void>) | undefined;
  private catalogPromise: Promise<CoreCatalog> | undefined;

  constructor(options: SkillManagerOptions = {}) {
    this.durableRoot = resolve(options.durableRoot ?? '/home/qubicl');
    this.catalogRoot = resolve(options.catalogRoot ?? '/opt/qubicl/skills');
    this.storeRoot = join(this.durableRoot, '.local', 'share', 'qubicl', 'skills');
    this.installedRoot = join(this.storeRoot, 'installed');
    this.customRoot = join(this.storeRoot, 'custom');
    this.registryPath = join(this.storeRoot, 'registry.json');
    this.discoveryRoots = ['.agents', '.claude', '.hermes', '.codex'].map((directory) => join(this.durableRoot, directory, 'skills'));
    this.enabledOperatorSkills = options.enabledCatalogSkills ?? (() => []);
    this.compatibility = options.compatibility ?? 'workstation';
    this.expectedRegistrySha256 = options.expectedRegistrySha256;
    this.onRegistryIntegrityFailure = options.onRegistryIntegrityFailure;
  }

  async list(scope: 'active' | 'core' | 'imported' | 'catalog' | 'custom', query: string, cursor: number, limit: number): Promise<Record<string, unknown>> {
    const catalog = await this.catalog();
    const registry = await this.registry();
    const enabled = new Set(this.enabledOperatorSkills());
    const coreById = new Map(catalog.skills.map((skill) => [skill.id, skill]));
    const operatorItems = await Promise.all(Object.values(registry.packages).map(async (skill) => {
      let currentSha256: string | null = null;
      let drift: 'unchanged' | 'modified' | 'missing' | 'corrupt' = 'missing';
      try {
        const inspected = await inspectWorkingSkill(join(this.installedRoot, skill.name));
        currentSha256 = inspected.sha256;
        drift = inspected.sha256 === skill.baselineSha256 ? 'unchanged' : 'modified';
      } catch (error) {
        drift = isNotFound(error) ? 'missing' : 'corrupt';
      }
      const core = coreById.get(skill.id);
      const availableOnPreset = skill.kind !== 'core' || Boolean(core?.compatiblePresets.includes(this.compatibility));
      return {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        category: core?.category ?? 'imported',
        source: skill.kind,
        license: core?.license,
        enabled: enabled.has(skill.id),
        operatorManaged: true,
        supported: skill.kind === 'core' && availableOnPreset,
        availableOnPreset,
        editable: true,
        resourceRoot: join(this.installedRoot, skill.name),
        baselineSha256: skill.baselineSha256,
        currentSha256,
        drift,
        provenance: skill.source,
        advisoryFindingCount: skill.security.findings.length,
        ...(skill.detectedRequirements ? { detectedRequirements: skill.detectedRequirements } : {}),
        ...(skill.updateAvailableSha256 ? { updateAvailableSha256: skill.updateAvailableSha256 } : {}),
      };
    }));
    const custom = await this.customSkills();
    const customItems = custom.map((skill) => ({ id: `custom/${skill.name}`, name: skill.name, description: skill.description, category: 'custom', source: 'custom', enabled: skill.enabled, operatorManaged: false, editable: true, resourceRoot: join(this.customRoot, skill.name) }));
    let selected = scope === 'core' || scope === 'catalog'
      ? operatorItems.filter(({ source }) => source === 'core')
      : scope === 'imported'
        ? operatorItems.filter(({ source }) => source === 'imported')
        : scope === 'custom'
          ? customItems
          : [...operatorItems.filter(({ enabled: active }) => active), ...customItems.filter(({ enabled: active }) => active)];
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery) selected = selected.filter((skill) => `${skill.name} ${skill.description} ${skill.category}`.toLowerCase().includes(normalizedQuery));
    selected.sort((left, right) => left.category.localeCompare(right.category) || left.name.localeCompare(right.name));
    return { scope, query: normalizedQuery, cursor, total: selected.length, skills: selected.slice(cursor, cursor + limit), nextCursor: cursor + limit < selected.length ? cursor + limit : null, coreSource: catalog.source };
  }

  async view(id: string, resourcePath: string, offset: number, maxBytes: number): Promise<Record<string, unknown>> {
    let root: string;
    let source: 'core' | 'imported' | 'custom';
    let baselineSha256: string | undefined;
    if (id.startsWith('custom/')) {
      const name = id.slice('custom/'.length);
      assertSkillName(name);
      const metadata = await this.customMetadata(name);
      if (!metadata.enabled) throw new QubiclError('skill_disabled', `Custom skill ${name} is disabled by its owner.`, 403);
      root = join(this.customRoot, name);
      source = 'custom';
    } else {
      const registry = await this.registry();
      const skill = registry.packages[id];
      if (!skill) throw new QubiclError('skill_not_found', `Installed skill ${id} was not found.`, 404);
      if (!this.enabledOperatorSkills().includes(id)) throw new QubiclError('skill_disabled', `Installed skill ${id} is disabled by the Qubicl operator.`, 403);
      if (skill.kind === 'core') {
        const core = (await this.catalog()).skills.find(({ id: coreId }) => coreId === skill.id);
        if (!core?.compatiblePresets.includes(this.compatibility)) throw new QubiclError('capability_unsupported', `Core skill ${skill.name} is not available on the ${this.compatibility} preset because its tested image dependencies are absent.`, 400);
      }
      root = join(this.installedRoot, skill.name);
      source = skill.kind;
      baselineSha256 = skill.baselineSha256;
    }
    const inspected = await inspectWorkingSkill(root);
    const blocked = inspected.findings.filter(({ blockingForSkills }) => blockingForSkills);
    if (blocked.length) throw new QubiclError('skill_security_rejected', `Editable skill ${id} contains blocked prompt-injection or concealment patterns.`, 403);
    const target = safeChild(root, resourcePath);
    await assertRegularTree(root, target);
    const bytes = await readFile(target);
    if (offset > bytes.length) throw new QubiclError('invalid_arguments', `Offset ${offset} exceeds the ${bytes.length}-byte skill resource.`);
    const chunk = bytes.subarray(offset, offset + maxBytes);
    return {
      id,
      source,
      path: resourcePath,
      resourceRoot: root,
      editable: true,
      ...(baselineSha256 ? { baselineSha256, currentSha256: inspected.sha256, drift: baselineSha256 === inspected.sha256 ? 'unchanged' : 'modified' } : {}),
      content: chunk.toString('utf8'),
      bytes: chunk.length,
      totalBytes: bytes.length,
      truncated: offset + chunk.length < bytes.length,
      nextOffset: offset + chunk.length < bytes.length ? offset + chunk.length : null,
    };
  }

  async manage(mutation: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = mutation.action as 'create' | 'update' | 'delete' | 'enable' | 'disable';
    const name = mutation.name as string;
    assertSkillName(name);
    const catalog = await this.catalog();
    const registry = await this.registry();
    if (catalog.skills.some((skill) => skill.name === name) || Object.values(registry.packages).some((skill) => skill.name === name)) throw new QubiclError('skill_name_reserved', `Skill name ${name} belongs to an operator-managed package.`, 409);
    await ensurePlainDirectoryTree(this.durableRoot, this.customRoot, 'skill_store_unsafe', 'Qubicl custom skill store');
    if (action === 'create') {
      if (await exists(join(this.customRoot, name))) throw new QubiclError('skill_exists', `Custom skill ${name} already exists.`, 409);
      const now = new Date().toISOString();
      await this.replaceCustomSkill({ schemaVersion: 1, name, description: mutation.description as string, enabled: mutation.enabled as boolean, createdAt: now, updatedAt: now }, mutation.instructions as string, mutation.files as Record<string, string>);
    } else if (action === 'update') {
      const existing = await this.customMetadata(name);
      const currentInstructions = skillInstructions(await readFile(join(this.customRoot, name, 'SKILL.md'), 'utf8'));
      await this.replaceCustomSkill({ ...existing, description: mutation.description as string | undefined ?? existing.description, updatedAt: new Date().toISOString() }, mutation.instructions as string | undefined ?? currentInstructions, mutation.files as Record<string, string> | undefined, true);
    } else if (action === 'delete') {
      await this.customMetadata(name);
      await rm(join(this.customRoot, name), { recursive: true, force: true });
      await this.removeDiscovery(name);
      return { action, id: `custom/${name}`, deleted: true };
    } else {
      const existing = await this.customMetadata(name);
      if (action === 'enable') await this.verifyEditableCustom(existing);
      existing.enabled = action === 'enable';
      existing.updatedAt = new Date().toISOString();
      await writeFile(join(this.customRoot, name, '.qubicl.json'), `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
      await this.synchronizeCustom(existing);
    }
    const skill = await this.customMetadata(name);
    return { action, id: `custom/${name}`, name, enabled: skill.enabled, editable: true, operatorSkillPolicyUnchanged: true };
  }

  private async replaceCustomSkill(metadata: CustomSkillMetadata, instructions: string, files: Record<string, string> | undefined, retainFiles = false): Promise<void> {
    await ensurePlainDirectoryTree(this.durableRoot, this.customRoot, 'skill_store_unsafe', 'Qubicl custom skill store');
    const staging = join(this.customRoot, `.tmp-${metadata.name}-${randomBytes(8).toString('hex')}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      if (retainFiles) await cp(join(this.customRoot, metadata.name), staging, { recursive: true });
      await writeFile(join(staging, 'SKILL.md'), renderSkill(metadata.name, metadata.description, instructions), { mode: 0o600 });
      if (files !== undefined) {
        for (const entry of await readdir(staging, { withFileTypes: true })) if (!['SKILL.md', '.qubicl.json'].includes(entry.name)) await rm(join(staging, entry.name), { recursive: true, force: true });
        let total = 0;
        for (const [path, content] of Object.entries(files)) {
          if (path === 'SKILL.md' || path === '.qubicl.json') throw new QubiclError('invalid_arguments', `${path} is managed by Qubicl.`);
          total += Buffer.byteLength(content);
          if (total > 1_000_000) throw new QubiclError('skill_too_large', 'Custom skill resources exceed 1 MB.');
          const target = safeChild(staging, path);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, content, { mode: 0o600 });
        }
      }
      const inspected = await inspectWorkingSkill(staging);
      const blocked = inspected.findings.filter(({ blockingForSkills }) => blockingForSkills);
      if (blocked.length) throw new QubiclError('skill_security_rejected', `Custom skill ${metadata.name} contains blocked prompt-injection or concealment patterns: ${[...new Set(blocked.map(({ id }) => id))].sort().join(', ')}.`, 400);
      metadata.baselineSha256 = inspected.sha256;
      metadata.security = { scannerVersion: CONTENT_SECURITY_SCANNER_VERSION, findings: inspected.findings };
      await writeFile(join(staging, '.qubicl.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
      const target = join(this.customRoot, metadata.name);
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
      await this.synchronizeCustom(metadata);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async synchronizeCustom(metadata: CustomSkillMetadata): Promise<void> {
    await this.removeDiscovery(metadata.name);
    if (!metadata.enabled) return;
    const source = join(this.customRoot, metadata.name);
    for (const root of this.discoveryRoots) {
      await ensurePlainDirectoryTree(this.durableRoot, root, 'skill_discovery_unsafe', `Native skill discovery root ${root}`);
      const target = join(root, metadata.name);
      if (await exists(target)) throw new QubiclError('skill_name_conflict', `Native skill discovery entry ${target} is owned outside Qubicl.`, 409);
      await symlink(relative(root, source), target, 'dir');
    }
  }

  private async removeDiscovery(name: string): Promise<void> {
    for (const root of this.discoveryRoots) {
      if (!(await assertPlainDirectoryTree(this.durableRoot, root, 'skill_discovery_unsafe', `Native skill discovery root ${root}`))) continue;
      const target = join(root, name);
      try {
        const info = await lstat(target);
        if (!info.isSymbolicLink()) continue;
        const resolved = resolve(root, await readlink(target));
        if (isWithin(this.installedRoot, resolved) || isWithin(this.customRoot, resolved)) await rm(target, { force: true });
      } catch (error) { if (!isNotFound(error)) throw error; }
    }
  }

  private async customSkills(): Promise<CustomSkillMetadata[]> {
    try {
      await assertPlainDirectoryTree(this.durableRoot, this.customRoot, 'skill_store_unsafe', 'Qubicl custom skill store');
      const entries = await readdir(this.customRoot, { withFileTypes: true });
      if (entries.length > MAX_EDITABLE_SKILL_FILES) throw new QubiclError('skill_package_limit', `Custom skill store exceeds the ${MAX_EDITABLE_SKILL_FILES}-package limit.`, 413);
      const result: CustomSkillMetadata[] = [];
      for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.tmp-')) result.push(await this.customMetadata(entry.name));
      return result;
    } catch (error) { if (isNotFound(error)) return []; throw error; }
  }

  private async customMetadata(name: string): Promise<CustomSkillMetadata> {
    try {
      await assertPlainDirectoryTree(this.durableRoot, this.customRoot, 'skill_store_unsafe', 'Qubicl custom skill store');
      const path = join(this.customRoot, name, '.qubicl.json');
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('invalid custom skill metadata file');
      const parsed = JSON.parse(await readFile(path, 'utf8')) as CustomSkillMetadata;
      if (parsed.schemaVersion !== 1 || parsed.name !== name || typeof parsed.description !== 'string' || typeof parsed.enabled !== 'boolean') throw new Error('invalid custom skill metadata');
      return parsed;
    } catch (error) {
      if (error instanceof QubiclError) throw error;
      if (isNotFound(error)) throw new QubiclError('skill_not_found', `Custom skill ${name} was not found.`, 404);
      throw new QubiclError('skill_corrupt', `Custom skill ${name} has invalid metadata.`, 500);
    }
  }

  private async catalog(): Promise<CoreCatalog> {
    this.catalogPromise ??= readFile(join(this.catalogRoot, 'core-catalog.json'), 'utf8').then((raw) => {
      const parsed = JSON.parse(raw) as CoreCatalog;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.skills) || parsed.skills.length !== 6) throw new Error('Qubicl core skill catalog is invalid.');
      return parsed;
    });
    return this.catalogPromise;
  }

  private async registry(): Promise<SkillRegistry> {
    try {
      await assertPlainDirectoryTree(this.durableRoot, this.storeRoot, 'skill_store_unsafe', 'Qubicl skill store');
      await assertPlainDirectoryTree(this.durableRoot, this.installedRoot, 'skill_store_unsafe', 'Qubicl installed skill store');
      await assertPlainDirectoryTree(this.durableRoot, this.customRoot, 'skill_store_unsafe', 'Qubicl custom skill store');
      const info = await lstat(this.registryPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('invalid registry file');
      const raw = await readFile(this.registryPath);
      const expectedDigest = this.expectedRegistrySha256?.();
      const actualDigest = createHash('sha256').update(raw).digest('hex');
      if (expectedDigest && expectedDigest !== actualDigest) {
        await this.onRegistryIntegrityFailure?.();
        throw new QubiclError('skill_registry_integrity', 'Qubicl skill registry differs from the operator-protected runtime policy. Agent control was revoked; reload the operator policy before using skills.', 409);
      }
      const parsed = JSON.parse(raw.toString('utf8')) as SkillRegistry;
      if (parsed.version !== 2 || !parsed.packages || typeof parsed.packages !== 'object') throw new Error('invalid registry');
      const names = new Set<string>();
      for (const [id, skill] of Object.entries(parsed.packages)) {
        if (!skill || skill.id !== id || (skill.kind !== 'core' && skill.kind !== 'imported')) throw new Error('invalid package ID');
        assertSkillName(skill.name);
        if (id !== `${skill.kind === 'core' ? 'qubicl-core' : 'imported'}/${skill.name}` || names.has(skill.name) || typeof skill.description !== 'string' || !skill.description.trim() || skill.description.length > 1024 || !/^[a-f0-9]{64}$/.test(skill.baselineSha256)) throw new Error('invalid package metadata');
        if (typeof skill.installedAt !== 'string' || typeof skill.updatedAt !== 'string' || !skill.source || typeof skill.source !== 'object' || !skill.security || typeof skill.security !== 'object' || !Array.isArray(skill.security.findings)) throw new Error('invalid package provenance');
        names.add(skill.name);
      }
      return parsed;
    } catch (error) {
      if (error instanceof QubiclError) throw error;
      if (isNotFound(error)) {
        const expectedDigest = this.expectedRegistrySha256?.();
        if (expectedDigest && expectedDigest !== 'not-initialized') {
          await this.onRegistryIntegrityFailure?.();
          throw new QubiclError('skill_registry_integrity', 'The operator-protected Qubicl skill registry is missing. Agent control was revoked; repair skills and reload policy.', 409);
        }
        return { version: 2, packages: {} };
      }
      throw new QubiclError('skill_registry_corrupt', 'Qubicl skill registry is invalid.', 500);
    }
  }

  private async verifyEditableCustom(metadata: CustomSkillMetadata): Promise<void> {
    const inspected = await inspectWorkingSkill(join(this.customRoot, metadata.name));
    const blocked = inspected.findings.filter(({ blockingForSkills }) => blockingForSkills);
    if (blocked.length) throw new QubiclError('skill_security_rejected', `Custom skill ${metadata.name} contains blocked prompt-injection or concealment patterns.`, 403);
    metadata.security = { scannerVersion: CONTENT_SECURITY_SCANNER_VERSION, findings: inspected.findings };
    await writeFile(join(this.customRoot, metadata.name, '.qubicl.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  }
}

function assertSkillName(name: string): void {
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new QubiclError('invalid_arguments', 'Skill name must be lowercase kebab-case and at most 64 characters.');
}

function safeChild(root: string, path: string): string {
  if (!path || path.startsWith('/') || path.split('/').includes('..')) throw new QubiclError('invalid_arguments', 'Skill resource path must be relative and cannot traverse upward.');
  const target = resolve(root, path);
  if (!isWithin(root, target)) throw new QubiclError('invalid_arguments', 'Skill resource escapes its package.');
  return target;
}

async function assertRegularTree(root: string, target: string): Promise<void> {
  let current = target;
  while (current !== root) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new QubiclError('skill_symlink_rejected', 'Skill resources cannot be reached through symlinks.', 403);
    current = dirname(current);
  }
  if (!(await lstat(target)).isFile()) throw new QubiclError('skill_resource_invalid', 'Skill resource must be a regular file.');
}

function renderSkill(name: string, description: string, instructions: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions.trim()}\n`;
}

function skillInstructions(raw: string): string { return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim(); }

async function inspectWorkingSkill(root: string): Promise<{ sha256: string; findings: SkillSecurityFinding[] }> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new QubiclError('skill_symlink_rejected', 'Editable skill root must be a regular directory, not a symlink.', 403);
  const files: Record<string, string> = {};
  const digest = createHash('sha256');
  const entries: Array<{ path: string; target: string }> = [];
  const pending: Array<{ directory: string; prefix: string }> = [{ directory: root, prefix: '' }];
  let visited = 0;
  let totalBytes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    const children = (await readdir(current.directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of children) {
      visited += 1;
      if (visited > MAX_EDITABLE_SKILL_ENTRIES) throw new QubiclError('skill_package_limit', `Editable skill exceeds the ${MAX_EDITABLE_SKILL_ENTRIES}-entry traversal limit.`, 413);
      const target = join(current.directory, entry.name);
      const path = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
      if (Buffer.byteLength(path) > MAX_EDITABLE_SKILL_PATH_BYTES) throw new QubiclError('skill_package_limit', `Editable skill path exceeds ${MAX_EDITABLE_SKILL_PATH_BYTES} bytes.`, 413);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new QubiclError('skill_symlink_rejected', `Editable skill contains unsupported symlink ${path}.`, 403);
      if (info.isDirectory()) { pending.push({ directory: target, prefix: path }); continue; }
      if (!info.isFile() || info.nlink > 1) throw new QubiclError('skill_symlink_rejected', `Editable skill resource ${path} must be an ordinary, non-hard-linked file.`, 403);
      if (entry.name === '.qubicl.json') continue;
      if (info.size > MAX_EDITABLE_SKILL_FILE_BYTES) throw new QubiclError('skill_package_limit', `Editable skill resource ${path} exceeds the ${MAX_EDITABLE_SKILL_FILE_BYTES}-byte limit.`, 413);
      totalBytes += info.size;
      if (totalBytes > MAX_EDITABLE_SKILL_TOTAL_BYTES) throw new QubiclError('skill_package_limit', `Editable skill exceeds the ${MAX_EDITABLE_SKILL_TOTAL_BYTES}-byte total limit.`, 413);
      entries.push({ path, target });
      if (entries.length > MAX_EDITABLE_SKILL_FILES) throw new QubiclError('skill_package_limit', `Editable skill exceeds the ${MAX_EDITABLE_SKILL_FILES}-file limit.`, 413);
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  for (const { path, target } of entries) {
    const bytes = await readFile(target);
    digest.update(`${path}\0`); digest.update(bytes); digest.update('\0');
    const text = decodeSkillText(bytes);
    if (text !== undefined) files[path] = text;
    else if (textDesignatedSkillResource(path)) throw new QubiclError('skill_security_rejected', `Editable skill text resource ${path} is not canonical UTF-8 or contains control/format characters.`, 403);
  }
  if (!entries.some(({ path }) => path === 'SKILL.md') || files['SKILL.md'] === undefined) throw new QubiclError('skill_security_rejected', 'Editable skills require a canonical UTF-8 SKILL.md.', 403);
  return { sha256: digest.digest('hex'), findings: scanSkillFiles(files) };
}

function decodeSkillText(bytes: Buffer): string | undefined {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (const character of decoded) {
      const code = character.codePointAt(0)!;
      if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || (code >= 127 && code <= 159) || /\p{Cf}/u.test(character)) return undefined;
    }
    return decoded;
  } catch { return undefined; }
}

function textDesignatedSkillResource(path: string): boolean {
  const name = path.split('/').at(-1)!.toLowerCase();
  return ['skill.md', 'readme', 'readme.md', 'license', 'license.md'].includes(name)
    || /\.(?:md|mdx|txt|json|ya?ml|toml|ini|cfg|csv|tsv|xml|html?|css|py|mjs|cjs|js|jsx|ts|tsx|sh|bash|zsh|fish|ps1|rb|rs|go|java|c|cc|cpp|h|hpp|sql)$/u.test(name);
}

function isWithin(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

async function assertPlainDirectoryTree(root: string, target: string, code: string, label: string): Promise<boolean> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new QubiclError(code, `${label} has an unsafe computer-home root.`, 403);
  const relativeTarget = relative(resolve(root), resolve(target));
  if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`)) throw new QubiclError(code, `${label} escapes the durable home.`, 403);
  let current = resolve(root);
  for (const component of relativeTarget.split(sep)) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new QubiclError(code, `${label} must use regular directories, not symlinks.`, 403);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
  return true;
}

async function ensurePlainDirectoryTree(root: string, target: string, code: string, label: string): Promise<void> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new QubiclError(code, `${label} has an unsafe computer-home root.`, 403);
  const relativeTarget = relative(resolve(root), resolve(target));
  if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`)) throw new QubiclError(code, `${label} escapes the durable home.`, 403);
  let current = resolve(root);
  for (const component of relativeTarget.split(sep)) {
    current = join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (!isAlreadyExists(error)) throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new QubiclError(code, `${label} must use regular directories, not symlinks.`, 403);
  }
}

async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (isNotFound(error)) return false; throw error; } }
function isNotFound(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
function isAlreadyExists(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'; }
