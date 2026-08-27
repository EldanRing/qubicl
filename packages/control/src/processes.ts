import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, parse, resolve, sep } from 'node:path';
import { QubiclError } from './errors.js';
import { workloadEnvironment } from './environments.js';
import type { LeaseProof } from './lease.js';

const DEFAULT_MAX_PROCESSES = 32;
const DEFAULT_MAX_COMPLETED_PROCESSES = 64;
const DEFAULT_MAX_RETAINED_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_COMPLETED_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_FULL_OUTPUT_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_AGGREGATE_OUTPUT_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_JOURNAL_RECORDS = 16_384;
const DEFAULT_MAX_AGGREGATE_JOURNAL_RECORDS = 131_072;
const DEFAULT_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OUTPUT_PARENT = '/tmp';
const DEFAULT_OUTPUT_TTL_MS = 60 * 60 * 1000;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_STDIN_QUEUE_BYTES = 256 * 1024;
const DEFAULT_STDIN_WRITE_TIMEOUT_MS = 5_000;
const MAX_STATUS_WAIT_MS = 30_000;
const MAX_PAGE_RECORDS = 1_000;
const MAX_PAGE_BYTES = 256 * 1024;
const MAX_JOURNAL_RECORD_BYTES = 64 * 1024;

interface OutputChunk {
  data: Buffer;
  sequence: number;
}

interface RetainedStream {
  chunks: OutputChunk[];
  bytes: number;
  truncated: boolean;
}

interface JournalRecord {
  type: 'stdout' | 'stderr';
  offset: number;
  length: number;
}

interface ProcessIdentity {
  pid: number;
  group: number;
  startTime: string;
  uid: number;
}

interface OutputIdentity {
  dev: bigint;
  ino: bigint;
}

interface OutputDirectoryState {
  path: string;
  descriptor: number;
  identity: OutputIdentity;
}

interface ManagedProcess {
  id: string;
  command: string;
  cwd: string;
  sessionId: string | null;
  compatibilitySession: boolean;
  groupLeaderStartTime: string | null;
  observedGroupMembers: Map<number, string>;
  expectedUid: number | null;
  startedAt: number;
  finishedAt: number | null;
  child: ChildProcessWithoutNullStreams;
  owner: LeaseProof;
  stdout: RetainedStream;
  stderr: RetainedStream;
  outputBytes: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  finished: Promise<void>;
  maxOutputBytes: number;
  outputMode: ProcessOutputMode;
  completed: boolean;
  outputPath: string;
  outputDescriptorPath: string;
  outputIdentity: OutputIdentity;
  outputFile: number;
  fullOutputBytes: number;
  outputFileTruncated: boolean;
  journal: JournalRecord[];
  journalPending: Record<'stdout' | 'stderr', Buffer>;
  waiters: Set<() => void>;
  stdinQueuedBytes: number;
  timeoutMs: number | null;
  timedOut: boolean;
  requestedSignal: StopSignal | null;
  terminationReason: 'stop' | 'timeout' | 'lifetime' | 'lease_revoked' | null;
  forcedKill: boolean;
  outputCleanupTimer?: NodeJS.Timeout;
  expiryTimer?: NodeJS.Timeout;
  lifetimeTimer?: NodeJS.Timeout;
  timeoutTimer?: NodeJS.Timeout;
}

export type StopSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP';
export type ProcessOutputMode = 'combined' | 'split';

export interface ProcessResult {
  processId: string;
  running: boolean;
  terminalState: 'running' | 'exited' | 'signaled' | 'timed_out' | 'failed';
  output?: string;
  stdout?: string;
  stderr?: string;
  truncation?: {
    inline?: { limitBytes: number; streams: Array<'stdout' | 'stderr'> };
    retainedLog?: { limitBytes: number };
    continuation?: { path: string; retainedLogTruncated: boolean };
  };
  exitCode?: number;
  signal?: NodeJS.Signals;
  timeoutMs?: number;
  termination?: {
    reason: 'stop' | 'timeout' | 'lifetime' | 'lease_revoked';
    requestedSignal: StopSignal;
    observedSignal?: NodeJS.Signals;
    forcedKill?: true;
  };
}

export type CompatibilityProcessStatus = 'running' | 'done' | 'killed';

export interface CompatibilityProcessSummary {
  id: string;
  command: string;
  status: CompatibilityProcessStatus;
  exit_code: number | null;
  log_path: null;
  cwd: string;
  session_id: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface CompatibilityProcessOutput extends CompatibilityProcessSummary {
  output: Array<{ type: 'stdout' | 'stderr'; data: string }>;
  truncated: boolean;
  next_offset: number;
}

export interface CompatibilityStatusOptions {
  waitMs?: number;
  offset?: number;
  tail?: number;
}

export interface ProcessManagerOptions {
  maxProcesses?: number;
  maxCompletedProcesses?: number;
  maxRetainedOutputBytes?: number;
  completedTtlMs?: number;
  maxFullOutputBytes?: number;
  maxAggregateOutputBytes?: number;
  maxJournalRecords?: number;
  maxAggregateJournalRecords?: number;
  maxLifetimeMs?: number;
  stdinWriteTimeoutMs?: number;
  outputDirectory?: string;
  outputTtlMs?: number;
  environment?: NodeJS.ProcessEnv;
  home?: string;
  spawnUid?: number;
  spawnGid?: number;
  fenceUid?: number;
}

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly maxProcesses: number;
  private readonly maxCompletedProcesses: number;
  private readonly maxRetainedOutputBytes: number;
  private readonly completedTtlMs: number;
  private readonly maxFullOutputBytes: number;
  private readonly maxAggregateOutputBytes: number;
  private readonly maxJournalRecords: number;
  private readonly maxAggregateJournalRecords: number;
  private readonly maxLifetimeMs: number;
  private readonly stdinWriteTimeoutMs: number;
  private readonly outputParent: string;
  private readonly outputTtlMs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly spawnUid: number | undefined;
  private readonly spawnGid: number | undefined;
  private readonly fenceUid: number | undefined;
  private retainedBytes = 0;
  private aggregateOutputBytes = 0;
  private aggregateJournalRecords = 0;
  private outputSequence = 0;
  private outputDirectory: OutputDirectoryState | undefined;
  private readonly outputFiles = new Set<string>();

  constructor(options: ProcessManagerOptions = {}) {
    this.maxProcesses = options.maxProcesses ?? DEFAULT_MAX_PROCESSES;
    this.maxCompletedProcesses = options.maxCompletedProcesses ?? DEFAULT_MAX_COMPLETED_PROCESSES;
    this.maxRetainedOutputBytes = options.maxRetainedOutputBytes ?? DEFAULT_MAX_RETAINED_OUTPUT_BYTES;
    this.completedTtlMs = options.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS;
    this.maxFullOutputBytes = options.maxFullOutputBytes ?? DEFAULT_MAX_FULL_OUTPUT_BYTES;
    this.maxAggregateOutputBytes = options.maxAggregateOutputBytes ?? DEFAULT_MAX_AGGREGATE_OUTPUT_BYTES;
    this.maxJournalRecords = options.maxJournalRecords ?? DEFAULT_MAX_JOURNAL_RECORDS;
    this.maxAggregateJournalRecords = options.maxAggregateJournalRecords ?? DEFAULT_MAX_AGGREGATE_JOURNAL_RECORDS;
    this.maxLifetimeMs = options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
    this.stdinWriteTimeoutMs = options.stdinWriteTimeoutMs ?? DEFAULT_STDIN_WRITE_TIMEOUT_MS;
    this.outputParent = resolve(options.outputDirectory ?? DEFAULT_OUTPUT_PARENT);
    this.outputTtlMs = options.outputTtlMs ?? DEFAULT_OUTPUT_TTL_MS;
    this.environment = workloadEnvironment(options.environment ?? process.env, options.home);
    this.spawnUid = options.spawnUid;
    this.spawnGid = options.spawnGid;
    this.fenceUid = options.fenceUid;
    if ((this.spawnUid === undefined) !== (this.spawnGid === undefined)) throw new Error('spawnUid and spawnGid must be provided together.');
    if (this.fenceUid !== undefined && this.spawnUid !== this.fenceUid) throw new Error('fenceUid must match spawnUid.');
    positiveInteger(this.maxProcesses, 'maxProcesses');
    positiveInteger(this.maxCompletedProcesses, 'maxCompletedProcesses');
    positiveInteger(this.maxRetainedOutputBytes, 'maxRetainedOutputBytes');
    positiveInteger(this.completedTtlMs, 'completedTtlMs');
    positiveInteger(this.maxFullOutputBytes, 'maxFullOutputBytes');
    positiveInteger(this.maxAggregateOutputBytes, 'maxAggregateOutputBytes');
    positiveInteger(this.maxJournalRecords, 'maxJournalRecords');
    positiveInteger(this.maxAggregateJournalRecords, 'maxAggregateJournalRecords');
    positiveInteger(this.maxLifetimeMs, 'maxLifetimeMs');
    positiveInteger(this.stdinWriteTimeoutMs, 'stdinWriteTimeoutMs');
    positiveInteger(this.outputTtlMs, 'outputTtlMs');
  }

  async exec(
    command: string,
    cwd: string,
    yieldTimeMs: number,
    maxOutputBytes: number,
    owner: LeaseProof,
    timeoutMs?: number,
    outputMode: ProcessOutputMode = 'combined',
  ): Promise<ProcessResult> {
    const managed = this.start(command, cwd, owner, maxOutputBytes, timeoutMs, outputMode, null, false);
    await Promise.race([managed.finished, delay(yieldTimeMs)]);
    const result = this.consume(managed);
    if (!result.running) await this.discard(managed, true);
    return result;
  }

  async write(id: string, input: string, close: boolean, yieldTimeMs: number, owner: LeaseProof): Promise<ProcessResult> {
    const managed = this.owned(id, owner);
    await this.writeInput(managed, input, close);
    if (!managed.completed) await Promise.race([managed.finished, delay(yieldTimeMs)]);
    const result = this.consume(managed);
    if (!result.running) await this.discard(managed, true);
    return result;
  }

  async stop(id: string, owner: LeaseProof, signal: StopSignal = 'SIGTERM'): Promise<ProcessResult> {
    const managed = this.owned(id, owner);
    await this.terminate(managed, signal, 'stop');
    const result = this.consume(managed);
    if (!result.running) await this.discard(managed, true);
    return result;
  }

  async executeCompatibility(
    command: string,
    cwd: string,
    owner: LeaseProof,
    options: CompatibilityStatusOptions = {},
    sessionId: string | null = null,
  ): Promise<CompatibilityProcessOutput> {
    assertUtf8Limit(command, MAX_COMMAND_BYTES, 'command');
    const waitMs = boundedInteger(options.waitMs ?? 0, 0, MAX_STATUS_WAIT_MS, 'wait');
    const offset = boundedInteger(options.offset ?? 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
    const tail = options.tail === undefined ? undefined : boundedInteger(options.tail, 1, MAX_PAGE_RECORDS, 'tail');
    const managed = this.start(command, cwd, owner, MAX_PAGE_BYTES, undefined, 'combined', sessionId, true);
    try {
      if (waitMs > 0) await Promise.race([managed.finished, delay(waitMs)]);
      return this.compatibilityPage(this.ownedCompatibility(managed.id, owner), offset, tail);
    } catch (error) {
      if (!managed.completed) await this.terminate(managed, 'SIGKILL', 'stop');
      if (!managed.completed) {
        throw new QubiclError('process_fencing_failed', `Could not confirm termination of compatibility process ${managed.id} after its initial output page failed.`, 500);
      }
      await this.discard(managed, false);
      throw error;
    }
  }

  listCompatibility(owner: LeaseProof): CompatibilityProcessSummary[] {
    return [...this.processes.values()]
      .filter((managed) => managed.compatibilitySession && sameOwner(managed.owner, owner))
      .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
      .map((managed) => compatibilitySummary(managed));
  }

  async statusCompatibility(id: string, owner: LeaseProof, options: CompatibilityStatusOptions = {}): Promise<CompatibilityProcessOutput> {
    let managed = this.ownedCompatibility(id, owner);
    const waitMs = boundedInteger(options.waitMs ?? 0, 0, MAX_STATUS_WAIT_MS, 'wait');
    const offset = boundedInteger(options.offset ?? 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
    const tail = options.tail === undefined ? undefined : boundedInteger(options.tail, 1, MAX_PAGE_RECORDS, 'tail');
    const baseline = managed.journal.length;
    if (!managed.completed && tail === undefined && offset >= baseline && waitMs > 0) {
      await this.waitForActivity(managed, waitMs);
      managed = this.ownedCompatibility(id, owner);
    } else if (!managed.completed && tail !== undefined && waitMs > 0 && baseline === 0) {
      await this.waitForActivity(managed, waitMs);
      managed = this.ownedCompatibility(id, owner);
    }
    return this.compatibilityPage(managed, offset, tail);
  }

  async inputCompatibility(id: string, input: string, owner: LeaseProof): Promise<{ status: 'ok' }> {
    const managed = this.ownedCompatibility(id, owner);
    if (managed.completed || managed.child.stdin.destroyed || managed.child.stdin.writableEnded) {
      throw new QubiclError('process_not_running', `Managed process ${id} is not accepting input.`, 409);
    }
    await this.writeInput(managed, input, false);
    this.ownedCompatibility(id, owner);
    return { status: 'ok' };
  }

  async deleteCompatibility(id: string, owner: LeaseProof, force = false): Promise<{ status: 'killed' }> {
    const managed = this.ownedCompatibility(id, owner);
    if (!managed.completed) await this.terminate(managed, force ? 'SIGKILL' : 'SIGTERM', 'stop');
    if (!managed.completed) {
      throw new QubiclError('process_fencing_failed', `Could not confirm termination of compatibility process ${id}; its tracking record was retained.`, 500);
    }
    await this.discard(managed, false);
    return { status: 'killed' };
  }

  async terminateOwner(owner: LeaseProof | undefined): Promise<{ terminatedManagedProcesses: number }> {
    if (!owner && this.fenceUid === undefined) return { terminatedManagedProcesses: 0 };
    const matching = owner
      ? [...this.processes.values()].filter((managed) => sameOwner(managed.owner, owner))
      : [...this.processes.values()];
    const terminatedManagedProcesses = matching.filter((managed) => !managed.completed).length;
    let groupError: unknown;
    await Promise.all(matching.map(async (managed) => {
      try {
        if (managed.completed) await this.terminateCompletedGroup(managed);
        else await this.terminate(managed, 'SIGKILL', 'lease_revoked');
      } catch (error) {
        groupError ??= error;
      }
    }));
    if (this.fenceUid !== undefined) await terminateUidPopulation(this.fenceUid);
    const surviving = matching.filter((managed) => processGroupMembers(managed.child.pid).length > 0);
    if (surviving.length) {
      groupError ??= new QubiclError('process_fencing_failed', `Could not confirm termination of ${surviving.length} managed process group${surviving.length === 1 ? '' : 's'}.`, 500);
    }
    if (this.fenceUid !== undefined && surviving.length === 0) groupError = undefined;
    if (groupError) throw groupError;
    for (const managed of matching) this.deleteRecord(managed, !managed.compatibilitySession);
    return { terminatedManagedProcesses };
  }

  count(): number {
    return [...this.processes.values()].filter((managed) => !managed.completed).length;
  }

  retainedOutputBytes(): number {
    return this.retainedBytes;
  }

  journalOutputBytes(): number {
    return this.aggregateOutputBytes;
  }

  journalRecordCount(): number {
    return this.aggregateJournalRecords;
  }

  private ensureOutputDirectory(): OutputDirectoryState {
    if (this.outputDirectory) {
      assertOutputDirectory(this.outputDirectory);
      return this.outputDirectory;
    }
    ensureNoSymlinkDirectory(this.outputParent);
    const path = mkdtempSync(join(this.outputParent, '.qubicl-command-output-'));
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      fchmodSync(descriptor, 0o700);
      const info = fstatSync(descriptor, { bigint: true });
      const named = lstatSync(path, { bigint: true });
      if (!info.isDirectory() || named.isSymbolicLink() || !named.isDirectory() || !sameIdentity(identity(info), identity(named))) {
        throw new Error('The managed process output directory changed while it was being created.');
      }
      const state = { path, descriptor, identity: identity(info) };
      assertOutputDirectory(state);
      this.outputDirectory = state;
      return state;
    } catch (error) {
      if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* best-effort cleanup */ }
      try { rmdirSync(path); } catch { /* leave ambiguous state untouched */ }
      throw error;
    }
  }

  private start(
    command: string,
    cwd: string,
    owner: LeaseProof,
    maxOutputBytes: number,
    timeoutMs: number | undefined,
    outputMode: ProcessOutputMode,
    sessionId: string | null,
    compatibilitySession: boolean,
  ): ManagedProcess {
    if (this.count() >= this.maxProcesses) {
      throw new QubiclError('process_limit', `This computer already has ${this.maxProcesses} managed processes. Read or stop an existing process before starting another.`, 429);
    }
    const id = randomBytes(12).toString('base64url');
    const outputDirectory = this.ensureOutputDirectory();
    const outputName = `${id}.log`;
    const outputPath = join(outputDirectory.path, outputName);
    const outputDescriptorPath = join(descriptorPath(outputDirectory.descriptor), outputName);
    const outputFile = openSync(
      outputDescriptorPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(outputFile, 0o600);
    const outputInfo = fstatSync(outputFile, { bigint: true });
    if (!outputInfo.isFile() || outputInfo.nlink !== 1n) {
      try { closeSync(outputFile); } catch { /* best-effort cleanup */ }
      try { unlinkSync(outputDescriptorPath); } catch { /* best-effort cleanup */ }
      throw new Error('The managed process journal could not be created as a private regular file.');
    }
    const outputIdentity = identity(outputInfo);
    this.outputFiles.add(outputDescriptorPath);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('/bin/bash', ['-lc', command], {
        cwd,
        detached: true,
        env: this.environment,
        ...(this.spawnUid === undefined ? {} : { uid: this.spawnUid, gid: this.spawnGid }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      try { closeSync(outputFile); } catch { /* best-effort cleanup */ }
      this.removeOutputFile(outputDescriptorPath, outputIdentity);
      throw error;
    }
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const managed: ManagedProcess = {
      id,
      command,
      cwd,
      sessionId,
      compatibilitySession,
      groupLeaderStartTime: processIdentity(child.pid)?.startTime ?? null,
      observedGroupMembers: new Map(),
      expectedUid: this.spawnUid ?? process.getuid?.() ?? null,
      startedAt: Date.now(),
      finishedAt: null,
      child,
      owner,
      stdout: emptyStream(),
      stderr: emptyStream(),
      outputBytes: 0,
      exitCode: null,
      signal: null,
      finished,
      maxOutputBytes,
      outputMode,
      completed: false,
      outputPath,
      outputDescriptorPath,
      outputIdentity,
      outputFile,
      fullOutputBytes: 0,
      outputFileTruncated: false,
      journal: [],
      journalPending: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
      waiters: new Set(),
      stdinQueuedBytes: 0,
      timeoutMs: timeoutMs ?? null,
      timedOut: false,
      requestedSignal: null,
      terminationReason: null,
      forcedKill: false,
    };
    child.stdout.on('data', (chunk: Buffer) => this.append(managed, managed.stdout, 'stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => this.append(managed, managed.stderr, 'stderr', chunk));
    child.on('error', (error) => {
      this.append(managed, managed.stderr, 'stderr', Buffer.from(`${error.message}\n`));
      managed.exitCode = -1;
      this.complete(managed);
      finish();
    });
    child.on('close', (code, signal) => {
      if (managed.exitCode === null) managed.exitCode = code;
      managed.signal = signal;
      this.complete(managed);
      finish();
    });
    this.processes.set(id, managed);
    if (compatibilitySession) {
      managed.lifetimeTimer = setTimeout(() => {
        if (managed.completed) return;
        managed.timedOut = true;
        void this.terminate(managed, 'SIGKILL', 'lifetime').catch(() => undefined);
      }, this.maxLifetimeMs);
      managed.lifetimeTimer.unref();
    }
    if (timeoutMs !== undefined) {
      managed.timeoutTimer = setTimeout(() => {
        if (managed.completed) return;
        managed.timedOut = true;
        void this.terminate(managed, 'SIGTERM', 'timeout').catch(() => undefined);
      }, timeoutMs);
      managed.timeoutTimer.unref();
    }
    return managed;
  }

  private owned(id: string, owner: LeaseProof): ManagedProcess {
    const managed = this.processes.get(id);
    if (!managed) throw new QubiclError('process_not_found', `Managed process ${id} was not found.`, 404);
    if (!sameOwner(managed.owner, owner)) throw new QubiclError('stale_process_owner', 'This process belongs to a different lease generation.', 409);
    return managed;
  }

  private ownedCompatibility(id: string, owner: LeaseProof): ManagedProcess {
    const managed = this.owned(id, owner);
    if (!managed.compatibilitySession) throw new QubiclError('process_not_found', `Managed process ${id} was not found.`, 404);
    return managed;
  }

  private append(managed: ManagedProcess, stream: RetainedStream, type: JournalRecord['type'], chunk: Buffer): void {
    if (!chunk.length || !this.processes.has(managed.id)) return;
    this.appendJournal(managed, type, chunk);
    const retained = Buffer.from(chunk);
    stream.chunks.push({ data: retained, sequence: this.outputSequence += 1 });
    stream.bytes += retained.length;
    managed.outputBytes += retained.length;
    this.retainedBytes += retained.length;
    this.trimProcess(managed);
    this.trimGlobal();
  }

  private appendJournal(managed: ManagedProcess, type: JournalRecord['type'], chunk: Buffer, final = false): void {
    if (managed.outputFileTruncated) return;
    if (!managed.compatibilitySession) {
      if (!final) this.appendJournalBytes(managed, type, chunk, false);
      return;
    }
    const combined = managed.journalPending[type].length
      ? Buffer.concat([managed.journalPending[type], chunk])
      : chunk;
    const completeBytes = final ? combined.length : completeUtf8PrefixLength(combined);
    managed.journalPending[type] = combined.subarray(completeBytes);
    if (completeBytes === 0) return;
    const complete = combined.subarray(0, completeBytes);
    this.appendJournalBytes(managed, type, complete, true);
  }

  private appendJournalBytes(managed: ManagedProcess, type: JournalRecord['type'], complete: Buffer, preserveUtf8Boundary: boolean): void {
    const remaining = Math.min(
      this.maxFullOutputBytes - managed.fullOutputBytes,
      managed.compatibilitySession
        ? this.maxAggregateOutputBytes - this.aggregateOutputBytes
        : this.maxFullOutputBytes - managed.fullOutputBytes,
    );
    if (remaining <= 0) {
      managed.outputFileTruncated = true;
      this.notify(managed);
      return;
    }
    const requestedBytes = Math.min(complete.length, remaining);
    const safeBytes = !preserveUtf8Boundary || requestedBytes === complete.length
      ? requestedBytes
      : completeUtf8PrefixLength(complete.subarray(0, requestedBytes));
    const candidate = complete.subarray(0, safeBytes);
    const availableRecords = managed.compatibilitySession
      ? Math.max(0, Math.min(
        this.maxJournalRecords - managed.journal.length,
        this.maxAggregateJournalRecords - this.aggregateJournalRecords,
      ))
      : Number.MAX_SAFE_INTEGER;
    const planned = managed.compatibilitySession
      ? planJournalRecords(type, managed.fullOutputBytes, candidate, availableRecords)
      : { records: [] as JournalRecord[], bytes: candidate.length };
    const retained = candidate.subarray(0, planned.bytes);
    try {
      writeAllSync(managed.outputFile, retained);
      managed.fullOutputBytes += retained.length;
      this.aggregateOutputBytes += retained.length;
      if (planned.records.length) {
        managed.journal.push(...planned.records);
        this.aggregateJournalRecords += planned.records.length;
      }
      if (retained.length < complete.length) {
        managed.outputFileTruncated = true;
        managed.journalPending.stdout = Buffer.alloc(0);
        managed.journalPending.stderr = Buffer.alloc(0);
      }
      this.notify(managed);
    } catch {
      managed.outputFileTruncated = true;
      this.notify(managed);
    }
  }

  private trimProcess(managed: ManagedProcess): void {
    while (managed.outputBytes > managed.maxOutputBytes) {
      const excess = managed.outputBytes - managed.maxOutputBytes;
      const stream = oldestStream(managed);
      if (!stream) break;
      this.drop(stream, managed, excess);
    }
  }

  private trimGlobal(): void {
    while (this.retainedBytes > this.maxRetainedOutputBytes) {
      let oldest: { managed: ManagedProcess; stream: RetainedStream; sequence: number } | undefined;
      for (const managed of this.processes.values()) {
        for (const stream of [managed.stdout, managed.stderr]) {
          const sequence = stream.chunks[0]?.sequence;
          if (sequence !== undefined && (!oldest || sequence < oldest.sequence)) oldest = { managed, stream, sequence };
        }
      }
      if (!oldest) break;
      this.drop(oldest.stream, oldest.managed, this.retainedBytes - this.maxRetainedOutputBytes);
    }
  }

  private drop(stream: RetainedStream, managed: ManagedProcess, requestedBytes: number): void {
    const first = stream.chunks[0];
    if (!first) return;
    const bytes = Math.min(requestedBytes, first.data.length);
    if (bytes === first.data.length) stream.chunks.shift();
    else first.data = first.data.subarray(bytes);
    stream.bytes -= bytes;
    managed.outputBytes -= bytes;
    this.retainedBytes -= bytes;
    stream.truncated = true;
  }

  private consume(managed: ManagedProcess): ProcessResult {
    const outputChunks = [...managed.stdout.chunks, ...managed.stderr.chunks]
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ data }) => data);
    const output = Buffer.concat(outputChunks, outputChunks.reduce((bytes, chunk) => bytes + chunk.length, 0)).toString('utf8');
    const truncatedStreams: Array<'stdout' | 'stderr'> = [];
    if (managed.stdout.truncated) truncatedStreams.push('stdout');
    if (managed.stderr.truncated) truncatedStreams.push('stderr');
    const stdout = consumeStream(managed.stdout);
    const stderr = consumeStream(managed.stderr);
    const hasTruncation = truncatedStreams.length > 0 || managed.outputFileTruncated;
    const result: ProcessResult = {
      processId: managed.id,
      running: !managed.completed,
      terminalState: processTerminalState(managed),
      ...(managed.outputMode === 'split' ? { stdout, stderr } : { output }),
      ...(hasTruncation ? {
        truncation: {
          ...(truncatedStreams.length ? { inline: { limitBytes: managed.maxOutputBytes, streams: truncatedStreams } } : {}),
          ...(managed.outputFileTruncated ? { retainedLog: { limitBytes: this.maxFullOutputBytes } } : {}),
          ...(truncatedStreams.length ? { continuation: { path: managed.outputPath, retainedLogTruncated: managed.outputFileTruncated } } : {}),
        },
      } : {}),
      ...(managed.exitCode !== null ? { exitCode: managed.exitCode } : {}),
      ...(managed.signal !== null ? { signal: managed.signal } : {}),
      ...(managed.timedOut && managed.timeoutMs !== null ? { timeoutMs: managed.timeoutMs } : {}),
      ...(managed.requestedSignal !== null && managed.terminationReason !== null ? {
        termination: {
          reason: managed.terminationReason,
          requestedSignal: managed.requestedSignal,
          ...(managed.signal !== null ? { observedSignal: managed.signal } : {}),
          ...(managed.forcedKill ? { forcedKill: true as const } : {}),
        },
      } : {}),
    };
    this.retainedBytes -= managed.outputBytes;
    managed.outputBytes = 0;
    managed.stdout.truncated = false;
    managed.stderr.truncated = false;
    return result;
  }

  private compatibilityPage(managed: ManagedProcess, requestedOffset: number, tail: number | undefined): CompatibilityProcessOutput {
    const start = tail === undefined ? Math.min(requestedOffset, managed.journal.length) : Math.max(0, managed.journal.length - tail);
    const output: CompatibilityProcessOutput['output'] = [];
    let bytes = 0;
    let nextOffset = start;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        managed.outputDescriptorPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      assertOutputFile(descriptor, managed.outputIdentity, managed.fullOutputBytes);
      while (nextOffset < managed.journal.length && output.length < MAX_PAGE_RECORDS) {
        const record = managed.journal[nextOffset]!;
        if (bytes + record.length > MAX_PAGE_BYTES) break;
        const buffer = Buffer.allocUnsafe(record.length);
        const read = readSync(descriptor, buffer, 0, record.length, record.offset);
        if (read !== record.length) throw new Error('Managed process journal was truncated unexpectedly.');
        output.push({ type: record.type, data: buffer.toString('utf8') });
        bytes += record.length;
        nextOffset += 1;
      }
      assertOutputFile(descriptor, managed.outputIdentity, managed.fullOutputBytes);
    } catch (error) {
      throw new QubiclError('process_journal_unavailable', `Managed process ${managed.id} output is unavailable: ${(error as Error).message}`, 500);
    } finally {
      if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* best-effort */ }
    }
    return {
      ...compatibilitySummary(managed),
      output,
      truncated: managed.outputFileTruncated || nextOffset < managed.journal.length,
      next_offset: nextOffset,
    };
  }

  private async writeInput(managed: ManagedProcess, input: string, close: boolean): Promise<void> {
    if (!managed.compatibilitySession) {
      if (input && !managed.child.stdin.destroyed) managed.child.stdin.write(input);
      if (close && !managed.child.stdin.destroyed) managed.child.stdin.end();
      return;
    }
    const bytes = Buffer.byteLength(input, 'utf8');
    if (bytes > MAX_INPUT_BYTES) throw new QubiclError('input_too_large', `Process input exceeds the ${MAX_INPUT_BYTES}-byte limit.`, 413);
    if (managed.completed || managed.child.stdin.destroyed || managed.child.stdin.writableEnded) {
      if (!input && close) return;
      throw new QubiclError('process_not_running', `Managed process ${managed.id} is not accepting input.`, 409);
    }
    if (managed.stdinQueuedBytes + bytes > MAX_STDIN_QUEUE_BYTES) {
      throw new QubiclError('stdin_backpressure', `Managed process ${managed.id} already has ${managed.stdinQueuedBytes} queued input bytes.`, 429);
    }
    if (bytes > 0) {
      managed.stdinQueuedBytes += bytes;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let queued = true;
        const releaseQueuedBytes = (): void => {
          if (!queued) return;
          queued = false;
          managed.stdinQueuedBytes = Math.max(0, managed.stdinQueuedBytes - bytes);
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          releaseQueuedBytes();
          managed.child.stdin.destroy();
          reject(new QubiclError('stdin_timeout', `Managed process ${managed.id} did not accept input within ${this.stdinWriteTimeoutMs} milliseconds.`, 504));
        }, this.stdinWriteTimeoutMs);
        timer.unref();
        managed.child.stdin.write(input, (error) => {
          releaseQueuedBytes();
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(new QubiclError('stdin_failed', `Could not write process input: ${error.message}`, 409));
          else resolve();
        });
      });
    }
    if (close && !managed.child.stdin.destroyed && !managed.child.stdin.writableEnded) managed.child.stdin.end();
  }

  private waitForActivity(managed: ManagedProcess, milliseconds: number): Promise<void> {
    if (milliseconds <= 0 || managed.completed) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        managed.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      timer.unref();
      managed.waiters.add(finish);
    });
  }

  private notify(managed: ManagedProcess): void {
    for (const waiter of [...managed.waiters]) waiter();
  }

  private complete(managed: ManagedProcess): void {
    if (managed.completed) return;
    this.appendJournal(managed, 'stdout', Buffer.alloc(0), true);
    this.appendJournal(managed, 'stderr', Buffer.alloc(0), true);
    managed.completed = true;
    for (const member of processGroupMembers(managed.child.pid)) managed.observedGroupMembers.set(member.pid, member.startTime);
    managed.finishedAt = Date.now();
    if (managed.timeoutTimer) clearTimeout(managed.timeoutTimer);
    if (managed.lifetimeTimer) clearTimeout(managed.lifetimeTimer);
    try { closeSync(managed.outputFile); } catch { /* already closed */ }
    this.notify(managed);
    managed.outputCleanupTimer = setTimeout(
      () => this.cleanupOutput(managed),
      Math.max(this.outputTtlMs, managed.compatibilitySession ? this.completedTtlMs : 0),
    );
    managed.outputCleanupTimer.unref();
    managed.expiryTimer = setTimeout(() => {
      void this.discard(managed, !managed.compatibilitySession).catch(() => undefined);
    }, this.completedTtlMs);
    managed.expiryTimer.unref();
    if (managed.compatibilitySession) void this.pruneCompleted().catch(() => undefined);
  }

  private async pruneCompleted(): Promise<void> {
    const completed = [...this.processes.values()]
      .filter((managed) => managed.completed && managed.compatibilitySession)
      .sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0) || left.id.localeCompare(right.id));
    while (completed.length > this.maxCompletedProcesses) {
      const oldest = completed.shift();
      if (oldest) await this.discard(oldest, false);
    }
  }

  private async discard(managed: ManagedProcess, preserveOutput: boolean): Promise<void> {
    if (this.processes.get(managed.id) !== managed) return;
    if (managed.completed) await this.terminateCompletedGroup(managed);
    this.deleteRecord(managed, preserveOutput);
  }

  private deleteRecord(managed: ManagedProcess, preserveOutput: boolean): void {
    if (this.processes.get(managed.id) !== managed) return;
    if (managed.expiryTimer) clearTimeout(managed.expiryTimer);
    if (managed.timeoutTimer) clearTimeout(managed.timeoutTimer);
    if (managed.lifetimeTimer) clearTimeout(managed.lifetimeTimer);
    this.retainedBytes -= managed.outputBytes;
    managed.outputBytes = 0;
    managed.stdout.chunks = [];
    managed.stderr.chunks = [];
    this.aggregateJournalRecords = Math.max(0, this.aggregateJournalRecords - managed.journal.length);
    managed.journal = [];
    this.notify(managed);
    this.processes.delete(managed.id);
    try { closeSync(managed.outputFile); } catch { /* already closed */ }
    if (!preserveOutput) {
      if (managed.outputCleanupTimer) clearTimeout(managed.outputCleanupTimer);
      this.cleanupOutput(managed);
    } else if (!managed.outputCleanupTimer) {
      managed.outputCleanupTimer = setTimeout(() => this.cleanupOutput(managed), this.outputTtlMs);
      managed.outputCleanupTimer.unref();
    }
  }

  private cleanupOutput(managed: ManagedProcess): void {
    if (managed.fullOutputBytes > 0) {
      this.aggregateOutputBytes = Math.max(0, this.aggregateOutputBytes - managed.fullOutputBytes);
      managed.fullOutputBytes = 0;
    }
    this.removeOutputFile(managed.outputDescriptorPath, managed.outputIdentity);
  }

  private removeOutputFile(path: string, expected: OutputIdentity): void {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(descriptor, { bigint: true });
      if (!info.isFile() || info.nlink !== 1n || !sameIdentity(identity(info), expected)) return;
      const named = lstatSync(path, { bigint: true });
      if (named.isSymbolicLink() || !named.isFile() || named.nlink !== 1n || !sameIdentity(identity(named), expected)) return;
      unlinkSync(path);
      this.outputFiles.delete(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.outputFiles.delete(path);
    } finally {
      if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* best-effort cleanup */ }
      this.cleanupOutputDirectory();
    }
  }

  private cleanupOutputDirectory(): void {
    const state = this.outputDirectory;
    if (!state || this.outputFiles.size > 0) return;
    try {
      if (readdirSync(descriptorPath(state.descriptor)).length > 0) return;
      assertOutputDirectory(state);
      rmdirSync(state.path);
      closeSync(state.descriptor);
      this.outputDirectory = undefined;
    } catch {
      // A changed or non-empty directory is deliberately left untouched.
    }
  }

  private async terminate(
    managed: ManagedProcess,
    signal: StopSignal | 'SIGKILL',
    reason: 'stop' | 'timeout' | 'lifetime' | 'lease_revoked',
  ): Promise<void> {
    if (managed.completed) return;
    if (reason !== 'timeout' && managed.timeoutTimer) {
      clearTimeout(managed.timeoutTimer);
      delete managed.timeoutTimer;
    }
    if (managed.requestedSignal !== null) {
      await Promise.race([managed.finished, delay(2_000)]);
      return;
    }
    managed.requestedSignal = signal === 'SIGKILL' ? 'SIGTERM' : signal;
    managed.terminationReason = reason;
    try {
      process.kill(-(managed.child.pid!), signal);
      if (signal === 'SIGKILL') managed.forcedKill = true;
    } catch {
      return;
    }
    await Promise.race([managed.finished, delay(signal === 'SIGKILL' ? 500 : 1_500)]);
    if (!managed.completed) {
      try {
        process.kill(-(managed.child.pid!), 'SIGKILL');
        managed.forcedKill = true;
      } catch { /* already gone */ }
      await Promise.race([managed.finished, delay(500)]);
    }
  }

  private async terminateCompletedGroup(managed: ManagedProcess): Promise<void> {
    const group = managed.child.pid;
    if (group === undefined) return;
    const members = processGroupMembers(group);
    if (!members.length) return;
    const leader = members.find((member) => member.pid === group);
    const leaderMatches = leader !== undefined && managed.groupLeaderStartTime !== null && leader.startTime === managed.groupLeaderStartTime;
    const observedMemberMatches = members.some((member) => managed.observedGroupMembers.get(member.pid) === member.startTime);
    const uidMatches = managed.expectedUid !== null && members.every((member) => member.uid === managed.expectedUid);
    if ((!leaderMatches && !observedMemberMatches) || !uidMatches) {
      throw new QubiclError('process_fencing_failed', `Could not safely identify surviving members of managed process group ${group}; refusing to signal a possibly recycled process group.`, 500);
    }
    try { process.kill(-group, 'SIGKILL'); } catch { /* exited concurrently */ }
    const deadline = Date.now() + 500;
    while (processGroupMembers(group).length > 0 && Date.now() < deadline) await delay(10);
    if (processGroupMembers(group).length > 0) {
      throw new QubiclError('process_fencing_failed', `Could not terminate surviving members of managed process group ${group}.`, 500);
    }
  }
}

function ensureNoSymlinkDirectory(path: string): void {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  let current = parsed.root;
  const rootInfo = lstatSync(current, { bigint: true });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Managed process output parent ${current} must be a real directory, not a symbolic link.`);
  }
  const parts = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    let info;
    try {
      info = lstatSync(current, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || index !== parts.length - 1) throw error;
      mkdirSync(current, { mode: 0o700 });
      info = lstatSync(current, { bigint: true });
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Managed process output parent ${current} must be a real directory, not a symbolic link.`);
    }
  }
}

function assertOutputDirectory(state: OutputDirectoryState): void {
  const descriptorInfo = fstatSync(state.descriptor, { bigint: true });
  const namedInfo = lstatSync(state.path, { bigint: true });
  if (
    !descriptorInfo.isDirectory()
    || !namedInfo.isDirectory()
    || namedInfo.isSymbolicLink()
    || (descriptorInfo.mode & 0o077n) !== 0n
    || !sameIdentity(identity(descriptorInfo), state.identity)
    || !sameIdentity(identity(namedInfo), state.identity)
  ) {
    throw new Error('The private managed process output directory changed identity or permissions.');
  }
}

function assertOutputFile(descriptor: number, expected: OutputIdentity, expectedSize: number): void {
  const info = fstatSync(descriptor, { bigint: true });
  if (
    !info.isFile()
    || info.nlink !== 1n
    || info.size !== BigInt(expectedSize)
    || !sameIdentity(identity(info), expected)
  ) {
    throw new Error('The managed process journal changed identity, type, link count, or size.');
  }
}

function identity(info: { dev: bigint; ino: bigint }): OutputIdentity {
  return { dev: info.dev, ino: info.ino };
}

function sameIdentity(left: OutputIdentity, right: OutputIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function descriptorPath(descriptor: number): string {
  return process.platform === 'linux' ? `/proc/self/fd/${descriptor}` : `/dev/fd/${descriptor}`;
}

function planJournalRecords(
  type: JournalRecord['type'],
  start: number,
  data: Buffer,
  maximumRecords: number,
): { records: JournalRecord[]; bytes: number } {
  const records: JournalRecord[] = [];
  let cursor = 0;
  while (cursor < data.length && records.length < maximumRecords) {
    const maximumEnd = Math.min(data.length, cursor + MAX_JOURNAL_RECORD_BYTES);
    const newline = data.indexOf(0x0a, cursor);
    let end = newline >= cursor && newline < maximumEnd ? newline + 1 : maximumEnd;
    if (end < data.length && !(newline >= cursor && newline < maximumEnd)) {
      const safe = completeUtf8PrefixLength(data.subarray(cursor, end));
      end = cursor + safe;
      if (end === cursor) end = Math.min(data.length, maximumEnd + 3);
    }
    records.push({ type, offset: start + cursor, length: end - cursor });
    cursor = end;
  }
  return { records, bytes: cursor };
}

function writeAllSync(descriptor: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(descriptor, data, offset, data.length - offset);
    if (written < 1) throw new Error('The managed output journal accepted a zero-byte write.');
    offset += written;
  }
}

function completeUtf8PrefixLength(data: Buffer): number {
  if (!data.length) return 0;
  let continuationBytes = 0;
  let index = data.length - 1;
  while (index >= 0 && continuationBytes < 3 && (data[index]! & 0xc0) === 0x80) {
    continuationBytes += 1;
    index -= 1;
  }
  if (index < 0) return data.length;
  const expected = utf8SequenceBytes(data[index]!);
  if (expected > 1 && data.length - index < expected) return index;
  return data.length;
}

function utf8SequenceBytes(first: number): number {
  if (first >= 0xc2 && first <= 0xdf) return 2;
  if (first >= 0xe0 && first <= 0xef) return 3;
  if (first >= 0xf0 && first <= 0xf4) return 4;
  return 1;
}

function compatibilitySummary(managed: ManagedProcess): CompatibilityProcessSummary {
  return {
    id: managed.id,
    command: managed.command,
    status: managed.completed
      ? managed.terminationReason === null && managed.signal === null && managed.exitCode !== -1 ? 'done' : 'killed'
      : 'running',
    exit_code: managed.exitCode,
    log_path: null,
    cwd: managed.cwd,
    session_id: managed.sessionId,
    started_at: managed.startedAt / 1000,
    finished_at: managed.finishedAt === null ? null : managed.finishedAt / 1000,
  };
}

async function terminateUidPopulation(uid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const pids = await processesForUid(uid);
    if (!pids.length) return;
    for (const pid of pids) {
      try { process.kill(pid, 'SIGSTOP'); } catch { /* exited concurrently */ }
    }
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* exited concurrently */ }
    }
    if (Date.now() >= deadline) {
      const surviving = await processesForUid(uid);
      if (surviving.length) throw new QubiclError('process_fencing_failed', `Could not empty the isolated workload boundary; ${surviving.length} process${surviving.length === 1 ? '' : 'es'} survived.`, 500);
      return;
    }
    await delay(10);
  }
}

async function processesForUid(uid: number): Promise<number[]> {
  const entries = await import('node:fs/promises').then(({ readdir }) => readdir('/proc', { withFileTypes: true }));
  const matches: number[] = [];
  await Promise.all(entries.filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name)).map(async (entry) => {
    const pid = Number(entry.name);
    if (pid === process.pid) return;
    try {
      const status = await import('node:fs/promises').then(({ readFile }) => readFile(`/proc/${pid}/status`, 'utf8'));
      const found = status.match(/^Uid:\s+(\d+)/mu);
      if (found && Number(found[1]) === uid) matches.push(pid);
    } catch { /* process exited or is not inspectable */ }
  }));
  return matches;
}

function processTerminalState(managed: ManagedProcess): ProcessResult['terminalState'] {
  if (!managed.completed) return 'running';
  if (managed.timedOut) return 'timed_out';
  if (managed.exitCode === -1) return 'failed';
  if (managed.signal !== null) return 'signaled';
  return 'exited';
}

function emptyStream(): RetainedStream {
  return { chunks: [], bytes: 0, truncated: false };
}

function oldestStream(managed: ManagedProcess): RetainedStream | undefined {
  const stdoutSequence = managed.stdout.chunks[0]?.sequence;
  const stderrSequence = managed.stderr.chunks[0]?.sequence;
  if (stdoutSequence === undefined) return stderrSequence === undefined ? undefined : managed.stderr;
  if (stderrSequence === undefined) return managed.stdout;
  return stdoutSequence <= stderrSequence ? managed.stdout : managed.stderr;
}

function consumeStream(stream: RetainedStream): string {
  const value = stream.chunks.length === 1 ? stream.chunks[0]!.data : Buffer.concat(stream.chunks.map(({ data }) => data), stream.bytes);
  stream.chunks = [];
  stream.bytes = 0;
  return value.toString('utf8');
}

function sameOwner(left: LeaseProof, right: LeaseProof): boolean {
  return left.id === right.id && left.generation === right.generation && left.epoch === right.epoch;
}

function processIdentity(pid: number | undefined): ProcessIdentity | undefined {
  if (pid === undefined || process.platform !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 1) return undefined;
    const fields = stat.slice(close + 2).trim().split(/\s+/u);
    const group = Number(fields[2]);
    const startTime = fields[19];
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const uidMatch = status.match(/^Uid:\s+(\d+)/mu);
    const uid = Number(uidMatch?.[1]);
    if (!Number.isSafeInteger(group) || group < 1 || startTime === undefined || !Number.isSafeInteger(uid) || uid < 0) return undefined;
    return { pid, group, startTime, uid };
  } catch {
    return undefined;
  }
}

function processGroupMembers(group: number | undefined): ProcessIdentity[] {
  if (group === undefined || process.platform !== 'linux') return [];
  let names: string[];
  try { names = readdirSync('/proc'); } catch { return []; }
  const members: ProcessIdentity[] = [];
  for (const name of names) {
    if (!/^\d+$/u.test(name)) continue;
    const identity = processIdentity(Number(name));
    if (identity?.group === group) members.push(identity);
  }
  return members;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new QubiclError('invalid_arguments', `${name} must be an integer from ${minimum} through ${maximum}.`, 400);
  }
  return value;
}

function assertUtf8Limit(value: string, maximum: number, name: string): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maximum) throw new QubiclError(`${name}_too_large`, `${name} exceeds the ${maximum}-byte UTF-8 limit.`, 413);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
