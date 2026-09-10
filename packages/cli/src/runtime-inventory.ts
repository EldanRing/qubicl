import { dashboardAssetNetworkName, dashboardContainerName, readDashboardConfiguration } from './dashboard/runtime.js';
import {
  computerRuntimeContainerNames,
  controlNetwork,
  displaySocketVolume,
  gatewayContainerName,
  gatewayNetworkName,
  usesUnifiedComputerRuntime,
  workspaceNetwork,
} from './runtime.js';
import type { LoadedState } from './state.js';

export interface ExpectedRuntimeResources {
  containers: Set<string>;
  networks: Set<string>;
  volumes: Set<string>;
}

export function expectedRuntimeResources(
  state: LoadedState,
  dashboardInstallationId?: string,
): ExpectedRuntimeResources {
  const installationId = state.config.installationId;
  if (dashboardInstallationId !== undefined && dashboardInstallationId !== installationId) {
    throw new Error('Dashboard installation identity does not match core state.');
  }
  return {
    containers: new Set([
      gatewayContainerName(installationId, state.paths.root),
      ...state.config.computers.flatMap((computer) => computerRuntimeContainerNames(state, computer)),
      ...(dashboardInstallationId ? [dashboardContainerName(state.paths.root, dashboardInstallationId)] : []),
    ]),
    networks: new Set([
      gatewayNetworkName(installationId, state.paths.root),
      ...state.config.computers.flatMap((computer) => usesUnifiedComputerRuntime(computer)
        ? [controlNetwork(installationId, computer.id, state.paths.root)]
        : [controlNetwork(installationId, computer.id, state.paths.root), workspaceNetwork(installationId, computer.id, state.paths.root)]),
      ...(dashboardInstallationId ? [dashboardAssetNetworkName(state.paths.root, dashboardInstallationId)] : []),
    ]),
    volumes: new Set(state.config.computers
      .filter((computer) => computer.capabilities.includes('viewer') && !usesUnifiedComputerRuntime(computer))
      .map((computer) => displaySocketVolume(installationId, computer.id, state.paths.root))),
  };
}

export async function configuredExpectedRuntimeResources(state: LoadedState): Promise<ExpectedRuntimeResources> {
  const dashboard = await readDashboardConfiguration(state.paths.root);
  return expectedRuntimeResources(state, dashboard?.installationId);
}
