import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { CONTENT_SECURITY_SCANNER_VERSION, scanSkillFiles, type SkillSecurityFinding } from './content-security.js';

export const CORE_SKILL_IDS = [
  'qubicl-core/plan',
  'qubicl-core/pdf',
  'qubicl-core/docx',
  'qubicl-core/xlsx',
  'qubicl-core/powerpoint',
  'qubicl-core/ocr-and-documents',
] as const;

export const LEGACY_CORE_SKILL_IDS: Readonly<Record<string, CoreSkillId>> = {
  'hermes-default/software-development/plan': 'qubicl-core/plan',
  'hermes-default/productivity/pdf': 'qubicl-core/pdf',
  'hermes-default/productivity/docx': 'qubicl-core/docx',
  'hermes-default/productivity/xlsx': 'qubicl-core/xlsx',
  'hermes-default/productivity/powerpoint': 'qubicl-core/powerpoint',
  'hermes-default/productivity/ocr-and-documents': 'qubicl-core/ocr-and-documents',
};

// Removed packaged IDs may remain in durable policy long enough for an older
// state document to be read and rewritten. They are never discovered or
// materialized. The broad prefix check intentionally covers the former 186-item
// Hermes catalog without retaining that catalog in the product.
export function isRetiredCatalogSkillId(id: string): boolean {
  return id.startsWith('hermes-default/') || id.startsWith('hermes-optional/');
}

/** @deprecated Use isRetiredCatalogSkillId for dynamic legacy recognition. */
export const RETIRED_CATALOG_SKILL_IDS = new Set(['hermes-optional/security/godmode']);

export type CoreSkillId = typeof CORE_SKILL_IDS[number];

export function defaultCatalogSkillsForCompatibility(compatibility: import('./presets.js').Preset): CoreSkillId[] {
  if (compatibility === 'file-system') return ['qubicl-core/plan'];
  if (compatibility === 'browser') return ['qubicl-core/plan', 'qubicl-core/pdf', 'qubicl-core/ocr-and-documents'];
  return [...CORE_SKILL_IDS];
}

export function normalizeOperatorSkillIds(ids: readonly string[]): string[] {
  const normalized = ids.map((id) => LEGACY_CORE_SKILL_IDS[id] ?? id);
  return [...new Set(normalized)];
}

export interface CatalogSkillSecurity {
  scannerVersion: typeof CONTENT_SECURITY_SCANNER_VERSION;
  verdict: 'no-blocking-findings' | 'reviewed-exception';
  findings: SkillSecurityFinding[];
}

export interface VerifiableCatalogSkill {
  id: string;
  files: string[];
  sha256: string;
  security: CatalogSkillSecurity;
}

export async function inspectSkillDirectory(root: string, expectedFiles: readonly string[]): Promise<{
  sha256: string;
  findings: SkillSecurityFinding[];
}> {
  const actualFiles: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Skill package contains unsupported symlink ${relative(root, path)}.`);
    if (entry.isFile()) actualFiles.push(relative(root, path).split(sep).join('/'));
  }
  actualFiles.sort();
  const expected = [...expectedFiles].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expected)) throw new Error('Skill package file list differs from its immutable catalog record.');
  const digest = createHash('sha256');
  const textFiles: Record<string, string> = {};
  for (const file of actualFiles) {
    const target = join(root, file);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Skill resource ${file} is not an immutable regular file.`);
    const bytes = await readFile(target);
    digest.update(`${file}\0`);
    digest.update(bytes);
    digest.update('\0');
    if (!bytes.includes(0)) textFiles[file] = bytes.toString('utf8');
  }
  return { sha256: digest.digest('hex'), findings: scanSkillFiles(textFiles) };
}

export async function verifyCatalogSkillDirectory(root: string, skill: VerifiableCatalogSkill): Promise<void> {
  if (skill.security?.scannerVersion !== CONTENT_SECURITY_SCANNER_VERSION || !Array.isArray(skill.security.findings)) {
    throw new Error(`Catalog skill ${skill.id} has no current mandatory security review.`);
  }
  const inspected = await inspectSkillDirectory(root, skill.files);
  if (inspected.sha256 !== skill.sha256) throw new Error(`Catalog skill ${skill.id} differs from its immutable reviewed digest.`);
  if (JSON.stringify(inspected.findings) !== JSON.stringify(skill.security.findings)) {
    throw new Error(`Catalog skill ${skill.id} security findings differ from its reviewed record.`);
  }
}
