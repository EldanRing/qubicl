import {
  IMAGE_CATALOG,
  type ImageIdentity,
  type Preset,
  type QubiclConfig,
} from '@qubicl/core';
import { runtimeImageReference } from './runtime.js';

export interface DoctorImageCheck {
  status: 'ok' | 'warning';
  detail: string;
  repair?: string;
}

interface ConfiguredImageUse {
  identity: ImageIdentity;
  kind: 'gateway' | 'computer';
  compatibility?: Preset;
  computerNames: string[];
}

/**
 * Report image availability using the same immutable reference that runtime
 * reconciliation uses. Source-built curated images may lose their repository
 * digest when a development tag is rebuilt while Docker still retains an
 * inspectable content ID. Custom and release images continue to use their
 * configured resolved reference.
 */
export async function doctorImageChecks(
  config: QubiclConfig,
  exists: (reference: string) => Promise<boolean>,
  computerStatus: (name: string) => Promise<{ status: string }>,
): Promise<DoctorImageCheck[]> {
  const uses = configuredImageUses(config);
  return Promise.all(uses.map(async (use) => {
    const runtimeReference = runtimeImageReference(use.identity, use.kind, use.compatibility);
    if (await exists(runtimeReference)) {
      return {
        status: 'ok' as const,
        detail: runtimeReference === use.identity.resolved
          ? `${use.identity.resolved} is available locally`
          : `${use.identity.resolved} is available locally as retained exact content ${runtimeReference}`,
      };
    }
    if (runtimeReference !== use.identity.resolved && await exists(use.identity.resolved)) {
      return { status: 'ok' as const, detail: `${use.identity.resolved} is available locally` };
    }

    const bundledDevelopmentImage = bundledDevelopmentIdentity(use);
    if (bundledDevelopmentImage) {
      const runningNames = (await Promise.all(use.computerNames.map(async (name) => ({
        name,
        running: (await computerStatus(name)).status === 'running',
      })))).filter(({ running }) => running).map(({ name }) => name);
      const retained = runningNames.length > 0
        ? `; ${computerList(runningNames)} ${runningNames.length === 1 ? 'is' : 'are'} running from ${runningNames.length === 1 ? 'its' : 'their'} retained container and can be reconnected or restarted without recreation`
        : '';
      return {
        status: 'warning' as const,
        detail: `${use.identity.resolved} is not available as a reusable local image${retained}`,
        repair: 'Preserve any existing container and its durable /home. To recreate it, create a new computer from current defaults and migrate durable data, or rebuild/provide the exact source revision image.',
      };
    }

    return {
      status: 'warning' as const,
      detail: `${use.identity.resolved} is not local; Qubicl will obtain it when needed`,
    };
  }));
}

function configuredImageUses(config: QubiclConfig): ConfiguredImageUse[] {
  const uses: ConfiguredImageUse[] = [{
    identity: config.gateway.image,
    kind: 'gateway',
    computerNames: [],
  }, {
    identity: config.defaults.image,
    kind: 'computer',
    compatibility: config.defaults.compatibility,
    computerNames: [],
  }, ...config.computers.map((computer) => ({
    identity: computer.image,
    kind: 'computer' as const,
    compatibility: computer.compatibility,
    computerNames: [computer.name],
  }))];

  const grouped = new Map<string, ConfiguredImageUse>();
  for (const use of uses) {
    const runtimeReference = runtimeImageReference(use.identity, use.kind, use.compatibility);
    const key = `${use.kind}\0${use.compatibility ?? ''}\0${use.identity.resolved}\0${runtimeReference}`;
    const existing = grouped.get(key);
    if (existing) existing.computerNames.push(...use.computerNames);
    else grouped.set(key, { ...use, computerNames: [...use.computerNames] });
  }
  return [...grouped.values()].sort((left, right) => (
    left.identity.resolved.localeCompare(right.identity.resolved)
  ));
}

function bundledDevelopmentIdentity(use: ConfiguredImageUse): boolean {
  if (!IMAGE_CATALOG.development) return false;
  if (use.kind === 'gateway') return use.identity.requested === IMAGE_CATALOG.gateway.requested;
  if (use.compatibility
    && use.identity.requested === IMAGE_CATALOG.presets[use.compatibility].image.requested) return true;
  return use.compatibility === 'workstation' && use.identity.requested === 'qubicl/computer:dev';
}

function computerList(names: string[]): string {
  if (names.length === 1) return `computer ${names[0]}`;
  return `computers ${names.join(', ')}`;
}
