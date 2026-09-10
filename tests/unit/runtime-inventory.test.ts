import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedRuntimeResources } from '../../packages/cli/dist/runtime-inventory.js';
import { dashboardAssetNetworkName, dashboardContainerName } from '../../packages/cli/dist/dashboard/runtime.js';
import type { LoadedState } from '../../packages/cli/dist/state.js';

const INSTALLATION_ID = '00000000-0000-4000-8000-000000000000';

test('enabled or retained dashboard resources are protected from orphan diagnosis and cleanup', () => {
  const root = '/tmp/qubicl-runtime-inventory-test';
  const state = {
    paths: { root },
    config: {
      installationId: INSTALLATION_ID,
      computers: [],
    },
  } as unknown as LoadedState;

  const withoutDashboard = expectedRuntimeResources(state);
  const withDashboard = expectedRuntimeResources(state, INSTALLATION_ID);
  const container = dashboardContainerName(root, INSTALLATION_ID);
  const network = dashboardAssetNetworkName(root, INSTALLATION_ID);

  assert.equal(withoutDashboard.containers.has(container), false);
  assert.equal(withoutDashboard.networks.has(network), false);
  assert.equal(withDashboard.containers.has(container), true);
  assert.equal(withDashboard.networks.has(network), true);
  assert.equal(withDashboard.containers.has(`${container}-orphan`), false);
  assert.equal(withDashboard.networks.has(`${network}-orphan`), false);
  assert.throws(() => expectedRuntimeResources(state, '11111111-1111-4111-8111-111111111111'), /identity does not match/);
});
