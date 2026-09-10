import { randomUUID, X509Certificate } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { stdin, stdout } from 'node:process';
import type { ParsedArgs } from '../args.js';
import { flag, numberOption, stringOption } from '../args.js';
import { browserOpenInvocation, inspectHostPlatform } from '../host-platform.js';
import { run, validateDocker } from '../docker.js';
import { ensureCurrentState, inspectStateFormat } from '../migrations.js';
import { inHostOperation } from '../operation-context.js';
import { loadState, statePaths, withStateLock } from '../state.js';
import { hashDashboardPassword, DashboardAuthManager } from './auth.js';
import { DashboardServer } from './server.js';
import { ManagementApplication } from './application.js';
import { VerifiedDashboardAssetLoader } from './assets.js';
import { dashboardStoragePaths, initializeDashboardStorage, loadDashboardAuthDocument, saveDashboardAuthDocument } from './storage.js';
import { assertDashboardRuntime, acquireDashboardImage, dashboardCatalogIdentity, readDashboardConfiguration, saveDashboardConfiguration, setDashboardRunning, startDashboardAtCurrentCatalog, type DashboardConfiguration } from './runtime.js';
import { dashboardPeerPolicy, readTlsFile, sha256, validateDashboardExposure } from './exposure.js';
import { manageDashboardService } from './service.js';

export async function dashboardCommand(args: ParsedArgs): Promise<void> {
  const action = args.positionals[0] ?? 'status';
  if (['status', 'open', 'serve'].includes(action)) return dashboardCommandUnlocked(args);
  const paths = statePaths();
  await inHostOperation(paths.root, () => withStateLock(paths, () => dashboardCommandUnlocked(args)), false);
  if (action === 'enable' && flag(args, 'foreground')) {
    const config = await readDashboardConfiguration(paths.root);
    if (!config) throw new Error('Dashboard configuration was not saved.');
    await serveDashboard(paths.root, config);
  }
}

async function dashboardCommandUnlocked(args: ParsedArgs): Promise<void> {
  const root = statePaths().root;
  const action = args.positionals[0] ?? 'status';
  const host = await inspectHostPlatform();
  if (host.wsl || !((host.platform === 'linux' && host.arch === 'x64') || (host.platform === 'darwin' && host.arch === 'arm64'))) throw new Error('The dashboard service is not yet qualified on this platform. Existing Qubicl CLI workflows remain available.');
  if (process.getuid?.() === 0) throw new Error('Run the dashboard as the normal Qubicl owner, never root.');
  const storage = dashboardStoragePaths(root);
  if (action === 'enable') {
    await initializeDashboardStorage(storage);
    const format = await inspectStateFormat(statePaths(root));
    if (format.status === 'invalid' || format.status === 'migration-pending') throw new Error('Recover existing state before enabling the dashboard.');
    if (format.status === 'legacy') {
      stdout.write('This installation requires a backed-up state migration to format 4. Older CLIs will refuse the migrated state.\n');
      if (!flag(args, 'yes')) await confirmEnable('Migrate state and enable the dashboard? Type yes: ');
      await withStateLock(statePaths(root), () => ensureCurrentState(statePaths(root)));
    } else if (!flag(args, 'yes')) await confirmEnable('Enable the local dashboard and its login-time helper? Type yes: ');
    const old = await readDashboardConfiguration(root);
    const core = await optionalCoreState(root);
    const identity = await dashboardCatalogIdentity();
    const config: DashboardConfiguration = old ?? {
      schemaVersion: 1, installationId: core?.config.installationId ?? randomUUID(), enabled: true, desiredRunning: true,
      localPort: numberOption(args, 'port') ?? 3212, assetPort: numberOption(args, 'asset-port') ?? 3213, ...identity,
    };
    if (!await loadDashboardAuthDocument(storage)) {
      const password = await promptPassword('Administrator password: ');
      if (password !== await promptPassword('Repeat password: ')) throw new Error('Passwords did not match.');
      await saveDashboardAuthDocument(storage, { schemaVersion: 1, password: await hashDashboardPassword(password), updatedAt: new Date().toISOString() });
    }
    config.enabled = true; config.desiredRunning = true;
    await saveDashboardConfiguration(root, config);
    const dockerAvailable = await validateDocker().then(() => true, () => false);
    if (dockerAvailable) await startDashboardAtCurrentCatalog(root, config, flag(args, 'offline'));
    else stdout.write('Docker is unavailable. The authenticated local recovery helper can start; run dashboard start after Docker is available.\n');
    if (flag(args, 'foreground')) return;
    try { await manageDashboardService(root, config.installationId, 'enable'); } catch (error) { throw new Error('Login-time service could not start. Use qubicl dashboard serve in a local terminal; Docker and the service manager are never started automatically.', { cause: error }); }
    stdout.write(`Dashboard enabled: http://qubicl-admin.localhost:${config.localPort}\n`);
    return;
  }
  const config = await readDashboardConfiguration(root);
  if (!config) {
    if (action === 'status') { stdout.write('Dashboard is not enabled. Run qubicl dashboard enable.\n'); return; }
    throw new Error('Enable the dashboard first.');
  }
  if (action === 'status') {
    stdout.write(`${JSON.stringify({ enabled: config.enabled, desiredRunning: config.desiredRunning, local: `http://qubicl-admin.localhost:${config.localPort}`, remote: config.remote ? { origin: `https://${config.remote.hostname}:${config.remote.port}`, expiresAt: config.remote.expiresAt } : null, image: config.image }, null, 2)}\n`); return;
  }
  if (action === 'open') {
    const invocation = browserOpenInvocation(`http://qubicl-admin.localhost:${config.localPort}`, host);
    await run(invocation.command, invocation.args); return;
  }
  if (action === 'serve') { if (!config.enabled) throw new Error('Dashboard is disabled.'); return serveDashboard(root, config); }
  if (action === 'sessions' && args.positionals[1] === 'revoke-all') {
    const current = await loadDashboardAuthDocument(storage);
    if (!current) throw new Error('Administrator password is unavailable.');
    if (!flag(args, 'yes')) await confirmEnable('Revoke all administrator browser sessions? Type yes: ');
    await saveDashboardAuthDocument(storage, { ...current, updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString() });
    stdout.write('All administrator sessions will be revoked on the next helper authentication refresh.\n'); return;
  }
  if (action === 'password' && args.positionals[1] === 'reset') {
    const password = await promptPassword('New administrator password: ');
    if (password !== await promptPassword('Repeat password: ')) throw new Error('Passwords did not match.');
    await saveDashboardAuthDocument(storage, { schemaVersion: 1, password: await hashDashboardPassword(password), updatedAt: new Date().toISOString() });
    stdout.write('Administrator password replaced. Active sessions will be revoked.\n'); return;
  }
  if (action === 'expose') {
    const cert = stringOption(args, 'cert'); const key = stringOption(args, 'key');
    if (!cert || !key) throw new Error('Remote management requires --cert and --key supplied on the host.');
    const certificate = await readTlsFile(cert, false); const privateKey = await readTlsFile(key, true);
    const remote = { bind: stringOption(args, 'bind') ?? '', hostname: stringOption(args, 'hostname') ?? '', port: numberOption(args, 'port') ?? 3214, allowNetworks: (stringOption(args, 'allow-networks') ?? '').split(',').filter(Boolean), certificate, privateKey, certificateSha256: sha256(certificate), privateKeySha256: sha256(privateKey), expiresAt: new Date(new X509Certificate(certificate).validTo).toISOString() };
    if ([config.localPort, config.assetPort].includes(remote.port)) throw new Error('Remote port must differ from local and asset ports.');
    validateDashboardExposure(remote, await optionalCoreState(root));
    stdout.write(`Remote administration: https://${remote.hostname}:${remote.port}; bind ${remote.bind}; clients ${remote.allowNetworks.join(', ')}\n`);
    if (!flag(args, 'yes')) await confirmEnable('Enable this private remote administrative listener? Type yes: ');
    config.remote = remote; await saveDashboardConfiguration(root, config); return;
  }
  if (action === 'revoke') { delete config.remote; await saveDashboardConfiguration(root, config); stdout.write('Remote dashboard access revoked. Local access is preserved.\n'); return; }
  if (action === 'disable' || action === 'stop' || action === 'start' || action === 'restart') {
    if (action === 'disable') { config.enabled = false; await saveDashboardConfiguration(root, config); }
    if (action === 'start' || action === 'restart') await startDashboardAtCurrentCatalog(root, config, flag(args, 'offline'), action === 'restart');
    else await setDashboardRunning(root, false);
    await manageDashboardService(root, config.installationId, action); return;
  }
  throw new Error('Unknown dashboard action. Use enable, disable, start, stop, restart, status, open, serve, expose, revoke, or password reset.');
}

async function serveDashboard(root: string, config: DashboardConfiguration): Promise<void> {
  return withStateLock({ ...statePaths(root), lock: join(root, 'dashboard', 'helper.lock') }, () => runDashboard(root, config));
}

async function runDashboard(root: string, config: DashboardConfiguration): Promise<void> {
  const addresses = await lookup('qubicl-admin.localhost', { all: true }).catch(() => []);
  const localBindings = dashboardLoopbackBindings(addresses.map(({ address }) => address));
  const storage = dashboardStoragePaths(root);
  const document = await loadDashboardAuthDocument(storage);
  if (!document) throw new Error('Set an administrator password through qubicl dashboard enable.');
  const auth = new DashboardAuthManager({ verifier: document.password });
  const application = new ManagementApplication(root); await application.initialize();
  const assets = new VerifiedDashboardAssetLoader({ endpoint: `http://127.0.0.1:${config.assetPort}`, expectedManifestSha256: config.assetManifestSha256 });
  const embeddedDashboard = await dashboardCatalogIdentity();
  const synchronizeAssetTrust = async (): Promise<void> => {
    const latest = await readDashboardConfiguration(root);
    if (latest?.image.requested === embeddedDashboard.image.requested
      && latest.image.resolved === embeddedDashboard.image.resolved
      && latest.assetManifestSha256 === embeddedDashboard.assetManifestSha256) {
      assets.updateExpectedManifestSha256(embeddedDashboard.assetManifestSha256);
    }
  };
  let authStamp = document.updatedAt;
  const refresh = async (): Promise<void> => {
    const current = await loadDashboardAuthDocument(storage);
    if (!current) { auth.removePasswordVerifier(); throw new Error('Administrator verifier unavailable.'); }
    if (current.updatedAt !== authStamp) { auth.revokeAll(); authStamp = current.updatedAt; }
    auth.refreshPasswordVerifier(current.password);
  };
  const localServers: DashboardServer[] = [];
  try {
    for (const binding of localBindings) {
      const server = new DashboardServer({ origin: `http://qubicl-admin.localhost:${config.localPort}`, auth, application, assets, authRefresh: refresh });
      await server.start({ ...binding, port: config.localPort });
      localServers.push(server);
    }
  } catch (error) {
    await Promise.all(localServers.map(async (server) => await server.close()));
    throw error;
  }
  let remote: DashboardServer | undefined;
  let remoteFingerprint = '';
  let stopping = false;
  let remoteRefresh: Promise<void> | undefined;
  const performRemoteRefresh = async (): Promise<void> => {
    if (stopping) return;
    try {
      const latest = await readDashboardConfiguration(root);
      if (stopping || !latest?.enabled) {
        await remote?.close(); remote = undefined; remoteFingerprint = '';
        return;
      }
      const fingerprint = latest?.remote ? sha256(JSON.stringify(latest.remote)) : '';
      if (latest?.remote) validateDashboardExposure(latest.remote, await optionalCoreState(root));
      if (fingerprint === remoteFingerprint) return;
      await remote?.close(); remote = undefined; remoteFingerprint = '';
      if (stopping || !latest?.remote) return;
      validateDashboardExposure(latest.remote, await optionalCoreState(root));
      const remoteDocument = (await loadDashboardAuthDocument(storage))!;
      const remoteAuth = new DashboardAuthManager({ verifier: remoteDocument.password });
      let remoteAuthStamp = remoteDocument.updatedAt;
      const next = new DashboardServer({ origin: `https://${latest.remote.hostname}:${latest.remote.port}`, auth: remoteAuth, authRefresh: async () => { const current = await loadDashboardAuthDocument(storage); if (!current) { remoteAuth.removePasswordVerifier(); throw new Error('Administrator verifier unavailable.'); } if (current.updatedAt !== remoteAuthStamp) { remoteAuth.revokeAll(); remoteAuthStamp = current.updatedAt; } remoteAuth.refreshPasswordVerifier(current.password); }, application, assets, tls: { certificate: latest.remote.certificate, privateKey: latest.remote.privateKey }, allowPeer: dashboardPeerPolicy(latest.remote.allowNetworks) });
      remote = next;
      await next.start({ host: latest.remote.bind, port: latest.remote.port });
      if (stopping) { await next.close(); if (remote === next) remote = undefined; return; }
      remoteFingerprint = fingerprint;
    } catch (error) { await remote?.close(); remote = undefined; remoteFingerprint = ''; throw error; }
  };
  const refreshRemote = (): Promise<void> => {
    if (remoteRefresh) return remoteRefresh;
    const refresh = performRemoteRefresh();
    const tracked = refresh.finally(() => { if (remoteRefresh === tracked) remoteRefresh = undefined; });
    remoteRefresh = tracked;
    return tracked;
  };
  await refreshRemote().catch(() => { stdout.write('Remote dashboard unavailable; local recovery remains available.\n'); });
  const timer = setInterval(() => { void refreshRemote().catch(() => undefined); }, 2000);
  let restoring = false;
  const restoreAssets = async (): Promise<void> => {
    if (restoring) return; restoring = true;
    try {
      await restoreDashboardAssetsIfDesired(root);
    } catch { /* Authenticated local recovery remains available. */ } finally { restoring = false; }
  };
  void restoreAssets();
  const assetTimer = setInterval(() => { void restoreAssets(); }, 30000);
  const assetTrustTimer = setInterval(() => { void synchronizeAssetTrust().catch(() => undefined); }, 1000);

  stdout.write(`Qubicl dashboard: http://qubicl-admin.localhost:${config.localPort}\n`);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      if (stopping) return; stopping = true;
      clearInterval(timer); clearInterval(assetTimer); clearInterval(assetTrustTimer); clearInterval(enabledTimer);
      process.off('SIGTERM', stop); process.off('SIGINT', stop);
      const closeRemote = async (): Promise<void> => {
        await remoteRefresh?.catch(() => undefined);
        await remote?.close(); remote = undefined;
      };
      void Promise.all([...localServers.map(async (server) => await server.close()), closeRemote()]).finally(resolve);
    };
    const enabledTimer = setInterval(() => {
      void readDashboardConfiguration(root).then((latest) => { if (!latest?.enabled) stop(); }, stop);
    }, 1000);
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  });
}

export function dashboardLoopbackBindings(addresses: readonly string[]): Array<{ host: string; ipv6Only?: boolean }> {
  if (!addresses.length || addresses.some((address) => address !== '127.0.0.1' && address !== '::1')) {
    throw new Error('qubicl-admin.localhost must resolve only to loopback. Configure its local loopback mapping; Qubicl will not change host DNS automatically.');
  }
  const unique = new Set(addresses);
  return [
    ...(unique.has('127.0.0.1') ? [{ host: '127.0.0.1' }] : []),
    ...(unique.has('::1') ? [{ host: '::1', ipv6Only: true }] : []),
  ];
}

export interface DashboardAssetRecoveryRuntime {
  validateDocker(): Promise<void>;
  withLock<T>(root: string, action: () => Promise<T>): Promise<T>;
  readConfiguration(root: string): Promise<DashboardConfiguration | undefined>;
  assertRuntime(root: string, config: DashboardConfiguration, requireRunning: boolean): Promise<boolean>;
  acquireImage(root: string, config: DashboardConfiguration, offline: boolean): Promise<void>;
  setRunning(root: string, running: boolean): Promise<void>;
}

const defaultDashboardAssetRecoveryRuntime: DashboardAssetRecoveryRuntime = {
  validateDocker: async () => { await validateDocker(); },
  withLock: async (root, action) => await withStateLock(statePaths(root), action),
  readConfiguration: readDashboardConfiguration,
  assertRuntime: assertDashboardRuntime,
  acquireImage: acquireDashboardImage,
  setRunning: setDashboardRunning,
};

/** Restore only the desired dashboard runtime selected under the installation lock. */
export async function restoreDashboardAssetsIfDesired(
  root: string,
  runtime: DashboardAssetRecoveryRuntime = defaultDashboardAssetRecoveryRuntime,
): Promise<void> {
  await runtime.validateDocker();
  await runtime.withLock(root, async () => {
    const latest = await runtime.readConfiguration(root);
    if (!latest?.enabled || !latest.desiredRunning) return;
    if (await runtime.assertRuntime(root, latest, true)) return;
    // Login recovery never pulls images or starts Docker; enable/start own acquisition.
    await runtime.acquireImage(root, latest, true);
    await runtime.setRunning(root, true);
  });
}

async function confirmEnable(message: string): Promise<void> {
  if (!stdin.isTTY) throw new Error('Use --yes after reviewing this operation. Password input still requires a local terminal.');
  const { createInterface } = await import('node:readline/promises');
  const prompt = createInterface({ input: stdin, output: stdout });
  try { if ((await prompt.question(message)).trim() !== 'yes') throw new Error('Cancelled.'); } finally { prompt.close(); }
}
export async function promptPassword(message: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Administrator password input requires a local terminal.');
  stdout.write(message);
  const priorRaw = stdin.isRaw; stdin.setRawMode(true); stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const decoder = new StringDecoder('utf8');
    const done = (error?: Error): void => { stdin.off('data', data); stdin.setRawMode(priorRaw); stdin.pause(); stdout.write('\n'); if (error) reject(error); else resolve(value); };
    const data = (chunk: Buffer): void => {
      for (const character of decoder.write(chunk)) {
        if (character === '\u0003') { done(new Error('Cancelled.')); return; }
        if (character === '\r' || character === '\n') { done(); return; }
        if (character === '\u007f' || character === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (character >= ' ' && Buffer.byteLength(value) < 1024) value += character;
      }
    };
    stdin.on('data', data);
  });
}

async function optionalCoreState(root: string): Promise<Awaited<ReturnType<typeof loadState>> | undefined> {
  const format = await inspectStateFormat(statePaths(root));
  if (format.status === 'uninitialized') return undefined;
  if (format.status !== 'current') throw new Error('Core state must be valid before administration TLS can be evaluated.');
  return loadState(statePaths(root));
}
