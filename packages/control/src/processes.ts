import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { LeaseProof } from './lease.js';
import { QubiclError } from './errors.js';
import { workloadEnvironment } from './environments.js';

const DEFAULT_MAX_PROCESSES = 32;
const DEFAULT_MAX_RETAINED_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_COMPLETED_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_FULL_OUTPUT_BYTES = 100 * 1024 * 1024;
const DEFAULT_OUTPUT_DIRECTORY = '/tmp/qubicl-command-output';
const DEFAULT_OUTPUT_TTL_MS = 60 * 60 * 1000;

interface OutputChunk {
  data: Buffer;
  sequence: number;
}

interface RetainedStream {
  chunks: OutputChunk[];
  bytes: number;
  truncated: boolean;
}

interface ManagedProcess {
  id: string;
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
  outputFile: number;
  fullOutputBytes: number;
  outputFileTruncated: boolean;
  timeoutMs: number | null;
  timedOut: boolean;
  requestedSignal: StopSignal | null;
  terminationReason: 'stop' | 'timeout' | 'lease_revoked' | null;
  forcedKill: boolean;
  outputCleanupTimer?: NodeJS.Timeout;
  expiryTimer?: NodeJS.Timeout;
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
    reason: 'stop' | 'timeout' | 'lease_revoked';
    requestedSignal: StopSignal;
    observedSignal?: NodeJS.Signals;
    forcedKill?: true;
  };
}

export interface ProcessManagerOptions {
  maxProcesses?: number;
  maxRetainedOutputBytes?: number;
  completedTtlMs?: number;
  maxFullOutputBytes?: number;
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
  private readonly maxRetainedOutputBytes: number;
  private readonly completedTtlMs: number;
  private readonly maxFullOutputBytes: number;
  private readonly outputDirectory: string;
  private readonly outputTtlMs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly spawnUid: number | undefined;
  private readonly spawnGid: number | undefined;
  private readonly fenceUid: number | undefined;
  private retainedBytes = 0;
  private outputSequence = 0;

  constructor(options: ProcessManagerOptions = {}) {
    this.maxProcesses = options.maxProcesses ?? DEFAULT_MAX_PROCESSES;
    this.maxRetainedOutputBytes = options.maxRetainedOutputBytes ?? DEFAULT_MAX_RETAINED_OUTPUT_BYTES;
    this.completedTtlMs = options.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS;
    this.maxFullOutputBytes = options.maxFullOutputBytes ?? DEFAULT_MAX_FULL_OUTPUT_BYTES;
    this.outputDirectory = options.outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY;
    this.outputTtlMs = options.outputTtlMs ?? DEFAULT_OUTPUT_TTL_MS;
    this.environment = workloadEnvironment(options.environment ?? process.env, options.home);
    this.spawnUid = options.spawnUid;
    this.spawnGid = options.spawnGid;
    this.fenceUid = options.fenceUid;
    if ((this.spawnUid === undefined) !== (this.spawnGid === undefined)) throw new Error('spawnUid and spawnGid must be provided together.');
    if (this.fenceUid !== undefined && this.spawnUid !== this.fenceUid) throw new Error('fenceUid must match spawnUid.');
    if (!Number.isInteger(this.maxProcesses) || this.maxProcesses < 1) throw new Error('maxProcesses must be a positive integer.');
    if (!Number.isInteger(this.maxRetainedOutputBytes) || this.maxRetainedOutputBytes < 1) throw new Error('maxRetainedOutputBytes must be a positive integer.');
    if (!Number.isInteger(this.completedTtlMs) || this.completedTtlMs < 1) throw new Error('completedTtlMs must be a positive integer.');
    if (!Number.isInteger(this.maxFullOutputBytes) || this.maxFullOutputBytes < 1) throw new Error('maxFullOutputBytes must be a positive integer.');
    if (!Number.isInteger(this.outputTtlMs) || this.outputTtlMs < 1) throw new Error('outputTtlMs must be a positive integer.');
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
    if (this.processes.size >= this.maxProcesses) {
      throw new QubiclError('process_limit', `This computer already has ${this.maxProcesses} managed processes. Read or stop an existing process before starting another.`, 429);
    }
    const id = randomBytes(12).toString('base64url');
    mkdirSync(this.outputDirectory, { recursive: true, mode: 0o700 });
    const outputPath = join(this.outputDirectory, `${id}.log`);
    const outputFile = openSync(outputPath, 'wx', 0o600);
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
      try { rmSync(outputPath, { force: true }); } catch { /* best-effort cleanup */ }
      throw error;
    }
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const managed: ManagedProcess = {
      id,
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
      outputFile,
      fullOutputBytes: 0,
      outputFileTruncated: false,
      timeoutMs: timeoutMs ?? null,
      timedOut: false,
      requestedSignal: null,
      terminationReason: null,
      forcedKill: false,
    };
    child.stdout.on('data', (chunk: Buffer) => this.append(managed, managed.stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => this.append(managed, managed.stderr, chunk));
    child.on('error', (error) => {
      this.append(managed, managed.stderr, Buffer.from(`${error.message}\n`));
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
    if (timeoutMs !== undefined) {
      managed.timeoutTimer = setTimeout(() => {
        if (managed.completed) return;
        managed.timedOut = true;
        void this.terminate(managed, 'SIGTERM', 'timeout').catch(() => undefined);
      }, timeoutMs);
      managed.timeoutTimer.unref();
    }

    await Promise.race([finished, delay(yieldTimeMs)]);
    const result = this.consume(managed);
    if (!result.running) this.delete(managed);
    return result;
  }

  async write(id: string, input: string, close: boolean, yieldTimeMs: number, owner: LeaseProof): Promise<ProcessResult> {
    const managed = this.owned(id, owner);
    if (input && !managed.child.stdin.destroyed) managed.child.stdin.write(input);
    if (close && !managed.child.stdin.destroyed) managed.child.stdin.end();
    if (!managed.completed) await Promise.race([managed.finished, delay(yieldTimeMs)]);
    const result = this.consume(managed);
    if (!result.running) this.delete(managed);
    return result;
  }

  async stop(id: string, owner: LeaseProof, signal: StopSignal = 'SIGTERM'): Promise<ProcessResult> {
    const managed = this.owned(id, owner);
    await this.terminate(managed, signal, 'stop');
    const result = this.consume(managed);
    if (!result.running) this.delete(managed);
    return result;
  }

  async terminateOwner(owner: LeaseProof | undefined): Promise<{ terminatedManagedProcesses: number }> {
    if (!owner && this.fenceUid === undefined) return { terminatedManagedProcesses: 0 };
    const matching = owner ? [...this.processes.values()].filter((process) => sameOwner(process.owner, owner)) : [...this.processes.values()];
    const terminatedManagedProcesses = matching.filter((process) => !process.completed).length;
    await Promise.all(matching.map(async (process) => {
      await this.terminate(process, 'SIGTERM', 'lease_revoked');
    }));
    const surviving = matching.filter((managed) => !managed.completed && processGroupExists(managed.child.pid));
    if (surviving.length) {
      throw new QubiclError('process_fencing_failed', `Could not confirm termination of ${surviving.length} managed process group${surviving.length === 1 ? '' : 's'}.`, 500);
    }
    for (const managed of matching) this.delete(managed);
    if (this.fenceUid !== undefined) await terminateUidPopulation(this.fenceUid);
    return { terminatedManagedProcesses };
  }

  count(): number {
    return this.processes.size;
  }

  retainedOutputBytes(): number {
    return this.retainedBytes;
  }

  private owned(id: string, owner: LeaseProof): ManagedProcess {
    const managed = this.processes.get(id);
    if (!managed) throw new QubiclError('process_not_found', `Managed process ${id} was not found.`, 404);
    if (!sameOwner(managed.owner, owner)) throw new QubiclError('stale_process_owner', 'This process belongs to a different lease generation.', 409);
    return managed;
  }

  private append(managed: ManagedProcess, stream: RetainedStream, chunk: Buffer): void {
    if (!chunk.length || !this.processes.has(managed.id)) return;
    this.appendFullOutput(managed, chunk);
    const retained = Buffer.from(chunk);
    stream.chunks.push({ data: retained, sequence: this.outputSequence += 1 });
    stream.bytes += retained.length;
    managed.outputBytes += retained.length;
    this.retainedBytes += retained.length;
    this.trimProcess(managed);
    this.trimGlobal();
  }

  private appendFullOutput(managed: ManagedProcess, chunk: Buffer): void {
    if (managed.outputFileTruncated) return;
    const remaining = this.maxFullOutputBytes - managed.fullOutputBytes;
    if (remaining <= 0) {
      managed.outputFileTruncated = true;
      return;
    }
    const retained = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
    try {
      writeSync(managed.outputFile, retained);
      managed.fullOutputBytes += retained.length;
      if (retained.length < chunk.length) managed.outputFileTruncated = true;
    } catch {
      managed.outputFileTruncated = true;
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
    const output = Buffer.concat(
      outputChunks,
      outputChunks.reduce((bytes, chunk) => bytes + chunk.length, 0),
    ).toString('utf8');
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
          ...(truncatedStreams.length ? {
            continuation: { path: managed.outputPath, retainedLogTruncated: managed.outputFileTruncated },
          } : {}),
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

  private complete(managed: ManagedProcess): void {
    if (managed.completed) return;
    managed.completed = true;
    if (managed.timeoutTimer) clearTimeout(managed.timeoutTimer);
    try { closeSync(managed.outputFile); } catch { /* already closed */ }
    managed.outputCleanupTimer = setTimeout(() => {
      try { rmSync(managed.outputPath, { force: true }); } catch { /* temporary output is best-effort */ }
    }, this.outputTtlMs);
    managed.outputCleanupTimer.unref();
    managed.expiryTimer = setTimeout(() => this.delete(managed), this.completedTtlMs);
    managed.expiryTimer.unref();
  }

  private delete(managed: ManagedProcess): void {
    if (this.processes.get(managed.id) !== managed) return;
    if (managed.expiryTimer) clearTimeout(managed.expiryTimer);
    if (managed.timeoutTimer) clearTimeout(managed.timeoutTimer);
    this.retainedBytes -= managed.outputBytes;
    managed.outputBytes = 0;
    managed.stdout.chunks = [];
    managed.stderr.chunks = [];
    this.processes.delete(managed.id);
  }

  private async terminate(
    managed: ManagedProcess,
    signal: StopSignal,
    reason: 'stop' | 'timeout' | 'lease_revoked',
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
    managed.requestedSignal = signal;
    managed.terminationReason = reason;
    try { process.kill(-(managed.child.pid!), signal); } catch { return; }
    await Promise.race([managed.finished, delay(1500)]);
    if (!managed.completed) {
      try {
        process.kill(-(managed.child.pid!), 'SIGKILL');
        managed.forcedKill = true;
      } catch { /* already gone */ }
      await Promise.race([managed.finished, delay(500)]);
    }
  }
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

function processGroupExists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
