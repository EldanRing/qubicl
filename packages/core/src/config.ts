import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CAPABILITY_CONTRACT_VERSION,
  CapabilityListSchema,
  ConfigPresetSchema,
  DockerPlatformSchema,
  ImageCatalogSchema,
  PresetSchema,
  ComputerToolNameSchema,
  capabilitiesForCompatibility,
  createDevelopmentCatalog,
  normalizeMemory,
  validateCpu,
  type Capability,
  type ConfigPreset,
  type DockerPlatform,
  type ImageCatalog,
  type Preset,
} from './presets.js';
import { normalizeOperatorSkillIds } from './skills.js';
import { QUBICL_BUILD } from './version.js';

declare const __QUBICL_BUILD_DEFAULT_COMPUTER_IMAGE__: string | undefined;
declare const __QUBICL_BUILD_DEFAULT_GATEWAY_IMAGE__: string | undefined;
declare const __QUBICL_BUILD_IMAGE_CATALOG__: string | undefined;

/** The former universal image name remains only for deterministic v2 migration. */
export const PACKAGED_DEFAULT_COMPUTER_IMAGE = typeof __QUBICL_BUILD_DEFAULT_COMPUTER_IMAGE__ === 'undefined'
  ? 'qubicl/computer:dev'
  : __QUBICL_BUILD_DEFAULT_COMPUTER_IMAGE__;
export const PACKAGED_DEFAULT_GATEWAY_IMAGE = typeof __QUBICL_BUILD_DEFAULT_GATEWAY_IMAGE__ === 'undefined'
  ? 'qubicl/gateway:dev'
  : __QUBICL_BUILD_DEFAULT_GATEWAY_IMAGE__;

export const IMAGE_CATALOG: ImageCatalog = typeof __QUBICL_BUILD_IMAGE_CATALOG__ === 'undefined'
  ? createDevelopmentCatalog(QUBICL_BUILD.version, QUBICL_BUILD.revision)
  : ImageCatalogSchema.parse(JSON.parse(__QUBICL_BUILD_IMAGE_CATALOG__));

export const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const DEFAULT_GATEWAY_PORT = 3211;
export const DEFAULT_CPUS = 2;
export const DEFAULT_MEMORY = '4g';
export const STATE_FORMAT_VERSION = 3;
export const TRANSACTION_FORMAT_VERSION = 3;
export const DEFAULT_GATEWAY_IMAGE = process.env.QUBICL_DEFAULT_GATEWAY_IMAGE ?? PACKAGED_DEFAULT_GATEWAY_IMAGE;
/** Kept for source compatibility; new code should use the workstation catalog entry. */
export const DEFAULT_COMPUTER_IMAGE = process.env.QUBICL_DEFAULT_COMPUTER_IMAGE ?? PACKAGED_DEFAULT_COMPUTER_IMAGE;

const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const manifestSha = z.string().regex(/^[a-f0-9]{64}$/);
const domainPattern = z.string().min(1).max(253).regex(/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i, 'must be a DNS name or *.domain wildcard');

export const ImageIdentitySchema = z.strictObject({
  requested: z.string().min(1),
  resolved: z.string().min(1),
  contentId: sha256.optional(),
  manifestSha256: manifestSha.optional(),
});

export type ImageIdentity = z.infer<typeof ImageIdentitySchema>;

const resourceFields = {
  cpus: z.number().positive().superRefine((value, context) => {
    try { validateCpu(value); } catch (error) { context.addIssue({ code: 'custom', message: errorMessage(error) }); }
  }),
  memory: z.string().transform((value, context) => {
    try { return normalizeMemory(value); }
    catch (error) { context.addIssue({ code: 'custom', message: errorMessage(error) }); return z.NEVER; }
  }),
};

const contractFields = {
  preset: ConfigPresetSchema,
  compatibility: PresetSchema,
  image: ImageIdentitySchema,
  capabilityContractVersion: z.literal(CAPABILITY_CONTRACT_VERSION),
  capabilities: CapabilityListSchema,
  ...resourceFields,
};

function validateContract(value: {
  preset: ConfigPreset;
  compatibility: Preset;
  capabilities: Capability[];
  image: ImageIdentity;
}, context: z.RefinementCtx): void {
  if (value.preset !== 'custom' && value.preset !== value.compatibility) {
    context.addIssue({ code: 'custom', path: ['compatibility'], message: 'curated presets must use matching compatibility' });
  }
  const expected = capabilitiesForCompatibility(value.compatibility);
  if (JSON.stringify(value.capabilities) !== JSON.stringify(expected)) {
    context.addIssue({ code: 'custom', path: ['capabilities'], message: `capabilities must exactly match ${value.compatibility} compatibility` });
  }
  if (!value.image.manifestSha256) {
    context.addIssue({ code: 'custom', path: ['image', 'manifestSha256'], message: 'computer images require an expected manifest digest' });
  }
}

export const ComputerDefaultsSchema = z.strictObject(contractFields).superRefine(validateContract);
export type ComputerDefaults = z.infer<typeof ComputerDefaultsSchema>;

export const NetworkProfileSchema = z.enum(['developer', 'web-only', 'offline', 'custom']);
export type NetworkProfile = z.infer<typeof NetworkProfileSchema>;
export const NetworkPolicySchema = z.strictObject({
  profile: NetworkProfileSchema,
  allowDomains: z.array(domainPattern).max(256).default([]),
  denyDomains: z.array(domainPattern).max(256).default([]),
  temporaryApprovals: z.array(z.strictObject({ domain: domainPattern, expiresAt: z.iso.datetime() })).max(64).default([]),
});
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;

export const SshAccessSchema = z.strictObject({
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65_535),
  publicKey: z.string().min(32).max(16_384),
  fingerprint: z.string().min(8).max(256),
});
export type SshAccess = z.infer<typeof SshAccessSchema>;

export const ToolPolicySchema = z.array(ComputerToolNameSchema).superRefine((tools, context) => {
  if (new Set(tools).size !== tools.length) context.addIssue({ code: 'custom', message: 'tool policy entries must be unique' });
  for (const required of ['get_computer_status', 'acquire_lease', 'renew_lease', 'release_lease'] as const) {
    if (!tools.includes(required)) context.addIssue({ code: 'custom', message: `tool policy must retain ${required}` });
  }
});
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

export const CatalogSkillIdSchema = z.string().min(3).max(256).regex(/^(?:qubicl-core|imported)\/[a-z0-9][a-z0-9-]*$|^hermes-(?:default|optional)\/[a-z0-9][a-z0-9/-]*$/);
export const SkillPolicySchema = z.strictObject({
  enabledCatalogSkills: z.array(CatalogSkillIdSchema).max(199).superRefine((skills, context) => {
    if (new Set(skills).size !== skills.length) context.addIssue({ code: 'custom', message: 'enabled catalog skills must be unique' });
  }).transform(normalizeOperatorSkillIds),
});
export type SkillPolicy = z.infer<typeof SkillPolicySchema>;

export const ComputerConfigSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().regex(NAME_PATTERN, 'must be a lowercase Docker-safe name'),
  runtimeName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/, 'must be a Docker-safe runtime name no longer than 63 characters').optional(),
  createdAt: z.iso.datetime(),
  controlProtocolVersion: z.number().int().positive().optional(),
  network: NetworkPolicySchema.optional(),
  ssh: SshAccessSchema.optional(),
  environment: z.record(
    z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    z.string().max(8192),
  ).refine((value) => Object.keys(value).length <= 128, 'at most 128 environment entries are allowed').optional(),
  toolPolicy: ToolPolicySchema.optional(),
  skillPolicy: SkillPolicySchema.optional(),
  ...contractFields,
}).superRefine((value, context) => {
  validateContract(value, context);
  for (const key of Object.keys(value.environment ?? {})) {
    if (key.startsWith('QUBICL_') || ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LD_PRELOAD', 'NODE_OPTIONS'].includes(key)) {
      context.addIssue({ code: 'custom', path: ['environment', key], message: 'reserved environment name' });
    }
  }
});

export type ComputerConfig = z.infer<typeof ComputerConfigSchema>;

export const GatewayConfigSchema = z.strictObject({
  port: z.number().int().min(1).max(65535),
  image: ImageIdentitySchema.omit({ manifestSha256: true }),
});

const legacyComputerFields = {
  id: z.uuid(),
  name: z.string().regex(NAME_PATTERN, 'must be a lowercase Docker-safe name'),
  image: z.string().min(1),
  cpus: z.number().positive(),
  memory: z.string().regex(/^\d+(?:\.\d+)?[kmg]$/i),
  createdAt: z.iso.datetime(),
};

export const LegacyComputerConfigSchema = z.object(legacyComputerFields);
export type LegacyComputerConfig = z.infer<typeof LegacyComputerConfigSchema>;

const legacyConfigFields = {
  gatewayPort: z.number().int().min(1).max(65535),
  nextName: z.number().int().positive(),
  defaults: z.object({
    image: z.string().min(1),
    cpus: z.number().positive(),
    memory: z.string().regex(/^\d+(?:\.\d+)?[kmg]$/i),
  }),
  computers: z.array(LegacyComputerConfigSchema),
};

function validateConfigComputers(
  config: { computers: Array<{ id: string; name: string }> },
  context: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, computer] of config.computers.entries()) {
    if (ids.has(computer.id)) context.addIssue({ code: 'custom', path: ['computers', index, 'id'], message: 'computer IDs must be unique' });
    if (names.has(computer.name)) context.addIssue({ code: 'custom', path: ['computers', index, 'name'], message: 'computer names must be unique' });
    ids.add(computer.id);
    names.add(computer.name);
  }
}

export interface StateComputerIdMismatch {
  missingSecrets: string[];
  orphanSecrets: string[];
}

export function stateComputerIdMismatch(
  config: { computers: ReadonlyArray<{ id: string }> },
  secrets: { computers: Readonly<Record<string, unknown>> },
): StateComputerIdMismatch {
  const configIds = new Set(config.computers.map(({ id }) => id));
  const secretIds = new Set(Object.keys(secrets.computers));
  return {
    missingSecrets: [...configIds].filter((id) => !secretIds.has(id)).sort(),
    orphanSecrets: [...secretIds].filter((id) => !configIds.has(id)).sort(),
  };
}

export function assertStateComputerIdsMatch(
  config: { computers: ReadonlyArray<{ id: string }> },
  secrets: { computers: Readonly<Record<string, unknown>> },
): void {
  const { missingSecrets, orphanSecrets } = stateComputerIdMismatch(config, secrets);
  if (!missingSecrets.length && !orphanSecrets.length) return;
  throw new Error(
    `Config/secrets computer IDs do not match: missing secrets for IDs: ${missingSecrets.join(', ') || 'none'}; orphan secrets for IDs: ${orphanSecrets.join(', ') || 'none'}.`,
  );
}

export const LegacyConfigV1Schema = z.object({ version: z.literal(1), ...legacyConfigFields }).superRefine(validateConfigComputers);
export type LegacyQubiclConfigV1 = z.infer<typeof LegacyConfigV1Schema>;

export const LegacyConfigV2Schema = z.object({
  version: z.literal(2),
  installationId: z.uuid(),
  ...legacyConfigFields,
}).superRefine(validateConfigComputers);
export type LegacyQubiclConfigV2 = z.infer<typeof LegacyConfigV2Schema>;

export const ConfigSchema = z.strictObject({
  version: z.literal(STATE_FORMAT_VERSION),
  installationId: z.uuid(),
  gateway: GatewayConfigSchema,
  defaults: ComputerDefaultsSchema,
  nextName: z.number().int().positive(),
  computers: z.array(ComputerConfigSchema),
}).superRefine(validateConfigComputers);

export type QubiclConfig = z.infer<typeof ConfigSchema>;

const secretFields = {
  computers: z.record(z.uuid(), z.object({
    token: z.string().min(32),
    internalKey: z.string().min(32),
    brokerCredentials: z.array(z.strictObject({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
      baseUrl: z.url({ protocol: /^https$/ }).max(2048),
      pathPrefix: z.string().startsWith('/').max(2048),
      methods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])).min(1).max(5),
      header: z.string().regex(/^[A-Za-z0-9-]{1,80}$/),
      provider: z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('direct'), value: z.string().min(1).max(32_768) }),
        z.strictObject({ type: z.literal('environment'), name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) }),
        z.strictObject({ type: z.literal('file'), path: z.string().startsWith('/').max(4096) }),
        z.strictObject({ type: z.literal('secret-tool'), service: z.string().min(1).max(256), account: z.string().min(1).max(256) }),
        z.strictObject({ type: z.literal('macos-keychain'), service: z.string().min(1).max(256), account: z.string().min(1).max(256) }),
      ]),
      expiresAt: z.iso.datetime().optional(),
    })).max(64).optional(),
  })),
};

export const LegacySecretsV1Schema = z.object({ version: z.literal(1), ...secretFields });
export type LegacyQubiclSecretsV1 = z.infer<typeof LegacySecretsV1Schema>;
export const LegacySecretsV2Schema = z.object({ version: z.literal(2), ...secretFields });
export type LegacyQubiclSecretsV2 = z.infer<typeof LegacySecretsV2Schema>;
export const SecretsSchema = z.object({ version: z.literal(STATE_FORMAT_VERSION), ...secretFields });
export type QubiclSecrets = z.infer<typeof SecretsSchema>;

export const StateMigrationSchema = z.strictObject({
  version: z.literal(2),
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  sourceVersion: z.union([z.literal(1), z.literal(2)]),
  targetVersion: z.literal(STATE_FORMAT_VERSION),
  backupName: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  config: ConfigSchema,
  secrets: SecretsSchema,
}).superRefine((migration, context) => {
  const { missingSecrets, orphanSecrets } = stateComputerIdMismatch(migration.config, migration.secrets);
  if (!missingSecrets.length && !orphanSecrets.length) return;
  context.addIssue({
    code: 'custom',
    path: ['secrets', 'computers'],
    message: `must exactly match config computer IDs; missing: ${missingSecrets.join(', ') || 'none'}; orphan: ${orphanSecrets.join(', ') || 'none'}`,
  });
});
export type StateMigration = z.infer<typeof StateMigrationSchema>;

export const LegacyStateMigrationV2Schema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  sourceVersion: z.literal(1),
  targetVersion: z.literal(2),
  backupName: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  config: LegacyConfigV2Schema,
  secrets: LegacySecretsV2Schema,
});

export const MetadataSchema = ComputerConfigSchema.extend({ deletedAt: z.iso.datetime().optional() });
export type ComputerMetadata = z.infer<typeof MetadataSchema>;
export const LegacyMetadataV2Schema = LegacyComputerConfigSchema.extend({ deletedAt: z.iso.datetime().optional() });

export const TransactionOperationSchema = z.enum([
  'setup',
  'config',
  'create',
  'upgrade',
  'rename',
  'delete',
  'restore',
  'backup-restore',
  'token-rotate',
  'apply',
]);

const LegacyTransactionOperationSchema = z.enum([
  'init', 'config', 'create', 'rename', 'delete', 'restore', 'token-rotate', 'apply',
]);

export const TransactionCheckpointSchema = z.enum([
  'journal-written',
  'active-ready',
  'config-written',
  'state-written',
  'runtime-rendered',
  'trash-ready',
  'state-committed',
  'docker-validated',
  'images-ready',
  'gateway-ready',
  'routes-removed',
  'runtime-removed',
  'computers-started',
  'routes-verified',
  'runtime-committed',
]);

const ActiveTransactionEntrySchema = z.strictObject({
  source: z.enum(['active', 'create', 'trash', 'staged']),
  metadata: ComputerConfigSchema,
});
const TrashTransactionEntrySchema = z.strictObject({ metadata: MetadataSchema.required({ deletedAt: true }) });
const LegacyActiveTransactionEntrySchema = z.strictObject({ source: z.enum(['active', 'create', 'trash']), metadata: LegacyComputerConfigSchema });
const LegacyTrashTransactionEntrySchema = z.strictObject({ metadata: LegacyMetadataV2Schema.required({ deletedAt: true }) });

export const RuntimeContainerBindingSchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.string().min(1),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  role: z.enum(['gateway', 'computer', 'computer-executor', 'computer-egress', 'computer-web', 'computer-session', 'computer-ssh']),
  topologyVersion: z.string().min(1).optional(),
});

const runtimeFields = z.strictObject({
  ensureImages: z.boolean(),
  startGateway: z.boolean(),
  replaceGatewayRunning: z.boolean().default(false),
  replaceGatewayStopped: z.boolean().default(false),
  gatewayRuntimeBinding: z.array(RuntimeContainerBindingSchema).default([]),
  reconnectIds: z.array(z.uuid()).default([]),
  replaceIds: z.array(z.uuid()).default([]),
  replaceStoppedIds: z.array(z.uuid()).default([]),
  computerRuntimeBindings: z.record(z.uuid(), z.array(RuntimeContainerBindingSchema)).default({}),
  startIds: z.array(z.uuid()),
  removeIds: z.array(z.uuid()),
  verifyTokenIds: z.array(z.uuid()),
});

const transactionBase = {
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  phase: z.enum(['prepared', 'state-committed']),
  runtime: runtimeFields,
};

interface TransactionValidationValue {
  operation: string;
  config: { computers: Array<{ id: string }> };
  secrets: { computers: Record<string, { token: string; internalKey: string }> };
  active: Array<{ source: 'active' | 'create' | 'trash' | 'staged'; metadata: { id: string } }>;
  trash: Array<{ metadata: { id: string; deletedAt?: string } }>;
  runtime: {
    startGateway: boolean;
    replaceGatewayRunning: boolean;
    replaceGatewayStopped: boolean;
    gatewayRuntimeBinding: Array<{ name: string; id: string; status: string; imageId: string; role: string; topologyVersion?: string | undefined }>;
    reconnectIds: string[];
    replaceIds: string[];
    replaceStoppedIds: string[];
    computerRuntimeBindings: Record<string, Array<{ name: string; id: string; status: string; imageId: string; role: string; topologyVersion?: string | undefined }>>;
    startIds: string[];
    removeIds: string[];
    verifyTokenIds: string[];
  };
}

function validateStateTransaction(transaction: TransactionValidationValue, context: z.RefinementCtx): void {
  const configIds = new Set(transaction.config.computers.map(({ id }) => id));
  const secretIds = new Set(Object.keys(transaction.secrets.computers));
  const activeIds = new Set<string>();
  const trashIds = new Set<string>();
  for (const [index, entry] of transaction.active.entries()) {
    if (activeIds.has(entry.metadata.id)) context.addIssue({ code: 'custom', path: ['active', index, 'metadata', 'id'], message: 'active transaction IDs must be unique' });
    activeIds.add(entry.metadata.id);
    const expected = transaction.config.computers.find(({ id }) => id === entry.metadata.id);
    if (!expected || JSON.stringify(expected) !== JSON.stringify(entry.metadata)) {
      context.addIssue({ code: 'custom', path: ['active', index, 'metadata'], message: 'active metadata must exactly match the target config' });
    }
  }
  const staged = transaction.active.filter(({ source }) => source === 'staged');
  if (staged.length > 0 && (transaction.operation !== 'backup-restore' || staged.length !== 1)) {
    context.addIssue({ code: 'custom', path: ['active'], message: 'staged sources are reserved for one-computer backup restores' });
  }
  for (const [index, entry] of transaction.trash.entries()) {
    const id = entry.metadata.id;
    if (trashIds.has(id)) context.addIssue({ code: 'custom', path: ['trash', index, 'metadata', 'id'], message: 'trash transaction IDs must be unique' });
    if (configIds.has(id)) context.addIssue({ code: 'custom', path: ['trash', index, 'metadata', 'id'], message: 'trashed IDs cannot remain in the target config' });
    trashIds.add(id);
  }
  if (!sameSet(configIds, secretIds)) context.addIssue({ code: 'custom', path: ['secrets', 'computers'], message: 'target secrets must exactly match target computer IDs' });
  if (!sameSet(configIds, activeIds)) context.addIssue({ code: 'custom', path: ['active'], message: 'active transaction entries must exactly match target computer IDs' });
  validateRuntimeIds(transaction.runtime.reconnectIds, configIds, ['runtime', 'reconnectIds'], context);
  validateRuntimeIds(transaction.runtime.replaceIds, configIds, ['runtime', 'replaceIds'], context);
  validateRuntimeIds(transaction.runtime.replaceStoppedIds, configIds, ['runtime', 'replaceStoppedIds'], context);
  validateRuntimeIds(Object.keys(transaction.runtime.computerRuntimeBindings), configIds, ['runtime', 'computerRuntimeBindings'], context);
  validateRuntimeIds(transaction.runtime.startIds, configIds, ['runtime', 'startIds'], context);
  const mutuallyExclusiveIds = [
    ...transaction.runtime.reconnectIds,
    ...transaction.runtime.replaceIds,
    ...transaction.runtime.replaceStoppedIds,
    ...transaction.runtime.startIds,
  ];
  if (new Set(mutuallyExclusiveIds).size !== mutuallyExclusiveIds.length) {
    context.addIssue({ code: 'custom', path: ['runtime'], message: 'reconnectIds, replaceIds, and startIds must not overlap' });
  }
  if (transaction.runtime.replaceGatewayRunning && !transaction.runtime.startGateway) {
    context.addIssue({ code: 'custom', path: ['runtime', 'replaceGatewayRunning'], message: 'running gateway replacement requires startGateway' });
  }
  if (transaction.runtime.replaceGatewayRunning && transaction.runtime.replaceGatewayStopped) {
    context.addIssue({ code: 'custom', path: ['runtime'], message: 'running and stopped gateway replacement are mutually exclusive' });
  }
  if (transaction.runtime.startGateway && transaction.runtime.replaceGatewayStopped) {
    context.addIssue({ code: 'custom', path: ['runtime'], message: 'startGateway and stopped gateway replacement are mutually exclusive' });
  }
  if (transaction.runtime.gatewayRuntimeBinding.length > 1) {
    context.addIssue({ code: 'custom', path: ['runtime', 'gatewayRuntimeBinding'], message: 'gateway runtime binding may contain at most one container' });
  }
  if (transaction.runtime.gatewayRuntimeBinding.length > 0
    && !transaction.runtime.startGateway
    && !transaction.runtime.replaceGatewayStopped
    && transaction.runtime.replaceIds.length === 0) {
    context.addIssue({ code: 'custom', path: ['runtime', 'gatewayRuntimeBinding'], message: 'gateway runtime binding requires gateway or running-computer lifecycle work' });
  }
  const replacementIds = new Set([...transaction.runtime.replaceIds, ...transaction.runtime.replaceStoppedIds]);
  for (const [id, bindings] of Object.entries(transaction.runtime.computerRuntimeBindings)) {
    if (!replacementIds.has(id)) {
      context.addIssue({ code: 'custom', path: ['runtime', 'computerRuntimeBindings', id], message: 'computer runtime binding requires a matching replacement ID' });
    }
    if (new Set(bindings.map(({ name }) => name)).size !== bindings.length
      || new Set(bindings.map(({ id: containerId }) => containerId)).size !== bindings.length) {
      context.addIssue({ code: 'custom', path: ['runtime', 'computerRuntimeBindings', id], message: 'computer runtime binding names and IDs must be unique' });
    }
  }
  validateRuntimeIds(transaction.runtime.verifyTokenIds, configIds, ['runtime', 'verifyTokenIds'], context);
  validateRuntimeIds(transaction.runtime.removeIds, trashIds, ['runtime', 'removeIds'], context);
}

export const LegacyStateTransactionV1Schema = z.strictObject({
  version: z.literal(1),
  operation: LegacyTransactionOperationSchema,
  ...transactionBase,
  config: LegacyConfigV1Schema,
  secrets: LegacySecretsV1Schema,
  active: z.array(LegacyActiveTransactionEntrySchema),
  trash: z.array(LegacyTrashTransactionEntrySchema),
}).superRefine(validateStateTransaction);

export const LegacyStateTransactionV2Schema = z.strictObject({
  version: z.literal(2),
  operation: LegacyTransactionOperationSchema,
  ...transactionBase,
  config: LegacyConfigV2Schema,
  secrets: LegacySecretsV2Schema,
  active: z.array(LegacyActiveTransactionEntrySchema),
  trash: z.array(LegacyTrashTransactionEntrySchema),
}).superRefine(validateStateTransaction);

export const StateTransactionSchema = z.strictObject({
  version: z.literal(TRANSACTION_FORMAT_VERSION),
  operation: TransactionOperationSchema,
  ...transactionBase,
  config: ConfigSchema,
  secrets: SecretsSchema,
  active: z.array(ActiveTransactionEntrySchema),
  trash: z.array(TrashTransactionEntrySchema),
}).superRefine(validateStateTransaction);

export type StateTransaction = z.infer<typeof StateTransactionSchema>;
export type RuntimeContainerBinding = z.infer<typeof RuntimeContainerBindingSchema>;
export type TransactionOperation = z.infer<typeof TransactionOperationSchema>;
export type TransactionCheckpoint = z.infer<typeof TransactionCheckpointSchema>;

export function imageIdentity(requested: string, resolved = requested, manifestSha256?: string): ImageIdentity {
  return ImageIdentitySchema.parse({ requested, resolved, ...(manifestSha256 ? { manifestSha256 } : {}) });
}

export function catalogPlatformForHost(catalog: ImageCatalog = IMAGE_CATALOG): DockerPlatform {
  const architecture = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  const candidate = DockerPlatformSchema.safeParse(`linux/${architecture}`);
  return candidate.success && catalog.supportedPlatforms.includes(candidate.data) ? candidate.data : catalog.supportedPlatforms[0]!;
}

export function catalogImageIdentity(image: ImageCatalog['gateway'], platform = catalogPlatformForHost()): ImageIdentity {
  const variant = image.platforms[platform];
  if (!variant) throw new Error(`Image ${image.requested} is unavailable for ${platform}.`);
  return imageIdentity(image.requested, variant.resolved);
}

export function presetDefaults(preset: Preset, platform = catalogPlatformForHost(), catalog = IMAGE_CATALOG): ComputerDefaults {
  const entry = catalog.presets[preset];
  const variant = entry.image.platforms[platform];
  if (!variant) throw new Error(`Preset ${preset} is unavailable for ${platform}.`);
  return ComputerDefaultsSchema.parse({
    preset,
    compatibility: preset,
    image: imageIdentity(entry.image.requested, variant.resolved, entry.manifestSha256),
    capabilityContractVersion: CAPABILITY_CONTRACT_VERSION,
    capabilities: entry.capabilities,
    cpus: entry.recommendedCpus,
    memory: entry.recommendedMemory,
  });
}

function legacyContract(image: string): Omit<ComputerDefaults, 'cpus' | 'memory'> {
  const workstation = presetDefaults('workstation');
  const knownFullImages = new Set([
    'qubicl/computer:dev',
    'qubicl/workstation:dev',
    PACKAGED_DEFAULT_COMPUTER_IMAGE,
    workstation.image.requested,
    workstation.image.resolved,
  ]);
  const curated = knownFullImages.has(image);
  return {
    preset: curated ? 'workstation' : 'custom',
    compatibility: 'workstation',
    image: imageIdentity(image, image, workstation.image.manifestSha256),
    capabilityContractVersion: CAPABILITY_CONTRACT_VERSION,
    capabilities: capabilitiesForCompatibility('workstation'),
  };
}

export function migrateComputerV2(computer: LegacyComputerConfig): ComputerConfig {
  return ComputerConfigSchema.parse({
    id: computer.id,
    name: computer.name,
    createdAt: computer.createdAt,
    ...legacyContract(computer.image),
    cpus: computer.cpus,
    memory: computer.memory,
  });
}

export function migrateMetadataV2(metadata: z.infer<typeof LegacyMetadataV2Schema>): ComputerMetadata {
  return MetadataSchema.parse({ ...migrateComputerV2(metadata), ...(metadata.deletedAt ? { deletedAt: metadata.deletedAt } : {}) });
}

export function parseComputerMetadataDocument(value: unknown): { metadata: ComputerMetadata; migrated: boolean } {
  const current = MetadataSchema.safeParse(value);
  if (current.success) return { metadata: current.data, migrated: false };
  const legacy = LegacyMetadataV2Schema.safeParse(value);
  if (!legacy.success) throw current.error;
  return { metadata: migrateMetadataV2(legacy.data), migrated: true };
}

export function migrateConfigV2(config: LegacyQubiclConfigV2): QubiclConfig {
  return ConfigSchema.parse({
    version: STATE_FORMAT_VERSION,
    installationId: config.installationId,
    gateway: { port: config.gatewayPort, image: catalogImageIdentity(IMAGE_CATALOG.gateway) },
    defaults: { ...legacyContract(config.defaults.image), cpus: config.defaults.cpus, memory: config.defaults.memory },
    nextName: config.nextName,
    computers: config.computers.map(migrateComputerV2),
  });
}

export function migrateConfigV1(config: LegacyQubiclConfigV1, installationId: string = randomUUID()): QubiclConfig {
  const { version: _version, ...fields } = LegacyConfigV1Schema.parse(config);
  return migrateConfigV2(LegacyConfigV2Schema.parse({ version: 2, installationId, ...fields }));
}

export function migrateSecretsV2(secrets: LegacyQubiclSecretsV2): QubiclSecrets {
  return SecretsSchema.parse({ version: STATE_FORMAT_VERSION, computers: secrets.computers });
}

export function migrateSecretsV1(secrets: LegacyQubiclSecretsV1): QubiclSecrets {
  return SecretsSchema.parse({ version: STATE_FORMAT_VERSION, computers: secrets.computers });
}

export function parseStateTransactionDocument(value: unknown): { transaction: StateTransaction; migrated: boolean; sourceVersion?: number } {
  const current = StateTransactionSchema.safeParse(value);
  if (current.success) return { transaction: current.data, migrated: false };
  const v2 = LegacyStateTransactionV2Schema.safeParse(value);
  if (v2.success) return { transaction: migrateLegacyTransaction(v2.data, 2), migrated: true, sourceVersion: 2 };
  const v1 = LegacyStateTransactionV1Schema.safeParse(value);
  if (v1.success) return { transaction: migrateLegacyTransaction(v1.data, 1), migrated: true, sourceVersion: 1 };
  throw current.error;
}

function migrateLegacyTransaction(
  legacy: z.infer<typeof LegacyStateTransactionV1Schema> | z.infer<typeof LegacyStateTransactionV2Schema>,
  version: 1 | 2,
): StateTransaction {
  const installationId = version === 1 ? legacy.id : (legacy.config as LegacyQubiclConfigV2).installationId;
  const config = version === 1
    ? migrateConfigV1(legacy.config as LegacyQubiclConfigV1, installationId)
    : migrateConfigV2(legacy.config as LegacyQubiclConfigV2);
  const secrets = version === 1
    ? migrateSecretsV1(legacy.secrets as LegacyQubiclSecretsV1)
    : migrateSecretsV2(legacy.secrets as LegacyQubiclSecretsV2);
  return StateTransactionSchema.parse({
    version: TRANSACTION_FORMAT_VERSION,
    id: legacy.id,
    operation: legacy.operation === 'init' ? 'setup' : legacy.operation,
    createdAt: legacy.createdAt,
    phase: legacy.phase,
    config,
    secrets,
    active: legacy.active.map((entry) => ({ source: entry.source, metadata: migrateComputerV2(entry.metadata) })),
    trash: legacy.trash.map((entry) => ({ metadata: migrateMetadataV2(entry.metadata) })),
    runtime: legacy.runtime,
  });
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function validateRuntimeIds(values: string[], allowed: Set<string>, path: string[], context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) context.addIssue({ code: 'custom', path: [...path, index], message: 'runtime IDs must be unique' });
    if (!allowed.has(value)) context.addIssue({ code: 'custom', path: [...path, index], message: 'runtime ID is not part of the corresponding transaction set' });
    seen.add(value);
  }
}

const manifestComputerFields = {
  name: z.string().regex(NAME_PATTERN),
  preset: ConfigPresetSchema,
  compatibility: PresetSchema,
  image: ImageIdentitySchema,
  capabilityContractVersion: z.literal(CAPABILITY_CONTRACT_VERSION),
  capabilities: CapabilityListSchema,
  ...resourceFields,
};

export const ManifestSchema = z.strictObject({
  version: z.literal(2),
  gateway: GatewayConfigSchema,
  defaults: ComputerDefaultsSchema,
  computers: z.array(z.strictObject(manifestComputerFields).superRefine(validateContract)),
});
export type QubiclManifest = z.infer<typeof ManifestSchema>;

export const LegacyManifestV1Schema = z.strictObject({
  version: z.literal(1),
  gateway: z.strictObject({ port: z.number().int().min(1).max(65535) }),
  computers: z.array(z.strictObject({
    name: z.string().regex(NAME_PATTERN),
    image: z.string().min(1).optional(),
    cpus: z.number().positive().optional(),
    memory: z.string().regex(/^\d+(?:\.\d+)?[kmg]$/i).optional(),
  })),
});

export function parseManifestDocument(value: unknown, fallback: QubiclConfig = defaultConfig()): { manifest: QubiclManifest; migrated: boolean } {
  const current = ManifestSchema.safeParse(value);
  if (current.success) return { manifest: current.data, migrated: false };
  const legacy = LegacyManifestV1Schema.safeParse(value);
  if (!legacy.success) throw current.error;
  return {
    migrated: true,
    manifest: ManifestSchema.parse({
      version: 2,
      gateway: { port: legacy.data.gateway.port, image: fallback.gateway.image },
      defaults: fallback.defaults,
      computers: legacy.data.computers.map((computer) => {
        const contract = computer.image ? legacyContract(computer.image) : fallback.defaults;
        return {
          name: computer.name,
          preset: contract.preset,
          compatibility: contract.compatibility,
          image: contract.image,
          capabilityContractVersion: contract.capabilityContractVersion,
          capabilities: contract.capabilities,
          cpus: computer.cpus ?? fallback.defaults.cpus,
          memory: computer.memory ?? fallback.defaults.memory,
        };
      }),
    }),
  };
}

export interface ManifestReconciliation {
  creates: QubiclManifest['computers'];
  updates: QubiclManifest['computers'];
  trashes: ComputerConfig[];
  gatewayChanged: boolean;
  defaultsChanged: boolean;
}

export function defaultConfig(): QubiclConfig {
  return ConfigSchema.parse({
    version: STATE_FORMAT_VERSION,
    installationId: randomUUID(),
    gateway: { port: DEFAULT_GATEWAY_PORT, image: catalogImageIdentity(IMAGE_CATALOG.gateway) },
    defaults: presetDefaults('workstation'),
    nextName: 1,
    computers: [],
  });
}

export function defaultSecrets(): QubiclSecrets {
  return { version: STATE_FORMAT_VERSION, computers: {} };
}

export function assertValidName(name: string): string {
  if (!NAME_PATTERN.test(name)) throw new Error(`Invalid computer name ${JSON.stringify(name)}; use lowercase letters, numbers, and hyphens.`);
  return name;
}

export function allocateName(config: QubiclConfig): string {
  const used = new Set(config.computers.map(({ name }) => name));
  while (used.has(`qubicl-${config.nextName}`)) config.nextName += 1;
  const name = `qubicl-${config.nextName}`;
  config.nextName += 1;
  return name;
}

export function reconcileManifest(config: QubiclConfig, manifest: QubiclManifest, prune: boolean): ManifestReconciliation {
  const names = new Set<string>();
  for (const declared of manifest.computers) {
    if (names.has(declared.name)) throw new Error(`Manifest declares ${declared.name} more than once.`);
    names.add(declared.name);
  }
  const creates = manifest.computers.filter(({ name }) => !config.computers.some((computer) => computer.name === name));
  const updates = manifest.computers.filter((declared) => {
    const current = config.computers.find(({ name }) => name === declared.name);
    if (!current) return false;
    const comparable = ({ name, preset, compatibility, image, capabilityContractVersion, capabilities, cpus, memory }: typeof declared) => ({
      name,
      preset,
      compatibility,
      image,
      capabilityContractVersion,
      capabilities,
      cpus,
      memory,
    });
    return JSON.stringify(comparable(current)) !== JSON.stringify(comparable(declared));
  });
  const trashes = prune ? config.computers.filter(({ name }) => !names.has(name)) : [];
  return {
    creates,
    updates,
    trashes,
    gatewayChanged: JSON.stringify(config.gateway) !== JSON.stringify(manifest.gateway),
    defaultsChanged: JSON.stringify(config.defaults) !== JSON.stringify(manifest.defaults),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
