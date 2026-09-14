/** Host management protocol. Workload credentials never belong in these records. */
export const MANAGEMENT_PROTOCOL_VERSION = 1;

export const MANAGEMENT_OPERATIONS = [
  'setup', 'computer.create', 'computer.start', 'computer.stop', 'computer.restart',
  'computer.rename', 'computer.delete', 'computer.restore', 'computer.resources',
  'computer.upgrade', 'computers.stop', 'upgrade.all', 'gateway.start', 'gateway.restart',
  'control.release', 'process.stop', 'preview.revoke', 'preview.share', 'preview.unshare', 'tools.set', 'skills.set',
  'skill.import', 'skill.update', 'skill.reset', 'skill.remove', 'skill.restore',
  'network.set', 'network.approve', 'network.revoke', 'credential.add',
  'credential.replace', 'credential.remove', 'client.create', 'client.rotate', 'client.revoke', 'token.rotate', 'backup.create',
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
  status: 'running' | 'succeeded' | 'failed' | 'recovery-required' | 'outcome-unknown';
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
  image: { requested: string; resolved: string; contentId?: string | undefined };
  capabilities: string[];
  controller?: unknown;
  resources?: unknown;
  browser?: unknown;
  tools: string[];
  skills: string[];
  network: unknown;
  clients: Array<{ id: string; label: string; scopes: string[]; createdAt: string; lastUsedAt?: string }>;
}
export interface ManagementSnapshot {
  protocolVersion: 1;
  initialized: boolean;
  migrationRequired: boolean;
  recoveryRequired: boolean;
  docker: { available: boolean; message?: string };
  gateway: { status: string };
  computers: ManagementComputer[];
  trash: Array<{ id: string; name: string; status: 'available' | 'quarantined'; diagnostic?: string }>;
  operations: ManagementJob[];
  defaultPreset: string;
  presets: Array<{ id: string; purpose: string; description: string; cpus: number; memory: string; capabilities: string[] }>;
  release: string;
}
