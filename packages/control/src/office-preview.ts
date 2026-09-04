import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QubiclError } from './errors.js';

export const OFFICE_PREVIEW_MAX_BYTES = 20_000_000;

export interface OfficePreviewOptions {
  executable?: string;
  timeoutMs?: number;
  temporaryRoot?: string;
}

/** Fixed-shape conversions: no shell, inherited credentials, or durable profile. */
export class OfficePreviewManager {
  private readonly active = new Map<AbortController, Promise<Buffer>>();
  constructor(private readonly options: OfficePreviewOptions = {}) {}

  convert(data: Buffer, extension: '.docx' | '.pptx', signal?: AbortSignal): Promise<Buffer> {
    if (this.active.size >= 2) return Promise.reject(new QubiclError('preview_busy', 'Two Office previews are already running.', 429));
    if (data.length > OFFICE_PREVIEW_MAX_BYTES) return Promise.reject(new QubiclError('file_too_large', 'Office preview input exceeds 20 MB.', 413));
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const conversion = this.render(data, extension, cancellation.signal).finally(() => {
      signal?.removeEventListener('abort', abort);
      this.active.delete(cancellation);
    });
    this.active.set(cancellation, conversion);
    return conversion;
  }

  async cancelAll(): Promise<void> {
    const pending = [...this.active.values()];
    for (const cancellation of this.active.keys()) cancellation.abort();
    await Promise.allSettled(pending);
  }

  private async render(data: Buffer, extension: '.docx' | '.pptx', signal: AbortSignal): Promise<Buffer> {
    const directory = await mkdtemp(join(this.options.temporaryRoot ?? tmpdir(), 'qubicl-office-'));
    try {
      if (signal.aborted) throw cancelled();
      const profile = join(directory, 'profile');
      await mkdir(join(profile, 'user'), { recursive: true, mode: 0o700 });
      // A fresh profile must not inherit the user's macro trust or link-update settings.
      await writeFile(join(profile, 'user', 'registrymodifications.xcu'), `<?xml version="1.0"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop><prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
</oor:items>`, { mode: 0o600, flag: 'wx' });
      const input = join(directory, `document${extension}`);
      await writeFile(input, data, { mode: 0o600, flag: 'wx' });
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(cancelled()); return; }
        const child = spawn('/usr/bin/prlimit', [
          `--fsize=${OFFICE_PREVIEW_MAX_BYTES}:${OFFICE_PREVIEW_MAX_BYTES}`, '--',
          this.options.executable ?? '/usr/bin/libreoffice',
          `-env:UserInstallation=${pathToFileURL(profile).href}`,
          '--headless', '--nologo', '--nodefault', '--norestore', '--convert-to', 'pdf', '--outdir', directory, input,
        ], {
          cwd: directory,
          detached: true,
          stdio: 'ignore',
          env: { HOME: directory, TMPDIR: directory, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', SAL_USE_VCLPLUGIN: 'svp' },
        });
        let timedOut = false;
        const kill = () => {
          if (child.pid) {
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL'); }
          }
        };
        const timer = setTimeout(() => { timedOut = true; kill(); }, this.options.timeoutMs ?? 30_000);
        signal.addEventListener('abort', kill, { once: true });
        child.once('error', reject);
        child.once('close', (code) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', kill);
          kill(); // Reap helper descendants even if the launcher exited first.
          if (signal.aborted) reject(cancelled());
          else if (timedOut) reject(new QubiclError('preview_timeout', 'Office preview exceeded its time limit.', 504));
          else if (code !== 0) reject(new QubiclError('preview_unavailable', 'Office conversion failed or LibreOffice is unavailable. Download the original instead.', 422));
          else resolve();
        });
      });
      if (signal.aborted) throw cancelled();
      const output = await open(join(directory, 'document.pdf'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await output.stat();
        if (!info.isFile() || info.size > OFFICE_PREVIEW_MAX_BYTES) throw new QubiclError('preview_too_large', 'Office preview exceeds 20 MB.', 413);
        const buffer = Buffer.alloc(Math.min(info.size + 1, OFFICE_PREVIEW_MAX_BYTES + 1));
        let bytes = 0;
        while (bytes < buffer.length) {
          const result = await output.read(buffer, bytes, buffer.length - bytes, bytes);
          if (!result.bytesRead) break;
          bytes += result.bytesRead;
        }
        const pdf = buffer.subarray(0, bytes);
        if (bytes !== info.size) throw new QubiclError('invalid_preview', 'Office preview changed while being read.', 422);
        if (bytes > OFFICE_PREVIEW_MAX_BYTES) throw new QubiclError('preview_too_large', 'Office preview exceeds 20 MB.', 413);
        if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new QubiclError('invalid_preview', 'Office conversion did not produce a PDF.', 422);
        return pdf;
      } finally { await output.close(); }
    } catch (error) {
      if (error instanceof QubiclError) throw error;
      throw new QubiclError('preview_unavailable', 'Office conversion failed. Download the original instead.', 422);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function cancelled(): QubiclError {
  return new QubiclError('preview_cancelled', 'Office preview was cancelled.', 499);
}
