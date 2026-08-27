import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CURATED_PRESETS = ['file-system', 'browser', 'computer', 'workstation'] as const;
export const PresetSchema = z.enum(CURATED_PRESETS);
export type Preset = z.infer<typeof PresetSchema>;

export const CONFIG_PRESETS = [...CURATED_PRESETS, 'custom'] as const;
export const ConfigPresetSchema = z.enum(CONFIG_PRESETS);
export type ConfigPreset = z.infer<typeof ConfigPresetSchema>;

export const CAPABILITY_IDS = [
  'shell',
  'process',
  'files',
  'desktop',
  'viewer',
  'browser',
  'desktop-apps',
  'development',
  'office',
] as const;
export const CapabilitySchema = z.enum(CAPABILITY_IDS);
export type Capability = z.infer<typeof CapabilitySchema>;

export const STARTUP_PROFILES = ['file-system', 'browser', 'desktop', 'workstation'] as const;
export const StartupProfileSchema = z.enum(STARTUP_PROFILES);
export type StartupProfile = z.infer<typeof StartupProfileSchema>;

export const VIEWER_AUTHENTICATION_HEADER_V1 = 'header-v1' as const;
export const ViewerAuthenticationSchema = z.literal(VIEWER_AUTHENTICATION_HEADER_V1);
export type ViewerAuthentication = z.infer<typeof ViewerAuthenticationSchema>;

export const CAPABILITY_CONTRACT_VERSION = 1;
export const CONTROL_PROTOCOL_VERSION = 10;

export interface PresetDefinition {
  id: Preset;
  purpose: string;
  description: string;
  viewer: boolean;
  viewerAuthentication?: ViewerAuthentication;
  capabilities: Capability[];
  cpus: number;
  memory: string;
  pidsLimit: number;
  shmSize?: string;
  startupBudgetSeconds: number;
  startupProfile: StartupProfile;
}

const baseCapabilities: Capability[] = ['shell', 'process', 'files'];
const displayCapabilities: Capability[] = [...baseCapabilities, 'desktop', 'viewer', 'browser'];

export const PRESET_DEFINITIONS: Readonly<Record<Preset, PresetDefinition>> = {
  'file-system': {
    id: 'file-system',
    purpose: 'Headless terminal, file, Git, process, script, and repository work',
    description: 'A lightweight command-line computer without browser or display assets.',
    viewer: false,
    capabilities: baseCapabilities,
    cpus: 1,
    memory: '512m',
    pidsLimit: 256,
    startupBudgetSeconds: 30,
    startupProfile: 'file-system',
  },
  browser: {
    id: 'browser',
    purpose: 'Browser automation and human viewing',
    description: 'Chromium in a minimal Openbox session with OCR, document inspection, viewer, and desktop control.',
    viewer: true,
    viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1,
    capabilities: displayCapabilities,
    cpus: 2,
    memory: '2g',
    pidsLimit: 768,
    shmSize: '1g',
    startupBudgetSeconds: 90,
    startupProfile: 'browser',
  },
  computer: {
    id: 'computer',
    purpose: 'Lightweight general-purpose graphical computer',
    description: 'Chromium, a selected XFCE desktop, document helpers, text editing, file management, and managed SSH.',
    viewer: true,
    viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1,
    capabilities: [...displayCapabilities, 'desktop-apps'],
    cpus: 2,
    memory: '3g',
    pidsLimit: 1024,
    shmSize: '1g',
    startupBudgetSeconds: 120,
    startupProfile: 'desktop',
  },
  workstation: {
    id: 'workstation',
    purpose: 'Full development and office environment',
    description: 'The broad desktop with developer tools, document helpers, Python, LibreOffice, and managed SSH.',
    viewer: true,
    viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1,
    capabilities: [...displayCapabilities, 'desktop-apps', 'development', 'office'],
    cpus: 2,
    memory: '4g',
    pidsLimit: 1024,
    shmSize: '1g',
    startupBudgetSeconds: 180,
    startupProfile: 'workstation',
  },
};

export const COMPUTER_TOOL_NAMES = [
  'get_computer_status',
  'acquire_lease',
  'renew_lease',
  'release_lease',
  'exec_command',
  'write_stdin',
  'stop_process',
  'list_ports',
  'publish_port',
  'list_previews',
  'unpublish_port',
  'broker_request',
  'skills_list',
  'skill_view',
  'skill_manage',
  'web_search',
  'web_extract',
  'list_files',
  'get_file_info',
  'read_file',
  'write_file',
  'edit_file',
  'copy_path',
  'move_path',
  'delete_path',
  'take_screenshot',
  'control_computer',
  'browser_navigate',
  'browser_snapshot',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_press',
  'browser_scroll',
  'browser_history',
  'browser_wait',
  'browser_tabs',
  'browser_use_tab',
  'browser_new_tab',
  'browser_close_tab',
  'browser_reset',
  'browser_click_at',
  'browser_double_click_at',
  'browser_hover_at',
  'browser_drag',
  'browser_scroll_at',
  'browser_type_focused',
  'browser_inspect_at',
  'browser_computer',
  'read_clipboard',
  'write_clipboard',
  'open_desktop_application',
  'list_desktop_applications',
  'close_desktop_application',
] as const;
export const ComputerToolNameSchema = z.enum(COMPUTER_TOOL_NAMES);
export type ComputerToolName = z.infer<typeof ComputerToolNameSchema>;

const baseToolNames: ComputerToolName[] = [
  'get_computer_status',
  'acquire_lease',
  'renew_lease',
  'release_lease',
  'exec_command',
  'write_stdin',
  'stop_process',
  'list_ports',
  'publish_port',
  'list_previews',
  'unpublish_port',
  'broker_request',
  'skills_list',
  'skill_view',
  'skill_manage',
  'web_search',
  'web_extract',
  'list_files',
  'get_file_info',
  'read_file',
  'write_file',
  'edit_file',
  'copy_path',
  'move_path',
  'delete_path',
];
const desktopToolNames: ComputerToolName[] = ['take_screenshot', 'control_computer'];
const browserToolNames: ComputerToolName[] = [
  'browser_navigate',
  'browser_snapshot',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_press',
  'browser_scroll',
  'browser_history',
  'browser_wait',
  'browser_tabs',
  'browser_use_tab',
  'browser_new_tab',
  'browser_close_tab',
  'browser_reset',
  'browser_click_at',
  'browser_double_click_at',
  'browser_hover_at',
  'browser_drag',
  'browser_scroll_at',
  'browser_type_focused',
  'browser_inspect_at',
  'browser_computer',
];
const clipboardToolNames: ComputerToolName[] = ['read_clipboard', 'write_clipboard'];
const desktopApplicationToolNames: ComputerToolName[] = ['open_desktop_application', 'list_desktop_applications', 'close_desktop_application'];

export function toolsForCapabilities(capabilities: readonly Capability[]): ComputerToolName[] {
  return [
    ...baseToolNames,
    ...(capabilities.includes('desktop') ? desktopToolNames : []),
    ...(capabilities.includes('browser') ? browserToolNames : []),
    ...(capabilities.includes('desktop') ? clipboardToolNames : []),
    ...(capabilities.includes('desktop-apps') ? desktopApplicationToolNames : []),
  ];
}

export function capabilitiesForCompatibility(compatibility: Preset): Capability[] {
  return [...PRESET_DEFINITIONS[compatibility].capabilities];
}

export function viewerForCapabilities(capabilities: readonly Capability[]): boolean {
  return capabilities.includes('viewer');
}

export function browserForCompatibility(compatibility: Preset): boolean {
  return PRESET_DEFINITIONS[compatibility].capabilities.includes('browser');
}

export function managedSshForCompatibility(compatibility: Preset): boolean {
  return compatibility === 'computer' || compatibility === 'workstation';
}

function sortedUniqueCapabilities(value: Capability[], context: z.RefinementCtx): void {
  const expected = CAPABILITY_IDS.filter((capability) => value.includes(capability));
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    context.addIssue({ code: 'custom', message: 'capabilities must be unique and in canonical order' });
  }
}

export const CapabilityListSchema = z.array(CapabilitySchema).superRefine(sortedUniqueCapabilities);

export const ComputerManifestSchema = z.strictObject({
  schemaVersion: z.literal(CAPABILITY_CONTRACT_VERSION),
  preset: PresetSchema,
  compatibility: PresetSchema,
  capabilities: CapabilityListSchema,
  tools: z.array(ComputerToolNameSchema),
  viewer: z.boolean(),
  controlProtocolVersion: z.literal(CONTROL_PROTOCOL_VERSION),
  qubiclVersion: z.string().min(1),
  revision: z.string().min(1),
  startupProfile: StartupProfileSchema,
}).superRefine((manifest, context) => {
  if (manifest.preset !== manifest.compatibility) {
    context.addIssue({ code: 'custom', path: ['compatibility'], message: 'curated image manifests must use matching preset and compatibility' });
  }
  const expectedCapabilities = capabilitiesForCompatibility(manifest.compatibility);
  if (JSON.stringify(manifest.capabilities) !== JSON.stringify(expectedCapabilities)) {
    context.addIssue({ code: 'custom', path: ['capabilities'], message: `capabilities do not match ${manifest.compatibility} compatibility` });
  }
  const expectedTools = toolsForCapabilities(manifest.capabilities);
  if (JSON.stringify(manifest.tools) !== JSON.stringify(expectedTools)) {
    context.addIssue({ code: 'custom', path: ['tools'], message: 'tools do not match declared capabilities' });
  }
  if (manifest.viewer !== viewerForCapabilities(manifest.capabilities)) {
    context.addIssue({ code: 'custom', path: ['viewer'], message: 'viewer does not match declared capabilities' });
  }
  const expectedStartupProfile = PRESET_DEFINITIONS[manifest.compatibility].startupProfile;
  if (manifest.startupProfile !== expectedStartupProfile) {
    context.addIssue({ code: 'custom', path: ['startupProfile'], message: `startup profile does not match ${manifest.compatibility} compatibility` });
  }
});

export type ComputerManifest = z.infer<typeof ComputerManifestSchema>;

export function buildComputerManifest(preset: Preset, version: string, revision: string): ComputerManifest {
  const definition = PRESET_DEFINITIONS[preset];
  return ComputerManifestSchema.parse({
    schemaVersion: CAPABILITY_CONTRACT_VERSION,
    preset,
    compatibility: preset,
    capabilities: definition.capabilities,
    tools: toolsForCapabilities(definition.capabilities),
    viewer: definition.viewer,
    controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
    qubiclVersion: version,
    revision,
    startupProfile: definition.startupProfile,
  });
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function manifestSha256(manifest: ComputerManifest): string {
  return createHash('sha256').update(canonicalJson(ComputerManifestSchema.parse(manifest))).digest('hex');
}

export const DockerPlatformSchema = z.enum(['linux/amd64', 'linux/arm64']);
export type DockerPlatform = z.infer<typeof DockerPlatformSchema>;

const bytes = z.number().int().nonnegative().nullable();
const contentDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const CatalogPlatformImageSchema = z.strictObject({
  resolved: z.string().min(1),
  digest: contentDigest.optional(),
  downloadBytes: bytes,
  expandedBytes: bytes,
});

export const CatalogImageSchema = z.strictObject({
  requested: z.string().min(1),
  indexDigest: contentDigest.optional(),
  platforms: z.record(DockerPlatformSchema, CatalogPlatformImageSchema),
});

export const PresetCatalogEntrySchema = z.strictObject({
  id: PresetSchema,
  purpose: z.string().min(1),
  description: z.string().min(1),
  capabilities: CapabilityListSchema,
  viewer: z.boolean(),
  viewerAuthentication: ViewerAuthenticationSchema.optional(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  image: CatalogImageSchema,
  recommendedCpus: z.number().positive(),
  recommendedMemory: z.string().regex(/^\d+(?:\.\d+)?[kmg]$/i),
  pidsLimit: z.number().int().positive(),
  shmSize: z.string().regex(/^\d+(?:\.\d+)?[kmg]$/i).optional(),
  startupBudgetSeconds: z.number().int().positive(),
});

export const ImageCatalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  releaseVersion: z.string().min(1),
  development: z.boolean(),
  source: z.string().url(),
  revision: z.string().min(1),
  supportedPlatforms: z.array(DockerPlatformSchema).min(1),
  gateway: CatalogImageSchema,
  presets: z.record(PresetSchema, PresetCatalogEntrySchema),
}).superRefine((catalog, context) => {
  for (const platform of catalog.supportedPlatforms) {
    validateCatalogImage(catalog.gateway, platform, catalog.development, ['gateway'], context);
    for (const preset of CURATED_PRESETS) {
      const entry = catalog.presets[preset];
      if (!entry) {
        context.addIssue({ code: 'custom', path: ['presets', preset], message: `catalog is missing ${preset}` });
        continue;
      }
      validateCatalogImage(entry.image, platform, catalog.development, ['presets', preset, 'image'], context);
      const definition = PRESET_DEFINITIONS[preset];
      if (entry.id !== preset
        || JSON.stringify(entry.capabilities) !== JSON.stringify(definition.capabilities)
        || entry.viewer !== definition.viewer
        || entry.viewerAuthentication !== definition.viewerAuthentication
        || entry.recommendedCpus !== definition.cpus
        || entry.recommendedMemory !== definition.memory
        || entry.pidsLimit !== definition.pidsLimit
        || entry.shmSize !== definition.shmSize
        || entry.startupBudgetSeconds !== definition.startupBudgetSeconds) {
        context.addIssue({ code: 'custom', path: ['presets', preset], message: `${preset} catalog policy does not match the built-in contract` });
      }
    }
  }
});

export type ImageCatalog = z.infer<typeof ImageCatalogSchema>;

function validateCatalogImage(
  image: z.infer<typeof CatalogImageSchema>,
  platform: DockerPlatform,
  development: boolean,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  const variant = image.platforms[platform];
  if (!variant) {
    context.addIssue({ code: 'custom', path: [...path, 'platforms', platform], message: `image has no ${platform} variant` });
    return;
  }
  if (development) return;
  if (!image.indexDigest) context.addIssue({ code: 'custom', path: [...path, 'indexDigest'], message: 'release images require an index digest' });
  if (!variant.digest) context.addIssue({ code: 'custom', path: [...path, 'platforms', platform, 'digest'], message: 'release variants require a platform digest' });
  if (image.indexDigest && !variant.resolved.endsWith(`@${image.indexDigest}`)) {
    context.addIssue({ code: 'custom', path: [...path, 'platforms', platform, 'resolved'], message: 'release resolved reference must use its multi-platform index digest' });
  }
  if (variant.downloadBytes === null || variant.expandedBytes === null) {
    context.addIssue({ code: 'custom', path: [...path, 'platforms', platform], message: 'release variants require measured sizes' });
  }
}

export function createDevelopmentCatalog(version = 'development', revision = 'unknown'): ImageCatalog {
  const platforms: DockerPlatform[] = ['linux/amd64', 'linux/arm64'];
  const image = (requested: string) => ({
    requested,
    platforms: Object.fromEntries(platforms.map((platform) => [platform, {
      resolved: requested,
      downloadBytes: null,
      expandedBytes: null,
    }])) as Record<DockerPlatform, z.infer<typeof CatalogPlatformImageSchema>>,
  });
  const developmentNames: Record<Preset, string> = {
    'file-system': 'qubicl/file-system:dev',
    browser: 'qubicl/browser:dev',
    computer: 'qubicl/desktop:dev',
    workstation: 'qubicl/workstation:dev',
  };
  const presets = Object.fromEntries(CURATED_PRESETS.map((preset) => {
    const definition = PRESET_DEFINITIONS[preset];
    const manifest = buildComputerManifest(preset, version, revision);
    return [preset, {
      id: preset,
      purpose: definition.purpose,
      description: definition.description,
      capabilities: definition.capabilities,
      viewer: definition.viewer,
      ...(definition.viewerAuthentication ? { viewerAuthentication: definition.viewerAuthentication } : {}),
      manifestSha256: manifestSha256(manifest),
      image: image(developmentNames[preset]),
      recommendedCpus: definition.cpus,
      recommendedMemory: definition.memory,
      pidsLimit: definition.pidsLimit,
      ...(definition.shmSize ? { shmSize: definition.shmSize } : {}),
      startupBudgetSeconds: definition.startupBudgetSeconds,
    }];
  }));
  return ImageCatalogSchema.parse({
    schemaVersion: 1,
    releaseVersion: version,
    development: true,
    source: 'https://github.com/EldanRing/qubicl',
    revision,
    supportedPlatforms: platforms,
    gateway: image('qubicl/gateway:dev'),
    presets,
  });
}

export function normalizeDockerPlatform(os: string, architecture: string): DockerPlatform {
  if (os !== 'linux') throw new Error(`Qubicl requires a Linux Docker daemon; found ${os}.`);
  const arch = architecture === 'x86_64' || architecture === 'amd64' ? 'amd64'
    : architecture === 'aarch64' || architecture === 'arm64' ? 'arm64'
      : architecture;
  return DockerPlatformSchema.parse(`linux/${arch}`);
}

export function memoryBytes(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([kmg])$/i);
  if (!match) throw new Error(`Memory ${JSON.stringify(value)} must look like 512m or 4g.`);
  const factors = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  return Number(match[1]) * factors[match[2]!.toLowerCase() as keyof typeof factors];
}

export function normalizeMemory(value: string): string {
  const bytesValue = memoryBytes(value);
  if (!Number.isSafeInteger(bytesValue) || bytesValue < 256 * 1024 ** 2) throw new Error('Memory must be at least 256m.');
  if (bytesValue % 1024 ** 3 === 0) return `${bytesValue / 1024 ** 3}g`;
  if (bytesValue % 1024 ** 2 === 0) return `${bytesValue / 1024 ** 2}m`;
  return `${bytesValue / 1024}k`;
}

export function validateCpu(value: number, capacity?: number): number {
  if (!Number.isFinite(value) || value < 0.25 || Math.round(value * 4) !== value * 4) {
    throw new Error('CPU must be a quarter-CPU increment from 0.25 upward.');
  }
  if (capacity !== undefined && value > capacity) throw new Error(`CPU ${value} exceeds Docker daemon capacity ${capacity}.`);
  return value;
}

export function validateMemory(value: string, capacityBytes?: number): string {
  const normalized = normalizeMemory(value);
  if (capacityBytes !== undefined && memoryBytes(normalized) > capacityBytes) {
    throw new Error(`Memory ${normalized} exceeds Docker daemon capacity.`);
  }
  return normalized;
}

export function formatBytes(value: number | null): string {
  if (value === null) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}
