import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';

export const DASHBOARD_PASSWORD_MIN_CODE_POINTS = 15;
export const DASHBOARD_PASSWORD_MAX_CODE_POINTS = 128;
export const DASHBOARD_SESSION_IDLE_MS = 30 * 60 * 1_000;
export const DASHBOARD_SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1_000;
export const DASHBOARD_REAUTHENTICATION_MS = 5 * 60 * 1_000;

const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_SALT_LENGTH = 16;
const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;
const MAX_KDF_QUEUE = 8;
const MAX_SESSIONS = 128;
const MAX_RATE_BUCKETS = 1_024;
const RATE_WINDOW_MS = 5 * 60 * 1_000;
const PEER_FAILURE_LIMIT = 5;
const GLOBAL_FAILURE_LIMIT = 20;

const BLOCKED_PASSWORDS = new Set([
  '123456789012345',
  'correcthorsebatterystaple',
  'letmeinletmeinletmein',
  'passwordpassword',
  'qubicladministrator',
  'qubicl-dashboard',
  'qubiclpassword',
]);

export interface DashboardPasswordVerifier {
  algorithm: 'scrypt';
  N: number;
  r: number;
  p: number;
  keyLength: number;
  salt: string;
  hash: string;
}

export interface DashboardSessionView {
  id: string;
  createdAt: string;
  lastActivityAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  reauthenticatedUntil?: string;
}

export interface DashboardAuthenticatedSession {
  actorId: string;
  csrfToken: string;
  reauthenticated: boolean;
  view: DashboardSessionView;
}

export class DashboardAuthError extends Error {
  constructor(
    readonly code: 'invalid_credentials' | 'rate_limited' | 'server_busy' | 'password_unavailable',
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'DashboardAuthError';
  }
}

interface SessionRecord {
  id: string;
  tokenHash: string;
  csrfToken: string;
  createdAt: number;
  lastActivityAt: number;
  absoluteExpiresAt: number;
  reauthenticatedUntil?: number;
}

interface RateBucket {
  failures: number;
  resetsAt: number;
}

interface KdfWork<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

class SingleKdfQueue {
  private active = false;
  private readonly pending: Array<KdfWork<unknown>> = [];

  async schedule<T>(run: () => Promise<T>): Promise<T> {
    if (this.pending.length >= MAX_KDF_QUEUE) {
      throw new DashboardAuthError('server_busy', 'Password verification is busy. Try again shortly.', 503, 1);
    }
    return await new Promise<T>((resolve, reject) => {
      this.pending.push({ run, resolve, reject } as KdfWork<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    if (this.active) return;
    const work = this.pending.shift();
    if (!work) return;
    this.active = true;
    void work.run().then(work.resolve, work.reject).finally(() => {
      this.active = false;
      this.drain();
    });
  }
}

const KDF_QUEUE = new SingleKdfQueue();

export function validateDashboardPassword(password: string): void {
  if (typeof password !== 'string') throw new Error('Administrator password must be text.');
  const length = Array.from(password).length;
  if (length < DASHBOARD_PASSWORD_MIN_CODE_POINTS) {
    throw new Error(`Administrator password must contain at least ${DASHBOARD_PASSWORD_MIN_CODE_POINTS} characters.`);
  }
  if (length > DASHBOARD_PASSWORD_MAX_CODE_POINTS) {
    throw new Error(`Administrator password must contain at most ${DASHBOARD_PASSWORD_MAX_CODE_POINTS} characters.`);
  }
  const comparable = password.normalize('NFKC').toLocaleLowerCase('en-US').replaceAll(/[^a-z0-9]/gu, '');
  if (BLOCKED_PASSWORDS.has(comparable) || comparable.includes('qubiclpassword')) {
    throw new Error('Choose an administrator password that is not a common or Qubicl-specific password.');
  }
}

export async function hashDashboardPassword(password: string): Promise<DashboardPasswordVerifier> {
  validateDashboardPassword(password);
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const hash = await deriveScrypt(password, salt);
  return {
    algorithm: 'scrypt',
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keyLength: SCRYPT_KEY_LENGTH,
    salt: salt.toString('base64url'),
    hash: hash.toString('base64url'),
  };
}

export function assertDashboardPasswordVerifier(value: unknown): asserts value is DashboardPasswordVerifier {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Dashboard password verifier is invalid.');
  const verifier = value as Partial<DashboardPasswordVerifier>;
  if (verifier.algorithm !== 'scrypt' || verifier.N !== SCRYPT_N || verifier.r !== SCRYPT_R
    || verifier.p !== SCRYPT_P || verifier.keyLength !== SCRYPT_KEY_LENGTH
    || typeof verifier.salt !== 'string' || typeof verifier.hash !== 'string') {
    throw new Error('Dashboard password verifier parameters are unsupported.');
  }
  const salt = decodeBase64Url(verifier.salt);
  const hash = decodeBase64Url(verifier.hash);
  if (salt.length !== SCRYPT_SALT_LENGTH || hash.length !== SCRYPT_KEY_LENGTH) {
    throw new Error('Dashboard password verifier is malformed.');
  }
}

export async function verifyDashboardPassword(password: string, verifier: DashboardPasswordVerifier): Promise<boolean> {
  assertDashboardPasswordVerifier(verifier);
  if (typeof password !== 'string' || Array.from(password).length > DASHBOARD_PASSWORD_MAX_CODE_POINTS) return false;
  const expected = decodeBase64Url(verifier.hash);
  const actual = await deriveScrypt(password, decodeBase64Url(verifier.salt));
  return timingSafeEqual(actual, expected);
}

export interface DashboardAuthManagerOptions {
  verifier?: DashboardPasswordVerifier;
  now?: () => number;
  idleMs?: number;
  absoluteMs?: number;
  reauthenticationMs?: number;
}

export class DashboardAuthManager {
  private readonly sessionsByHash = new Map<string, SessionRecord>();
  private readonly peerFailures = new Map<string, RateBucket>();
  private globalFailures: RateBucket = { failures: 0, resetsAt: 0 };
  private verifier: DashboardPasswordVerifier | undefined;
  private authorizationGeneration = 0;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly reauthenticationMs: number;

  constructor(options: DashboardAuthManagerOptions = {}) {
    if (options.verifier) assertDashboardPasswordVerifier(options.verifier);
    this.verifier = options.verifier ? structuredClone(options.verifier) : undefined;
    this.now = options.now ?? Date.now;
    this.idleMs = positiveDuration(options.idleMs, DASHBOARD_SESSION_IDLE_MS, 'idle');
    this.absoluteMs = positiveDuration(options.absoluteMs, DASHBOARD_SESSION_ABSOLUTE_MS, 'absolute');
    this.reauthenticationMs = positiveDuration(options.reauthenticationMs, DASHBOARD_REAUTHENTICATION_MS, 'reauthentication');
  }

  hasPassword(): boolean {
    return this.verifier !== undefined;
  }

  replacePasswordVerifier(verifier: DashboardPasswordVerifier): void {
    assertDashboardPasswordVerifier(verifier);
    this.verifier = structuredClone(verifier);
    this.revokeAll();
  }

  refreshPasswordVerifier(verifier: DashboardPasswordVerifier): boolean {
    assertDashboardPasswordVerifier(verifier);
    if (this.verifier && passwordVerifierEqual(this.verifier, verifier)) return false;
    this.verifier = structuredClone(verifier);
    this.revokeAll();
    return true;
  }

  removePasswordVerifier(): void {
    this.verifier = undefined;
    this.revokeAll();
  }

  async login(password: unknown, peer: string): Promise<{ token: string; session: DashboardAuthenticatedSession }> {
    const now = this.now();
    this.assertAttemptAllowed(peer, now);
    const verifier = this.verifier;
    if (!verifier) {
      throw new DashboardAuthError('password_unavailable', 'Administrator password has not been configured.', 503);
    }
    const generation = this.authorizationGeneration;
    const valid = await this.verifyAttempt(password, peer, now, verifier);
    if (!valid) throw new DashboardAuthError('invalid_credentials', 'Invalid administrator password.', 401);
    if (generation !== this.authorizationGeneration || this.verifier !== verifier) {
      throw new DashboardAuthError('invalid_credentials', 'Administrator authentication changed during sign-in.', 401);
    }
    this.clearPeerFailures(peer);
    this.prune(now);
    if (this.sessionsByHash.size >= MAX_SESSIONS) {
      throw new DashboardAuthError('server_busy', 'Too many dashboard sessions are active.', 503);
    }
    const token = randomBytes(32).toString('base64url');
    const record: SessionRecord = {
      id: randomUUID(),
      tokenHash: tokenHash(token),
      csrfToken: randomBytes(32).toString('base64url'),
      createdAt: now,
      lastActivityAt: now,
      absoluteExpiresAt: now + this.absoluteMs,
    };
    this.sessionsByHash.set(record.tokenHash, record);
    return { token, session: this.toAuthenticated(record, now) };
  }

  authenticate(token: string | undefined): DashboardAuthenticatedSession | undefined {
    if (!token) return undefined;
    const now = this.now();
    const hash = tokenHash(token);
    const record = this.sessionsByHash.get(hash);
    if (!record) return undefined;
    if (this.expired(record, now)) {
      this.sessionsByHash.delete(hash);
      return undefined;
    }
    return this.toAuthenticated(record, now);
  }

  hasValidCsrf(token: string, supplied: string | undefined): boolean {
    if (!supplied) return false;
    const record = this.activeRecord(token);
    return record ? secretEqual(record.csrfToken, supplied) : false;
  }

  recordActivity(token: string): DashboardAuthenticatedSession | undefined {
    const record = this.activeRecord(token);
    if (!record) return undefined;
    const now = this.now();
    record.lastActivityAt = now;
    return this.toAuthenticated(record, now);
  }

  async reauthenticate(token: string, password: unknown, peer: string): Promise<{ token: string; session: DashboardAuthenticatedSession }> {
    const record = this.activeRecord(token);
    if (!record) throw new DashboardAuthError('invalid_credentials', 'Dashboard session is not authenticated.', 401);
    const now = this.now();
    this.assertAttemptAllowed(peer, now);
    const verifier = this.verifier;
    const generation = this.authorizationGeneration;
    const originalHash = record.tokenHash;
    if (!verifier || !await this.verifyAttempt(password, peer, now, verifier)) {
      throw new DashboardAuthError('invalid_credentials', 'Invalid administrator password.', 401);
    }
    if (generation !== this.authorizationGeneration || this.verifier !== verifier
      || this.sessionsByHash.get(originalHash) !== record || record.tokenHash !== originalHash) {
      throw new DashboardAuthError('invalid_credentials', 'Dashboard session changed during reauthentication.', 401);
    }
    this.clearPeerFailures(peer);
    this.sessionsByHash.delete(originalHash);
    const rotatedToken = randomBytes(32).toString('base64url');
    record.tokenHash = tokenHash(rotatedToken);
    record.csrfToken = randomBytes(32).toString('base64url');
    record.lastActivityAt = now;
    record.reauthenticatedUntil = Math.min(now + this.reauthenticationMs, record.absoluteExpiresAt);
    this.sessionsByHash.set(record.tokenHash, record);
    return { token: rotatedToken, session: this.toAuthenticated(record, now) };
  }

  logout(token: string): boolean {
    return this.sessionsByHash.delete(tokenHash(token));
  }

  revoke(sessionId: string): boolean {
    this.prune(this.now());
    for (const [hash, record] of this.sessionsByHash) {
      if (record.id === sessionId) return this.sessionsByHash.delete(hash);
    }
    return false;
  }

  revokeAll(): void {
    this.authorizationGeneration += 1;
    this.sessionsByHash.clear();
  }

  list(): DashboardSessionView[] {
    const now = this.now();
    this.prune(now);
    return [...this.sessionsByHash.values()]
      .map((record) => sessionView(record, this.idleMs))
      .toSorted((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
  }

  private activeRecord(token: string): SessionRecord | undefined {
    const now = this.now();
    const hash = tokenHash(token);
    const record = this.sessionsByHash.get(hash);
    if (!record) return undefined;
    if (this.expired(record, now)) {
      this.sessionsByHash.delete(hash);
      return undefined;
    }
    return record;
  }

  private toAuthenticated(record: SessionRecord, now: number): DashboardAuthenticatedSession {
    return {
      actorId: record.id,
      csrfToken: record.csrfToken,
      reauthenticated: (record.reauthenticatedUntil ?? 0) > now,
      view: sessionView(record, this.idleMs),
    };
  }

  private expired(record: SessionRecord, now: number): boolean {
    return now >= record.absoluteExpiresAt || now - record.lastActivityAt >= this.idleMs;
  }

  private prune(now: number): void {
    for (const [hash, record] of this.sessionsByHash) if (this.expired(record, now)) this.sessionsByHash.delete(hash);
    for (const [peer, bucket] of this.peerFailures) if (bucket.resetsAt <= now) this.peerFailures.delete(peer);
    if (this.globalFailures.resetsAt <= now) this.globalFailures = { failures: 0, resetsAt: now + RATE_WINDOW_MS };
  }

  private async verifyAttempt(password: unknown, peer: string, now: number, verifier: DashboardPasswordVerifier): Promise<boolean> {
    if (typeof password !== 'string' || Array.from(password).length > DASHBOARD_PASSWORD_MAX_CODE_POINTS) {
      this.recordFailure(peer, now);
      return false;
    }
    let valid = false;
    try {
      valid = await verifyDashboardPassword(password, verifier);
    } catch (error) {
      if (error instanceof DashboardAuthError && error.code === 'server_busy') throw error;
      throw error;
    }
    if (!valid) this.recordFailure(peer, this.now());
    return valid;
  }

  private assertAttemptAllowed(peer: string, now: number): void {
    this.prune(now);
    const peerBucket = this.peerFailures.get(peer);
    if ((peerBucket?.failures ?? 0) >= PEER_FAILURE_LIMIT || this.globalFailures.failures >= GLOBAL_FAILURE_LIMIT) {
      const resetsAt = Math.max(peerBucket?.resetsAt ?? now, this.globalFailures.resetsAt);
      throw new DashboardAuthError('rate_limited', 'Too many failed password attempts. Try again later.', 429, Math.max(1, Math.ceil((resetsAt - now) / 1_000)));
    }
  }

  private recordFailure(peer: string, now: number): void {
    if (!this.peerFailures.has(peer) && this.peerFailures.size >= MAX_RATE_BUCKETS) {
      const oldest = this.peerFailures.keys().next().value as string | undefined;
      if (oldest) this.peerFailures.delete(oldest);
    }
    const peerBucket = activeBucket(this.peerFailures.get(peer), now);
    peerBucket.failures += 1;
    this.peerFailures.set(peer, peerBucket);
    this.globalFailures = activeBucket(this.globalFailures, now);
    this.globalFailures.failures += 1;
  }

  private clearPeerFailures(peer: string): void {
    this.peerFailures.delete(peer);
  }
}

function sessionView(record: SessionRecord, idleMs: number): DashboardSessionView {
  return {
    id: record.id,
    createdAt: new Date(record.createdAt).toISOString(),
    lastActivityAt: new Date(record.lastActivityAt).toISOString(),
    idleExpiresAt: new Date(Math.min(record.lastActivityAt + idleMs, record.absoluteExpiresAt)).toISOString(),
    absoluteExpiresAt: new Date(record.absoluteExpiresAt).toISOString(),
    ...(record.reauthenticatedUntil ? { reauthenticatedUntil: new Date(record.reauthenticatedUntil).toISOString() } : {}),
  };
}

function activeBucket(bucket: RateBucket | undefined, now: number): RateBucket {
  return !bucket || bucket.resetsAt <= now ? { failures: 0, resetsAt: now + RATE_WINDOW_MS } : bucket;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

function secretEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('Dashboard password verifier encoding is invalid.');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new Error('Dashboard password verifier encoding is invalid.');
  return decoded;
}

function deriveScrypt(password: string, salt: Buffer): Promise<Buffer> {
  return KDF_QUEUE.schedule(async () => await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAX_MEMORY,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(Buffer.from(derivedKey));
    });
  }));
}

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) throw new Error(`Dashboard ${name} duration must be a positive integer.`);
  return selected;
}

function passwordVerifierEqual(left: DashboardPasswordVerifier, right: DashboardPasswordVerifier): boolean {
  return left.algorithm === right.algorithm && left.N === right.N && left.r === right.r && left.p === right.p
    && left.keyLength === right.keyLength && secretEqual(left.salt, right.salt) && secretEqual(left.hash, right.hash);
}
