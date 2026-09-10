import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';

const DEFAULT_MANIFEST_PATH = '/asset-manifest.json';
const DEFAULT_MANIFEST_LIMIT = 256 * 1024;
const DEFAULT_ASSET_LIMIT = 8 * 1024 * 1024;
const DEFAULT_TOTAL_ASSET_LIMIT = 32 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_AVAILABILITY_TTL_MS = 1_000;
const MAX_AVAILABILITY_TTL_MS = 2_000;
const ALLOWED_CONTENT_TYPES = new Set([
  'application/javascript; charset=utf-8',
  'application/json; charset=utf-8',
  'application/wasm',
  'font/woff2',
  'image/png',
  'image/svg+xml',
  'image/webp',
  'text/css; charset=utf-8',
  'text/html; charset=utf-8',
]);

export interface DashboardAssetManifestEntry {
  path: string;
  sha256: string;
  bytes: number;
  contentType: string;
  cache: 'no-store' | 'immutable';
}

export interface DashboardAssetManifest {
  schemaVersion: 1;
  entrypoint: string;
  assets: DashboardAssetManifestEntry[];
}

export interface VerifiedDashboardAsset {
  bytes: Buffer;
  contentType: string;
  cacheControl: string;
  etag: string;
}

export interface VerifiedDashboardAssetLoaderOptions {
  endpoint: string | URL;
  expectedManifestSha256: string;
  manifestPath?: string;
  manifestLimitBytes?: number;
  assetLimitBytes?: number;
  totalAssetLimitBytes?: number;
  requestTimeoutMs?: number;
  availabilityTtlMs?: number;
}

export class DashboardAssetError extends Error {
  constructor(
    readonly code: 'asset_unavailable' | 'asset_manifest_invalid' | 'asset_not_found' | 'asset_integrity_failed',
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DashboardAssetError';
  }
}

export class VerifiedDashboardAssetLoader {
  private readonly endpoint: URL;
  private expectedManifestSha256: string;
  private readonly manifestPath: string;
  private readonly manifestLimitBytes: number;
  private readonly assetLimitBytes: number;
  private readonly totalAssetLimitBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly availabilityTtlMs: number;
  private manifestPromise: Promise<{ manifest: DashboardAssetManifest; entries: Map<string, DashboardAssetManifestEntry> }> | undefined;
  private availabilityPromise: Promise<void> | undefined;
  private availabilityVerifiedAt = 0;
  private readonly cache = new Map<string, VerifiedDashboardAsset>();

  constructor(options: VerifiedDashboardAssetLoaderOptions) {
    this.endpoint = normalizedLoopbackEndpoint(options.endpoint);
    this.expectedManifestSha256 = normalizeSha256(options.expectedManifestSha256, 'expected dashboard asset manifest');
    this.manifestPath = assertAssetPath(options.manifestPath ?? DEFAULT_MANIFEST_PATH);
    this.manifestLimitBytes = positiveLimit(options.manifestLimitBytes, DEFAULT_MANIFEST_LIMIT, 'manifest');
    this.assetLimitBytes = positiveLimit(options.assetLimitBytes, DEFAULT_ASSET_LIMIT, 'asset');
    this.totalAssetLimitBytes = positiveLimit(options.totalAssetLimitBytes, DEFAULT_TOTAL_ASSET_LIMIT, 'total asset');
    this.requestTimeoutMs = positiveLimit(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'request timeout');
    this.availabilityTtlMs = positiveLimit(options.availabilityTtlMs, DEFAULT_AVAILABILITY_TTL_MS, 'availability TTL');
    if (this.availabilityTtlMs > MAX_AVAILABILITY_TTL_MS) throw new Error('Dashboard availability TTL cannot exceed 2000 milliseconds.');
  }

  async load(requestPath: string): Promise<VerifiedDashboardAsset> {
    const { manifest, entries } = await this.loadManifest();
    const path = requestPath === '/' ? manifest.entrypoint : assertAssetPath(requestPath);
    const entry = entries.get(path);
    if (!entry) throw new DashboardAssetError('asset_not_found', 'Dashboard asset was not found.', 404);
    const cached = this.cache.get(path);
    if (cached) return cloneAsset(cached);
    let bytes: Buffer;
    try {
      bytes = await requestBytes(this.endpoint, path, entry.bytes, this.requestTimeoutMs, entry.contentType);
    } catch (error) {
      if (error instanceof DashboardAssetError) throw error;
      throw new DashboardAssetError('asset_unavailable', 'Dashboard assets are unavailable.', 503);
    }
    if (bytes.length !== entry.bytes || sha256(bytes) !== normalizeSha256(entry.sha256, `dashboard asset ${path}`)) {
      throw new DashboardAssetError('asset_integrity_failed', 'Dashboard asset integrity verification failed.', 503);
    }
    const asset: VerifiedDashboardAsset = {
      bytes,
      contentType: entry.contentType,
      cacheControl: entry.cache === 'immutable' ? 'public, max-age=31536000, immutable' : 'no-store',
      etag: `"sha256-${normalizeSha256(entry.sha256, `dashboard asset ${path}`)}"`,
    };
    this.cache.set(path, asset);
    return cloneAsset(asset);
  }

  async verifyAvailability(): Promise<void> {
    if (this.availabilityVerifiedAt + this.availabilityTtlMs > Date.now()) return;
    if (!this.availabilityPromise) {
      this.availabilityPromise = this.readManifest(Math.min(this.requestTimeoutMs, 2_000)).then((loaded) => {
        this.manifestPromise = Promise.resolve(loaded);
        this.availabilityVerifiedAt = Date.now();
      }).finally(() => {
        this.availabilityPromise = undefined;
      });
    }
    await this.availabilityPromise;
  }

  clear(): void {
    this.manifestPromise = undefined;
    this.availabilityPromise = undefined;
    this.availabilityVerifiedAt = 0;
    this.cache.clear();
  }

  updateExpectedManifestSha256(value: string): boolean {
    const expected = normalizeSha256(value, 'expected dashboard asset manifest');
    if (expected === this.expectedManifestSha256) return false;
    this.expectedManifestSha256 = expected;
    this.clear();
    return true;
  }

  private async loadManifest(): Promise<{ manifest: DashboardAssetManifest; entries: Map<string, DashboardAssetManifestEntry> }> {
    if (!this.manifestPromise) {
      this.manifestPromise = this.readManifest();
    }
    try {
      return await this.manifestPromise;
    } catch (error) {
      this.manifestPromise = undefined;
      throw error;
    }
  }

  private async readManifest(timeoutMs = this.requestTimeoutMs): Promise<{ manifest: DashboardAssetManifest; entries: Map<string, DashboardAssetManifestEntry> }> {
    let bytes: Buffer;
    try {
      bytes = await requestBytes(this.endpoint, this.manifestPath, this.manifestLimitBytes, timeoutMs, 'application/json');
    } catch (error) {
      if (error instanceof DashboardAssetError) throw error;
      throw new DashboardAssetError('asset_unavailable', 'Dashboard asset manifest is unavailable.', 503);
    }
    if (sha256(bytes) !== this.expectedManifestSha256) {
      throw new DashboardAssetError('asset_integrity_failed', 'Dashboard asset manifest integrity verification failed.', 503);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new DashboardAssetError('asset_manifest_invalid', 'Dashboard asset manifest is invalid.', 503);
    }
    const manifest = validateManifest(parsed, this.assetLimitBytes, this.totalAssetLimitBytes);
    return { manifest, entries: new Map(manifest.assets.map((entry) => [entry.path, entry])) };
  }
}

function validateManifest(value: unknown, assetLimit: number, totalLimit: number): DashboardAssetManifest {
  if (!isPlainObject(value) || value.schemaVersion !== 1 || typeof value.entrypoint !== 'string' || !Array.isArray(value.assets)) {
    throw new DashboardAssetError('asset_manifest_invalid', 'Dashboard asset manifest is invalid.', 503);
  }
  const entrypoint = assertAssetPath(value.entrypoint);
  const assets: DashboardAssetManifestEntry[] = [];
  const paths = new Set<string>();
  let total = 0;
  for (const candidate of value.assets) {
    if (!isPlainObject(candidate) || typeof candidate.path !== 'string' || typeof candidate.sha256 !== 'string'
      || typeof candidate.bytes !== 'number' || typeof candidate.contentType !== 'string'
      || (candidate.cache !== 'no-store' && candidate.cache !== 'immutable')) {
      throw new DashboardAssetError('asset_manifest_invalid', 'Dashboard asset manifest entry is invalid.', 503);
    }
    const path = assertAssetPath(candidate.path);
    if (paths.has(path) || candidate.bytes < 0 || !Number.isSafeInteger(candidate.bytes) || candidate.bytes > assetLimit
      || !ALLOWED_CONTENT_TYPES.has(candidate.contentType)) {
      throw new DashboardAssetError('asset_manifest_invalid', 'Dashboard asset manifest entry is invalid.', 503);
    }
    normalizeSha256(candidate.sha256, `dashboard asset ${path}`);
    total += candidate.bytes;
    if (!Number.isSafeInteger(total) || total > totalLimit) {
      throw new DashboardAssetError('asset_manifest_invalid', 'Dashboard asset manifest exceeds the total size limit.', 503);
    }
    paths.add(path);
    assets.push({
      path,
      sha256: candidate.sha256,
      bytes: candidate.bytes,
      contentType: candidate.contentType,
      cache: candidate.cache,
    });
  }
  if (!paths.has(entrypoint)) throw new DashboardAssetError('asset_manifest_invalid', 'Dashboard asset manifest entrypoint is missing.', 503);
  const entry = assets.find(({ path }) => path === entrypoint)!;
  if (entry.contentType !== 'text/html; charset=utf-8' || entry.cache !== 'no-store') {
    throw new DashboardAssetError('asset_manifest_invalid', 'Dashboard entrypoint must be no-store HTML.', 503);
  }
  return { schemaVersion: 1, entrypoint, assets };
}

function normalizedLoopbackEndpoint(input: string | URL): URL {
  const endpoint = new URL(input);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || !endpoint.port) {
    throw new Error('Dashboard asset endpoint must be an HTTP loopback IP with an explicit port and no path.');
  }
  return endpoint;
}

export function assertAssetPath(path: string): string {
  if (!path.startsWith('/') || path === '/' || path.length > 512 || path.includes('%') || path.includes('\\')
    || path.includes('\0') || path.includes('?') || path.includes('#') || path.includes('//')) {
    throw new DashboardAssetError('asset_manifest_invalid', 'Dashboard asset path is invalid.', 503);
  }
  const segments = path.slice(1).split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/u.test(segment))) {
    throw new DashboardAssetError('asset_manifest_invalid', 'Dashboard asset path is invalid.', 503);
  }
  return path;
}

async function requestBytes(endpoint: URL, path: string, limit: number, timeoutMs: number, expectedContentType: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const request = httpRequest({
      protocol: 'http:',
      hostname: endpoint.hostname === '[::1]' ? '::1' : endpoint.hostname,
      port: endpoint.port,
      path,
      method: 'GET',
      headers: { accept: expectedContentType, connection: 'close' },
      timeout: timeoutMs,
    }, (response) => {
      if (response.statusCode !== 200 || response.headers.location || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        response.resume();
        reject(new DashboardAssetError('asset_unavailable', 'Dashboard asset server returned an invalid response.', 503));
        return;
      }
      const sourceType = response.headers['content-type']?.toLowerCase().replaceAll(/\s+/gu, ' ').trim();
      if (!sourceType || (expectedContentType === 'application/json'
        ? !sourceType.startsWith('application/json')
        : sourceType !== expectedContentType)) {
        response.resume();
        reject(new DashboardAssetError('asset_integrity_failed', 'Dashboard asset content type did not match its manifest.', 503));
        return;
      }
      const declared = response.headers['content-length'];
      if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
        response.resume();
        reject(new DashboardAssetError('asset_integrity_failed', 'Dashboard asset exceeds its size limit.', 503));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > limit) {
          response.destroy(new DashboardAssetError('asset_integrity_failed', 'Dashboard asset exceeds its size limit.', 503));
          return;
        }
        chunks.push(bytes);
      });
      response.on('end', () => resolve(Buffer.concat(chunks, length)));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Dashboard asset request timed out.')));
    request.on('error', reject);
    request.end();
  });
}

function normalizeSha256(value: string, label: string): string {
  const normalized = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new DashboardAssetError('asset_manifest_invalid', `${label} digest is invalid.`, 503);
  return normalized;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) throw new Error(`Dashboard ${label} limit must be a positive integer.`);
  return selected;
}

function cloneAsset(asset: VerifiedDashboardAsset): VerifiedDashboardAsset {
  return { ...asset, bytes: Buffer.from(asset.bytes) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
