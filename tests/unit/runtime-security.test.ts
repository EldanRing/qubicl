import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { CONTROL_PROTOCOL_VERSION, IMAGE_CATALOG, imageIdentity, presetDefaults, type ComputerConfig } from '@qubicl/core';
import {
  containerName,
  computerExecutorServiceName,
  computerEgressServiceName,
  computerServiceName,
  computerSessionServiceName,
  computerWebServiceName,
  controlNetwork,
  gatewayContainerName,
  gatewayNetworkName,
  projectName,
  readableContainerName,
  renderRuntime,
  runtimeImageReference,
  serviceName,
} from '../../packages/cli/dist/runtime.js';
import { initializeState, statePaths } from '../../packages/cli/dist/state.js';
import { migrateLegacyRuntime, prepareRuntimeMigration, type LegacyRuntimeMigrationAdapter, type RuntimeInspection } from '../../packages/cli/dist/docker.js';

test('gateway runtime is hardened without arbitrary CPU or memory limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-runtime-security-'));
  try {
    const state = await initializeState(statePaths(root));
    await renderRuntime(state);
    const document = YAML.parse(await readFile(state.paths.compose, 'utf8')) as {
      services?: {
        gateway?: {
          read_only?: boolean;
          cap_drop?: string[];
          security_opt?: string[];
          cpus?: unknown;
          mem_limit?: unknown;
        };
      };
    };
    const gateway = document.services?.gateway;
    assert.ok(gateway);
    assert.equal(gateway.read_only, true);
    assert.deepEqual(gateway.cap_drop, ['ALL']);
    assert.deepEqual(gateway.security_opt, ['no-new-privileges:true']);
    assert.equal(gateway.cpus, undefined);
    assert.equal(gateway.mem_limit, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source runtime prefers a recorded local content ID without changing stored identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-runtime-development-image-'));
  try {
    const state = await initializeState(statePaths(root));
    const gatewayContentId = `sha256:${'1'.repeat(64)}`;
    const computerContentId = `sha256:${'2'.repeat(64)}`;
    state.config.gateway.image = {
      requested: IMAGE_CATALOG.gateway.requested,
      resolved: `qubicl/gateway@sha256:${'3'.repeat(64)}`,
      contentId: gatewayContentId,
    };
    const configured: ComputerConfig = {
      id: '00000000-0000-4000-8000-000000000321',
      name: 'old-dev-computer',
      createdAt: new Date().toISOString(),
      controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
      ...presetDefaults('workstation'),
    };
    configured.image = {
      ...configured.image,
      resolved: `qubicl/workstation@sha256:${'4'.repeat(64)}`,
      contentId: computerContentId,
    };
    state.config.computers.push(configured);
    state.secrets.computers[configured.id] = { token: 't'.repeat(43), internalKey: 'i'.repeat(43) };

    await renderRuntime(state);
    const document = YAML.parse(await readFile(state.paths.compose, 'utf8')) as {
      services: Record<string, { image: string; pull_policy?: string }>;
    };
    assert.equal(document.services.gateway?.image, gatewayContentId);
    assert.equal(document.services.gateway?.pull_policy, 'never');
    assert.equal(document.services[computerServiceName(state, configured)]?.image, computerContentId);
    assert.equal(document.services[computerServiceName(state, configured)]?.pull_policy, 'never');
    assert.equal(configured.image.resolved, `qubicl/workstation@sha256:${'4'.repeat(64)}`);

    const custom = imageIdentity('example/custom:dev', 'example/custom:dev');
    custom.contentId = `sha256:${'5'.repeat(64)}`;
    assert.equal(runtimeImageReference(custom, 'computer', 'workstation'), custom.resolved);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('current computers use one bounded runtime container plus the shared gateway', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-runtime-isolated-topology-'));
  try {
    const state = await initializeState(statePaths(root));
    const computer: ComputerConfig = {
      id: '00000000-0000-4000-8000-000000000322',
      name: 'isolated-workstation',
      createdAt: new Date().toISOString(),
      controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
      ...presetDefaults('workstation'),
      network: { profile: 'offline', allowDomains: [], denyDomains: [], temporaryApprovals: [] },
      environment: { PROJECT_MODE: 'test' },
      ssh: { enabled: true, port: 22_220, publicKey: `ssh-ed25519 ${'A'.repeat(48)} qubicl:test`, fingerprint: 'SHA256:test-fingerprint' },
    };
    state.config.computers.push(computer);
    state.secrets.computers[computer.id] = { token: 't'.repeat(43), internalKey: 'i'.repeat(43) };
    await renderRuntime(state);

    const document = YAML.parse(await readFile(state.paths.compose, 'utf8')) as {
      services: Record<string, {
        environment?: Record<string, string>;
        networks?: string[];
        ports?: string[];
        volumes?: Array<{ target: string }>;
        depends_on?: Record<string, unknown>;
        healthcheck?: { test?: string[] };
        read_only?: boolean;
        cap_drop?: string[];
        cap_add?: string[];
        security_opt?: string[];
        privileged?: boolean;
        shm_size?: string;
      }>;
      networks: Record<string, { name: string; internal?: boolean }>;
    };
    const runtime = document.services[computerServiceName(state, computer)]!;
    const gateway = document.services.gateway!;
    assert.equal(Object.keys(document.services).length, 2);
    assert.equal(runtime.environment?.QUBICL_RUNTIME_ROLE, 'computer');
    assert.equal(runtime.environment?.QUBICL_INTERNAL_KEY, 'i'.repeat(43));
    assert.equal(runtime.environment?.QUBICL_EXECUTOR_URL, 'http://127.0.0.1:3213');
    assert.equal(runtime.environment?.QUBICL_SESSION_URL, 'http://127.0.0.1:3214');
    assert.equal(runtime.environment?.QUBICL_WEB_URL, 'http://127.0.0.1:3215');
    assert.equal(runtime.environment?.QUBICL_POINTER_URL, 'http://127.0.0.1:3212/_qubicl/session/pointer');
    assert.equal(runtime.environment?.QUBICL_WORKLOAD_ENV_JSON, JSON.stringify({ PROJECT_MODE: 'test' }));
    assert.match(runtime.environment?.QUBICL_PROXY_URL ?? '', /@.+gateway:3128$/u);
    assert.equal(runtime.volumes?.some(({ target }) => target === '/run/qubicl/audit.jsonl'), true);
    assert.equal(gateway.volumes?.some(({ target }) => target === '/audit'), true);

    const controlKey = runtime.networks![0]!;
    assert.equal(document.networks[controlKey]?.name, controlNetwork(state.config.installationId, computer.id, state.paths.root));
    assert.equal(document.networks[controlKey]?.internal, true);
    assert.equal(Object.keys(document.networks).length, 2);
    assert.equal(runtime.privileged, false);
    assert.equal(runtime.shm_size, '1g');
    assert.equal(runtime.cap_add, undefined);
    assert.deepEqual(runtime.security_opt, [
      'no-new-privileges:true',
      `seccomp=${join(state.paths.runtime, 'chromium-seccomp.json')}`,
    ]);
    const profilePath = join(state.paths.runtime, 'chromium-seccomp.json');
    assert.equal((await lstat(profilePath)).mode & 0o777, 0o600);
    const seccomp = JSON.parse(await readFile(profilePath, 'utf8')) as {
      defaultAction: string;
      syscalls: Array<{ names: string[]; action: string; args?: Array<{ value?: number; valueTwo?: number }> }>;
    };
    assert.equal(seccomp.defaultAction, 'SCMP_ACT_ERRNO');
    const namespaceRules = seccomp.syscalls.filter(({ names, args }) => args && (names.includes('clone') || names.includes('unshare')));
    assert.deepEqual(
      namespaceRules.filter(({ names }) => names.includes('unshare')).map(({ args }) => args?.[0]?.valueTwo),
      [268435456],
    );
    assert.deepEqual(
      namespaceRules.filter(({ names, args }) => names.includes('clone') && args?.[0]?.valueTwo !== undefined)
        .map(({ args }) => args?.[0]?.valueTwo).toSorted((left, right) => left! - right!),
      [268435456, 536870912, 805306368, 1342177280, 1879048192],
    );
    assert.deepEqual(runtime.ports, ['127.0.0.1:22220:2222']);
    assert.equal(runtime.healthcheck?.test?.[0], 'CMD');
    assert.equal(runtime.healthcheck?.test?.[1], 'node');
    assert.equal(runtime.healthcheck?.test?.includes('curl'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('protocol 9 computers remain renderable as split runtimes for rolling upgrades', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-runtime-rolling-legacy-'));
  try {
    const state = await initializeState(statePaths(root));
    const computer: ComputerConfig = {
      id: '00000000-0000-4000-8000-000000000323',
      name: 'legacy-workstation',
      createdAt: new Date().toISOString(),
      controlProtocolVersion: 9,
      ...presetDefaults('workstation'),
    };
    state.config.computers.push(computer);
    state.secrets.computers[computer.id] = { token: 't'.repeat(43), internalKey: 'i'.repeat(43) };
    await renderRuntime(state);
    const document = YAML.parse(await readFile(state.paths.compose, 'utf8')) as { services: Record<string, { container_name?: string }>; networks: Record<string, unknown> };
    assert.equal(document.services[computerServiceName(state, computer)]?.container_name !== undefined, true);
    assert.equal(document.services[computerExecutorServiceName(state, computer)]?.container_name !== undefined, true);
    assert.equal(document.services[computerEgressServiceName(state, computer)]?.container_name !== undefined, true);
    assert.equal(document.services[computerWebServiceName(state, computer)]?.container_name !== undefined, true);
    assert.equal(document.services[computerSessionServiceName(state, computer)]?.container_name !== undefined, true);
    assert.equal(document.networks[`workspace_${computer.id.replaceAll('-', '')}`] !== undefined, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy runtime migration verifies ownership and preserves gateway lifecycle state', async () => {
  for (const scenario of [
    { status: 'running', expectedCompose: ['up', '--detach', '--no-deps', 'gateway'], waits: 1 },
    { status: 'exited', expectedCompose: ['create', '--no-deps', 'gateway'], waits: 0 },
  ]) {
    const root = await mkdtemp(join(tmpdir(), `qubicl-runtime-migrate-${scenario.status}-`));
    try {
      const state = await initializeState(statePaths(root));
      await renderRuntime(state);
      const inspections = new Map<string, RuntimeInspection>([['qubicl-gateway', {
        State: { Status: scenario.status },
        Config: { Labels: { 'dev.qubicl.role': 'gateway' } },
        Mounts: [{ Source: state.paths.runtime, Destination: '/runtime' }],
      }]]);
      const dockerCalls: string[][] = [];
      const composeCalls: string[][] = [];
      let waits = 0;
      const adapter: LegacyRuntimeMigrationAdapter = {
        inspectContainer: async (name) => inspections.get(name),
        docker: async (args) => {
          dockerCalls.push(args);
          if (args[0] === 'rm') inspections.delete(args.at(-1)!);
          return '';
        },
        compose: async (_state, args) => { composeCalls.push(args); return ''; },
        waitForContainerHealthy: async () => { waits += 1; },
        waitForHealthy: async () => undefined,
        waitForGatewayComputer: async () => undefined,
      };

      assert.equal(await migrateLegacyRuntime(state, adapter), true);
      assert.deepEqual(composeCalls, [scenario.expectedCompose]);
      assert.equal(waits, scenario.waits);
      assert.ok(dockerCalls.some((args) => args.join(' ') === 'rm --force qubicl-gateway'));
      assert.ok(dockerCalls.some((args) => args.join(' ') === 'network rm qubicl-gateway'));
      await assert.rejects(lstat(state.paths.runtimeMigration), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('legacy runtime migration refuses containers not proven to belong to the active state root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-runtime-refuse-'));
  try {
    const state = await initializeState(statePaths(root));
    await renderRuntime(state);
    const inspection: RuntimeInspection = {
      State: { Status: 'running' },
      Config: { Labels: { 'dev.qubicl.role': 'gateway' } },
      Mounts: [{ Source: '/home/someone-else/.qubicl/runtime', Destination: '/runtime' }],
    };
    const adapter: LegacyRuntimeMigrationAdapter = {
      inspectContainer: async (name) => name === 'qubicl-gateway' ? inspection : undefined,
      docker: async () => { throw new Error('must not mutate Docker'); },
      compose: async () => { throw new Error('must not mutate Compose'); },
      waitForContainerHealthy: async () => undefined,
      waitForHealthy: async () => undefined,
      waitForGatewayComputer: async () => undefined,
    };
    await assert.rejects(migrateLegacyRuntime(state, adapter), /owned by a different Qubicl state directory/);
    await assert.rejects(lstat(state.paths.runtimeMigration), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime identities are stable per installation and isolated across QUBICL_HOME paths', async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), 'qubicl-runtime-first-'));
  const secondRoot = await mkdtemp(join(tmpdir(), 'qubicl-runtime-second-'));
  try {
    const first = await initializeState(statePaths(firstRoot));
    const second = await initializeState(statePaths(secondRoot));
    await renderRuntime(first);
    await renderRuntime(second);
    const firstCompose = YAML.parse(await readFile(first.paths.compose, 'utf8')) as {
      name: string;
      services: { gateway: { container_name: string; labels: Record<string, string> } };
      networks: { gateway: { name: string } };
    };
    const secondCompose = YAML.parse(await readFile(second.paths.compose, 'utf8')) as typeof firstCompose;

    assert.equal(firstCompose.name, projectName(first.config.installationId, first.paths.root));
    assert.equal(firstCompose.services.gateway.container_name, gatewayContainerName(first.config.installationId, first.paths.root));
    assert.equal(firstCompose.networks.gateway.name, gatewayNetworkName(first.config.installationId, first.paths.root));
    assert.equal(firstCompose.services.gateway.labels['dev.qubicl.installation'], first.config.installationId);
    assert.notEqual(firstCompose.name, secondCompose.name);
    assert.notEqual(firstCompose.services.gateway.container_name, secondCompose.services.gateway.container_name);
    assert.notEqual(firstCompose.networks.gateway.name, secondCompose.networks.gateway.name);

    const id = '00000000-0000-4000-8000-000000000123';
    assert.notEqual(containerName(first.config.installationId, id, undefined, first.paths.root), containerName(second.config.installationId, id, undefined, second.paths.root));
    assert.notEqual(controlNetwork(first.config.installationId, id, first.paths.root), controlNetwork(second.config.installationId, id, second.paths.root));
    assert.ok(containerName(first.config.installationId, id, undefined, first.paths.root).length <= 63);
    assert.ok(controlNetwork(first.config.installationId, id, first.paths.root).length <= 63);
    const readable = readableContainerName(first.config.installationId, id, 'open-webui-native', first.paths.root);
    assert.match(readable, /^qubicl-open-webui-native-[a-f0-9]{8}-[a-f0-9]{8}$/);
    assert.equal(readable.length <= 63, true);
  } finally {
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});

test('the primary installation renders one qubicl group with literal computer names', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'qubicl-runtime-primary-'));
  try {
    const state = await initializeState(statePaths(temporaryRoot));
    state.paths.root = join(homedir(), '.qubicl');
    const computer: ComputerConfig = {
      id: '00000000-0000-4000-8000-000000000456',
      name: 'openwebui-qubicl',
      runtimeName: 'qubicl-openwebui-qubicl-deadbeef-feedface',
      createdAt: new Date().toISOString(),
      controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
      ...presetDefaults('workstation'),
    };
    state.config.computers.push(computer);
    state.secrets.computers[computer.id] = { token: 't'.repeat(43), internalKey: 'i'.repeat(43) };

    await renderRuntime(state);
    const document = YAML.parse(await readFile(state.paths.compose, 'utf8')) as {
      name: string;
      services: Record<string, { container_name: string }>;
    };
    assert.equal(document.name, 'qubicl');
    assert.equal(document.services.gateway?.container_name, 'gateway');
    assert.equal(document.services[computer.name]?.container_name, 'openwebui-qubicl');
    assert.equal(Object.keys(document.services).length, 2);
    assert.equal(document.services[serviceName(computer.id)], undefined);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('a namespaced primary runtime with Docker Desktop bind paths migrates without changing durable state', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'qubicl-runtime-friendly-migration-'));
  try {
    const source = await initializeState(statePaths(temporaryRoot));
    const computer: ComputerConfig = {
      id: '00000000-0000-4000-8000-000000000567',
      name: 'openwebui-qubicl',
      runtimeName: readableContainerName(source.config.installationId, '00000000-0000-4000-8000-000000000567', 'openwebui-qubicl', source.paths.root),
      createdAt: new Date().toISOString(),
      ...presetDefaults('workstation'),
    };
    source.config.computers.push(computer);
    source.secrets.computers[computer.id] = { token: 't'.repeat(43), internalKey: 'i'.repeat(43) };
    await renderRuntime(source);
    const sourceGateway = gatewayContainerName(source.config.installationId, source.paths.root);
    const sourceComputer = containerName(source.config.installationId, computer.id, computer.runtimeName, source.paths.root);
    const inspections = new Map<string, RuntimeInspection>([
      [sourceGateway, {
        State: { Status: 'running' },
        Config: { Labels: { 'dev.qubicl.role': 'gateway', 'dev.qubicl.installation': source.config.installationId } },
        Mounts: [{ Source: `/host_mnt${source.paths.runtime}`, Destination: '/runtime' }],
      }],
      [sourceComputer, {
        State: { Status: 'running' },
        Config: { Labels: { 'dev.qubicl.role': 'computer', 'dev.qubicl.installation': source.config.installationId, 'dev.qubicl.id': computer.id } },
        Mounts: [{ Source: `/host_mnt${join(source.paths.computers, computer.id, 'home')}`, Destination: '/home' }],
      }],
    ]);
    const dockerCalls: string[][] = [];
    const composeCalls: string[][] = [];
    const adapter: LegacyRuntimeMigrationAdapter = {
      inspectContainer: async (name) => inspections.get(name),
      docker: async (args) => {
        dockerCalls.push(args);
        if (args[0] === 'image') return 'sha256:available';
        if (args[0] === 'rm') inspections.delete(args.at(-1)!);
        return '';
      },
      compose: async (_state, args) => { composeCalls.push(args); return ''; },
      waitForContainerHealthy: async () => undefined,
      waitForHealthy: async () => undefined,
      waitForGatewayComputer: async () => undefined,
    };

    assert.equal(await prepareRuntimeMigration(source, adapter), true);
    const target = { ...source, paths: { ...source.paths, root: join(homedir(), '.qubicl') } };
    await renderRuntime(target);
    assert.equal(await migrateLegacyRuntime(target, adapter), true);

    assert.ok(dockerCalls.some((args) => args.join(' ') === `rm --force ${sourceComputer}`));
    assert.ok(dockerCalls.some((args) => args.join(' ') === `rm --force ${sourceGateway}`));
    assert.deepEqual(composeCalls, [
      ['up', '--detach', '--no-deps', 'gateway'],
      ['up', '--detach', computer.name],
    ]);
    const document = YAML.parse(await readFile(source.paths.compose, 'utf8')) as { name: string; services: Record<string, { container_name: string }> };
    assert.equal(document.name, 'qubicl');
    assert.equal(document.services.gateway?.container_name, 'gateway');
    assert.equal(document.services[computer.name]?.container_name, computer.name);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('a primary UUID service label migrates to the literal computer name shown by Docker Desktop', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'qubicl-runtime-service-label-'));
  try {
    const state = await initializeState(statePaths(temporaryRoot));
    state.paths.root = join(homedir(), '.qubicl');
    const computer: ComputerConfig = {
      id: '00000000-0000-4000-8000-000000000668',
      name: 'openwebui-qubicl',
      runtimeName: 'openwebui-qubicl',
      createdAt: new Date().toISOString(),
      ...presetDefaults('workstation'),
    };
    state.config.computers.push(computer);
    state.secrets.computers[computer.id] = { token: 't'.repeat(43), internalKey: 'i'.repeat(43) };
    await renderRuntime(state);
    const document = YAML.parse(await readFile(state.paths.compose, 'utf8')) as {
      services: Record<string, { container_name: string; labels: Record<string, string> }>;
    };
    document.services[serviceName(computer.id)] = document.services[computer.name]!;
    delete document.services[computer.name];
    await writeFile(state.paths.compose, YAML.stringify(document), { mode: 0o600 });

    const inspections = new Map<string, RuntimeInspection>([
      ['gateway', {
        State: { Status: 'running' },
        Config: { Labels: { 'dev.qubicl.role': 'gateway', 'dev.qubicl.installation': state.config.installationId } },
        Mounts: [{ Source: state.paths.runtime, Destination: '/runtime' }],
      }],
      [computer.name, {
        State: { Status: 'running' },
        Config: { Labels: { 'dev.qubicl.role': 'computer', 'dev.qubicl.installation': state.config.installationId, 'dev.qubicl.id': computer.id } },
        Mounts: [{ Source: join(state.paths.computers, computer.id, 'home'), Destination: '/home' }],
      }],
    ]);
    const dockerCalls: string[][] = [];
    const composeCalls: string[][] = [];
    const adapter: LegacyRuntimeMigrationAdapter = {
      inspectContainer: async (name) => inspections.get(name),
      docker: async (args) => {
        dockerCalls.push(args);
        if (args[0] === 'image') return 'sha256:available';
        if (args[0] === 'rm') inspections.delete(args.at(-1)!);
        return '';
      },
      compose: async (_state, args) => { composeCalls.push(args); return ''; },
      waitForContainerHealthy: async () => undefined,
      waitForHealthy: async () => undefined,
      waitForGatewayComputer: async () => undefined,
    };

    assert.equal(await prepareRuntimeMigration(state, adapter), true);
    await renderRuntime(state);
    assert.equal(await migrateLegacyRuntime(state, adapter), true);

    assert.ok(dockerCalls.some((args) => args.join(' ') === `rm --force ${computer.name}`));
    assert.equal(dockerCalls.some((args) => args.join(' ') === 'rm --force gateway'), false);
    assert.deepEqual(composeCalls, [['up', '--detach', computer.name]]);
    const migrated = YAML.parse(await readFile(state.paths.compose, 'utf8')) as { services: Record<string, unknown> };
    assert.ok(migrated.services[computer.name]);
    assert.equal(migrated.services[serviceName(computer.id)], undefined);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('renaming a primary computer recreates only its service despite an unrelated missing image pin', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'qubicl-runtime-friendly-rename-'));
  try {
    const state = await initializeState(statePaths(temporaryRoot));
    state.paths.root = join(homedir(), '.qubicl');
    const computer: ComputerConfig = {
      id: '00000000-0000-4000-8000-000000000678',
      name: 'before-name',
      runtimeName: 'before-name',
      createdAt: new Date().toISOString(),
      ...presetDefaults('workstation'),
    };
    const unrelated: ComputerConfig = {
      id: '00000000-0000-4000-8000-000000000679',
      name: 'retained-unrelated',
      runtimeName: 'retained-unrelated',
      createdAt: new Date().toISOString(),
      ...presetDefaults('workstation'),
    };
    unrelated.image = {
      ...unrelated.image,
      resolved: `qubicl/workstation@sha256:${'9'.repeat(64)}`,
      contentId: `sha256:${'9'.repeat(64)}`,
    };
    const unrelatedImage = runtimeImageReference(unrelated.image, 'computer', unrelated.compatibility);
    state.config.computers.push(computer, unrelated);
    state.secrets.computers[computer.id] = { token: 't'.repeat(43), internalKey: 'i'.repeat(43) };
    state.secrets.computers[unrelated.id] = { token: 'u'.repeat(43), internalKey: 'j'.repeat(43) };
    await renderRuntime(state);
    const inspections = new Map<string, RuntimeInspection>([
      ['gateway', {
        State: { Status: 'running' },
        Config: { Labels: { 'dev.qubicl.role': 'gateway', 'dev.qubicl.installation': state.config.installationId } },
        Mounts: [{ Source: state.paths.runtime, Destination: '/runtime' }],
      }],
      ['before-name', {
        State: { Status: 'running' },
        Config: { Labels: { 'dev.qubicl.role': 'computer', 'dev.qubicl.installation': state.config.installationId, 'dev.qubicl.id': computer.id } },
        Mounts: [{ Source: join(state.paths.computers, computer.id, 'home'), Destination: '/home' }],
      }],
      [unrelated.name, {
        State: { Status: 'running' },
        Config: { Labels: { 'dev.qubicl.role': 'computer', 'dev.qubicl.installation': state.config.installationId, 'dev.qubicl.id': unrelated.id } },
        Mounts: [{ Source: join(state.paths.computers, unrelated.id, 'home'), Destination: '/home' }],
      }],
    ]);
    const dockerCalls: string[][] = [];
    const composeCalls: string[][] = [];
    const adapter: LegacyRuntimeMigrationAdapter = {
      inspectContainer: async (name) => inspections.get(name),
      docker: async (args) => {
        dockerCalls.push(args);
        if (args[0] === 'image') return args.at(-1) === unrelatedImage ? '' : 'sha256:available';
        if (args[0] === 'rm') inspections.delete(args.at(-1)!);
        return '';
      },
      compose: async (_state, args) => { composeCalls.push(args); return ''; },
      waitForContainerHealthy: async () => undefined,
      waitForHealthy: async () => undefined,
      waitForGatewayComputer: async () => undefined,
    };
    computer.name = 'after-name';
    computer.runtimeName = 'after-name';
    assert.equal(await prepareRuntimeMigration(state, adapter), true);
    await renderRuntime(state);
    assert.equal(await migrateLegacyRuntime(state, adapter), true);
    assert.ok(dockerCalls.some((args) => args.join(' ') === 'rm --force before-name'));
    assert.equal(dockerCalls.some((args) => args.join(' ') === `rm --force ${unrelated.name}`), false);
    assert.equal(dockerCalls.some((args) => args[0] === 'image' && args.at(-1) === unrelatedImage), false);
    assert.equal(dockerCalls.some((args) => args[0] === 'rename'), false);
    assert.deepEqual(composeCalls, [['up', '--detach', 'after-name']]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
