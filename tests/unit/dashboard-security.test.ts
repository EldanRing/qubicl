import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { request as httpRequest, createServer as createHttpServer, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DASHBOARD_SESSION_ABSOLUTE_MS,
  DASHBOARD_SESSION_IDLE_MS,
  DashboardAuthManager,
  hashDashboardPassword,
  validateDashboardPassword,
} from '../../packages/cli/dist/dashboard/auth.js';
import { DashboardAssetError, VerifiedDashboardAssetLoader, type DashboardAssetManifest } from '../../packages/cli/dist/dashboard/assets.js';
import {
  createDashboardServer,
  type DashboardApplicationAdapter,
  type DashboardApplicationEvent,
} from '../../packages/cli/dist/dashboard/server.js';
import {
  dashboardStoragePaths,
  initializeDashboardStorage,
  loadDashboardAuthDocument,
  saveDashboardAuthDocument,
} from '../../packages/cli/dist/dashboard/storage.js';
import { TEST_GATEWAY_CERTIFICATE_PEM, TEST_GATEWAY_PRIVATE_KEY_PEM } from './gateway-test-fixtures.js';

const PASSWORD = 'harbor glass orbit meadow 47';
const verifierPromise = hashDashboardPassword(PASSWORD);

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

test('dashboard password and storage use bounded scrypt parameters and private no-follow documents', async () => {
  assert.throws(() => validateDashboardPassword('short password'), /at least 15/);
  assert.throws(() => validateDashboardPassword('qubicl-password'), /common or Qubicl-specific/);
  validateDashboardPassword(PASSWORD);
  const verifier = await verifierPromise;
  assert.deepEqual({ algorithm: verifier.algorithm, N: verifier.N, r: verifier.r, p: verifier.p, keyLength: verifier.keyLength }, {
    algorithm: 'scrypt', N: 2 ** 17, r: 8, p: 1, keyLength: 32,
  });

  const root = await mkdtemp(join(tmpdir(), 'qubicl-dashboard-storage-'));
  const paths = dashboardStoragePaths(root);
  try {
    await initializeDashboardStorage(paths);
    await saveDashboardAuthDocument(paths, { schemaVersion: 1, password: verifier, updatedAt: new Date().toISOString() });
    assert.equal((await stat(paths.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.auth)).mode & 0o777, 0o600);
    assert.equal((await loadDashboardAuthDocument(paths))?.password.hash, verifier.hash);
    assert.equal((await readFile(paths.auth, 'utf8')).includes(PASSWORD), false);

    await rm(paths.auth);
    await symlink('/etc/passwd', paths.auth);
    await assert.rejects(loadDashboardAuthDocument(paths), /symbolic link|ELOOP|regular private file/i);
    await assert.rejects(
      saveDashboardAuthDocument(paths, { schemaVersion: 1, password: verifier, updatedAt: new Date().toISOString() }),
      /regular private file/i,
    );
    assert.equal((await lstat(paths.auth)).isSymbolicLink(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dashboard sessions expire on user-idle and absolute clocks without polling refresh', async () => {
  let now = Date.parse('2026-09-07T12:00:00.000Z');
  const verifier = await verifierPromise;
  const auth = new DashboardAuthManager({ verifier, now: () => now });
  const { token, session } = await auth.login(PASSWORD, '192.0.2.10');
  assert.equal(auth.authenticate(token)?.actorId, session.actorId);

  now += 20 * 60 * 1_000;
  assert.equal(auth.authenticate(token)?.view.lastActivityAt, session.view.lastActivityAt, 'authentication checks and polling do not record activity');
  assert.equal(auth.recordActivity(token)?.actorId, session.actorId);
  now += 29 * 60 * 1_000;
  assert.equal(auth.authenticate(token)?.actorId, session.actorId);
  now += 61 * 1_000;
  assert.equal(auth.authenticate(token), undefined);

  now = Date.parse('2026-09-08T12:00:00.000Z');
  const next = await auth.login(PASSWORD, '192.0.2.10');
  assert.notEqual(next.token, token, 'each login creates a fresh session token');
  const rotated = await auth.reauthenticate(next.token, PASSWORD, '192.0.2.10');
  assert.equal(auth.authenticate(next.token), undefined, 'reauthentication invalidates the prior cookie token');
  assert.notEqual(rotated.token, next.token);
  assert.equal(rotated.session.actorId, next.session.actorId, 'session rotation preserves only the opaque audit actor');
  for (let elapsed = 29 * 60 * 1_000; elapsed < DASHBOARD_SESSION_ABSOLUTE_MS; elapsed += 29 * 60 * 1_000) {
    now = Date.parse('2026-09-08T12:00:00.000Z') + elapsed;
    assert.ok(auth.recordActivity(rotated.token));
  }
  now = Date.parse('2026-09-08T12:00:00.000Z') + DASHBOARD_SESSION_ABSOLUTE_MS;
  assert.equal(auth.authenticate(rotated.token), undefined, 'activity cannot extend the 12-hour absolute lifetime');
  assert.equal(DASHBOARD_SESSION_IDLE_MS, 30 * 60 * 1_000);

  const stable = new DashboardAuthManager({ verifier });
  const stableSession = await stable.login(PASSWORD, '127.0.0.1');
  assert.equal(stable.refreshPasswordVerifier(structuredClone(verifier)), false);
  assert.ok(stable.authenticate(stableSession.token));
  const changed = { ...verifier, hash: `${verifier.hash.startsWith('A') ? 'B' : 'A'}${verifier.hash.slice(1)}` };
  assert.equal(stable.refreshPasswordVerifier(changed), true);
  assert.equal(stable.authenticate(stableSession.token), undefined, 'a changed verifier revokes every session');

  const loginRace = new DashboardAuthManager({ verifier });
  const pendingLogin = loginRace.login(PASSWORD, '127.0.0.1');
  loginRace.revokeAll();
  await assert.rejects(pendingLogin, /authentication changed during sign-in/);
  assert.deepEqual(loginRace.list(), [], 'revoke-all also fences an in-flight password derivation');

  const reauthRace = new DashboardAuthManager({ verifier });
  const beforeReauth = await reauthRace.login(PASSWORD, '127.0.0.1');
  const pendingReauth = reauthRace.reauthenticate(beforeReauth.token, PASSWORD, '127.0.0.1');
  assert.equal(reauthRace.logout(beforeReauth.token), true);
  await assert.rejects(pendingReauth, /session changed during reauthentication/);
  assert.deepEqual(reauthRace.list(), [], 'in-flight reauthentication cannot resurrect a revoked session');
});

test('dashboard asset loader forwards no browser authority and verifies manifest, bytes, type, and bounds', async () => {
  const fixture = await startAssetFixture();
  try {
    const loader = new VerifiedDashboardAssetLoader({
      endpoint: fixture.endpoint,
      expectedManifestSha256: sha256(fixture.manifestBytes),
    });
    const loaded = await loader.load('/');
    assert.equal(loaded.bytes.toString('utf8'), fixture.index.toString('utf8'));
    assert.equal(loaded.contentType, 'text/html; charset=utf-8');
    assert.equal(fixture.requests.length, 2);
    for (const headers of fixture.requests) {
      assert.equal(headers.cookie, undefined);
      assert.equal(headers.authorization, undefined);
      assert.equal(headers.origin, undefined);
      assert.equal(headers.referer, undefined);
    }

    fixture.index = Buffer.from('<!doctype html><title>tampered</title>');
    const tampered = new VerifiedDashboardAssetLoader({
      endpoint: fixture.endpoint,
      expectedManifestSha256: sha256(fixture.manifestBytes),
    });
    await assert.rejects(tampered.load('/'), (error: unknown) => error instanceof DashboardAssetError && error.code === 'asset_integrity_failed');
    assert.throws(() => new VerifiedDashboardAssetLoader({
      endpoint: 'http://host.docker.internal:3219', expectedManifestSha256: sha256(fixture.manifestBytes),
    }), /loopback IP/);
  } finally {
    await closeServer(fixture.server);
  }
});

test('dashboard HTTP helper enforces Host, Origin, CSRF, response secrecy, recovery scope, and disconnect-safe execution', async () => {
  const fixture = await startAssetFixture();
  const verifier = await verifierPromise;
  const auth = new DashboardAuthManager({ verifier });
  let actorId = '';
  let finishExecution: (() => void) | undefined;
  let executionStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { executionStarted = resolve; });
  let executionCompleted = false;
  const application: DashboardApplicationAdapter = {
    query: async (resource, params) => params.get('secret') === '1' ? { token: 'must-not-leak' } : { resource, ok: true },
    plan: async (body, sessionId) => {
      actorId = sessionId;
      return { id: 'plan_12345678', operation: body.operation, effects: [], preserved: [], warnings: [], requiresInterruption: false, requiresReauthentication: false, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
    execute: async (_planId, _body, sessionId, reauthenticated) => {
      assert.equal(sessionId, actorId);
      assert.equal(reauthenticated, false);
      executionStarted?.();
      await new Promise<void>((resolve) => { finishExecution = resolve; });
      executionCompleted = true;
      return { operationId: 'operation_12345678' };
    },
    operation: async (id) => ({ id, status: 'running' }),
    action: async (resource, _body, sessionId) => ({ resource, actorMatches: sessionId === actorId }),
    events: async function* (_signal): AsyncIterable<DashboardApplicationEvent> {
      yield { id: '1', event: 'snapshot', data: { ok: true } };
    },
  };
  const loader = new VerifiedDashboardAssetLoader({ endpoint: fixture.endpoint, expectedManifestSha256: sha256(fixture.manifestBytes), availabilityTtlMs: 1 });
  const dashboard = createDashboardServer({ origin: 'http://qubicl-admin.localhost', auth, application, assets: loader });
  const address = await dashboard.start({ host: '127.0.0.1', port: 0 });
  const baseHeaders = { host: 'qubicl-admin.localhost' };
  try {
    const wrongHost = await rawRequest(address.port, '/api/v1/session', { headers: { host: '127.0.0.1' } });
    assert.equal(wrongHost.status, 421);
    const wrongOrigin = await rawRequest(address.port, '/api/v1/session/login', {
      method: 'POST', headers: { ...baseHeaders, origin: 'http://attacker.localhost', 'content-type': 'application/json' }, body: { password: PASSWORD },
    });
    assert.equal(wrongOrigin.status, 403);

    const login = await rawRequest(address.port, '/api/v1/session/login', {
      method: 'POST', headers: { ...baseHeaders, origin: 'http://qubicl-admin.localhost', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: { password: PASSWORD },
    });
    assert.equal(login.status, 200);
    assert.equal(login.headers['access-control-allow-origin'], undefined);
    assert.match(String(login.headers['content-security-policy']), /frame-ancestors 'none'/);
    const loginBody = JSON.parse(login.body.toString('utf8')) as { authenticated: boolean; csrfToken: string; authorizationToken: string };
    assert.equal(loginBody.authenticated, true);
    assert.equal(login.headers['set-cookie'], undefined, 'local HTTP authentication is never ambient cookie authority');
    assert.match(loginBody.authorizationToken, /^[A-Za-z0-9_-]{43}$/u);
    const authorization = `Qubicl-Session ${loginBody.authorizationToken}`;

    const ambientCookie = await rawRequest(address.port, '/api/v1/snapshot', {
      headers: { ...baseHeaders, cookie: `qubicl-admin-local=${loginBody.authorizationToken}` },
    });
    assert.equal(ambientCookie.status, 401, 'a cookie copied across localhost ports has no local dashboard authority');
    const snapshot = await rawRequest(address.port, '/api/v1/snapshot', { headers: { ...baseHeaders, authorization } });
    assert.deepEqual(JSON.parse(snapshot.body.toString('utf8')), { resource: '/snapshot', ok: true });
    assert.equal((await rawRequest(address.port, '/api/v1/activity', { headers: { ...baseHeaders, authorization } })).status, 200);
    assert.equal((await rawRequest(address.port, '/api/v1/settings', { headers: { ...baseHeaders, authorization } })).status, 200);
    const computerId = '123e4567-e89b-42d3-a456-426614174000';
    assert.equal((await rawRequest(address.port, `/api/v1/computers/${computerId}/credentials`, { headers: { ...baseHeaders, authorization } })).status, 200);
    const secretResponse = await rawRequest(address.port, '/api/v1/snapshot?secret=1', { headers: { ...baseHeaders, authorization } });
    assert.equal(secretResponse.status, 500);
    assert.equal(secretResponse.body.toString('utf8').includes('must-not-leak'), false);

    const noCsrf = await rawRequest(address.port, '/api/v1/plans', {
      method: 'POST', headers: { ...baseHeaders, authorization, origin: 'http://qubicl-admin.localhost', 'content-type': 'application/json' }, body: { operation: 'gateway.start' },
    });
    assert.equal(noCsrf.status, 403);
    const mutationHeaders = { ...baseHeaders, authorization, origin: 'http://qubicl-admin.localhost', 'content-type': 'application/json', 'x-qubicl-csrf': loginBody.csrfToken };
    const plan = await rawRequest(address.port, '/api/v1/plans', { method: 'POST', headers: mutationHeaders, body: { operation: 'gateway.start' } });
    assert.equal(plan.status, 200);
    assert.notEqual(actorId, loginBody.authorizationToken, 'the application receives an opaque actor ID rather than the authorization token');
    const previewOpen = await rawRequest(address.port, `/api/v1/computers/${computerId}/previews/abcdefghijklmnop/open`, {
      method: 'POST', headers: mutationHeaders, body: { access: 'local' },
    });
    assert.equal(previewOpen.status, 200);
    assert.deepEqual(JSON.parse(previewOpen.body.toString('utf8')), {
      resource: `/computers/${computerId}/previews/abcdefghijklmnop/open`, actorMatches: true,
    });

    const asset = await rawRequest(address.port, '/', { headers: { ...baseHeaders, authorization } });
    assert.equal(asset.status, 200);
    assert.equal(fixture.requests.at(-1)?.cookie, undefined);
    assert.equal(fixture.requests.at(-1)?.authorization, undefined);

    const client = httpRequest({
      hostname: '127.0.0.1', port: address.port, path: '/api/v1/plans/plan_12345678/execute', method: 'POST',
      headers: { ...mutationHeaders, connection: 'close' },
    });
    client.on('error', () => undefined);
    client.end(JSON.stringify({ idempotencyKey: 'test-key-00000001' }));
    await started;
    client.destroy();
    finishExecution?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(executionCompleted, true, 'accepted execution survives browser disconnect');

    const events = await rawRequest(address.port, '/api/v1/events', { headers: { ...baseHeaders, authorization } });
    assert.equal(events.status, 200);
    assert.match(events.body.toString('utf8'), /event: snapshot/);
    assert.match(events.body.toString('utf8'), /data: \{"ok":true\}/);

    const reauth = await rawRequest(address.port, '/api/v1/session/reauth', {
      method: 'POST', headers: mutationHeaders, body: { password: PASSWORD },
    });
    assert.equal(reauth.status, 200);
    assert.equal(reauth.headers['set-cookie'], undefined);
    const reauthBody = JSON.parse(reauth.body.toString('utf8')) as { csrfToken: string; authorizationToken: string };
    assert.notEqual(reauthBody.authorizationToken, loginBody.authorizationToken);
    assert.equal((await rawRequest(address.port, '/api/v1/snapshot', { headers: { ...baseHeaders, authorization } })).status, 401, 'reauthentication invalidates the prior local authorization token');
    assert.equal((await rawRequest(address.port, '/api/v1/snapshot', { headers: { ...baseHeaders, authorization: `Qubicl-Session ${reauthBody.authorizationToken}` } })).status, 200);

    await closeServer(fixture.server);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const degraded = await rawRequest(address.port, '/', { headers: baseHeaders });
    assert.equal(degraded.status, 200);
    assert.match(degraded.body.toString('utf8'), /Qubicl recovery/, 'cached assets do not hide a stopped sidecar from local recovery');
  } finally {
    await dashboard.close();
  }

  await closeServer(fixture.server);
  const unavailable = new VerifiedDashboardAssetLoader({ endpoint: fixture.endpoint, expectedManifestSha256: sha256(fixture.manifestBytes), requestTimeoutMs: 100 });
  const recovery = createDashboardServer({ origin: 'http://qubicl-admin.localhost', auth, application, assets: unavailable });
  const recoveryAddress = await recovery.start({ host: '127.0.0.1', port: 0 });
  try {
    const page = await rawRequest(recoveryAddress.port, '/', { headers: baseHeaders });
    assert.equal(page.status, 200);
    assert.match(page.body.toString('utf8'), /Qubicl recovery/);
    assert.doesNotMatch(page.body.toString('utf8'), /<script[^>]*>[^<]/u, 'recovery page has no inline script');
    const recoveryScript = await rawRequest(recoveryAddress.port, '/recovery.js', { headers: baseHeaders });
    assert.match(recoveryScript.body.toString('utf8'), /requiresReauthentication/u);
    assert.match(recoveryScript.body.toString('utf8'), /\/api\/v1\/session\/reauth/u);

    const current = await rawRequest(recoveryAddress.port, '/api/v1/session', { headers: { ...baseHeaders, cookie: '' } });
    assert.equal(current.status, 200);
    const recoveryLogin = await rawRequest(recoveryAddress.port, '/api/v1/session/login', {
      method: 'POST', headers: { ...baseHeaders, origin: 'http://qubicl-admin.localhost', 'content-type': 'application/json' }, body: { password: PASSWORD },
    });
    const recoveryBody = JSON.parse(recoveryLogin.body.toString('utf8')) as { csrfToken: string; authorizationToken: string };
    const recoveryHeaders = { ...baseHeaders, authorization: `Qubicl-Session ${recoveryBody.authorizationToken}`, origin: 'http://qubicl-admin.localhost', 'content-type': 'application/json', 'x-qubicl-csrf': recoveryBody.csrfToken };
    const disallowed = await rawRequest(recoveryAddress.port, '/api/v1/plans', { method: 'POST', headers: recoveryHeaders, body: { operation: 'computer.create' } });
    assert.equal(disallowed.status, 503);
    const allowed = await rawRequest(recoveryAddress.port, '/api/v1/plans', { method: 'POST', headers: recoveryHeaders, body: { operation: 'gateway.start' } });
    assert.equal(allowed.status, 200);
  } finally {
    await recovery.close();
  }

  const remoteFixture = await startAssetFixture();
  const remoteLoader = new VerifiedDashboardAssetLoader({
    endpoint: remoteFixture.endpoint,
    expectedManifestSha256: sha256(remoteFixture.manifestBytes),
    availabilityTtlMs: 1,
    requestTimeoutMs: 100,
  });
  const remote = createDashboardServer({
    origin: 'https://gateway.example.test', auth, application, assets: remoteLoader,
    tls: { certificate: TEST_GATEWAY_CERTIFICATE_PEM, privateKey: TEST_GATEWAY_PRIVATE_KEY_PEM },
    allowPeer: (peer) => peer === '127.0.0.1',
  });
  const remoteAddress = await remote.start({ host: '127.0.0.1', port: 0 });
  try {
    const primed = await rawRequest(remoteAddress.port, '/', {
      secure: true, servername: 'gateway.example.test', headers: { host: 'gateway.example.test' },
    });
    assert.equal(primed.status, 200);
    const remoteLogin = await rawRequest(remoteAddress.port, '/api/v1/session/login', {
      method: 'POST', secure: true, servername: 'gateway.example.test',
      headers: { host: 'gateway.example.test', origin: 'https://gateway.example.test', 'content-type': 'application/json' },
      body: { password: PASSWORD },
    });
    assert.equal(remoteLogin.status, 200);
    assert.match(String(remoteLogin.headers['set-cookie']), /^__Host-qubicl-admin=.*; HttpOnly; Secure; SameSite=Strict; Path=\//u);
    assert.equal(Object.hasOwn(JSON.parse(remoteLogin.body.toString('utf8')) as object, 'authorizationToken'), false);
    const remoteAuthorization = await rawRequest(remoteAddress.port, '/api/v1/session', {
      secure: true, servername: 'gateway.example.test',
      headers: { host: 'gateway.example.test', authorization: `Qubicl-Session ${'A'.repeat(43)}` },
    });
    assert.equal(remoteAuthorization.status, 400, 'remote HTTPS never accepts the local authorization-token transport');
    await closeServer(remoteFixture.server);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const blocked = await rawRequest(remoteAddress.port, '/api/v1/session', {
      secure: true, servername: 'gateway.example.test', headers: { host: 'gateway.example.test' },
    });
    assert.equal(blocked.status, 503, 'remote API fails closed when verified dashboard assets are unavailable');
  } finally {
    await remote.close();
    await closeServer(remoteFixture.server);
  }
});

test('dashboard event streams end when their session is revoked without recording activity', async () => {
  const fixture = await startAssetFixture();
  const auth = new DashboardAuthManager({ verifier: await verifierPromise });
  const application: DashboardApplicationAdapter = {
    query: async () => ({}), plan: async () => ({}), execute: async () => ({}), operation: async () => ({}),
    events: async function* (signal): AsyncIterable<DashboardApplicationEvent> {
      let id = 0;
      while (!signal.aborted) {
        yield { id: String(++id), data: { ok: true } };
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
  const loader = new VerifiedDashboardAssetLoader({ endpoint: fixture.endpoint, expectedManifestSha256: sha256(fixture.manifestBytes), availabilityTtlMs: 1 });
  const dashboard = createDashboardServer({ origin: 'http://qubicl-admin.localhost', auth, application, assets: loader });
  const address = await dashboard.start({ host: '127.0.0.1', port: 0 });
  try {
    const login = await rawRequest(address.port, '/api/v1/session/login', {
      method: 'POST', headers: { host: 'qubicl-admin.localhost', origin: 'http://qubicl-admin.localhost', 'content-type': 'application/json' },
      body: { password: PASSWORD },
    });
    const token = (JSON.parse(login.body.toString('utf8')) as { authorizationToken: string }).authorizationToken;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Revoked dashboard event stream remained open.')), 1_000);
      const request = httpRequest({
        hostname: '127.0.0.1', port: address.port, path: '/api/v1/events',
        headers: { host: 'qubicl-admin.localhost', authorization: `Qubicl-Session ${token}` },
      }, (response) => {
        response.once('data', () => auth.revokeAll());
        response.once('close', () => { clearTimeout(timeout); resolve(); });
        response.resume();
      });
      request.once('error', (error) => { clearTimeout(timeout); reject(error); });
      request.end();
    });
  } finally {
    await dashboard.close();
    await closeServer(fixture.server);
  }
});

test('local session management rotates explicit authorization and revokes only the selected session', async () => {
  const fixture = await startAssetFixture();
  const auth = new DashboardAuthManager({ verifier: await verifierPromise });
  const application: DashboardApplicationAdapter = { query: async () => ({}), plan: async () => ({}), execute: async () => ({}), operation: async () => ({}) };
  const dashboard = createDashboardServer({ origin: 'http://qubicl-admin.localhost', auth, application, assets: new VerifiedDashboardAssetLoader({ endpoint: fixture.endpoint, expectedManifestSha256: sha256(fixture.manifestBytes) }) });
  const address = await dashboard.start({ host: '127.0.0.1', port: 0 });
  try {
    const primary = await auth.login(PASSWORD, '127.0.0.1');
    const other = await auth.login(PASSWORD, '127.0.0.2');
    const headers = { host: 'qubicl-admin.localhost', origin: 'http://qubicl-admin.localhost', 'content-type': 'application/json', authorization: `Qubicl-Session ${primary.token}`, 'x-qubicl-csrf': primary.session.csrfToken };
    const listing = await rawRequest(address.port, '/api/v1/sessions', { headers });
    assert.equal(listing.status, 200);
    const sessions = (JSON.parse(listing.body.toString()) as { sessions: Array<{ id: string; current: boolean }> }).sessions;
    assert.equal(sessions.find(({ id }) => id === primary.session.actorId)?.current, true);
    assert.equal(sessions.find(({ id }) => id === other.session.actorId)?.current, false);
    const activity = await rawRequest(address.port, '/api/v1/session/activity', { method: 'POST', headers, body: {} });
    assert.equal(activity.status, 200);
    const revoked = await rawRequest(address.port, `/api/v1/sessions/${other.session.actorId}`, { method: 'DELETE', headers, body: {} });
    assert.equal(revoked.status, 200);
    assert.equal(auth.authenticate(other.token), undefined);
    assert.ok(auth.authenticate(primary.token));
    assert.equal((await rawRequest(address.port, `/api/v1/sessions/${other.session.actorId}`, { method: 'DELETE', headers, body: {} })).status, 404);

    const reauthenticated = await rawRequest(address.port, '/api/v1/session/reauth', { method: 'POST', headers, body: { password: PASSWORD } });
    assert.equal(reauthenticated.status, 200);
    assert.equal(reauthenticated.headers['set-cookie'], undefined);
    const rotated = JSON.parse(reauthenticated.body.toString()) as { authorizationToken: string; csrfToken: string };
    assert.notEqual(rotated.authorizationToken, primary.token);
    assert.notEqual(rotated.csrfToken, primary.session.csrfToken);
    assert.equal((await rawRequest(address.port, '/api/v1/sessions', { headers })).status, 401);
    const rotatedHeaders = { ...headers, authorization: `Qubicl-Session ${rotated.authorizationToken}`, 'x-qubicl-csrf': rotated.csrfToken };
    const logout = await rawRequest(address.port, '/api/v1/session/logout', { method: 'POST', headers: rotatedHeaders, body: {} });
    assert.equal(logout.status, 200);
    assert.equal(logout.headers['set-cookie'], undefined);
    assert.equal(auth.authenticate(rotated.authorizationToken), undefined);
  } finally { await dashboard.close(); await closeServer(fixture.server); }
});

test('closing the dashboard terminates active event streams without waiting for session expiry', async () => {
  const fixture = await startAssetFixture();
  const auth = new DashboardAuthManager({ verifier: await verifierPromise });
  let streamAborted = false;
  const application: DashboardApplicationAdapter = {
    query: async () => ({}), plan: async () => ({}), execute: async () => ({}), operation: async () => ({}),
    events: async function* (signal): AsyncIterable<DashboardApplicationEvent> {
      try {
        yield { id: '1', data: { ok: true } };
        await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      } finally { streamAborted = signal.aborted; }
    },
  };
  const loader = new VerifiedDashboardAssetLoader({ endpoint: fixture.endpoint, expectedManifestSha256: sha256(fixture.manifestBytes) });
  const dashboard = createDashboardServer({ origin: 'http://qubicl-admin.localhost', auth, application, assets: loader });
  const address = await dashboard.start({ host: '127.0.0.1', port: 0 });
  const { token } = await auth.login(PASSWORD, '127.0.0.1');
  let request: ReturnType<typeof httpRequest> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { request?.destroy(); reject(new Error('Dashboard close waited for its live event stream.')); }, 1_000);
      request = httpRequest({ hostname: '127.0.0.1', port: address.port, path: '/api/v1/events', headers: { host: 'qubicl-admin.localhost', authorization: `Qubicl-Session ${token}` } }, (response) => {
        response.once('data', () => { void dashboard.close().then(() => { clearTimeout(timeout); resolve(); }, reject); });
        response.on('error', () => undefined);
        response.resume();
      });
      request.on('error', (error) => { clearTimeout(timeout); reject(error); });
      request.end();
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (streamAborted) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(streamAborted, true);
    assert.equal(dashboard.server.listening, false);
  } finally { request?.destroy(); await dashboard.close(); await closeServer(fixture.server); }
});

async function startAssetFixture(): Promise<{
  server: HttpServer;
  endpoint: string;
  manifestBytes: Buffer;
  index: Buffer;
  requests: IncomingHttpHeaders[];
}> {
  const state = {
    index: Buffer.from('<!doctype html><title>Qubicl dashboard</title>'),
    requests: [] as IncomingHttpHeaders[],
  };
  const manifest: DashboardAssetManifest = {
    schemaVersion: 1,
    entrypoint: '/index.html',
    assets: [{
      path: '/index.html', sha256: sha256(state.index), bytes: state.index.length,
      contentType: 'text/html; charset=utf-8', cache: 'no-store',
    }],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const server = createHttpServer((request, response) => {
    state.requests.push(request.headers);
    if (request.url === '/asset-manifest.json') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': manifestBytes.length });
      response.end(manifestBytes);
    } else if (request.url === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': state.index.length });
      response.end(state.index);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Asset fixture did not start.');
  return {
    server,
    endpoint: `http://127.0.0.1:${address.port}`,
    manifestBytes,
    get index() { return state.index; },
    set index(value: Buffer) { state.index = Buffer.from(value); },
    requests: state.requests,
  };
}

async function rawRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown; secure?: boolean; servername?: string } = {},
): Promise<RawResponse> {
  return await new Promise<RawResponse>((resolve, reject) => {
    const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    const request = (options.secure ? httpsRequest : httpRequest)({
      hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: {
        ...options.headers,
        ...(body ? { 'content-length': `${body.length}` } : {}),
      },
      ...(options.secure ? { servername: options.servername, rejectUnauthorized: false } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function closeServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
