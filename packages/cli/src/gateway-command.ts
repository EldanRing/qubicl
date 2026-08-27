import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  ConfigSchema,
  SecretsSchema,
  gatewayExposureOrigin,
  gatewayExposureRuntime,
  gatewayExposureRuntimeId,
  type GatewayExposureConfig,
  type QubiclConfig,
  type RuntimeContainerBinding,
} from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { flag, numberOption, stringOption } from './args.js';
import {
  assertConfiguredComputersSupportRemotePreviews,
  assertConfiguredGatewaySupportsExposure,
  inspectGatewayExternalPublication,
  managedComputerRuntimeObservation,
  managedGatewayRuntimeObservation,
  portAvailable,
  validateDocker,
  type ManagedRuntimeGroupObservation,
  type GatewayExternalPublication,
} from './docker.js';
import {
  buildGatewayExposureConfig,
  gatewayBindAddressPresent,
  gatewayEndpointSet,
  gatewayExposureRuntimeSnapshotPresent,
  normalizeBindAddress,
  normalizeGatewayHostname,
  normalizeGatewayPreviewDomain,
  parseCommaSeparatedOption,
  validateConfiguredGatewayTls,
  validateGatewayExposureRuntimeSnapshot,
  validateGatewayTlsInput,
} from './gateway-access.js';
import { gatewayUpgradeRuntimePlan, requirePreservedRuntimeState, type PreservedRuntimeState } from './lifecycle-update.js';
import { createStateTransaction, executeStateTransaction, inspectPendingTransaction } from './transactions.js';
import { loadState, statePaths, withStateLock, type LoadedState, type StatePaths } from './state.js';

export interface GatewayCommandDependencies {
  paths(): StatePaths;
  withStateLock<T>(paths: StatePaths, operation: () => Promise<T>): Promise<T>;
  loadState(paths: StatePaths): Promise<LoadedState>;
  validateDocker(): Promise<unknown>;
  assertGatewayExposureSupport(state: LoadedState): Promise<void>;
  assertRemotePreviewSupport(state: LoadedState): Promise<void>;
  externalPublication(state: LoadedState): Promise<GatewayExternalPublication | undefined>;
  runtimeSnapshotPresent(paths: StatePaths): Promise<boolean>;
  validateRuntimeSnapshot(state: LoadedState): Promise<void>;
  observeGateway(state: LoadedState): Promise<ManagedRuntimeGroupObservation>;
  observeComputer(state: LoadedState, computer: QubiclConfig['computers'][number]): Promise<ManagedRuntimeGroupObservation>;
  portAvailable(port: number, host: string): Promise<boolean>;
  executeTransaction(paths: StatePaths, state: LoadedState, runtime: GatewayExposureRuntimePlan): Promise<void>;
  localHealth(state: LoadedState): Promise<unknown | undefined>;
  pendingRecovery(paths: StatePaths): Promise<boolean>;
  question(message: string): Promise<string>;
  interactive: boolean;
  write(message: string): void;
}

export interface GatewayExposureRuntimeReview {
  state: PreservedRuntimeState;
  gateway: ManagedRuntimeGroupObservation;
  computers: Record<string, ManagedRuntimeGroupObservation>;
  runningComputerIds: string[];
}

export interface GatewayExposureRuntimePlan {
  startGateway?: boolean;
  replaceGatewayRunning?: boolean;
  replaceGatewayStopped?: boolean;
  gatewayRuntimeBinding?: RuntimeContainerBinding[];
  reconnectIds?: string[];
}

export async function gatewayCommand(args: ParsedArgs, injected?: GatewayCommandDependencies): Promise<void> {
  const action = args.positionals[0];
  validateGatewayActionOptions(action, args);
  const dependencies = injected ?? defaultDependencies();
  if (action === 'status') return gatewayExposureStatus(args, dependencies);
  if (action === 'expose') return exposeGateway(args, dependencies);
  if (action === 'revoke') return revokeGateway(args, dependencies);
  throw new Error('Gateway action must be expose, status, or revoke.');
}

function validateGatewayActionOptions(action: string | undefined, args: ParsedArgs): void {
  const allowed = action === 'status'
    ? new Set(['json'])
    : action === 'revoke'
      ? new Set(['yes'])
      : action === 'expose'
        ? new Set(['bind', 'port', 'hostname', 'cert', 'key', 'allow-networks', 'trusted-origins', 'preview-domain', 'client-ca', 'all-interfaces', 'allow-all-clients', 'yes'])
        : new Set<string>();
  for (const option of args.options.keys()) {
    if (!allowed.has(option)) throw new Error(`Gateway ${action ?? 'command'} does not accept --${option}.`);
  }
}

export async function inspectGatewayExposureRuntime(
  state: LoadedState,
  dependencies: Pick<GatewayCommandDependencies, 'observeGateway' | 'observeComputer'>,
): Promise<GatewayExposureRuntimeReview> {
  const gateway = await dependencies.observeGateway(state);
  const gatewayState = requirePreservedRuntimeState(gateway, 'Gateway');
  const computers: Record<string, ManagedRuntimeGroupObservation> = {};
  const runningComputerIds: string[] = [];
  for (const computer of state.config.computers) {
    const observation = await dependencies.observeComputer(state, computer);
    const computerState = requirePreservedRuntimeState(observation, `Computer ${computer.name}`);
    computers[computer.id] = observation;
    if (computerState === 'running') runningComputerIds.push(computer.id);
  }
  if (gatewayState !== 'running' && runningComputerIds.length) {
    throw new Error(`Gateway is ${gatewayState} while ${runningComputerIds.length} computer runtime(s) are running; reconcile the runtime before changing remote access.`);
  }
  return { state: gatewayState, gateway, computers, runningComputerIds };
}

export function gatewayExposureRuntimePlan(review: GatewayExposureRuntimeReview): GatewayExposureRuntimePlan {
  return {
    ...gatewayUpgradeRuntimePlan(true, review.state, review.gateway.containers),
    ...(review.state === 'running' && review.runningComputerIds.length
      ? { reconnectIds: [...review.runningComputerIds] }
      : {}),
  };
}

export function sameGatewayExposureRuntimeReview(
  left: GatewayExposureRuntimeReview,
  right: GatewayExposureRuntimeReview,
): boolean {
  return left.state === right.state
    && JSON.stringify(left.gateway) === JSON.stringify(right.gateway)
    && JSON.stringify(left.computers) === JSON.stringify(right.computers)
    && JSON.stringify(left.runningComputerIds) === JSON.stringify(right.runningComputerIds);
}

async function exposeGateway(args: ParsedArgs, dependencies: GatewayCommandDependencies): Promise<void> {
  const bindValue = requiredOption(args, 'bind');
  const port = numberOption(args, 'port');
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port must be an integer from 1 to 65535.');
  const hostname = normalizeGatewayHostname(requiredOption(args, 'hostname'));
  const previewDomainValue = stringOption(args, 'preview-domain');
  const previewDomain = previewDomainValue === undefined ? undefined : normalizeGatewayPreviewDomain(previewDomainValue);
  const bindAddress = normalizeBindAddress(bindValue);
  const allInterfaces = bindAddress === '0.0.0.0' || bindAddress === '::';
  if (allInterfaces && !flag(args, 'all-interfaces')) {
    throw new Error(`Binding ${bindAddress} requires --all-interfaces so all-interface exposure cannot be enabled accidentally.`);
  }
  if (!allInterfaces && flag(args, 'all-interfaces')) throw new Error('--all-interfaces is accepted only with --bind 0.0.0.0 or --bind ::.');
  const allowedNetworks = parseCommaSeparatedOption(requiredOption(args, 'allow-networks'), '--allow-networks');
  const allowsEveryClient = allowedNetworks.some((network) => network.endsWith('/0'));
  if (allowsEveryClient && !flag(args, 'allow-all-clients')) {
    throw new Error('An allowlist containing 0.0.0.0/0 or ::/0 requires --allow-all-clients.');
  }
  if (!allowsEveryClient && flag(args, 'allow-all-clients')) throw new Error('--allow-all-clients is accepted only when the network allowlist contains 0.0.0.0/0 or ::/0.');
  const trustedOrigins = parseCommaSeparatedOption(stringOption(args, 'trusted-origins'), '--trusted-origins');
  const validatedTls = await validateGatewayTlsInput({
    certificatePath: requiredOption(args, 'cert'),
    privateKeyPath: requiredOption(args, 'key'),
    ...(stringOption(args, 'client-ca') ? { clientCertificateAuthorityPath: stringOption(args, 'client-ca')! } : {}),
    hostname,
    ...(previewDomain ? { previewDomain } : {}),
  });
  const exposure = buildGatewayExposureConfig({
    bindAddress,
    port,
    hostname,
    allowedNetworks,
    trustedOrigins,
    ...(previewDomain ? { previewDomain } : {}),
    tls: validatedTls.metadata,
  });

  const paths = dependencies.paths();
  await dependencies.withStateLock(paths, async () => {
    const state = await dependencies.loadState(paths);
    if (state.config.gateway.port === exposure.port) {
      throw new Error(`External TLS port ${exposure.port} must differ from the local gateway port.`);
    }
    assertBindAddressPresent(exposure.bindAddress);
    await dependencies.validateDocker();
    await dependencies.assertGatewayExposureSupport(state);
    if (previewDomain) await dependencies.assertRemotePreviewSupport(state);
    const review = await inspectGatewayExposureRuntime(state, dependencies);
    const currentlyManagedPort = state.config.gateway.exposure?.port === exposure.port
      && state.config.gateway.exposure.bindAddress === exposure.bindAddress
      && review.gateway.group === 'complete';
    if (!currentlyManagedPort && !await dependencies.portAvailable(exposure.port, exposure.bindAddress)) {
      throw new Error(`${exposure.bindAddress}:${exposure.port} is already in use.`);
    }
    printExposurePreview(state, exposure, validatedTls, review, dependencies.write);
    await requireTypedConfirmation(
      args,
      dependencies,
      `Type "expose ${exposure.hostname}" to enable this HTTPS listener: `,
      `expose ${exposure.hostname}`,
    );
    const currentReview = await inspectGatewayExposureRuntime(state, dependencies);
    if (!sameGatewayExposureRuntimeReview(review, currentReview)) {
      throw new Error('Gateway or computer runtime state changed while exposure was being reviewed. No Qubicl state was changed.');
    }
    if (!currentlyManagedPort && !await dependencies.portAvailable(exposure.port, exposure.bindAddress)) {
      throw new Error(`${exposure.bindAddress}:${exposure.port} became unavailable after confirmation. No Qubicl state was changed.`);
    }
    state.config.gateway.exposure = exposure;
    state.secrets.gateway = { tls: validatedTls.secret };
    state.config = ConfigSchema.parse(state.config);
    state.secrets = SecretsSchema.parse(state.secrets);
    await dependencies.executeTransaction(paths, state, gatewayExposureRuntimePlan(review));
    const finalReview = await inspectGatewayExposureRuntime(state, dependencies);
    if (finalReview.state !== review.state) throw new Error(`Gateway runtime state changed from ${review.state} to ${finalReview.state} while exposure was applied.`);
    if (finalReview.state !== 'absent') {
      const publication = await dependencies.externalPublication(state);
      if (publication?.hostIp !== exposure.bindAddress || publication.hostPort !== exposure.port || publication.verificationIssue) {
        throw new Error('Gateway runtime did not confirm the exact configured external address and port.');
      }
    }
    if (review.state === 'running') assertExternalHealth(await dependencies.localHealth(state), exposure);
    dependencies.write(`Remote gateway access is configured at ${gatewayExposureOrigin(exposure)}.`);
    dependencies.write(review.state === 'running'
      ? 'The gateway was recreated and previously running computers were reconnected; durable homes and computer identities were unchanged.'
      : `The gateway remained ${review.state}; remote access will become active the next time it is started.`);
  });
}

async function revokeGateway(args: ParsedArgs, dependencies: GatewayCommandDependencies): Promise<void> {
  const paths = dependencies.paths();
  await dependencies.withStateLock(paths, async () => {
    const state = await dependencies.loadState(paths);
    const exposure = state.config.gateway.exposure;
    await dependencies.validateDocker();
    const review = await inspectGatewayExposureRuntime(state, dependencies);
    const publication = review.state === 'absent' ? undefined : await dependencies.externalPublication(state);
    const runtimeSnapshot = await dependencies.runtimeSnapshotPresent(paths);
    if (!exposure && !publication && !runtimeSnapshot) {
      dependencies.write('Remote gateway access is already off, no external gateway port is published, and no managed TLS snapshot remains.');
      return;
    }
    if (!exposure) {
      dependencies.write([
        'Gateway exposure drift cleanup preview',
        `  observed publication drift: ${publication ? publicationDescription(publication) : 'none'}`,
        `  managed TLS runtime snapshot: ${runtimeSnapshot ? 'present and will be removed' : 'absent'}`,
        `  gateway runtime: ${review.state}${review.state === 'running' ? ' (will be recreated; active sessions disconnect)' : ' (will remain stopped)'}`,
        '  preserve: local loopback gateway, computer IDs/tokens/policies/resources, and every durable home',
      ].join('\n'));
      await requireTypedConfirmation(args, dependencies, 'Type "revoke gateway" to reconcile local-only access: ', 'revoke gateway');
      const currentReview = await inspectGatewayExposureRuntime(state, dependencies);
      const currentPublication = currentReview.state === 'absent' ? undefined : await dependencies.externalPublication(state);
      const currentSnapshot = await dependencies.runtimeSnapshotPresent(paths);
      if (!sameGatewayExposureRuntimeReview(review, currentReview)
        || JSON.stringify(publication) !== JSON.stringify(currentPublication)
        || runtimeSnapshot !== currentSnapshot) {
        throw new Error('Gateway exposure drift changed while revocation was being reviewed. No Qubicl state was changed.');
      }
      await dependencies.executeTransaction(paths, state, gatewayExposureRuntimePlan(review));
      const finalReview = await inspectGatewayExposureRuntime(state, dependencies);
      if (finalReview.state !== review.state) throw new Error(`Gateway runtime state changed from ${review.state} to ${finalReview.state} during revoke.`);
      const remainingPublication = finalReview.state === 'absent' ? undefined : await dependencies.externalPublication(state);
      if (remainingPublication || await dependencies.runtimeSnapshotPresent(paths)) {
        throw new Error('Gateway exposure cleanup did not prove removal of the external publication and managed TLS snapshot.');
      }
      dependencies.write('Remote gateway drift was revoked. The loopback gateway and all computer data were preserved.');
      return;
    }
    dependencies.write([
      'Gateway exposure revoke preview',
      `  remove external listener: ${gatewayExposureOrigin(exposure)} on ${exposure.bindAddress}:${exposure.port}`,
      `  remove managed TLS snapshot: ${exposure.tls.certificateFingerprint256}`,
      `  gateway runtime: ${review.state}${review.state === 'running' ? ' (will be recreated; active sessions disconnect)' : ' (will remain stopped)'}`,
      '  preserve: local loopback gateway, computer IDs/tokens/policies/resources, and every durable home',
    ].join('\n'));
    await requireTypedConfirmation(
      args,
      dependencies,
      `Type "revoke ${exposure.hostname}" to remove remote access: `,
      `revoke ${exposure.hostname}`,
    );
    const currentReview = await inspectGatewayExposureRuntime(state, dependencies);
    if (!sameGatewayExposureRuntimeReview(review, currentReview)) {
      throw new Error('Gateway or computer runtime state changed while revocation was being reviewed. No Qubicl state was changed.');
    }
    delete state.config.gateway.exposure;
    delete state.secrets.gateway;
    state.config = ConfigSchema.parse(state.config);
    state.secrets = SecretsSchema.parse(state.secrets);
    await dependencies.executeTransaction(paths, state, gatewayExposureRuntimePlan(review));
    const finalReview = await inspectGatewayExposureRuntime(state, dependencies);
    if (finalReview.state !== review.state) throw new Error(`Gateway runtime state changed from ${review.state} to ${finalReview.state} during revoke.`);
    const remainingPublication = finalReview.state === 'absent' ? undefined : await dependencies.externalPublication(state);
    if (remainingPublication || await dependencies.runtimeSnapshotPresent(paths)) {
      throw new Error('Gateway revoke did not prove removal of the external publication and managed TLS snapshot.');
    }
    dependencies.write('Remote gateway access was revoked. The loopback gateway and all computer data were preserved.');
  });
}

async function gatewayExposureStatus(args: ParsedArgs, dependencies: GatewayCommandDependencies): Promise<void> {
  const state = await dependencies.loadState(dependencies.paths());
  const exposure = state.config.gateway.exposure;
  let runtime: ManagedRuntimeGroupObservation | { group: 'unknown'; status: 'unknown'; error: string };
  try {
    await dependencies.validateDocker();
    runtime = await dependencies.observeGateway(state);
  } catch (error) {
    runtime = { group: 'unknown', status: 'unknown', error: errorMessage(error) };
  }
  let publication: GatewayExternalPublication | undefined;
  let publicationChecked = runtime.group === 'absent';
  let publicationError: string | undefined;
  if (runtime.group !== 'absent' && runtime.group !== 'unknown') {
    try {
      publication = await dependencies.externalPublication(state);
      publicationChecked = true;
    } catch (error) {
      publicationError = errorMessage(error);
    }
  }
  let runtimeSnapshot: boolean | undefined;
  let runtimeSnapshotError: string | undefined;
  try { runtimeSnapshot = await dependencies.runtimeSnapshotPresent(state.paths); }
  catch (error) { runtimeSnapshotError = errorMessage(error); }
  if (exposure && runtimeSnapshot === true && runtimeSnapshotError === undefined) {
    try { await dependencies.validateRuntimeSnapshot(state); }
    catch (error) { runtimeSnapshotError = errorMessage(error); }
  }
  const health = runtime.status === 'running' ? await dependencies.localHealth(state) : undefined;
  const externalHealth = (health as {
    external?: { configured?: unknown; ready?: unknown; protocol?: unknown; configurationId?: unknown };
  } | null)?.external;
  let recoveryRequired: boolean | undefined;
  let recoveryError: string | undefined;
  try { recoveryRequired = await dependencies.pendingRecovery(state.paths); }
  catch (error) { recoveryError = errorMessage(error); }
  const publicationMatches = exposure !== undefined
    && publication?.hostIp === exposure.bindAddress
    && publication.hostPort === exposure.port
    && publication.verificationIssue === undefined;
  const publicationExpected = exposure !== undefined && runtime.group !== 'absent' && runtime.group !== 'unknown';
  const publicationDrift = publicationChecked
    && (publicationExpected ? !publicationMatches : publication !== undefined);
  const runtimeSnapshotDrift = runtimeSnapshot !== undefined
    && runtimeSnapshot !== (exposure !== undefined);
  const drift = publicationDrift || runtimeSnapshotDrift || recoveryRequired === true;
  let certificate: ReturnType<typeof validateConfiguredGatewayTls> | { error: string } | undefined;
  if (exposure) {
    try { certificate = validateConfiguredGatewayTls(exposure, state.secrets.gateway!.tls); }
    catch (error) { certificate = { error: errorMessage(error) }; }
  }
  const certificateValid = certificate !== undefined && !('error' in certificate);
  const active = exposure !== undefined
    && runtime.status === 'running'
    && publicationMatches
    && runtimeSnapshot === true
    && runtimeSnapshotError === undefined
    && recoveryRequired === false
    && recoveryError === undefined
    && externalHealth?.configured === true
    && externalHealth.ready === true
    && externalHealth.protocol === 'direct-tls-v1'
    && externalHealth.configurationId === gatewayExposureRuntimeId(gatewayExposureRuntime(exposure))
    && certificateValid;
  const value = {
    enabled: exposure !== undefined,
    active,
    drift,
    local: { origin: `http://127.0.0.1:${state.config.gateway.port}`, preserved: true },
    runtime,
    recovery: { required: recoveryRequired ?? null, error: recoveryError ?? null },
    observed: {
      publication: publication ?? null,
      publicationChecked,
      runtimeSnapshot: runtimeSnapshot ?? null,
      errors: [publicationError, runtimeSnapshotError].filter((value): value is string => value !== undefined),
    },
    ...(exposure ? {
      external: {
        protocol: exposure.protocol,
        origin: gatewayExposureOrigin(exposure),
        bindAddress: exposure.bindAddress,
        port: exposure.port,
        allowedNetworks: exposure.allowedNetworks,
        trustedOrigins: exposure.trustedOrigins,
        previewDomain: exposure.previewDomain ?? null,
        certificate,
        health: health ?? null,
        firewall: 'not managed by Qubicl; verify the host firewall separately',
      },
      computers: state.config.computers.map((computer) => ({
        name: computer.name,
        id: computer.id,
        endpoints: gatewayEndpointSet(state.config.gateway, computer, 'remote'),
      })),
    } : {}),
  };
  if (flag(args, 'json')) {
    dependencies.write(JSON.stringify(value, null, 2));
    return;
  }
  if (!exposure) {
    const stateLabel = drift
      ? 'off in configuration (managed exposure drift detected; run `qubicl gateway revoke`)'
      : publicationChecked && runtimeSnapshot !== undefined
        ? 'off (local-only state verified)'
        : 'off in configuration (runtime verification incomplete)';
    dependencies.write([
      `Remote gateway access: ${stateLabel}`,
      `Local gateway: http://127.0.0.1:${state.config.gateway.port}`,
      `Observed publication: ${publication ? publicationDescription(publication) : publicationChecked ? 'none' : 'unknown'}`,
      `Managed TLS snapshot: ${runtimeSnapshot === undefined ? 'unknown' : runtimeSnapshot ? 'present' : 'absent'}`,
      ...(publicationError ? [`Publication inspection: ${publicationError}`] : []),
      ...(runtimeSnapshotError ? [`TLS snapshot inspection: ${runtimeSnapshotError}`] : []),
      ...(recoveryRequired ? ['Recovery: a pending Qubicl transaction must complete before exposure can be reported active.'] : []),
      ...(recoveryError ? [`Recovery inspection: ${recoveryError}`] : []),
      `Runtime: ${runtime.status}`,
    ].join('\n'));
    return;
  }
  dependencies.write([
    `Remote gateway access: configured (${active ? 'active' : runtime.status === 'running' ? 'unavailable' : 'inactive while the gateway is stopped'})`,
    `Local gateway: http://127.0.0.1:${state.config.gateway.port}`,
    `External origin: ${gatewayExposureOrigin(exposure)}`,
    `Binding: ${exposure.bindAddress}:${exposure.port}`,
    `Allowed networks: ${exposure.allowedNetworks.join(', ')}`,
    `Trusted browser origins: ${exposure.trustedOrigins.join(', ')}`,
    `Remote previews: ${exposure.previewDomain ? `enabled under *.${exposure.previewDomain}` : 'disabled (no wildcard preview domain configured)'}`,
    `Client certificate: ${certificate && 'clientCertificatesRequired' in certificate && certificate.clientCertificatesRequired ? 'required' : 'not required'}`,
    `Certificate: ${exposure.tls.certificateFingerprint256}; expires ${exposure.tls.certificateNotAfter}`,
    ...(certificate && 'error' in certificate ? [`Certificate status: invalid — ${certificate.error}`] : []),
    `Observed publication: ${publication ? publicationDescription(publication) : publicationChecked ? 'none' : 'unknown'}`,
    `Managed TLS snapshot: ${runtimeSnapshot === undefined ? 'unknown' : runtimeSnapshot ? 'present' : 'absent'}`,
    ...(drift ? ['Exposure state: drift detected; run `qubicl doctor` and reconcile with `qubicl gateway expose` or `qubicl gateway revoke`.'] : []),
    ...(publicationError ? [`Publication inspection: ${publicationError}`] : []),
    ...(runtimeSnapshotError ? [`TLS snapshot inspection: ${runtimeSnapshotError}`] : []),
    ...(recoveryRequired ? ['Recovery: pending; exposure is not reported active until roll-forward completes.'] : []),
    ...(recoveryError ? [`Recovery inspection: ${recoveryError}`] : []),
    `Runtime: ${runtime.status}`,
    'Firewall: not managed by Qubicl; verify the host firewall separately.',
  ].join('\n'));
}

function printExposurePreview(
  state: LoadedState,
  exposure: GatewayExposureConfig,
  certificate: Awaited<ReturnType<typeof validateGatewayTlsInput>>,
  review: GatewayExposureRuntimeReview,
  write: (message: string) => void,
): void {
  const surfaces = state.config.computers.map((computer) => {
    const names = ['MCP', 'OpenAPI', 'Open Terminal', ...(computer.capabilities.includes('viewer') ? ['viewer'] : [])];
    return `    ${computer.name}: ${names.join(', ')}`;
  });
  write([
    'Gateway exposure preview',
    `  external HTTPS/WSS origin: ${gatewayExposureOrigin(exposure)}`,
    `  host binding: ${exposure.bindAddress}:${exposure.port}${['0.0.0.0', '::'].includes(exposure.bindAddress) ? ' (every host interface)' : ''}`,
    `  allowed client networks: ${exposure.allowedNetworks.join(', ')}`,
    `  trusted browser origins: ${exposure.trustedOrigins.join(', ')}`,
    `  certificate fingerprint: ${exposure.tls.certificateFingerprint256}`,
    `  certificate subject: ${certificate.certificateSubject || '(empty)'}`,
    `  certificate issuer: ${certificate.certificateIssuer || '(empty)'}`,
    `  certificate SANs: ${certificate.certificateSubjectAltName || '(none)'}`,
    `  certificate validity: ${exposure.tls.certificateNotBefore} through ${exposure.tls.certificateNotAfter}`,
    `  client certificates: ${exposure.tls.clientCertificateAuthoritySha256 ? 'required' : 'not required'}`,
    `  remote previews: ${exposure.previewDomain ? `enabled under *.${exposure.previewDomain}` : 'disabled; local *.localhost previews remain available'}`,
    `  routed computers: ${state.config.computers.length}`,
    ...(surfaces.length ? surfaces : ['    none']),
    `  gateway runtime: ${review.state}${review.state === 'running' ? ' (will be recreated; active gateway, viewer, and MCP connections disconnect)' : ' (will remain stopped)'}`,
    '  remains local-only: the existing HTTP listener on 127.0.0.1',
    '  preserved: all computer containers, IDs, bearer tokens, policies, resources, and durable homes',
    '  firewall: Qubicl does not modify or verify the host firewall; restrict it separately',
  ].join('\n'));
}

async function requireTypedConfirmation(
  args: ParsedArgs,
  dependencies: GatewayCommandDependencies,
  message: string,
  expected: string,
): Promise<void> {
  if (flag(args, 'yes')) return;
  if (!dependencies.interactive) throw new Error('Non-interactive gateway exposure changes require --yes.');
  const answer = (await dependencies.question(message)).trim();
  if (answer !== expected) throw new Error('Gateway exposure change was cancelled; confirmation text did not match.');
}

function assertBindAddressPresent(bindAddress: string): void {
  if (!gatewayBindAddressPresent(bindAddress)) throw new Error(`Bind address ${bindAddress} is not assigned to a host network interface.`);
}

function assertExternalHealth(value: unknown, exposure: GatewayExposureConfig | undefined): void {
  const external = (value as { external?: unknown } | null)?.external as {
    configured?: unknown;
    ready?: unknown;
    protocol?: unknown;
    configurationId?: unknown;
  } | undefined;
  const expectedConfigured = exposure !== undefined;
  if (!external || external.configured !== expectedConfigured
    || (exposure && (external.ready !== true
      || external.protocol !== 'direct-tls-v1'
      || external.configurationId !== gatewayExposureRuntimeId(gatewayExposureRuntime(exposure))))
    || (!exposure && external.ready !== false)) {
    throw new Error(exposure
      ? 'Gateway restarted, but its local health response did not confirm the configured TLS listener.'
      : 'Gateway restarted, but its local health response did not confirm that external access is disabled.');
  }
}

function requiredOption(args: ParsedArgs, name: string): string {
  const value = stringOption(args, name);
  if (!value) throw new Error(`Gateway expose requires --${name}.`);
  return value;
}

function defaultDependencies(): GatewayCommandDependencies {
  return {
    paths: statePaths,
    withStateLock,
    loadState,
    validateDocker,
    assertGatewayExposureSupport: assertConfiguredGatewaySupportsExposure,
    assertRemotePreviewSupport: assertConfiguredComputersSupportRemotePreviews,
    externalPublication: inspectGatewayExternalPublication,
    runtimeSnapshotPresent: gatewayExposureRuntimeSnapshotPresent,
    validateRuntimeSnapshot: async (state) => { await validateGatewayExposureRuntimeSnapshot(state); },
    observeGateway: managedGatewayRuntimeObservation,
    observeComputer: managedComputerRuntimeObservation,
    portAvailable,
    executeTransaction: async (paths, state, runtime) => {
      await executeStateTransaction(paths, createStateTransaction('config', state, { runtime }));
    },
    localHealth: async (state) => {
      try {
        const response = await fetch(`http://127.0.0.1:${state.config.gateway.port}/health`, { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) return undefined;
        return response.json();
      } catch { return undefined; }
    },
    pendingRecovery: async (paths) => (await inspectPendingTransaction(paths)) !== undefined,
    question: async (message) => {
      const input = createInterface({ input: stdin, output: stdout });
      try { return await input.question(message); }
      finally { input.close(); }
    },
    interactive: Boolean(stdin.isTTY && stdout.isTTY),
    write: (message) => console.log(message),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicationDescription(publication: GatewayExternalPublication): string {
  const target = publication.target === 'local-http'
    ? 'local HTTP'
    : publication.target === 'unexpected'
      ? 'unexpected gateway port'
      : 'external TLS';
  const endpoint = publication.hostIp !== undefined && publication.hostPort !== undefined
    ? ` ${publication.hostIp}:${publication.hostPort}`
    : '';
  const issue = publication.verificationIssue ? ` (${publication.verificationIssue})` : '';
  return `${target}${endpoint}${issue}${publication.detail ? ` — ${publication.detail}` : ''}`;
}
