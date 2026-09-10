export const MANAGEMENT_OPERATIONS = [
  'setup', 'computer.create', 'computer.start', 'computer.stop', 'computer.restart',
  'computer.rename', 'computer.delete', 'computer.restore', 'computer.resources',
  'computer.upgrade', 'computers.stop', 'upgrade.all', 'gateway.start', 'gateway.restart',
  'control.release', 'process.stop', 'preview.revoke', 'tools.set', 'skills.set',
  'skill.import', 'skill.update', 'skill.reset', 'skill.remove', 'skill.restore',
  'network.set', 'network.approve', 'network.revoke', 'credential.add',
  'credential.replace', 'credential.remove', 'token.rotate', 'backup.create',
  'backup.verify', 'backup.restore', 'backup.prune', 'checkpoint.create', 'computer.clone',
  'recovery.resume', 'dashboard.restart', 'dashboard.revoke', 'gateway.revoke',
] as const;

export type ManagementOperation = typeof MANAGEMENT_OPERATIONS[number];

export interface ManagementRequest {
  operation: ManagementOperation;
  target?: string;
  input?: Record<string, unknown>;
}

export interface ManagementPlan {
  id: string;
  operation: ManagementOperation;
  target?: string;
  expiresAt: string;
  effects: string[];
  preserved: string[];
  warnings: string[];
  requiresInterruption: boolean;
  requiresReauthentication: boolean;
}

export interface ManagementJob {
  id: string;
  operation: ManagementOperation;
  target?: string;
  status: 'running' | 'succeeded' | 'failed' | 'recovery-required';
  createdAt: string;
  updatedAt: string;
  message: string;
  result?: unknown;
}

export interface ManagementComputer {
  id: string;
  name: string;
  preset: string;
  status: string;
  health?: string;
  cpus: number;
  memory: string;
  image: { requested: string; resolved: string; contentId?: string };
  capabilities: string[];
  controller?: OperatorController;
  resources?: { managedProcesses?: number; activePreviews?: number };
  tools: string[];
  skills: string[];
  network: unknown;
  [key: string]: unknown;
}

export interface ManagementSnapshot {
  protocolVersion: 1;
  initialized: boolean;
  migrationRequired: boolean;
  recoveryRequired: boolean;
  docker: { available: boolean; message?: string };
  gateway: { status: string };
  computers: ManagementComputer[];
  trash: Array<{ id: string; name: string }>;
  operations: ManagementJob[];
  presets: Array<{ id: string; cpus: number; memory: string; capabilities: string[] }>;
  release: string;
}

export interface SessionState {
  authenticated: boolean;
  csrfToken?: string;
  expiresAt?: string;
  remote?: boolean;
  [key: string]: unknown;
}

export interface DashboardSessionItem {
  id: string;
  createdAt: string;
  lastActivityAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  reauthenticatedUntil?: string;
  current: boolean;
}

export interface ListResponse<T> { items: T[] }

export interface OperatorController {
  kind: 'none' | 'agent' | 'human';
  generation: number;
  expiresAt?: string;
  actor?: { protocol: string; untrustedLabel: string };
}

export interface ManagedProcess {
  id: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  owner: 'agent';
  ownerGeneration: number;
}

export interface PublishedPreview {
  id: string;
  kind: 'port' | 'file';
  status: 'published';
  createdAt: string;
  expiresAt: string;
  port?: number;
}

export interface ToolItem { id: string; enabled: boolean; locked: boolean }
export interface SkillItem {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  kind?: string;
  origin?: string;
  drift?: string;
  drifted?: boolean;
  resetAvailable?: boolean;
}
export interface BackupItem { id: string; name: string; createdAt: string; encrypted: boolean; consistency: string }

export interface AssetManifestEntry {
  path: string;
  sha256: string;
  bytes: number;
  contentType: string;
  cache: 'no-store' | 'immutable';
}

export interface AssetManifest {
  schemaVersion: 1;
  entrypoint: string;
  assets: AssetManifestEntry[];
}
