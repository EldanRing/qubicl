import { createHash } from 'node:crypto';
import {
  CAPABILITY_CONTRACT_VERSION,
  ComputerDefaultsSchema,
  IMAGE_CATALOG,
  PRESET_DEFINITIONS,
  PresetSchema,
  assertValidName,
  capabilitiesForCompatibility,
  canonicalJson,
  catalogImageIdentity,
  catalogPlatformForHost,
  imageIdentity,
  memoryBytes,
  presetDefaults,
  validateCpu,
  validateMemory,
  type ComputerDefaults,
  type DockerPlatform,
  type ImageCatalog,
  type Preset,
  type QubiclConfig,
} from '@qubicl/core';

export interface SetupSnapshot {
  initialized: boolean;
  installationId?: string;
  configDigest?: string;
  config?: QubiclConfig;
}

export interface SetupSelections {
  preset?: Preset;
  image?: string;
  cpus?: number;
  memory?: string;
  gatewayPort?: number;
  createName?: string | null;
  start?: boolean;
  offline?: boolean;
  allowUnsupportedResources?: boolean;
}

export interface SetupPlan {
  snapshot: SetupSnapshot;
  firstRun: boolean;
  platform: DockerPlatform;
  selected: { kind: 'preset'; preset: Preset } | { kind: 'custom'; image: string };
  proposedDefault: ComputerDefaults;
  gateway: { port: number; image: ReturnType<typeof catalogImageIdentity> };
  createName: string | null;
  start: boolean;
  offline: boolean;
  recommendation: { cpus: number; memory: string };
  unsupportedResources: boolean;
  warnings: string[];
  gatewayDownloadBytes: number | null;
  gatewayExpandedBytes: number | null;
  computerDownloadBytes: number | null;
  computerExpandedBytes: number | null;
  downloadBytes: number | null;
  expandedBytes: number | null;
}

export function snapshotSetup(config?: QubiclConfig): SetupSnapshot {
  if (!config) return { initialized: false };
  return {
    initialized: true,
    installationId: config.installationId,
    configDigest: configDigest(config),
    config: structuredClone(config),
  };
}

export function configDigest(config: QubiclConfig): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
}

export function sameSetupSnapshot(expected: SetupSnapshot, actual?: QubiclConfig): boolean {
  if (!expected.initialized) return actual === undefined;
  return Boolean(actual
    && actual.installationId === expected.installationId
    && configDigest(actual) === expected.configDigest);
}

export function buildSetupPlan(
  snapshot: SetupSnapshot,
  selections: SetupSelections,
  catalog: ImageCatalog = IMAGE_CATALOG,
  platform: DockerPlatform = catalogPlatformForHost(catalog),
  capacity?: { cpus: number; memoryBytes: number },
): SetupPlan {
  if (selections.preset && selections.image) throw new Error('--preset and --image are mutually exclusive.');
  if (!selections.preset && !selections.image) throw new Error('Setup requires an explicit preset or custom image selection.');
  if (selections.createName === undefined) throw new Error('Setup must explicitly choose whether to create a computer.');
  if (selections.createName !== null) {
    assertValidName(selections.createName);
    if (snapshot.config?.computers.some(({ name }) => name === selections.createName)) {
      throw new Error(`Computer ${selections.createName} already exists.`);
    }
  }
  if (selections.start === false && selections.createName === null) throw new Error('--no-start is valid only when creating a computer.');
  if (selections.gatewayPort !== undefined && (!Number.isInteger(selections.gatewayPort) || selections.gatewayPort < 1 || selections.gatewayPort > 65535)) {
    throw new Error('Gateway port must be an integer from 1 through 65535.');
  }
  if (!catalog.supportedPlatforms.includes(platform)) throw new Error(`The setup catalog does not support ${platform}.`);

  const selected = selections.preset
    ? { kind: 'preset' as const, preset: PresetSchema.parse(selections.preset) }
    : { kind: 'custom' as const, image: selections.image! };
  const retainedCustom = selected.kind === 'custom'
    && snapshot.config?.defaults.preset === 'custom'
    && snapshot.config.defaults.image.requested === selected.image
    ? snapshot.config.defaults
    : undefined;
  const conservativePreset = selected.kind === 'preset'
    ? selected.preset
    : retainedCustom?.compatibility ?? 'workstation';
  const recommendation = PRESET_DEFINITIONS[conservativePreset];
  const base = selected.kind === 'preset'
    ? presetDefaults(selected.preset, platform, catalog)
    : retainedCustom
      ? structuredClone(retainedCustom)
    : ComputerDefaultsSchema.parse({
      preset: 'custom',
      compatibility: 'workstation',
      image: imageIdentity(selected.image, selected.image, catalog.presets.workstation.manifestSha256),
      capabilityContractVersion: CAPABILITY_CONTRACT_VERSION,
      capabilities: capabilitiesForCompatibility('workstation'),
      cpus: recommendation.cpus,
      memory: recommendation.memory,
    });
  const cpus = validateCpu(selections.cpus ?? base.cpus, capacity?.cpus);
  const memory = validateMemory(selections.memory ?? base.memory, capacity?.memoryBytes);
  const unsupportedResources = cpus < recommendation.cpus || memoryBytes(memory) < memoryBytes(recommendation.memory);
  if (unsupportedResources && !selections.allowUnsupportedResources) {
    throw new Error(`Selected resources are below the tested ${conservativePreset} recommendation (${recommendation.cpus} CPU / ${recommendation.memory}); explicit unsupported-resource approval is required.`);
  }
  const variant = selected.kind === 'preset' ? catalog.presets[selected.preset].image.platforms[platform] : undefined;
  const gatewayVariant = catalog.gateway.platforms[platform];
  const total = (left: number | null | undefined, right: number | null | undefined): number | null => (
    left === null || left === undefined || right === null || right === undefined ? null : left + right
  );
  const warnings: string[] = [];
  if (selected.kind === 'custom') warnings.push('A custom image can access this computer\'s durable home and normal outbound network. Compatibility is validated after acquisition.');
  if (unsupportedResources) warnings.push(`Resources are below the tested ${conservativePreset} recommendation.`);
  return {
    snapshot,
    firstRun: !snapshot.initialized,
    platform,
    selected,
    proposedDefault: ComputerDefaultsSchema.parse({ ...base, cpus, memory }),
    gateway: {
      port: selections.gatewayPort ?? snapshot.config?.gateway.port ?? 3211,
      image: catalogImageIdentity(catalog.gateway, platform),
    },
    createName: selections.createName,
    start: selections.start ?? true,
    offline: selections.offline ?? false,
    recommendation: { cpus: recommendation.cpus, memory: recommendation.memory },
    unsupportedResources,
    warnings,
    gatewayDownloadBytes: gatewayVariant?.downloadBytes ?? null,
    gatewayExpandedBytes: gatewayVariant?.expandedBytes ?? null,
    computerDownloadBytes: variant?.downloadBytes ?? null,
    computerExpandedBytes: variant?.expandedBytes ?? null,
    downloadBytes: total(gatewayVariant?.downloadBytes, variant?.downloadBytes),
    expandedBytes: total(gatewayVariant?.expandedBytes, variant?.expandedBytes),
  };
}
