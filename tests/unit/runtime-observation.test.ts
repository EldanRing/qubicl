import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { CONTROL_PROTOCOL_VERSION, presetDefaults, type ComputerConfig, type RuntimeContainerBinding } from '../../packages/core/dist/index.js';
import {
  assertGatewayRuntimeBinding,
  managedComputerRuntimeObservation,
  managedGatewayRuntimeObservation,
  parseManagedRuntimeInventory,
  removeComputerRuntimeForLifecycleReplacement,
  removeGatewayRuntimeForLifecycleReplacement,
  strictLifecycleContainerInspection,
  strictLifecycleRuntimeStatus,
  type ManagedRuntimeObservationAdapter,
  type RunOptions,
  type RuntimeInspection,
} from '../../packages/cli/dist/docker.js';
import { computerContainerName, gatewayContainerName } from '../../packages/cli/dist/runtime.js';
import { statePaths, type LoadedState } from '../../packages/cli/dist/state.js';

test('managed runtime inventory fails closed when Docker listing fails', async () => {
  const { state, computer } = fixture();
  const adapter: ManagedRuntimeObservationAdapter = {
    docker: async () => { throw new Error('Docker inventory unavailable'); },
    inspectContainer: async () => undefined,
  };

  await assert.rejects(managedComputerRuntimeObservation(state, computer, adapter), /Docker inventory unavailable/);
});

test('managed runtime observations propagate transient inspection and status failures instead of inferring absence', async () => {
  const { state, computer } = fixture();
  const name = computerContainerName(state, computer);
  const identity = JSON.stringify({ ID: 'a'.repeat(64), Names: name });
  const inspectFailure: ManagedRuntimeObservationAdapter = {
    docker: async (args) => args.some((arg) => arg.includes('dev.qubicl.role=computer')) ? `${identity}\n` : '',
    inspectContainer: async () => { throw new Error('daemon permission denied'); },
  };
  await assert.rejects(managedComputerRuntimeObservation(state, computer, inspectFailure), /daemon permission denied/);
  await assert.rejects(managedGatewayRuntimeObservation(state, inspectFailure), /daemon permission denied/);

});

test('strict lifecycle inspection maps only exact container not-found to absence and validates bounded singleton identity', async () => {
  const name = 'qubicl-observed';
  const inspection: RuntimeInspection = {
    Id: 'a'.repeat(64),
    Name: `/${name}`,
    Image: `sha256:${'b'.repeat(64)}`,
    State: { Status: 'created' },
    Config: { Labels: {} },
  };
  let observedArgs: string[] | undefined;
  let observedOptions: { timeoutMs?: number; maxOutputBytes?: number } | undefined;
  const runDocker = async (args: string[], options?: RunOptions) => {
    observedArgs = args;
    observedOptions = options;
    return JSON.stringify([inspection]);
  };

  assert.deepEqual(await strictLifecycleContainerInspection(name, runDocker), inspection);
  assert.deepEqual(await strictLifecycleRuntimeStatus(name, runDocker), { status: 'created' });
  assert.deepEqual(observedArgs, ['container', 'inspect', name]);
  assert.equal(observedOptions?.timeoutMs, 30_000);
  assert.equal(observedOptions?.maxOutputBytes, 1024 * 1024);

  assert.equal(await strictLifecycleContainerInspection(name, async () => {
    throw new Error(`docker container inspect ${name} failed (1): Error: No such container: ${name}`);
  }), undefined);
  await assert.rejects(strictLifecycleContainerInspection(name, async () => {
    throw new Error('permission denied while opening Docker socket');
  }), /refusing to infer absence/);
  await assert.rejects(strictLifecycleContainerInspection(name, async () => {
    throw new Error(`No such container: ${name}-different`);
  }), /refusing to infer absence/);
  await assert.rejects(strictLifecycleContainerInspection(name, async () => '[]'), /exactly one container/);
  await assert.rejects(strictLifecycleContainerInspection(name, async () => JSON.stringify([
    inspection,
    inspection,
  ])), /exactly one container/);
  await assert.rejects(strictLifecycleContainerInspection(name, async () => JSON.stringify([{
    ...inspection,
    Name: '/substituted',
  }])), /different container name/);
  await assert.rejects(strictLifecycleContainerInspection(name, async () => JSON.stringify([{
    ...inspection,
    Id: 'short-id',
  }])), /full container ID/);
});

test('managed runtime inventory validates bounded Docker names and preserves created as a complete non-running group', async () => {
  const { state, computer } = fixture();
  const name = computerContainerName(state, computer);
  const inspection = managedInspection(state, computer, name, 'created');
  let listCall = 0;
  const adapter: ManagedRuntimeObservationAdapter = {
    docker: async () => {
      listCall += 1;
      return listCall === 1 ? `${JSON.stringify({ ID: inspection.Id, Names: name })}\n` : '';
    },
    inspectContainer: async (candidate) => candidate === name || candidate === inspection.Id ? inspection : undefined,
  };

  assert.deepEqual(await managedComputerRuntimeObservation(state, computer, adapter), {
    status: 'created',
    group: 'complete',
    containers: [{
      name,
      id: inspection.Id!,
      status: 'created',
      imageId: inspection.Image!,
      role: 'computer',
      topologyVersion: '6',
    }],
  });
  const record = JSON.stringify({ ID: 'c'.repeat(64), Names: 'valid' });
  assert.deepEqual(parseManagedRuntimeInventory(`${record}\n`, 'test inventory'), [{ id: 'c'.repeat(64), name: 'valid' }]);
  assert.throws(() => parseManagedRuntimeInventory(`${record}\n${record}\n`, 'test inventory'), /duplicate immutable/);
  assert.throws(() => parseManagedRuntimeInventory(`${'{}\n'.repeat(1_025)}`, 'test inventory'), /too many containers/);
});

test('managed runtime completeness rejects arbitrary names and wrong roles carrying the computer ID', async () => {
  const { state, computer } = fixture();
  const primaryName = computerContainerName(state, computer);
  const extra = managedInspection(state, computer, 'qubicl-unexpected', 'running');
  extra.Id = 'd'.repeat(64);
  const extraAdapter: ManagedRuntimeObservationAdapter = {
    docker: async (args) => args.some((arg) => arg.includes('dev.qubicl.id='))
      ? JSON.stringify({ ID: extra.Id, Names: 'qubicl-unexpected' })
      : '',
    inspectContainer: async (reference) => reference === extra.Id ? extra : undefined,
  };
  assert.equal((await managedComputerRuntimeObservation(state, computer, extraAdapter)).group, 'inconsistent');

  const wrongRole = managedInspection(state, computer, primaryName, 'running');
  wrongRole.Config!.Labels!['dev.qubicl.role'] = 'computer-egress';
  const wrongRoleAdapter: ManagedRuntimeObservationAdapter = {
    docker: async (args) => args.some((arg) => arg.includes('dev.qubicl.id='))
      ? JSON.stringify({ ID: wrongRole.Id, Names: primaryName })
      : '',
    inspectContainer: async () => wrongRole,
  };
  await assert.rejects(managedComputerRuntimeObservation(state, computer, wrongRoleAdapter), /ownership, role, or topology/);
});

test('lifecycle replacement never deletes a same-name substitution or an unbound legacy source', async () => {
  const { state, computer } = fixture();
  const name = computerContainerName(state, computer);
  const sourceInspection = managedInspection(state, computer, name, 'running');
  const sourceBinding: RuntimeContainerBinding = {
    name,
    id: sourceInspection.Id!,
    status: 'running',
    imageId: sourceInspection.Image! as `sha256:${string}`,
    role: 'computer',
    topologyVersion: '6',
  };
  const substitution = managedInspection(state, computer, name, 'running');
  substitution.Id = 'e'.repeat(64);
  substitution.Config!.Labels = {};
  const dockerCalls: string[][] = [];
  const adapter: ManagedRuntimeObservationAdapter = {
    docker: async (args) => { dockerCalls.push(args); return ''; },
    inspectContainer: async (reference) => reference === name ? substitution : undefined,
  };

  await assert.rejects(
    removeComputerRuntimeForLifecycleReplacement(state, computer, [sourceBinding], false, adapter),
    /occupied outside the exact source\/target ownership inventory/,
  );
  await assert.rejects(
    removeComputerRuntimeForLifecycleReplacement(state, computer, [], false, adapter),
    /no immutable source binding/,
  );
  assert.equal(dockerCalls.some((args) => args[0] === 'rm'), false);
});

test('gateway assertion recovery accepts only an exact reviewed image when a source is recreated without a config content ID', async () => {
  const { state } = fixture();
  const name = gatewayContainerName(state.config.installationId, state.paths.root);
  const source: RuntimeContainerBinding = {
    name,
    id: '7'.repeat(64),
    status: 'running',
    imageId: `sha256:${'8'.repeat(64)}`,
    role: 'gateway',
  };
  const target: RuntimeInspection = {
    Id: '9'.repeat(64),
    Name: `/${name}`,
    Image: source.imageId,
    State: { Status: 'running' },
    Config: { Labels: {
      'dev.qubicl.installation': state.config.installationId,
      'dev.qubicl.role': 'gateway',
    } },
    Mounts: [{ Source: state.paths.runtime, Destination: '/runtime' }],
  };
  const runDocker = async (args: string[]) => {
    const reference = args[2];
    if (reference === source.id) throw new Error(`No such container: ${source.id}`);
    if (reference === name) return JSON.stringify([target]);
    throw new Error(`unexpected Docker reference ${String(reference)}`);
  };

  assert.equal(state.config.gateway.image.contentId, undefined);
  await assert.doesNotReject(assertGatewayRuntimeBinding(state, [source], runDocker));
  target.Image = `sha256:${'a'.repeat(64)}`;
  await assert.rejects(
    assertGatewayRuntimeBinding(state, [source], runDocker),
    /same-name replacement is not the exact owned target runtime/,
  );
  target.Image = source.imageId;
  await assert.rejects(
    removeGatewayRuntimeForLifecycleReplacement(state, [source], false, runDocker),
    /same-name replacement is not the exact owned target runtime/,
  );
});

test('split-to-unified recovery removes only a remaining bound source ID and retains an exact target already created', async () => {
  const { state, computer } = fixture();
  const name = computerContainerName(state, computer);
  const targetImage = `sha256:${'f'.repeat(64)}` as const;
  computer.image.contentId = targetImage;
  const oldPrimary: RuntimeContainerBinding = {
    name,
    id: 'a'.repeat(64),
    status: 'running',
    imageId: `sha256:${'b'.repeat(64)}`,
    role: 'computer',
    topologyVersion: '5',
  };
  const sidecarName = `${name}-executor`;
  const oldSidecar: RuntimeContainerBinding = {
    name: sidecarName,
    id: 'c'.repeat(64),
    status: 'running',
    imageId: `sha256:${'b'.repeat(64)}`,
    role: 'computer-executor',
  };
  const target = managedInspection(state, computer, name, 'running');
  target.Id = 'd'.repeat(64);
  target.Image = targetImage;
  const sidecar: RuntimeInspection = {
    Id: oldSidecar.id,
    Name: `/${sidecarName}`,
    Image: oldSidecar.imageId,
    State: { Status: 'running' },
    Config: { Labels: {
      'dev.qubicl.installation': state.config.installationId,
      'dev.qubicl.role': 'computer-executor',
      'dev.qubicl.computer-id': computer.id,
    } },
  };
  const calls: string[][] = [];
  const adapter: ManagedRuntimeObservationAdapter = {
    docker: async (args) => {
      calls.push(args);
      if (args[0] === 'rm') return '';
      return args.some((arg) => arg.includes('dev.qubicl.id='))
        ? JSON.stringify({ ID: target.Id, Names: name })
        : JSON.stringify({ ID: sidecar.Id, Names: sidecarName });
    },
    inspectContainer: async (reference) => {
      if (reference === target.Id || reference === name) return target;
      if (reference === sidecar.Id || reference === sidecarName) return sidecar;
      return undefined;
    },
  };

  await removeComputerRuntimeForLifecycleReplacement(
    state,
    computer,
    [oldPrimary, oldSidecar],
    false,
    adapter,
  );
  assert.deepEqual(calls.find((args) => args[0] === 'rm'), ['rm', '--force', oldSidecar.id]);
});

function fixture(): { state: LoadedState; computer: ComputerConfig } {
  const computer: ComputerConfig = {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'observed',
    runtimeName: 'qubicl-observed',
    createdAt: '2026-08-27T00:00:00.000Z',
    controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
    ...presetDefaults('file-system'),
  };
  const paths = statePaths('/tmp/qubicl-runtime-observation');
  const state = {
    paths,
    config: {
      version: 3,
      installationId: '00000000-0000-4000-8000-000000000000',
      gateway: { port: 3211, image: { requested: 'gateway', resolved: 'gateway' } },
      defaults: presetDefaults('file-system'),
      nextName: 2,
      computers: [computer],
    },
    secrets: {
      version: 3,
      computers: {
        [computer.id]: { token: 't'.repeat(32), internalKey: 'i'.repeat(32) },
      },
    },
  } as LoadedState;
  return { state, computer };
}

function managedInspection(state: LoadedState, computer: ComputerConfig, name: string, status: string): RuntimeInspection {
  return {
    Id: 'a'.repeat(64),
    Name: `/${name}`,
    Image: `sha256:${'b'.repeat(64)}`,
    State: { Status: status },
    Config: {
      Labels: {
        'dev.qubicl.installation': state.config.installationId,
        'dev.qubicl.role': 'computer',
        'dev.qubicl.id': computer.id,
        'dev.qubicl.name': computer.name,
        'dev.qubicl.topology-version': '6',
      },
    },
    Mounts: [{ Source: join(state.paths.computers, computer.id, 'home'), Destination: '/home' }],
  };
}
