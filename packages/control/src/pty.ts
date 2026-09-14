import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { QubiclError } from './errors.js';
import { workloadEnvironment } from './environments.js';
import type { LeaseProof } from './lease.js';
import type { ProcessLifecycle, StopSignal } from './processes.js';

const MAX_TERMINALS = 8;
const MAX_OUTPUT_BYTES = 4_000_000;
const MAX_AGGREGATE_OUTPUT_BYTES = 16_000_000;
const MAX_INPUT_BYTES = 64_000;
const MAX_PROTOCOL_LINE_BYTES = 256_000;
const DEFAULT_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_COMPLETED_TERMINALS = 32;

interface PtySession {
  id: string;
  label: string;
  lifecycle: Extract<ProcessLifecycle, 'session' | 'task'>;
  owner: LeaseProof;
  child: ChildProcessWithoutNullStreams;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  output: Buffer;
  outputOffset: number;
  totalOutput: number;
  protocolBuffer: Buffer;
  protocolError?: string;
  ready: Promise<void>;
  finish: Promise<void>;
  notify: Set<() => void>;
  cleanupTimer?: NodeJS.Timeout;
}

export interface PtySummary {
  terminalId: string;
  label: string;
  lifecycle: 'session' | 'task';
  running: boolean;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
  outputOffset: number;
  outputBytes: number;
}

export interface PtyPage extends PtySummary {
  offset: number;
  nextOffset: number;
  truncated: boolean;
  encoding: 'utf8' | 'base64';
  data: string;
}

export interface PtyManagerOptions {
  helperPath?: string;
  home?: string;
  environment?: NodeJS.ProcessEnv;
  spawnUid?: number;
  spawnGid?: number;
  maxTerminals?: number;
  maxOutputBytes?: number;
  maxAggregateOutputBytes?: number;
  completedTtlMs?: number;
  maxCompletedTerminals?: number;
}

export class PtyManager {
  private readonly sessions = new Map<string, PtySession>();
  private readonly helperPath: string;
  private readonly home: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly spawnUid: number | undefined;
  private readonly spawnGid: number | undefined;
  private readonly maxTerminals: number;
  private readonly maxOutputBytes: number;
  private readonly maxAggregateOutputBytes: number;
  private readonly completedTtlMs: number;
  private readonly maxCompletedTerminals: number;
  private aggregateOutputBytes = 0;

  constructor(options: PtyManagerOptions = {}) {
    this.helperPath = options.helperPath ?? process.env.QUBICL_PTY_HELPER ?? '/opt/qubicl/pty-helper.py';
    this.home = resolve(options.home ?? '/home/qubicl');
    this.environment = workloadEnvironment(options.environment ?? process.env, this.home);
    this.spawnUid = options.spawnUid;
    this.spawnGid = options.spawnGid;
    this.maxTerminals = options.maxTerminals ?? MAX_TERMINALS;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    this.maxAggregateOutputBytes = options.maxAggregateOutputBytes ?? MAX_AGGREGATE_OUTPUT_BYTES;
    this.completedTtlMs = options.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS;
    this.maxCompletedTerminals = options.maxCompletedTerminals ?? DEFAULT_MAX_COMPLETED_TERMINALS;
    if ((this.spawnUid === undefined) !== (this.spawnGid === undefined)) throw new Error('PTY spawnUid and spawnGid must be configured together.');
  }

  async open(command: string, cwd: string, rows: number, columns: number, owner: LeaseProof, lifecycle: 'session' | 'task', label: string): Promise<PtySummary> {
    if (this.runningCount() >= this.maxTerminals) throw new QubiclError('terminal_limit', `This computer already has ${this.maxTerminals} interactive terminals.`, 429);
    const id = randomBytes(12).toString('base64url');
    const child = spawn('/usr/bin/python3', ['-I', this.helperPath, String(rows), String(columns), cwd, command], {
      cwd,
      detached: true,
      env: this.environment,
      ...(this.spawnUid === undefined ? {} : { uid: this.spawnUid, gid: this.spawnGid }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    let finishResolve!: () => void;
    const ready = new Promise<void>((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
    const finish = new Promise<void>((resolveFinish) => { finishResolve = resolveFinish; });
    const session: PtySession = { id, label, lifecycle, owner, child, startedAt: Date.now(), output: Buffer.alloc(0), outputOffset: 0, totalOutput: 0, protocolBuffer: Buffer.alloc(0), ready, finish, notify: new Set() };
    this.sessions.set(id, session);
    child.stdout.on('data', (chunk: Buffer) => this.protocol(session, chunk, readyResolve, finishResolve));
    child.stderr.on('data', (chunk: Buffer) => this.append(session, chunk));
    child.on('error', (error) => { session.protocolError = error.message; readyReject(error); this.complete(session, undefined, undefined, finishResolve); });
    child.on('close', (code, signal) => this.complete(session, code ?? undefined, signal ?? undefined, finishResolve));
    const timer = setTimeout(() => readyReject(new Error('PTY helper did not become ready.')), 2_000);
    timer.unref();
    try { await ready; }
    catch (error) { await this.closeSession(session, true); throw new QubiclError('terminal_start_failed', `Interactive terminal could not start: ${(error as Error).message}`, 500); }
    finally { clearTimeout(timer); }
    return summary(session);
  }

  list(): PtySummary[] { return [...this.sessions.values()].map(summary).sort((a, b) => a.startedAt.localeCompare(b.startedAt)); }

  listForManagement(): Array<{ id: string; status: 'running' | 'exited' | 'signaled'; startedAt: string; finishedAt?: string; label: string; lifecycle: 'session' | 'task'; owner: 'agent' | 'computer'; ownerGeneration: number }> {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      status: session.finishedAt === undefined ? 'running' : session.signal ? 'signaled' : 'exited',
      startedAt: new Date(session.startedAt).toISOString(),
      ...(session.finishedAt ? { finishedAt: new Date(session.finishedAt).toISOString() } : {}),
      label: session.label,
      lifecycle: session.lifecycle,
      owner: session.lifecycle === 'session' ? 'agent' : 'computer',
      ownerGeneration: session.owner.generation,
    }));
  }

  async read(id: string, owner: LeaseProof, offset: number, maxBytes: number, waitMs: number, encoding: 'utf8' | 'base64'): Promise<PtyPage> {
    let session = this.owned(id, owner);
    const baseline = session.totalOutput;
    if (!session.finishedAt && offset >= baseline && waitMs > 0) await this.wait(session, waitMs);
    session = this.owned(id, owner);
    const requested = Math.max(0, Math.min(offset, session.totalOutput));
    const start = Math.max(requested, session.outputOffset);
    const local = start - session.outputOffset;
    const data = session.output.subarray(local, Math.min(session.output.length, local + maxBytes));
    return { ...summary(session), offset: start, nextOffset: start + data.length, truncated: requested < session.outputOffset || start + data.length < session.totalOutput, encoding, data: data.toString(encoding) };
  }

  async write(id: string, owner: LeaseProof, input: string): Promise<{ terminalId: string; acceptedBytes: number }> {
    const session = this.running(id, owner);
    const data = Buffer.from(input);
    if (data.length > MAX_INPUT_BYTES) throw new QubiclError('terminal_input_too_large', `Terminal input is limited to ${MAX_INPUT_BYTES} bytes.`, 413);
    await this.send(session, { type: 'input', data: data.toString('base64') });
    return { terminalId: id, acceptedBytes: data.length };
  }

  async resize(id: string, owner: LeaseProof, rows: number, columns: number): Promise<{ terminalId: string; rows: number; columns: number }> {
    const session = this.running(id, owner);
    await this.send(session, { type: 'resize', rows, columns });
    return { terminalId: id, rows, columns };
  }

  async signal(id: string, owner: LeaseProof, signal: StopSignal): Promise<{ terminalId: string; signal: StopSignal }> {
    const session = this.running(id, owner);
    await this.send(session, { type: 'signal', signal });
    return { terminalId: id, signal };
  }

  async close(id: string, owner: LeaseProof, force = false): Promise<PtySummary> {
    const session = this.owned(id, owner);
    await this.closeSession(session, force);
    return summary(session);
  }

  async closeForManagement(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    await this.closeSession(session, true);
    return true;
  }

  async terminateOwner(owner: LeaseProof | undefined): Promise<number> {
    const matches = [...this.sessions.values()].filter((session) => session.lifecycle === 'session' && (!owner || sameOwner(session.owner, owner)));
    await Promise.all(matches.map((session) => this.closeSession(session, true)));
    return matches.length;
  }

  async shutdown(): Promise<void> { await Promise.all([...this.sessions.values()].map((session) => this.closeSession(session, true))); }

  private protocol(session: PtySession, chunk: Buffer, ready: () => void, finish: () => void): void {
    session.protocolBuffer = Buffer.concat([session.protocolBuffer, chunk]);
    if (session.protocolBuffer.length > MAX_PROTOCOL_LINE_BYTES) {
      session.protocolError = 'PTY helper returned an oversized protocol line.';
      void this.closeSession(session, true);
      return;
    }
    for (;;) {
      const newline = session.protocolBuffer.indexOf(10);
      if (newline < 0) break;
      const line = session.protocolBuffer.subarray(0, newline).toString('utf8');
      session.protocolBuffer = session.protocolBuffer.subarray(newline + 1);
      try {
        const event = JSON.parse(line) as { type?: unknown; data?: unknown; code?: unknown; signal?: unknown; message?: unknown };
        if (event.type === 'ready') ready();
        else if (event.type === 'output' && typeof event.data === 'string') this.append(session, Buffer.from(event.data, 'base64'));
        else if (event.type === 'error' && typeof event.message === 'string') session.protocolError = event.message;
        else if (event.type === 'exit') this.complete(session, typeof event.code === 'number' ? event.code : undefined, typeof event.signal === 'string' ? event.signal as NodeJS.Signals : undefined, finish);
      } catch { session.protocolError = 'PTY helper returned invalid JSON.'; }
    }
  }

  private append(session: PtySession, data: Buffer): void {
    if (!data.length) return;
    session.output = Buffer.concat([session.output, data]);
    session.totalOutput += data.length;
    this.aggregateOutputBytes += data.length;
    this.dropOutput(session, Math.max(session.output.length - this.maxOutputBytes, 0));
    while (this.aggregateOutputBytes > this.maxAggregateOutputBytes) {
      const oldest = [...this.sessions.values()].filter((candidate) => candidate.output.length > 0)
        .sort((left, right) => Number(left.finishedAt === undefined) - Number(right.finishedAt === undefined) || left.startedAt - right.startedAt)[0];
      if (!oldest) break;
      this.dropOutput(oldest, this.aggregateOutputBytes - this.maxAggregateOutputBytes);
    }
    this.notify(session);
  }

  private dropOutput(session: PtySession, requested: number): void {
    const removed = Math.min(Math.max(requested, 0), session.output.length);
    if (!removed) return;
    session.output = session.output.subarray(removed);
    session.outputOffset += removed;
    this.aggregateOutputBytes -= removed;
  }

  private complete(session: PtySession, code: number | undefined, signal: NodeJS.Signals | undefined, finish: () => void): void {
    if (session.finishedAt) return;
    session.finishedAt = Date.now();
    if (code !== undefined) session.exitCode = code;
    if (signal !== undefined) session.signal = signal;
    finish();
    this.notify(session);
    session.cleanupTimer = setTimeout(() => this.deleteSession(session), this.completedTtlMs);
    session.cleanupTimer.unref();
    this.pruneCompleted();
  }

  private pruneCompleted(): void {
    const completed = [...this.sessions.values()].filter((session) => session.finishedAt !== undefined)
      .sort((left, right) => left.finishedAt! - right.finishedAt! || left.id.localeCompare(right.id));
    while (completed.length > this.maxCompletedTerminals) this.deleteSession(completed.shift()!);
  }

  private deleteSession(session: PtySession): void {
    if (this.sessions.get(session.id) !== session || session.finishedAt === undefined) return;
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    this.aggregateOutputBytes = Math.max(0, this.aggregateOutputBytes - session.output.length);
    session.output = Buffer.alloc(0);
    session.notify.clear();
    this.sessions.delete(session.id);
  }

  private async send(session: PtySession, value: Record<string, unknown>): Promise<void> {
    if (session.child.stdin.destroyed || session.child.stdin.writableEnded) throw new QubiclError('terminal_not_running', `Interactive terminal ${session.id} is not accepting input.`, 409);
    if (session.child.stdin.writableLength > 256_000) throw new QubiclError('terminal_backpressure', `Interactive terminal ${session.id} has too much queued input.`, 429);
    await new Promise<void>((resolveWrite, rejectWrite) => session.child.stdin.write(`${JSON.stringify(value)}\n`, (error) => error ? rejectWrite(new QubiclError('terminal_input_failed', `Terminal input failed: ${error.message}`, 409)) : resolveWrite()));
  }

  private async closeSession(session: PtySession, force: boolean): Promise<void> {
    if (session.finishedAt) return;
    if (!force) await this.send(session, { type: 'close' }).catch(() => undefined);
    else await this.send(session, { type: 'signal', signal: 'SIGKILL' }).catch(() => undefined);
    await Promise.race([session.finish, new Promise((resolveWait) => setTimeout(resolveWait, force ? 500 : 1_500))]);
    if (!session.finishedAt) {
      session.child.kill('SIGKILL');
      await Promise.race([session.finish, new Promise((resolveWait) => setTimeout(resolveWait, 500))]);
    }
    if (!session.finishedAt) throw new QubiclError('terminal_fencing_failed', `Interactive terminal ${session.id} could not be confirmed stopped.`, 500);
  }

  private owned(id: string, owner: LeaseProof): PtySession {
    const session = this.sessions.get(id);
    if (!session) throw new QubiclError('terminal_not_found', `Interactive terminal ${id} was not found.`, 404);
    if (session.lifecycle === 'session' && !sameOwner(session.owner, owner)) throw new QubiclError('stale_terminal_owner', 'This connection terminal belongs to a different lease generation.', 409);
    return session;
  }

  private running(id: string, owner: LeaseProof): PtySession {
    const session = this.owned(id, owner);
    if (session.finishedAt) throw new QubiclError('terminal_not_running', `Interactive terminal ${id} has exited.`, 409);
    return session;
  }

  private wait(session: PtySession, milliseconds: number): Promise<void> {
    return new Promise((resolveWait) => {
      const done = (): void => { clearTimeout(timer); session.notify.delete(done); resolveWait(); };
      const timer = setTimeout(done, milliseconds); timer.unref(); session.notify.add(done);
    });
  }
  private notify(session: PtySession): void { for (const notify of [...session.notify]) notify(); }
  private runningCount(): number { return [...this.sessions.values()].filter((session) => !session.finishedAt).length; }
}

function summary(session: PtySession): PtySummary {
  return {
    terminalId: session.id,
    label: session.label,
    lifecycle: session.lifecycle,
    running: session.finishedAt === undefined,
    startedAt: new Date(session.startedAt).toISOString(),
    ...(session.finishedAt ? { finishedAt: new Date(session.finishedAt).toISOString() } : {}),
    ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
    ...(session.signal === undefined ? {} : { signal: session.signal }),
    outputOffset: session.outputOffset,
    outputBytes: session.totalOutput,
  };
}

function sameOwner(left: LeaseProof, right: LeaseProof): boolean { return left.id === right.id && left.generation === right.generation && left.epoch === right.epoch; }
