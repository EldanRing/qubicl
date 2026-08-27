import { randomUUID } from 'node:crypto';
import {
  ComputerConfigSchema,
  CONTROL_PROTOCOL_VERSION,
  allocateName,
  assertValidName,
  type ComputerDefaults,
  type ComputerConfig,
  defaultCatalogSkillsForCompatibility,
  toolsForCapabilities,
} from '@qubicl/core';
import { newSecret, type LoadedState } from './state.js';
import { isPrimaryRuntimeRoot, readableContainerName } from './runtime.js';

export function addConfiguredComputer(
  state: LoadedState,
  requestedName?: string,
  defaults: ComputerDefaults = state.config.defaults,
  policy: Partial<Pick<ComputerConfig, 'toolPolicy' | 'skillPolicy'>> = {},
): ComputerConfig {
  const name = requestedName ? assertValidName(requestedName) : allocateName(state.config);
  if (isPrimaryRuntimeRoot(state.paths.root) && name === 'gateway') throw new Error('Computer name gateway is reserved by the primary Qubicl runtime.');
  if (state.config.computers.some((computer) => computer.name === name)) throw new Error(`Computer name ${name} is already in use.`);
  const id = randomUUID();
  const computer = ComputerConfigSchema.parse({
    id,
    name,
    runtimeName: readableContainerName(state.config.installationId, id, name, state.paths.root),
    createdAt: new Date().toISOString(),
    controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
    ...structuredClone(defaults),
    toolPolicy: toolsForCapabilities(defaults.capabilities),
    skillPolicy: { enabledCatalogSkills: defaultCatalogSkillsForCompatibility(defaults.compatibility) },
    ...policy,
  });
  state.config.computers.push(computer);
  state.secrets.computers[computer.id] = newSecret();
  return computer;
}
