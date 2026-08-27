import {
  ComputerConfigSchema,
  CONTROL_PROTOCOL_VERSION,
  type ComputerConfig,
  type ComputerDefaults,
  toolsForCapabilities,
} from '@qubicl/core';

/**
 * Replace only the image capability contract while retaining the durable
 * computer identity and all operator-managed settings.
 */
export function upgradedComputer(computer: ComputerConfig, imageDefaults: ComputerDefaults): ComputerConfig {
  const maximum = toolsForCapabilities(imageDefaults.capabilities);
  return ComputerConfigSchema.parse({
    ...structuredClone(computer),
    preset: imageDefaults.preset,
    compatibility: imageDefaults.compatibility,
    image: structuredClone(imageDefaults.image),
    capabilityContractVersion: imageDefaults.capabilityContractVersion,
    capabilities: [...imageDefaults.capabilities],
    controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
    cpus: computer.cpus,
    memory: computer.memory,
    toolPolicy: maximum.filter((tool) => (computer.toolPolicy ?? maximum).includes(tool)),
  });
}
