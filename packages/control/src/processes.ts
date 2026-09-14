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
  renameSync,
  rmdirSync,
  fsyncSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { QubiclError } from './errors.js';
import { workloadEnvironment } from './environments.js';
import type { LeaseProof } from './lease.js';
import { BoundedFileSystem, BoundedPathError } from './bounded-files.js';
import { PtyManager, type PtyManagerOptions, type PtyPage, type PtySummary } from './pty.js';

const DEFAULT_MAX_PROCESSES = 32;
const DEFAULT_MAX_COMPLETED_PROCESSES = 64;
const DEFAULT_MAX_RETAINED_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FULL_OUTPUT_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_AGGREGATE_OUTPUT_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_JOURNAL_RECORDS = 16_384;
const DEFAULT_MAX_AGGREGATE_JOURNAL_RECORDS = 131_072;
const DEFAULT_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_OUTPUT_PARENT = '/tmp';
const DEFAULT_OUTPUT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_STDIN_QUEUE_BYTES = 256 * 1024;
const DEFAULT_STDIN_WRITE_TIMEOUT_MS = 5_000;
const MAX_STATUS_WAIT_MS = 30_000;
const MAX_PAGE_RECORDS = 1_000;
const MAX_PAGE_BYTES = 256 * 1024;
const MAX_JOURNAL_RECORD_BYTES = 64 * 1024;
const MAX_TASK_RECORD_BYTES = 1024 * 1024;

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
  label: string;
  lifecycle: ProcessLifecycle;
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
  outputFileClosed: boolean;
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
export type ProcessLifecycle = 'session' | 'task' | 'service';

export interface ProcessResult {
  processId: string;
  label: string;
  lifecycle: ProcessLifecycle;
  survivesDisconnect: boolean;
  survivesHumanTakeover: boolean;
  running: boolean;
  terminalState: 'running' | 'exited' | 'signaled' | 'timed_out' | 'failed';
  output?: string;
  stdout?: string;
  stderr?: string;
  truncation?: {
    inline?: { limitBytes: number; streams: Array<'stdout' | 'stderr'> };
    retainedLog?: { limitBytes: number };
    continuation?: { processId: string; path: string; retainedLogTruncated: boolean };
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

/** Safe host-operator metadata. It deliberately excludes commands, paths, output, and lease proofs. */
export interface ManagementProcessSummary {
  id: string;
  status: 'running' | 'exited' | 'signaled' | 'timed-out' | 'stopped' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  label: string;
  lifecycle: ProcessLifecycle;
  owner: 'agent' | 'computer';
  ownerGeneration: number;
}

export interface AgentProcessSummary extends ManagementProcessSummary {}

interface PersistedTaskRecord extends ManagementProcessSummary {
  version: 1 | 2;
  outputPath: string;
  outputTruncated?: boolean;
}

export interface ProcessOutputPage {
  processId: string;
  offset: number;
  nextOffset: number;
  size: number;
  complete: boolean;
  truncated: boolean;
  encoding: 'utf8' | 'base64';
  data: string;
}

interface PersistedServiceDefinition {
  version: 1;
  id: string;
  label: string;
  command: string;
  cwd: string;
  maxOutputBytes: number;
  outputMode: ProcessOutputMode;
  timeoutMs?: number;
  ownerGeneration: number;
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
  persistTaskRecords?: boolean;
  pty?: PtyManagerOptions;
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
  private readonly durableHome: string;
  private readonly outputWorkspace: BoundedFileSystem;
  private readonly spawnUid: number | undefined;
  private readonly spawnGid: number | undefined;
  private readonly fenceUid: number | undefined;
  private retainedBytes = 0;
  private aggregateOutputBytes = 0;
  private aggregateJournalRecords = 0;
  private outputSequence = 0;
  private outputDirectory: OutputDirectoryState | undefined;
  private readonly outputFiles = new Set<string>();
  private readonly taskHistory = new Map<string, PersistedTaskRecord>();
  private readonly taskRecordPath: string | undefined;
  private readonly serviceRecordDirectory: string | undefined;
  private readonly terminals: PtyManager;

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
    this.taskRecordPath = options.persistTaskRecords ? join(this.outputParent, 'task-records.jsonl') : undefined;
    this.serviceRecordDirectory = options.persistTaskRecords ? join(this.outputParent, 'services') : undefined;
    this.outputTtlMs = options.outputTtlMs ?? DEFAULT_OUTPUT_TTL_MS;
    this.environment = workloadEnvironment(options.environment ?? process.env, options.home);
    this.durableHome = resolve(this.environment.HOME ?? '/home/qubicl');
    this.outputWorkspace = new BoundedFileSystem(this.durableHome);
    this.terminals = new PtyManager({
      home: this.durableHome,
      environment: this.environment,
      ...(options.spawnUid === undefined ? undefined : { spawnUid: options.spawnUid, spawnGid: options.spawnGid }),
      ...options.pty,
    });
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
    if (this.taskRecordPath) this.loadTaskHistory();
    if (this.serviceRecordDirectory) this.loadServices();
  }

  async exec(
    command: string,
    cwd: string,
    yieldTimeMs: number,
    maxOutputBytes: number,
    owner: LeaseProof,
    timeoutMs?: number,
    outputMode: ProcessOutputMode = 'combined',
    lifecycle: ProcessLifecycle = 'session',
    label = 'Task',
  ): Promise<ProcessResult> {
    const id = lifecycle === 'service' ? randomBytes(12).toString('base64url') : undefined;
    if (id) this.persistServiceDefinition({ version: 1, id, label, command, cwd, maxOutputBytes, outputMode, ...(timeoutMs === undefined ? {} : { timeoutMs }), ownerGeneration: owner.generation });
    let managed: ManagedProcess;
    try {
      managed = this.start(command, cwd, owner, maxOutputBytes, timeoutMs, outputMode, null, false, lifecycle, label, id);
    } catch (error) {
      if (id) this.removeServiceDefinition(id);
      throw error;
    }
    await Promise.race([managed.finished, delay(yieldTimeMs)]);
    const result = this.consume(managed);
    if (!result.running && lifecycle !== 'service') await this.discard(managed, true);
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
    if (!result.running) {
      if (managed.lifecycle === 'service') this.removeServiceDefinition(managed.id);
      await this.discard(managed, true);
    }
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
    const managed = this.start(command, cwd, owner, MAX_PAGE_BYTES, undefined, 'combined', sessionId, true, 'session', 'Open Terminal session');
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
      ? [...this.processes.values()].filter((managed) => managed.lifecycle === 'session' && sameOwner(managed.owner, owner))
      : [...this.processes.values()].filter((managed) => managed.lifecycle === 'session');
    const terminatedTerminals = await this.terminals.terminateOwner(owner);
    const terminatedManagedProcesses = matching.filter((managed) => !managed.completed).length + terminatedTerminals;
    let groupError: unknown;
    await Promise.all(matching.map(async (managed) => {
      try {
        if (managed.completed) await this.terminateCompletedGroup(managed);
        else await this.terminate(managed, 'SIGKILL', 'lease_revoked');
      } catch (error) {
        groupError ??= error;
      }
    }));
    const surviving = matching.filter((managed) => processGroupMembers(managed.child.pid).length > 0);
    if (surviving.length) {
      groupError ??= new QubiclError('process_fencing_failed', `Could not confirm termination of ${surviving.length} managed process group${surviving.length === 1 ? '' : 's'}.`, 500);
    }
    if (groupError) throw groupError;
    for (const managed of matching) this.deleteRecord(managed, !managed.compatibilitySession);
    return { terminatedManagedProcesses };
  }

  count(): number {
    return [...this.processes.values()].filter((managed) => !managed.completed).length + this.terminals.list().filter(({ running }) => running).length;
  }

  terminalOpen(command: string, cwd: string, rows: number, columns: number, owner: LeaseProof, lifecycle: 'session' | 'task', label: string): Promise<PtySummary> {
    return this.terminals.open(command, cwd, rows, columns, owner, lifecycle, label);
  }
  terminalList(): PtySummary[] { return this.terminals.list(); }
  terminalRead(id: string, owner: LeaseProof, offset: number, maxBytes: number, waitMs: number, encoding: 'utf8' | 'base64'): Promise<PtyPage> {
    return this.terminals.read(id, owner, offset, maxBytes, waitMs, encoding);
  }
  terminalWrite(id: string, owner: LeaseProof, input: string): Promise<{ terminalId: string; acceptedBytes: number }> { return this.terminals.write(id, owner, input); }
  terminalResize(id: string, owner: LeaseProof, rows: number, columns: number): Promise<{ terminalId: string; rows: number; columns: number }> { return this.terminals.resize(id, owner, rows, columns); }
  terminalSignal(id: string, owner: LeaseProof, signal: StopSignal): Promise<{ terminalId: string; signal: StopSignal }> { return this.terminals.signal(id, owner, signal); }
  terminalClose(id: string, owner: LeaseProof, force: boolean): Promise<PtySummary> { return this.terminals.close(id, owner, force); }

  listForManagement(): ManagementProcessSummary[] {
    const current = [...this.processes.values()].map((managed) => managementSummary(managed));
    const liveIds = new Set(current.map(({ id }) => id));
    return [...current, ...this.terminals.listForManagement(), ...[...this.taskHistory.values()].filter(({ id }) => !liveIds.has(id)).map(stripPersistedTask)]
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
  }

  listForAgent(): AgentProcessSummary[] {
    return this.listForManagement();
  }

  async stopForManagement(id: string): Promise<{ id: string; status: 'stopped' }> {
    const managed = this.processes.get(id);
    if (!managed) {
      if (await this.terminals.closeForManagement(id)) return { id, status: 'stopped' };
      throw new QubiclError('process_not_found', `Managed process or terminal ${id} was not found.`, 404);
    }
    if (!managed.completed) await this.terminate(managed, 'SIGTERM', 'stop');
    if (!managed.completed) {
      throw new QubiclError('process_fencing_failed', `Could not confirm termination of managed process ${id}; its tracking record was retained.`, 500);
    }
    if (managed.lifecycle === 'service') this.removeServiceDefinition(managed.id);
    await this.discard(managed, false);
    return { id, status: 'stopped' };
  }

  readOutput(id: string, offset: number, maxBytes: number, tailBytes: number | undefined, encoding: 'utf8' | 'base64'): ProcessOutputPage {
    const safeOffset = boundedInteger(offset, 0, Number.MAX_SAFE_INTEGER, 'offset');
    const safeMaximum = boundedInteger(maxBytes, 1, 1_000_000, 'maxBytes');
    const safeTail = tailBytes === undefined ? undefined : boundedInteger(tailBytes, 1, 1_000_000, 'tailBytes');
    const output = this.openRetainedOutput(id);
    try {
      const start = safeTail === undefined ? Math.min(safeOffset, output.size) : Math.max(0, output.size - safeTail);
      const length = Math.min(safeMaximum, output.size - start);
      const data = Buffer.alloc(length);
      const bytes = length ? readExactlySync(output.descriptor, data, start) : 0;
      if (bytes !== length) throw new QubiclError('process_output_unavailable', `Managed task ${id} output changed while it was read.`, 409);
      return {
        processId: id,
        offset: start,
        nextOffset: start + bytes,
        size: output.size,
        complete: output.complete,
        truncated: output.truncated || start + bytes < output.size,
        encoding,
        data: data.toString(encoding),
      };
    } finally {
      closeSync(output.descriptor);
    }
  }

  readOutputBuffer(id: string, maxBytes: number): { data: Buffer; complete: boolean; truncated: boolean; size: number } {
    const safeMaximum = boundedInteger(maxBytes, 1, DEFAULT_MAX_FULL_OUTPUT_BYTES, 'maxBytes');
    const output = this.openRetainedOutput(id);
    try {
      if (output.size > safeMaximum) throw new QubiclError('process_output_too_large', `Managed task ${id} output is ${output.size} bytes; increase maxBytes up to ${DEFAULT_MAX_FULL_OUTPUT_BYTES} or save a bounded page.`, 413, { size: output.size, maximumBytes: safeMaximum });
      const data = Buffer.alloc(output.size);
      const bytes = output.size ? readExactlySync(output.descriptor, data, 0) : 0;
      if (bytes !== output.size) throw new QubiclError('process_output_unavailable', `Managed task ${id} output changed while it was read.`, 409);
      return { data, complete: output.complete, truncated: output.truncated, size: output.size };
    } finally {
      closeSync(output.descriptor);
    }
  }

  async saveOutput(id: string, target: string, maxBytes: number): Promise<{ processId: string; path: string; bytes: number; complete: boolean; sourceTruncated: boolean }> {
    const output = this.readOutputBuffer(id, maxBytes);
    let path: string;
    try { path = this.outputWorkspace.absolutePath(target); }
    catch (error) {
      if (error instanceof BoundedPathError) throw new QubiclError('path_outside_home', `Saved task output must stay beneath ${this.durableHome}.`, 403);
      throw error;
    }
    await this.outputWorkspace.writeFile(path, output.data, { createParents: true });
    return { processId: id, path, bytes: output.data.length, complete: output.complete, sourceTruncated: output.truncated };
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

  limits(): { maxConcurrent: number; maxLifetimeSeconds: number; maxOutputBytes: number; completedRetentionSeconds: number } {
    return {
      maxConcurrent: this.maxProcesses,
      maxLifetimeSeconds: Math.floor(this.maxLifetimeMs / 1000),
      maxOutputBytes: this.maxFullOutputBytes,
      completedRetentionSeconds: Math.floor(this.outputTtlMs / 1000),
    };
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
    lifecycle: ProcessLifecycle,
    label: string,
    idOverride?: string,
  ): ManagedProcess {
    if (this.count() >= this.maxProcesses) {
      throw new QubiclError('process_limit', `This computer already has ${this.maxProcesses} managed processes. Read or stop an existing process before starting another.`, 429);
    }
    const id = idOverride ?? randomBytes(12).toString('base64url');
    if (this.processes.has(id)) throw new QubiclError('process_conflict', `Managed process ${id} already exists.`, 409);
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
      label,
      lifecycle,
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
      outputFileClosed: false,
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
    if (lifecycle === 'task') this.persistTask(managed);
    if (compatibilitySession || lifecycle === 'task') {
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
    if (managed.lifecycle === 'session' && !sameOwner(managed.owner, owner)) {
      throw new QubiclError('stale_process_owner', 'This session process belongs to a different lease generation.', 409);
    }
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
    if (managed.outputFileTruncated || managed.outputFileClosed) return;
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
      label: managed.label,
      lifecycle: managed.lifecycle,
      survivesDisconnect: managed.lifecycle !== 'session',
      survivesHumanTakeover: managed.lifecycle !== 'session',
      running: !managed.completed,
      terminalState: processTerminalState(managed),
      ...(managed.outputMode === 'split' ? { stdout, stderr } : { output }),
      ...(hasTruncation ? {
        truncation: {
          ...(truncatedStreams.length ? { inline: { limitBytes: managed.maxOutputBytes, streams: truncatedStreams } } : {}),
          ...(managed.outputFileTruncated ? { retainedLog: { limitBytes: this.maxFullOutputBytes } } : {}),
          ...(truncatedStreams.length ? { continuation: { processId: managed.id, path: managed.outputPath, retainedLogTruncated: managed.outputFileTruncated } } : {}),
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
        const read = readExactlySync(descriptor, buffer, record.offset);
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
    closeOutputDescriptor(managed);
    if (managed.lifecycle === 'task') this.persistTask(managed);
    this.notify(managed);
    managed.outputCleanupTimer = setTimeout(
      () => this.cleanupOutput(managed),
      Math.max(this.outputTtlMs, managed.compatibilitySession ? this.completedTtlMs : 0),
    );
    managed.outputCleanupTimer.unref();
    if (managed.lifecycle !== 'service') {
      managed.expiryTimer = setTimeout(() => {
        void this.discard(managed, !managed.compatibilitySession).catch(() => undefined);
      }, this.completedTtlMs);
      managed.expiryTimer.unref();
    }
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
    closeOutputDescriptor(managed);
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

  private loadTaskHistory(): void {
    if (!this.taskRecordPath) return;
    ensureNoSymlinkDirectory(this.outputParent);
    let raw: string;
    try {
      const info = lstatSync(this.taskRecordPath, { bigint: true });
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n || (info.mode & 0o077n) !== 0n) {
        throw new Error('The retained task record must be a private regular file.');
      }
      raw = readFileSync(this.taskRecordPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const parsed = parsePersistedTask(line);
      if (parsed) this.taskHistory.set(parsed.id, parsed);
    }
    for (const record of [...this.taskHistory.values()]) {
      if (record.status !== 'running') continue;
      const interrupted: PersistedTaskRecord = {
        ...record,
        status: 'interrupted',
        finishedAt: new Date().toISOString(),
      };
      this.appendTaskRecord(interrupted);
      this.taskHistory.set(interrupted.id, interrupted);
    }
    if (Buffer.byteLength(raw) > MAX_TASK_RECORD_BYTES) this.compactTaskRecords();
  }

  private persistTask(managed: ManagedProcess): void {
    const record: PersistedTaskRecord = {
      version: 2,
      ...managementSummary(managed),
      outputPath: managed.outputPath,
      outputTruncated: managed.outputFileTruncated,
    };
    this.appendTaskRecord(record);
    this.taskHistory.set(record.id, record);
  }

  private openRetainedOutput(id: string): { descriptor: number; size: number; complete: boolean; truncated: boolean } {
    if (!/^[A-Za-z0-9_-]{16}$/u.test(id)) throw new QubiclError('invalid_arguments', 'processId must be an exact managed task identifier.', 400);
    const managed = this.processes.get(id);
    const historical = this.taskHistory.get(id);
    if (!managed && !historical) throw new QubiclError('process_not_found', `Managed task ${id} was not found or its retained output expired.`, 404);
    const outputPath = managed?.outputPath ?? historical!.outputPath;
    const relativePath = relative(this.outputParent, outputPath);
    const parentName = basename(dirname(outputPath));
    if (isAbsolute(relativePath) || relativePath.startsWith(`..${sep}`) || relativePath === '..'
      || !/^\.qubicl-command-output-[A-Za-z0-9_-]+$/u.test(parentName)
      || basename(outputPath) !== `${id}.log`
      || dirname(dirname(outputPath)) !== this.outputParent) {
      throw new QubiclError('process_output_unavailable', `Managed task ${id} has an invalid retained-output location.`, 500);
    }
    let directory: number | undefined;
    let descriptor: number | undefined;
    try {
      directory = openSync(dirname(outputPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const openedDirectory = fstatSync(directory, { bigint: true });
      const namedDirectory = lstatSync(dirname(outputPath), { bigint: true });
      if (!openedDirectory.isDirectory() || namedDirectory.isSymbolicLink() || !sameIdentity(identity(openedDirectory), identity(namedDirectory))) throw new Error('retained-output directory identity changed');
      descriptor = openSync(join(descriptorPath(directory), basename(outputPath)), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(descriptor, { bigint: true });
      if (!info.isFile() || info.nlink !== 1n || (info.mode & 0o077n) !== 0n || info.size > BigInt(DEFAULT_MAX_FULL_OUTPUT_BYTES)) throw new Error('retained-output file is not a private bounded regular file');
      closeSync(directory);
      directory = undefined;
      return {
        descriptor,
        size: Number(info.size),
        complete: managed ? managed.completed : historical!.status !== 'running',
        truncated: managed?.outputFileTruncated ?? historical?.outputTruncated ?? false,
      };
    } catch (error) {
      if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* best effort */ }
      throw new QubiclError('process_output_unavailable', `Managed task ${id} output is unavailable: ${(error as Error).message}`, 500);
    } finally {
      if (directory !== undefined) try { closeSync(directory); } catch { /* best effort */ }
    }
  }

  private appendTaskRecord(record: PersistedTaskRecord): void {
    if (!this.taskRecordPath) return;
    ensureNoSymlinkDirectory(this.outputParent);
    const descriptor = openSync(
      this.taskRecordPath,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    let compact = false;
    try {
      fchmodSync(descriptor, 0o600);
      const info = fstatSync(descriptor, { bigint: true });
      if (!info.isFile() || info.nlink !== 1n) throw new Error('The retained task record is not a private regular file.');
      writeAllSync(descriptor, Buffer.from(`${JSON.stringify(record)}\n`));
      compact = Number(info.size) > MAX_TASK_RECORD_BYTES;
    } finally {
      closeSync(descriptor);
    }
    if (compact) this.compactTaskRecords(record);
  }

  private compactTaskRecords(extra?: PersistedTaskRecord): void {
    if (!this.taskRecordPath) return;
    const latest = new Map(this.taskHistory);
    if (extra) latest.set(extra.id, extra);
    const running = [...latest.values()].filter((record) => record.status === 'running');
    const completed = [...latest.values()].filter((record) => record.status !== 'running')
      .sort((left, right) => Date.parse(right.finishedAt ?? right.startedAt) - Date.parse(left.finishedAt ?? left.startedAt) || right.id.localeCompare(left.id))
      .slice(0, this.maxCompletedProcesses);
    const retained = [...running, ...completed].sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
    const temporary = join(this.outputParent, `.task-records-${randomBytes(8).toString('hex')}.tmp`);
    const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(descriptor, 0o600);
      writeAllSync(descriptor, Buffer.from(retained.map((record) => JSON.stringify(record)).join('\n') + (retained.length ? '\n' : '')));
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    renameSync(temporary, this.taskRecordPath);
    this.taskHistory.clear();
    for (const record of retained) this.taskHistory.set(record.id, record);
  }

  private loadServices(): void {
    const directory = this.serviceRecordDirectory;
    if (!directory) return;
    ensureNoSymlinkDirectory(directory);
    const directoryInfo = lstatSync(directory, { bigint: true });
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077n) !== 0n) {
      throw new Error('The durable service directory must be private.');
    }
    const names = readdirSync(directory).filter((name) => /^[A-Za-z0-9_-]{16}\.json$/u.test(name)).sort();
    if (names.length > this.maxProcesses) throw new Error('Too many durable service definitions.');
    for (const name of names) {
      const path = join(directory, name);
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let definition: PersistedServiceDefinition;
      try {
        const info = fstatSync(descriptor, { bigint: true });
        if (!info.isFile() || info.nlink !== 1n || (info.mode & 0o077n) !== 0n || info.size > BigInt(MAX_COMMAND_BYTES + 8192)) {
          throw new Error('A durable service definition is unsafe.');
        }
        definition = parsePersistedService(readFileSync(descriptor, 'utf8'), this.durableHome);
      } finally {
        closeSync(descriptor);
      }
      if (`${definition.id}.json` !== name) throw new Error('A durable service definition has a mismatched identity.');
      this.start(
        definition.command,
        definition.cwd,
        { id: 'durable-service', generation: definition.ownerGeneration, epoch: 'computer' },
        definition.maxOutputBytes,
        definition.timeoutMs,
        definition.outputMode,
        null,
        false,
        'service',
        definition.label,
        definition.id,
      );
    }
  }

  private persistServiceDefinition(definition: PersistedServiceDefinition): void {
    const directory = this.serviceRecordDirectory;
    if (!directory) throw new QubiclError('service_persistence_unavailable', 'Durable services are unavailable in this runtime.', 409);
    assertUtf8Limit(definition.command, MAX_COMMAND_BYTES, 'command');
    parsePersistedService(JSON.stringify(definition), this.durableHome);
    ensureNoSymlinkDirectory(directory);
    const path = join(directory, `${definition.id}.json`);
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(descriptor, 0o600);
      const info = fstatSync(descriptor, { bigint: true });
      if (!info.isFile() || info.nlink !== 1n) throw new Error('The durable service definition is not a private regular file.');
      writeAllSync(descriptor, Buffer.from(`${JSON.stringify(definition)}\n`));
    } catch (error) {
      try { unlinkSync(path); } catch { /* leave ambiguous state for operator review */ }
      throw error;
    } finally {
      closeSync(descriptor);
    }
  }

  private removeServiceDefinition(id: string): void {
    if (!this.serviceRecordDirectory) return;
    const path = join(this.serviceRecordDirectory, `${id}.json`);
    try {
      const info = lstatSync(path, { bigint: true });
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n) throw new Error('The durable service definition changed identity.');
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function stripPersistedTask(record: PersistedTaskRecord): ManagementProcessSummary {
  const { version: _version, outputPath: _outputPath, ...summary } = record;
  return summary;
}

function parsePersistedTask(line: string): PersistedTaskRecord | undefined {
  try {
    const value = JSON.parse(line) as Partial<PersistedTaskRecord>;
    if (
      (value.version !== 1 && value.version !== 2)
      || typeof value.id !== 'string'
      || !/^[A-Za-z0-9_-]{16}$/u.test(value.id)
      || typeof value.label !== 'string'
      || value.lifecycle !== 'task'
      || !['running', 'exited', 'signaled', 'timed-out', 'stopped', 'interrupted'].includes(value.status ?? '')
      || typeof value.startedAt !== 'string'
      || typeof value.outputPath !== 'string'
      || value.owner !== 'computer'
      || !Number.isSafeInteger(value.ownerGeneration)
    ) return undefined;
    if (value.outputTruncated !== undefined && typeof value.outputTruncated !== 'boolean') return undefined;
    return value as PersistedTaskRecord;
  } catch {
    return undefined;
  }
}

function parsePersistedService(raw: string, durableHome: string): PersistedServiceDefinition {
  let value: Partial<PersistedServiceDefinition>;
  try { value = JSON.parse(raw) as Partial<PersistedServiceDefinition>; }
  catch { throw new Error('A durable service definition is invalid JSON.'); }
  if (
    value.version !== 1
    || typeof value.id !== 'string'
    || !/^[A-Za-z0-9_-]{16}$/u.test(value.id)
    || typeof value.label !== 'string'
    || !value.label.trim()
    || value.label.length > 120
    || typeof value.command !== 'string'
    || Buffer.byteLength(value.command) > MAX_COMMAND_BYTES
    || typeof value.cwd !== 'string'
    || (resolve(value.cwd ?? '') !== durableHome && !resolve(value.cwd ?? '').startsWith(`${durableHome}${sep}`))
    || !Number.isSafeInteger(value.maxOutputBytes)
    || (value.maxOutputBytes ?? 0) < 1024
    || (value.maxOutputBytes ?? 0) > 50_000
    || !['combined', 'split'].includes(value.outputMode ?? '')
    || (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 86_400_000))
    || !Number.isSafeInteger(value.ownerGeneration)
    || (value.ownerGeneration ?? 0) < 1
    || Object.keys(value).some((key) => !['version', 'id', 'label', 'command', 'cwd', 'maxOutputBytes', 'outputMode', 'timeoutMs', 'ownerGeneration'].includes(key))
  ) throw new Error('A durable service definition is invalid.');
  return value as PersistedServiceDefinition;
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

function readExactlySync(descriptor: number, target: Buffer, position: number): number {
  let offset = 0;
  while (offset < target.length) {
    const read = readSync(descriptor, target, offset, target.length - offset, position + offset);
    if (read === 0) break;
    offset += read;
  }
  return offset;
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

function closeOutputDescriptor(managed: ManagedProcess): void {
  if (managed.outputFileClosed) return;
  // Invalidate before closing: the OS can reuse this number for another request.
  managed.outputFileClosed = true;
  try { closeSync(managed.outputFile); } catch { /* never retry a potentially reused descriptor */ }
}

function managementSummary(managed: ManagedProcess): ManagementProcessSummary {
  const status: ManagementProcessSummary['status'] = !managed.completed
    ? 'running'
    : managed.timedOut
      ? 'timed-out'
      : managed.terminationReason !== null
        ? 'stopped'
        : managed.signal !== null
          ? 'signaled'
          : 'exited';
  return {
    id: managed.id,
    label: managed.label,
    lifecycle: managed.lifecycle,
    status,
    startedAt: new Date(managed.startedAt).toISOString(),
    ...(managed.finishedAt === null ? {} : { finishedAt: new Date(managed.finishedAt).toISOString() }),
    owner: managed.lifecycle === 'session' ? 'agent' : 'computer',
    ownerGeneration: managed.owner.generation,
  };
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
