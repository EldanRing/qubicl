import { OfficePreviewManager } from './office-preview.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { annotateUntrustedToolResult, MODEL_TEXT_BUDGET_BYTES, toolDefinitions, type ComputerManifest, type DesktopApplicationName, type ToolName } from '@qubicl/core';
import type { z } from 'zod';
import { QubiclError } from './errors.js';
import { creationTime, mapFileSystemError, type FileErrorContext } from './file-errors.js';
import { DesktopApplicationManager } from './desktop-applications.js';
import { LeaseManager, type LeaseProof } from './lease.js';
import {
  ProcessManager,
  type CompatibilityProcessOutput,
  type CompatibilityProcessSummary,
  type CompatibilityStatusOptions,
  type ProcessOutputMode,
  type StopSignal,
} from './processes.js';
import { readEffectiveResourceLimits } from './resource-limits.js';
import { developmentComputerManifest } from './image-manifest.js';
import { withFileMutation } from './file-mutations.js';
import { BrowserManager, type BrowserComputerAction, type BrowserMouseButton, type BrowserViewerResult } from './browser.js';
import { desktopHelperEnvironment } from './environments.js';
import { RemoteBrokerManager, RemoteBrowserManager, RemoteDesktopApplicationManager, RemoteDesktopManager, RemotePortManager, RemoteProcessManager, RemoteWebManager, type RemoteProcessStatus } from './remote-runners.js';
import { discoverListeningPorts } from './ports.js';
import { PreviewManager, previewAccessFileSource, type PortSource } from './previews.js';
import { AuditLog, contentAuditMetadata, toolAuditMetadata } from './audit.js';
import { SkillManager } from './skills.js';
import { RuntimePolicy } from './policy.js';
import { ViewerPointerStore, type ViewerPointerUpdate } from './viewer-actions.js';
import { BoundedFileSystem, BoundedPathError, type BoundedListOptions } from './bounded-files.js';
import { createOpenTerminalArchive, OPEN_TERMINAL_ARCHIVE_LIMITS, type OpenTerminalArchive } from './open-terminal-archive.js';

type ToolInput = Record<string, unknown>;

export interface ToolExecutorOptions {
  processes?: ProcessController;
  desktopApplications?: DesktopApplicationController;
  browser?: BrowserManager;
  desktop?: DesktopController;
  durableRoot?: string;
  previews?: PreviewManager;
  skills?: SkillManager;
  policy?: RuntimePolicy;
  web?: WebController;
  viewerPointers?: ViewerPointerStore;
  files?: BoundedFileSystem;
  archiveFactory?: typeof createOpenTerminalArchive;
  officePreviews?: OfficePreviewManager;
}

type ProcessController = Pick<ProcessManager,
  | 'exec'
  | 'write'
  | 'stop'
  | 'executeCompatibility'
  | 'statusCompatibility'
  | 'inputCompatibility'
  | 'deleteCompatibility'
  | 'terminateOwner'
> & {
  count(): number | Promise<number>;
  listCompatibility(owner: LeaseProof): ReturnType<ProcessManager['listCompatibility']> | Promise<ReturnType<ProcessManager['listCompatibility']>>;
  status?(): Promise<RemoteProcessStatus>;
};
type DesktopApplicationController = Pick<DesktopApplicationManager, 'open' | 'close' | 'shutdown'> & {
  list(): ReturnType<DesktopApplicationManager['list']> | Promise<ReturnType<DesktopApplicationManager['list']>>;
  count(): number | Promise<number>;
};
interface DesktopController {
  screenshot(): Promise<unknown>;
  control(action: ControlAction): Promise<unknown>;
  readClipboard(): Promise<{ text: string; truncated?: boolean }>;
  writeClipboard(text: string): Promise<{ written: true }>;
}
interface WebController {
  search(input: { query: string; limit: number }): Promise<Record<string, unknown>>;
  extract(input: { url: string; format: 'markdown' | 'text'; maxChars: number }): Promise<Record<string, unknown>>;
  extractRendered(input: {
    finalUrl: string;
    title: string;
    contentType: string;
    html: string;
    sourceTruncated: boolean;
    format: 'markdown' | 'text';
    maxChars: number;
  }): Promise<Record<string, unknown>>;
}

export class ToolExecutor {
  readonly leases = new LeaseManager();
  readonly processes: ProcessController;
  readonly desktopApplications: DesktopApplicationController;
  readonly browser: BrowserManager;
  readonly desktop: DesktopController;
  readonly previews: PreviewManager;
  readonly broker: RemoteBrokerManager | undefined;
  readonly web: WebController | undefined;
  readonly skills: SkillManager;
  readonly policy: RuntimePolicy;
  readonly audit = new AuditLog();
  readonly viewerPointers: ViewerPointerStore;
  readonly computerId = process.env.QUBICL_ID ?? 'unknown';
  readonly computerName = process.env.QUBICL_NAME ?? 'qubicl';
  readonly manifest: ComputerManifest;
  readonly manifestSha256: string;
  readonly durableRoot: string;
  readonly files: BoundedFileSystem;
  private readonly archiveFactory: typeof createOpenTerminalArchive;
  private readonly officePreviews: OfficePreviewManager;
  private activeArchives = 0;
  private reservedArchiveBytes = 0;
  private gatewayEpoch: string | undefined;
  private gatewayTransition: Promise<void> | undefined;

  constructor(contract = developmentComputerManifest(), options: ToolExecutorOptions = {}) {
    this.manifest = contract.manifest;
    this.manifestSha256 = contract.sha256;
    this.policy = options.policy ?? new RuntimePolicy(contract.manifest);
    this.viewerPointers = options.viewerPointers ?? new ViewerPointerStore();
    this.durableRoot = resolve(options.durableRoot ?? options.files?.root ?? '/home/qubicl');
    this.files = options.files ?? new BoundedFileSystem(this.durableRoot);
    this.archiveFactory = options.archiveFactory ?? createOpenTerminalArchive;
    this.officePreviews = options.officePreviews ?? new OfficePreviewManager();
    if (this.files.root !== this.durableRoot) throw new Error('The bounded filesystem root must match the durable root.');
    this.processes = options.processes ?? configuredProcessController(this.durableRoot);
    this.desktopApplications = options.desktopApplications ?? configuredDesktopApplicationController(contract.manifest.compatibility, this.durableRoot);
    this.browser = options.browser ?? configuredBrowserController(contract.manifest.capabilities.includes('browser'), this.durableRoot);
    this.desktop = options.desktop ?? configuredDesktopController();
    this.previews = options.previews ?? configuredPreviewManager();
    this.skills = options.skills ?? new SkillManager({
      durableRoot: this.durableRoot,
      compatibility: contract.manifest.compatibility,
      enabledCatalogSkills: () => this.policy.enabledCatalogSkills(),
      expectedRegistrySha256: () => this.policy.expectedSkillRegistrySha256(),
      onRegistryIntegrityFailure: async () => { await this.leases.revokeAgentControl(); },
    });
    this.broker = process.env.QUBICL_BROKER_URL && process.env.QUBICL_BROKER_KEY
      ? new RemoteBrokerManager(process.env.QUBICL_BROKER_URL, process.env.QUBICL_BROKER_KEY)
      : undefined;
    this.web = options.web ?? (process.env.QUBICL_WEB_URL && process.env.QUBICL_WEB_KEY
      ? new RemoteWebManager(process.env.QUBICL_WEB_URL, process.env.QUBICL_WEB_KEY)
      : undefined);
    this.leases.setRevocationHandler(async (proof) => {
      this.viewerPointers.clear();
      await this.officePreviews.cancelAll();
      try {
        return await this.processes.terminateOwner(proof);
      } finally {
        // Capability URLs must be invalidated even if process fencing fails.
        // Lease acquisition remains fail-closed through LeaseManager's
        // rejected revocation state.
        this.previews.clear();
      }
    });
  }

  async call(name: ToolName, rawInput: unknown): Promise<unknown> {
    const started = Date.now();
    try {
      const result = annotateUntrustedToolResult(name, await this.executeCall(name, rawInput));
      this.audit.record({ type: 'tool', tool: name, status: 'ok', durationMs: Date.now() - started, ...toolAuditMetadata(name, (rawInput ?? {}) as Record<string, unknown>), ...contentAuditMetadata(result) });
      return result;
    } catch (error) {
      this.audit.record({ type: 'tool', tool: name, status: 'error', durationMs: Date.now() - started, code: error instanceof QubiclError ? error.code : 'internal_error', ...toolAuditMetadata(name, (rawInput ?? {}) as Record<string, unknown>) });
      throw error;
    }
  }

  private async executeCall(name: ToolName, rawInput: unknown): Promise<unknown> {
    if (!this.policy.isToolEnabled(name)) throw new QubiclError('capability_unsupported', `Tool ${name} is not supported because it is disabled by this computer's operator policy or capability contract.`, 404);
    const schema = toolDefinitions[name].input as z.ZodType<ToolInput>;
    const parsed = schema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new QubiclError('invalid_arguments', parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '));
    }
    const input = parsed.data;
    let owner: LeaseProof | undefined;
    if (toolDefinitions[name].lease) {
      owner = this.leases.verify(input.lease as LeaseProof, true);
    }
    const respond = (value: unknown): unknown => value;
    const respondBrowser = <T>(value: BrowserViewerResult<T>): T => {
      for (const action of value.pointerActions) this.viewerPointers.record(action);
      return value.result;
    };

    switch (name) {
      case 'get_computer_status': {
        // In the split runtime the controller has a deliberately tiny cgroup.
        // Report the executor's enforceable limits—the boundary in which model
        // commands actually run—rather than mislabeling controller limits as
        // the workload's scheduling capacity.
        const processStatus = await this.processes.status?.();
        const effectiveResourceLimits = processStatus?.effectiveResourceLimits ?? await readEffectiveResourceLimits();
        const lease = this.leases.snapshot();
        const full = input.detail === 'full';
        return {
          id: this.computerId,
          name: this.computerName,
          controller: lease.controller,
          effectiveResourceLimits,
          managedProcesses: processStatus?.managedProcesses ?? await this.processes.count(),
          ...(this.manifest.capabilities.includes('desktop-apps') ? { desktopApplications: await this.desktopApplications.count() } : {}),
          ...(this.manifest.capabilities.includes('browser') ? { browserSessions: this.browser.count() } : {}),
          preset: this.manifest.preset,
          compatibility: this.manifest.compatibility,
          environment: { durableHome: '/home/qubicl', hostMetricsMayDiffer: true },
          runtimeResourceEnvelope: configuredResourceEnvelope(),
          ...(full ? {
            lease,
            leasePolicy: { activityRefresh: true },
            resourceVisibility: {
              authoritativeForScheduling: 'effectiveResourceLimits',
              standardSystemInterfacesMayReportHostDerivedValues: true,
              hostFilesOutsideComputerHomeAccessible: false,
            },
            capabilities: this.manifest.capabilities,
            tools: this.policy.enabledTools(),
            policy: this.policy.snapshot(),
            manifestSha256: this.manifestSha256,
            ...(this.manifest.viewer ? { desktop: { display: process.env.DISPLAY ?? ':0' } } : {}),
          } : {}),
        };
      }
      case 'acquire_lease':
        return this.leases.acquire(input.durationSeconds as number);
      case 'renew_lease':
        return this.leases.renew(input.lease as LeaseProof, input.durationSeconds as number);
      case 'release_lease':
        await this.leases.release(input.lease as LeaseProof);
        return { released: true, lease: this.leases.snapshot() };
      case 'exec_command': {
        const result = await this.processes.exec(
          input.command as string,
          commandWorkingDirectory(this.durableRoot, input.cwd as string),
          input.yieldTimeMs as number,
          input.maxOutputBytes as number,
          owner!,
          input.timeoutMs as number | undefined,
          input.outputMode as ProcessOutputMode,
        );
        return respond(result);
      }
      case 'write_stdin':
        return respond(await this.processes.write(input.processId as string, input.input as string, input.close as boolean, input.yieldTimeMs as number, owner!));
      case 'stop_process':
        return respond(await this.processes.stop(input.processId as string, owner!, input.signal as StopSignal));
      case 'list_ports':
        return respond({ ports: await this.previews.listPorts() });
      case 'publish_port': {
        const publication = await this.previews.publish(input.port as number, input.expiresInSeconds as number);
        if (input.openInBrowser) {
          try {
            publication.browser = await this.browser.navigate(publication.browserUrl as string);
          } catch (error) {
            this.previews.unpublish(publication.id as string);
            throw error;
          }
        }
        return respond(publication);
      }
      case 'list_previews':
        return respond({ previews: this.previews.list() });
      case 'unpublish_port':
        return respond({ publicationId: input.publicationId, unpublished: this.previews.unpublish(input.publicationId as string) });
      case 'broker_request': {
        if (!this.broker) throw new QubiclError('credential_broker_unavailable', 'This runtime has no credential broker.', 503);
        const { lease: _lease, ...request } = input;
        return respond(await this.broker.request(request));
      }
      case 'skills_list':
        return respond(await this.skills.list(input.scope as 'active' | 'core' | 'imported' | 'catalog' | 'custom', input.query as string, input.cursor as number, input.limit as number));
      case 'skill_view':
        return respond(await this.skills.view(input.id as string, input.path as string, input.offset as number, input.maxBytes as number));
      case 'skill_manage':
        return respond(await this.skills.manage(input.mutation as Record<string, unknown>));
      case 'web_search': {
        if (!this.web) throw new QubiclError('web_service_unavailable', 'This runtime has no isolated web service.', 503);
        return respond(await this.web.search({ query: input.query as string, limit: input.limit as number }));
      }
      case 'web_extract': {
        if (!this.web) throw new QubiclError('web_service_unavailable', 'This runtime has no isolated web service.', 503);
        const render = input.render as 'auto' | 'never' | 'browser';
        const url = input.url as string;
        const format = input.format as 'markdown' | 'text';
        const maxChars = input.maxChars as number;
        if (render === 'browser') return respond(await this.browserExtract(url, format, maxChars));
        try {
          const extracted = await this.web.extract({ url, format, maxChars });
          if (render === 'auto' && extracted.browserRecommended === true && this.manifest.capabilities.includes('browser')) {
            return respond(await this.browserExtract(url, format, maxChars));
          }
          return respond(extracted);
        } catch (error) {
          if (render === 'auto' && this.manifest.capabilities.includes('browser') && error instanceof QubiclError
            && ['web_upstream_error', 'web_unsupported_content_type'].includes(error.code)) {
            return respond(await this.browserExtract(url, format, maxChars));
          }
          throw error;
        }
      }
      case 'list_files': {
        const path = this.workspacePath(input.path as string);
        return respond(await fileOperation(this.durableRoot, { operation: 'list', path }, async () => {
          const entryBudget = Math.max(1024, MODEL_TEXT_BUDGET_BYTES - Buffer.byteLength(path) - 512);
          const listing = await this.files.list(path, input.recursive as boolean, input.cursor as number, input.maxEntries as number, entryBudget);
          return { root: path, cursor: input.cursor as number, ...listing };
        }));
      }
      case 'get_file_info': {
        const path = this.workspacePath(input.path as string);
        return respond(await fileOperation(this.durableRoot, { operation: 'inspect', path }, async () => fileInfo(path, await this.files.info(path))));
      }
      case 'read_file': {
        const path = this.workspacePath(input.path as string);
        return respond(await fileOperation(this.durableRoot, { operation: 'read', path }, () => readToolFile(
          this.files,
          path,
          input.offset as number,
          input.limit as number,
          input.encoding as 'auto' | 'utf8',
          input.maxBytes as number,
        )));
      }
      case 'write_file': {
        const target = this.workspacePath(input.path as string);
        const data = Buffer.from(input.content as string, input.encoding as BufferEncoding);
        return respond(await fileOperation(this.durableRoot, { operation: 'write', path: target }, async () => {
          await withFileMutation(target, () => this.files.writeFile(target, data, { createParents: input.createParents as boolean }));
          return { path: target, bytesWritten: data.length };
        }));
      }
      case 'edit_file': {
        const path = this.workspacePath(input.path as string);
        return respond(await fileOperation(this.durableRoot, { operation: 'edit', path }, () => editFile(this.files, path, input.edits as EditOperation[])));
      }
      case 'copy_path': {
        const source = this.workspacePath(input.source as string);
        const destination = this.workspacePath(input.destination as string);
        const overwrite = input.overwrite as boolean;
        return respond(await fileOperation(this.durableRoot, { operation: 'copy', source, destination }, async () => {
          requireNonOverlappingDestination(source, destination);
          await this.files.copy(source, destination, overwrite);
          return { source, destination };
        }));
      }
      case 'move_path': {
        const source = this.workspacePath(input.source as string);
        const destination = this.workspacePath(input.destination as string);
        const overwrite = input.overwrite as boolean;
        return respond(await fileOperation(this.durableRoot, { operation: 'move', source, destination }, async () => {
          requireNonOverlappingDestination(source, destination);
          await this.files.move(source, destination, overwrite);
          return { source, destination };
        }));
      }
      case 'delete_path': {
        const target = this.workspacePath(input.path as string);
        if (target === this.durableRoot) {
          throw new QubiclError('unsafe_delete', `Refusing to delete protected path ${target}.`, 400);
        }
        return respond(await fileOperation(this.durableRoot, { operation: 'delete', path: target }, async () => {
          await this.files.remove(target, input.recursive as boolean);
          return { path: target, deleted: true };
        }));
      }
      case 'take_screenshot':
        return respond(await this.desktop.screenshot());
      case 'control_computer':
        {
          const action = input.action as ControlAction;
          const pointer = this.viewerPointers.begin(action);
          try {
            const result = await this.desktop.control(action);
            if (pointer) this.viewerPointers.confirm(pointer.actionId);
            return respond(result);
          } catch (error) {
            if (pointer) this.viewerPointers.cancel(pointer.actionId);
            throw error;
          }
        }
      case 'browser_navigate':
        return respond(await this.browser.navigate(input.url as string));
      case 'browser_snapshot':
        return respond(await this.browser.snapshot());
      case 'browser_screenshot':
        return respond(await this.browser.screenshot(input.full_page as boolean));
      case 'browser_click':
        return respond(respondBrowser(await this.browser.clickWithViewerPointer(input.ref as string, input.button as 'left' | 'right', owner!.generation)));
      case 'browser_type':
        return respond(await this.browser.type(input.ref as string, input.text as string, input.submit as boolean, input.clear as boolean));
      case 'browser_select':
        return respond(await this.browser.select(input.ref as string, input.value as string));
      case 'browser_press':
        return respond(await this.browser.press(input.key as string, input.ref as string | undefined));
      case 'browser_scroll':
        return respond(await this.browser.scroll(input.direction as 'up' | 'down', input.amount as number));
      case 'browser_history':
        return respond(await this.browser.history(input.action as 'back' | 'forward' | 'reload'));
      case 'browser_wait':
        return respond(await this.browser.wait(input.milliseconds as number));
      case 'browser_tabs':
        return respond(await this.browser.tabs());
      case 'browser_use_tab':
        return respond(await this.browser.useTab(input.index as number));
      case 'browser_new_tab':
        return respond(await this.browser.newTab(input.url as string | undefined));
      case 'browser_close_tab':
        return respond(await this.browser.closeTab(input.index as number));
      case 'browser_reset':
        return respond(await this.browser.reset());
      case 'browser_click_at':
        return respond(respondBrowser(await this.browser.computerWithViewerPointers([{
          type: 'click', x: input.x as number, y: input.y as number, button: input.button as BrowserMouseButton,
        }], owner!.generation)));
      case 'browser_double_click_at':
        return respond(respondBrowser(await this.browser.computerWithViewerPointers([{
          type: 'double_click', x: input.x as number, y: input.y as number, button: input.button as BrowserMouseButton,
        }], owner!.generation)));
      case 'browser_hover_at':
        return respond(respondBrowser(await this.browser.computerWithViewerPointers([{
          type: 'move', x: input.x as number, y: input.y as number,
        }], owner!.generation)));
      case 'browser_drag':
        return respond(respondBrowser(await this.browser.computerWithViewerPointers([{
          type: 'drag',
          path: [
            { x: input.start_x as number, y: input.start_y as number },
            { x: input.end_x as number, y: input.end_y as number },
          ],
        }], owner!.generation)));
      case 'browser_scroll_at':
        return respond(respondBrowser(await this.browser.computerWithViewerPointers([{
          type: 'scroll',
          x: input.x as number,
          y: input.y as number,
          scroll_x: input.scroll_x as number,
          scroll_y: input.scroll_y as number,
        }], owner!.generation)));
      case 'browser_type_focused':
        return respond(await this.browser.typeFocused(input.text as string));
      case 'browser_inspect_at':
        return respond(await this.browser.inspectAt(input.x as number, input.y as number));
      case 'browser_computer':
        return respond(respondBrowser(await this.browser.computerWithViewerPointers(input.actions as BrowserComputerAction[], owner!.generation)));
      case 'read_clipboard': {
        return respond(await this.desktop.readClipboard());
      }
      case 'write_clipboard': {
        return respond(await this.desktop.writeClipboard(input.text as string));
      }
      case 'open_desktop_application':
        return respond(await this.desktopApplications.open(
          input.application as DesktopApplicationName,
          input.paths as string[],
        ));
      case 'list_desktop_applications':
        return respond({ applications: await this.desktopApplications.list() });
      case 'close_desktop_application':
        return respond(await this.desktopApplications.close(input.applicationId as string));
    }
  }

  enabledToolNames(): ToolName[] { return this.policy.enabledTools(); }

  compatibilityProcessList(proof: LeaseProof): Promise<CompatibilityProcessSummary[]> {
    return this.compatibilityOperation('exec_command', 'process-list', proof, async (owner) => this.processes.listCompatibility(owner));
  }

  compatibilityProcessExecute(
    command: string,
    cwd: string,
    proof: LeaseProof,
    options: CompatibilityStatusOptions,
    sessionId: string | null,
  ): Promise<CompatibilityProcessOutput> {
    return this.compatibilityOperation('exec_command', 'process-start', proof, (owner) => {
      if (Buffer.byteLength(command, 'utf8') > 64 * 1024) {
        throw new QubiclError('command_too_large', 'command exceeds the 65536-byte UTF-8 limit.', 413);
      }
      if (sessionId !== null && (sessionId.length < 1 || sessionId.length > 256)) {
        throw new QubiclError('invalid_arguments', 'The compatibility session identifier is invalid.', 400);
      }
      const workingDirectory = commandWorkingDirectory(this.durableRoot, cwd);
      return this.processes.executeCompatibility(command, workingDirectory, owner, options, sessionId);
    }, {}, true);
  }

  compatibilityProcessStatus(id: string, proof: LeaseProof, options: CompatibilityStatusOptions): Promise<CompatibilityProcessOutput> {
    return this.compatibilityOperation('exec_command', 'process-attach', proof, (owner) => (
      this.processes.statusCompatibility(id, owner, options)
    ), { processId: id });
  }

  compatibilityProcessInput(id: string, input: string, proof: LeaseProof): Promise<{ status: 'ok' }> {
    const bytes = Buffer.byteLength(input, 'utf8');
    return this.compatibilityOperation('write_stdin', 'process-input', proof, (owner) => {
      if (bytes > 64 * 1024) throw new QubiclError('input_too_large', 'input exceeds the 65536-byte UTF-8 limit.', 413);
      return this.processes.inputCompatibility(id, input, owner);
    }, { processId: id, bytes }, true);
  }

  compatibilityProcessDelete(id: string, proof: LeaseProof, force: boolean): Promise<{ status: 'killed' }> {
    return this.compatibilityOperation('stop_process', 'process-stop', proof, (owner) => (
      this.processes.deleteCompatibility(id, owner, force)
    ), { processId: id, force });
  }

  compatibilityOfficePreview(data: Buffer, extension: '.docx' | '.pptx', proof: LeaseProof, signal?: AbortSignal): Promise<Buffer> {
    return this.compatibilityOperation('read_file', 'office-preview', proof, async () => {
      if (this.manifest.preset !== 'workstation') throw new QubiclError('preview_unsupported', 'PDF previews of Office documents require the workstation preset.', 415);
      return this.officePreviews.convert(data, extension, signal);
    });
  }

  compatibilityFileList(target: string, proof: LeaseProof, recursive: boolean, options: BoundedListOptions = {}) {
    return this.compatibilityOperation('list_files', 'file-list', proof, () => (
      this.files.list(this.workspacePath(target), recursive, 0, 10_000, 4_000_000, options)
    ));
  }

  compatibilityFileRead(target: string, proof: LeaseProof): Promise<{ data: Buffer; mimeType?: string }> {
    return this.compatibilityOperation('read_file', 'editor-read', proof, async () => {
      const { data, info } = await this.files.readFile(this.workspacePath(target), MAX_TEXT_SOURCE_BYTES);
      if (!info.isFile()) throw new QubiclError('not_a_file', 'Editor reads require a regular file.', 400);
      if (info.size > MAX_TEXT_SOURCE_BYTES || data.length > MAX_TEXT_SOURCE_BYTES) {
        throw new QubiclError('file_too_large', `Files larger than ${MAX_TEXT_SOURCE_BYTES} bytes cannot be opened in the editor. Download the original instead.`, 413);
      }
      const mimeType = supportedImageMimeType(data);
      return { data, ...(mimeType ? { mimeType } : {}) };
    });
  }

  async compatibilityArchive(paths: readonly string[], proof: LeaseProof, signal?: AbortSignal): Promise<OpenTerminalArchive> {
    const started = Date.now();
    let releaseReservation: (() => void) | undefined;
    try {
      for (const name of ['list_files', 'read_file'] as const) {
        if (!this.policy.isToolEnabled(name)) {
          throw new QubiclError('capability_unsupported', `Tool ${name} is not supported because it is disabled by this computer's operator policy or capability contract.`, 404);
        }
      }
      this.leases.verify(proof, true);
      if (signal?.aborted) throw new QubiclError('archive_cancelled', 'Archive creation was cancelled because the client disconnected.', 499);
      releaseReservation = this.reserveArchive();
      const bounded = paths.map((path) => this.workspacePath(path));
      const archive = await this.archiveFactory(this.files, bounded, signal ? { signal } : {});
      try {
        if (signal?.aborted) throw new QubiclError('archive_cancelled', 'Archive creation was cancelled because the client disconnected.', 499);
        for (const name of ['list_files', 'read_file'] as const) {
          if (!this.policy.isToolEnabled(name)) {
            throw new QubiclError('capability_unsupported', `Tool ${name} was disabled while the compatibility operation was in progress.`, 404);
          }
        }
        this.leases.verify(proof, true);
        this.audit.record({ type: 'tool', tool: 'read_file', compatibility: 'open-terminal', operation: 'archive-read', status: 'ok', durationMs: Date.now() - started, pathCount: paths.length });
        const release = releaseReservation;
        releaseReservation = undefined;
        let cleaned = false;
        return {
          ...archive,
          cleanup: async () => {
            if (cleaned) return;
            cleaned = true;
            try { await archive.cleanup(); }
            finally { release?.(); }
          },
        };
      } catch (error) {
        await archive.cleanup();
        throw error;
      }
    } catch (error) {
      this.audit.record({ type: 'tool', tool: 'read_file', compatibility: 'open-terminal', operation: 'archive-read', status: 'error', durationMs: Date.now() - started, pathCount: paths.length, code: error instanceof QubiclError ? error.code : 'internal_error' });
      throw error;
    } finally {
      releaseReservation?.();
    }
  }

  private reserveArchive(): () => void {
    const reservedBytes = OPEN_TERMINAL_ARCHIVE_LIMITS.maximumOutputBytes;
    if (this.activeArchives >= OPEN_TERMINAL_ARCHIVE_LIMITS.maximumConcurrentArchives
      || this.reservedArchiveBytes + reservedBytes > OPEN_TERMINAL_ARCHIVE_LIMITS.maximumReservedOutputBytes) {
      throw new QubiclError(
        'archive_busy',
        `This computer already has ${this.activeArchives} active archive download${this.activeArchives === 1 ? '' : 's'}. Wait for one to finish before starting another.`,
        429,
      );
    }
    this.activeArchives += 1;
    this.reservedArchiveBytes += reservedBytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeArchives = Math.max(0, this.activeArchives - 1);
      this.reservedArchiveBytes = Math.max(0, this.reservedArchiveBytes - reservedBytes);
    };
  }

  applyViewerPointerUpdate(update: ViewerPointerUpdate): boolean {
    const lease = this.leases.snapshot();
    if (lease.controller !== 'agent' || lease.generation !== update.generation) return false;
    return this.viewerPointers.apply(update);
  }

  private async compatibilityOperation<T>(
    tool: 'exec_command' | 'write_stdin' | 'stop_process' | 'read_file' | 'list_files',
    operation: string,
    proof: LeaseProof,
    action: (owner: LeaseProof) => Promise<T> | T,
    metadata: Record<string, unknown> = {},
    fenceAmbiguousFailure = false,
  ): Promise<T> {
    const started = Date.now();
    try {
      if (!this.policy.isToolEnabled(tool)) {
        throw new QubiclError('capability_unsupported', `Tool ${tool} is not supported because it is disabled by this computer's operator policy or capability contract.`, 404);
      }
      const owner = this.leases.verify(proof, true);
      let result: T;
      try {
        result = await action(owner);
      } catch (error) {
        if (fenceAmbiguousFailure && error instanceof QubiclError && error.code === 'internal_runner_ambiguous') {
          try { await this.leases.revokeAgentControlFor(owner); }
          catch (fenceError) {
            throw new QubiclError(
              'process_fencing_failed',
              `The isolated process operation had an ambiguous result. The lease was invalidated, but Qubicl could not confirm owner fencing: ${(fenceError as Error).message}`,
              500,
            );
          }
        }
        throw error;
      }
      try {
        if (!this.policy.isToolEnabled(tool)) {
          throw new QubiclError('capability_unsupported', `Tool ${tool} was disabled while the compatibility operation was in progress.`, 404);
        }
        this.leases.verify(owner, true);
      } catch (boundaryError) {
        await this.leases.revokeAgentControlFor(owner);
        throw boundaryError;
      }
      this.audit.record({ type: 'tool', tool, compatibility: 'open-terminal', operation, status: 'ok', durationMs: Date.now() - started, ...metadata });
      return result;
    } catch (error) {
      this.audit.record({ type: 'tool', tool, compatibility: 'open-terminal', operation, status: 'error', durationMs: Date.now() - started, ...metadata, code: error instanceof QubiclError ? error.code : 'internal_error' });
      throw error;
    }
  }

  private async browserExtract(url: string, format: 'markdown' | 'text', maxChars: number): Promise<Record<string, unknown>> {
    if (!this.manifest.capabilities.includes('browser')) {
      throw new QubiclError('capability_unsupported', 'Browser-rendered extraction requires a browser-capable computer preset.', 400);
    }
    if (!this.web) throw new QubiclError('web_service_unavailable', 'This runtime has no isolated web service.', 503);
    const rendered = await this.browser.renderForExtraction(url);
    return this.web.extractRendered({ ...rendered, format, maxChars });
  }

  async reloadPolicy(): Promise<Record<string, unknown>> {
    const loaded = await this.policy.load();
    const revocation = loaded.changed ? await this.leases.revokeAgentControl() : { terminatedManagedProcesses: 0 };
    return { ...loaded, ...revocation, tools: this.policy.enabledTools(), catalogSkills: this.policy.enabledCatalogSkills(), reconnectRequired: loaded.changed };
  }

  async takeHumanControl(): Promise<unknown> {
    const takeover = await this.leases.takeHumanControl();
    this.audit.record({ type: 'control', action: 'human-take', generation: takeover.generation, terminatedManagedProcesses: takeover.terminatedManagedProcesses });
    return {
      ...takeover,
      preservedDesktopApplications: await this.desktopApplications.count(),
      preservedBrowserSessions: this.browser.count(),
    };
  }

  releaseHumanControl(): unknown {
    this.viewerPointers.clear();
    const released = this.leases.releaseHumanControl();
    this.audit.record({ type: 'control', action: 'human-release', generation: released.generation });
    return released;
  }

  async observeGatewayEpoch(epoch: string): Promise<void> {
    if (epoch !== this.gatewayEpoch) {
      const hadPriorGateway = this.gatewayEpoch !== undefined;
      this.gatewayEpoch = epoch;
      if (hadPriorGateway) {
        const previous = this.gatewayTransition ?? Promise.resolve();
        this.gatewayTransition = previous.then(() => this.leases.resetEpoch());
      }
    }
    if (this.gatewayTransition) {
      const transition = this.gatewayTransition;
      await transition;
      if (this.gatewayTransition === transition) this.gatewayTransition = undefined;
    }
  }

  async shutdown(): Promise<void> {
    this.previews.clear();
    await Promise.all([this.desktopApplications.shutdown(), this.browser.shutdown()]);
    await this.audit.flush();
  }

  private workspacePath(value: string): string {
    try { return this.files.absolutePath(value); }
    catch (error) {
      if (!(error instanceof BoundedPathError)) throw error;
      throw new QubiclError('path_outside_workspace', `Paths must stay beneath the durable workspace ${this.durableRoot}.`, 403);
    }
  }
}

function configuredResourceEnvelope(): unknown {
  const value = process.env.QUBICL_RESOURCE_ENVELOPE_JSON;
  if (!value) return undefined;
  try { return JSON.parse(value) as unknown; } catch { return { unavailable: true }; }
}

function configuredProcessController(root: string): ProcessController {
  const url = process.env.QUBICL_EXECUTOR_URL;
  const key = process.env.QUBICL_EXECUTOR_KEY;
  if (url || key) {
    if (!url || !key) throw new Error('QUBICL_EXECUTOR_URL and QUBICL_EXECUTOR_KEY must be configured together.');
    return new RemoteProcessManager(url, key);
  }
  return new ProcessManager({ home: root });
}

function configuredDesktopApplicationController(compatibility: ComputerManifest['compatibility'], root: string): DesktopApplicationController {
  const url = process.env.QUBICL_SESSION_URL;
  const key = process.env.QUBICL_SESSION_KEY;
  if (url || key) {
    if (!url || !key) throw new Error('QUBICL_SESSION_URL and QUBICL_SESSION_KEY must be configured together.');
    return new RemoteDesktopApplicationManager(url, key);
  }
  return new DesktopApplicationManager(compatibility, { root });
}

function configuredBrowserController(enabled: boolean, root: string): BrowserManager {
  const sessionUrl = process.env.QUBICL_SESSION_URL;
  const sessionKey = process.env.QUBICL_SESSION_KEY;
  if (enabled && sessionUrl && sessionKey) return new RemoteBrowserManager(sessionUrl, sessionKey);
  return new BrowserManager(enabled, { home: root });
}

function configuredDesktopController(): DesktopController {
  const sessionUrl = process.env.QUBICL_SESSION_URL;
  const sessionKey = process.env.QUBICL_SESSION_KEY;
  if (sessionUrl || sessionKey) {
    if (!sessionUrl || !sessionKey) throw new Error('QUBICL_SESSION_URL and QUBICL_SESSION_KEY must be configured together.');
    const remote = new RemoteDesktopManager(sessionUrl, sessionKey);
    return {
      screenshot: () => remote.screenshot(),
      control: (action) => remote.control(action as unknown as Record<string, unknown>),
      readClipboard: () => remote.readClipboard(),
      writeClipboard: (text) => remote.writeClipboard(text),
    };
  }
  return {
    screenshot: takeScreenshot,
    control: controlDesktop,
    readClipboard,
    writeClipboard: async (text) => {
      await writeClipboard(text);
      return { written: true };
    },
  };
}

function configuredPreviewManager(): PreviewManager {
  const executorUrl = process.env.QUBICL_EXECUTOR_URL;
  const executorKey = process.env.QUBICL_EXECUTOR_KEY;
  const source: PortSource = executorUrl && executorKey
    ? new RemotePortManager(executorUrl, executorKey)
    : { listPorts: () => discoverListeningPorts(process.getuid?.() ?? 1000) };
  const id = process.env.QUBICL_ID ?? 'unknown';
  return new PreviewManager(
    source,
    process.env.QUBICL_EXECUTOR_HOST ?? '127.0.0.1',
    process.env.QUBICL_PUBLIC_PREVIEW_BASE ?? `http://127.0.0.1:3211/computers/${id}/previews`,
    process.env.QUBICL_INTERNAL_PREVIEW_BASE ?? `http://127.0.0.1:3211/computers/${id}/previews`,
    process.env.QUBICL_REMOTE_PREVIEW_BASE,
    process.env.QUBICL_PREVIEW_ACCESS_PATH ? previewAccessFileSource(process.env.QUBICL_PREVIEW_ACCESS_PATH) : undefined,
  );
}

export interface ControlAction {
  type: 'click' | 'double_click' | 'right_click' | 'move' | 'drag' | 'type' | 'keypress' | 'scroll' | 'wait';
  x?: number;
  y?: number;
  button?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  durationMs?: number;
  text?: string;
  keys?: string[];
  deltaY?: number;
  targetWindowId?: number;
}

type DesktopCommandRunner = (command: string, args: string[], stdin?: string) => Promise<{ stdout: string; stderr: string }>;

interface WindowEvidence {
  id: number;
  title: string | null;
  className: string | null;
}

interface EditOperation {
  oldText: string;
  newText: string;
}

interface ResolvedEdit extends EditOperation {
  start: number;
  end: number;
}

const MAX_TEXT_READ_BYTES = MODEL_TEXT_BUDGET_BYTES;
const MAX_TEXT_SOURCE_BYTES = 20_000_000;
const MAX_EDIT_DIFF_BYTES = MODEL_TEXT_BUDGET_BYTES;

function fileInfo(target: string, info: import('node:fs').Stats): unknown {
  return {
    path: target,
    name: basename(target),
    type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'symlink' : 'other',
    size: info.size,
    mode: `0${(info.mode & 0o7777).toString(8)}`,
    modifiedAt: info.mtime.toISOString(),
    createdAt: creationTime(info),
  };
}

function commandWorkingDirectory(root: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(root, value);
}

async function fileOperation<T>(root: string, context: FileErrorContext, action: (context: FileErrorContext) => Promise<T>): Promise<T> {
  try { return await action(context); }
  catch (error) {
    if (error instanceof BoundedPathError) {
      const path = error.path;
      throw new QubiclError('path_outside_workspace', `Path ${path} resolves outside the durable workspace ${root}.`, 403);
    }
    throw mapFileSystemError(error, context);
  }
}

function requireNonOverlappingDestination(source: string, destination: string): void {
  if (source === destination || isWithin(source, destination) || isWithin(destination, source)) {
    throw new QubiclError('destination_invalid', `Destination ${destination} overlaps the source path ${source}. Choose a separate destination.`, 400);
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const nested = relative(parent, candidate);
  return nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
}

async function readToolFile(
  files: BoundedFileSystem,
  target: string,
  offset: number,
  limit: number,
  encoding: 'auto' | 'utf8',
  maxBytes: number,
): Promise<unknown> {
  const { data, info } = await files.readFile(target, MAX_TEXT_SOURCE_BYTES + 1);
  if (!info.isFile()) throw new QubiclError('not_a_file', `${target} is not a regular file.`, 400);
  if (info.size > MAX_TEXT_SOURCE_BYTES || data.length > MAX_TEXT_SOURCE_BYTES) {
    throw new QubiclError('file_too_large', `${target} is ${info.size} bytes; files larger than ${MAX_TEXT_SOURCE_BYTES} bytes cannot be read through this tool.`, 413);
  }
  const mimeType = encoding === 'auto' ? supportedImageMimeType(data) : undefined;
  if (mimeType) {
    if (data.length > maxBytes) throw new QubiclError('file_too_large', `${target} is ${data.length} bytes; the image read limit is ${maxBytes}.`, 413);
    return { path: target, size: data.length, encoding: 'base64', mimeType, ...imageDimensions(data, mimeType), data: data.toString('base64') };
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch {
    throw new QubiclError('unsupported_binary_file', `${target} is not valid UTF-8 or a supported image. Use a client-native file download or a bounded shell inspection instead of placing binary data in model context.`, 415);
  }
  const lines = text.split('\n');
  if (offset > lines.length) {
    throw new QubiclError('offset_out_of_range', `Line offset ${offset} is beyond the end of ${target} (${lines.length} lines).`, 400);
  }
  const requested = lines.slice(offset - 1, offset - 1 + limit);
  const bounded = truncateCompleteLines(requested, MAX_TEXT_READ_BYTES);
  const consumedLines = bounded.lines;
  const nextOffset = offset + consumedLines;
  const hasMoreLines = nextOffset - 1 < lines.length;
  const truncated = hasMoreLines || bounded.longLineTruncated;
  return {
    path: target,
    size: data.length,
    encoding: 'utf8',
    content: bounded.content,
    startLine: offset,
    endLine: consumedLines ? nextOffset - 1 : offset - 1,
    totalLines: lines.length,
    truncated,
    ...(truncated ? {
      ...(hasMoreLines ? { nextOffset, continuation: `Read the next section with offset ${nextOffset}.` } : {}),
      ...(bounded.longLineTruncated ? { note: `Line ${nextOffset - 1} exceeded the ${MAX_TEXT_READ_BYTES}-byte response limit and was truncated.` } : {}),
    } : {}),
  };
}

async function editFile(files: BoundedFileSystem, target: string, edits: EditOperation[]): Promise<unknown> {
  return withFileMutation(target, async () => {
    const read = await files.readFile(target, undefined, 'edit');
    const originalData = read.data;
    const hasBom = originalData.length >= 3 && originalData[0] === 0xef && originalData[1] === 0xbb && originalData[2] === 0xbf;
    const bodyData = hasBom ? originalData.subarray(3) : originalData;
    let original: string;
    try { original = new TextDecoder('utf-8', { fatal: true }).decode(bodyData); }
    catch { throw new QubiclError('unsupported_binary_file', `${target} is not valid UTF-8 and cannot be edited as text.`, 415); }
    const lineEnding = preferredLineEnding(original);
    const resolved = edits.map((edit, index) => resolveEdit(original, edit, index, lineEnding)).sort((left, right) => left.start - right.start);
    for (let index = 1; index < resolved.length; index += 1) {
      if (resolved[index]!.start < resolved[index - 1]!.end) {
        throw new QubiclError('overlapping_edits', `Edits ${index} and ${index + 1} overlap in ${target}; each original range may be changed only once.`, 409);
      }
    }
    let updated = original;
    for (const edit of resolved.toReversed()) updated = `${updated.slice(0, edit.start)}${edit.newText}${updated.slice(edit.end)}`;
    const updatedData = Buffer.concat([hasBom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(updated, 'utf8')]);
    await files.writeFile(target, updatedData, {
      createParents: false,
      operation: 'edit',
      expectedIdentity: read.identity,
      expectedNamedIdentity: read.namedIdentity,
    });
    const rendered = renderEditDiff(target, original, resolved);
    const boundedDiff = truncateUtf8(rendered, MAX_EDIT_DIFF_BYTES);
    return {
      path: target,
      replacements: resolved.length,
      bytesWritten: updatedData.length,
      diff: boundedDiff.text,
      diffTruncated: boundedDiff.truncated,
    };
  });
}

function resolveEdit(original: string, edit: EditOperation, index: number, lineEnding: '\n' | '\r\n'): ResolvedEdit {
  const oldText = normalizeLineEndings(edit.oldText, lineEnding);
  const newText = normalizeLineEndings(edit.newText, lineEnding);
  const matches: number[] = [];
  let searchFrom = 0;
  for (;;) {
    const found = original.indexOf(oldText, searchFrom);
    if (found < 0) break;
    matches.push(found);
    if (matches.length > 1) break;
    searchFrom = found + 1;
  }
  if (!matches.length) throw new QubiclError('edit_text_not_found', `Edit ${index + 1} oldText was not found exactly in the original file.`, 409);
  if (matches.length > 1) throw new QubiclError('edit_text_not_unique', `Edit ${index + 1} oldText occurs more than once in the original file; include more surrounding text.`, 409);
  return { oldText, newText, start: matches[0]!, end: matches[0]! + oldText.length };
}

function preferredLineEnding(text: string): '\n' | '\r\n' {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const bareLf = text.match(/(?<!\r)\n/g)?.length ?? 0;
  return crlf > bareLf ? '\r\n' : '\n';
}

function normalizeLineEndings(text: string, lineEnding: '\n' | '\r\n'): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\n', lineEnding);
}

function renderEditDiff(path: string, original: string, edits: ResolvedEdit[]): string {
  const lines = [`--- ${path}`, `+++ ${path}`];
  let lineDelta = 0;
  for (const edit of edits) {
    const oldStart = countLines(original.slice(0, edit.start));
    const oldLines = edit.oldText.replaceAll('\r\n', '\n').split('\n');
    const newLines = edit.newText.replaceAll('\r\n', '\n').split('\n');
    const newStart = oldStart + lineDelta;
    lines.push(`@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`);
    lines.push(...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`));
    lineDelta += newLines.length - oldLines.length;
  }
  return `${lines.join('\n')}\n`;
}

function countLines(text: string): number {
  let lines = 1;
  for (const character of text) if (character === '\n') lines += 1;
  return lines;
}

function truncateCompleteLines(lines: string[], maxBytes: number): { content: string; lines: number; longLineTruncated: boolean } {
  const joined = lines.join('\n');
  if (Buffer.byteLength(joined) <= maxBytes) return { content: joined, lines: lines.length, longLineTruncated: false };
  const prefix = truncateUtf8(joined, maxBytes).text;
  const lastNewline = prefix.lastIndexOf('\n');
  if (lastNewline >= 0) {
    const content = prefix.slice(0, lastNewline);
    return { content, lines: content.split('\n').length, longLineTruncated: false };
  }
  return { content: prefix, lines: 1, longLineTruncated: true };
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const data = Buffer.from(value, 'utf8');
  if (data.length <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  while (end > 0) {
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, end)), truncated: true }; }
    catch { end -= 1; }
  }
  return { text: '', truncated: true };
}

function supportedImageMimeType(data: Buffer): string | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}

function imageDimensions(data: Buffer, mimeType: string): { width?: number; height?: number } {
  if (mimeType === 'image/png' && data.length >= 24) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (mimeType === 'image/gif' && data.length >= 10) return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  return {};
}

export async function takeScreenshot(): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-screenshot-'));
  const target = join(directory, 'screen.png');
  try {
    await run('scrot', ['--silent', target]);
    const data = await readFile(target);
    return { mimeType: 'image/png', width: data.readUInt32BE(16), height: data.readUInt32BE(20), data: data.toString('base64') };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function controlDesktop(action: ControlAction, runner: DesktopCommandRunner = run): Promise<unknown> {
  const recordsFocus = ['click', 'double_click', 'right_click', 'type', 'keypress'].includes(action.type);
  const acceptsTarget = action.type === 'type' || action.type === 'keypress';
  const focusBefore = acceptsTarget ? await prepareInputFocus(action.targetWindowId, runner) : null;
  switch (action.type) {
    case 'click':
      await runner('xdotool', ['mousemove', `${action.x}`, `${action.y}`, 'click', `${action.button}`]);
      break;
    case 'double_click':
      await runner('xdotool', ['mousemove', `${action.x}`, `${action.y}`, 'click', '--repeat', '2', '--delay', '120', `${action.button}`]);
      break;
    case 'right_click':
      await runner('xdotool', ['mousemove', `${action.x}`, `${action.y}`, 'click', '3']);
      break;
    case 'move':
      await runner('xdotool', ['mousemove', `${action.x}`, `${action.y}`]);
      break;
    case 'drag':
      await drag(action, runner);
      break;
    case 'type':
      await runner('xdotool', ['type', '--clearmodifiers', '--delay', '1', action.text ?? '']);
      break;
    case 'keypress':
      {
        const result = await runner('xdotool', keypressCommandArguments(action.keys ?? []));
        if (keypressReportedUnknownKey(result.stdout, result.stderr)) {
          throw new QubiclError('invalid_keypress', 'One or more key names were not recognized. Use X11 key names such as Return, End, or PageDown.', 400);
        }
      }
      break;
    case 'scroll': {
      if (action.x !== undefined && action.y !== undefined) await runner('xdotool', ['mousemove', `${action.x}`, `${action.y}`]);
      const button = (action.deltaY ?? 0) < 0 ? '4' : '5';
      const count = Math.abs(action.deltaY ?? 0);
      if (count) await runner('xdotool', ['click', '--repeat', `${count}`, '--delay', '20', button]);
      break;
    }
    case 'wait':
      await new Promise((resolve) => setTimeout(resolve, action.durationMs ?? 0));
      break;
  }
  const focusAfter = recordsFocus ? await activeWindowEvidence(runner) : null;
  return {
    action: action.type,
    dispatch: 'completed',
    verified: false,
    verification: 'dispatch_only',
    ...(recordsFocus ? {
      focusEvidence: {
        requestedWindowId: action.targetWindowId ?? null,
        before: focusBefore,
        after: focusAfter,
        targetConfirmedBeforeDispatch: action.targetWindowId === undefined ? null : focusBefore?.id === action.targetWindowId,
        targetStillActiveAfterDispatch: action.targetWindowId === undefined || focusAfter === null ? null : focusAfter.id === action.targetWindowId,
      },
    } : {}),
    note: 'Qubicl completed input dispatch only. Focus evidence does not prove that the application accepted the input or changed state; verify the semantic effect before sending dependent input.',
  };
}

async function prepareInputFocus(targetWindowId: number | undefined, runner: DesktopCommandRunner): Promise<WindowEvidence | null> {
  if (targetWindowId !== undefined) {
    try {
      await runner('xdotool', ['windowactivate', '--sync', `${targetWindowId}`]);
    } catch {
      throw new QubiclError('window_focus_failed', `Could not activate X11 window ${targetWindowId}; no input was dispatched.`, 409);
    }
  }
  const activeWindow = await activeWindowEvidence(runner);
  if (targetWindowId !== undefined && activeWindow?.id !== targetWindowId) {
    const observed = activeWindow === null ? 'could not be inspected' : `was ${activeWindow.id}`;
    throw new QubiclError('window_focus_failed', `X11 window ${targetWindowId} was requested, but the active window ${observed}; no input was dispatched.`, 409);
  }
  return activeWindow;
}

async function activeWindowEvidence(runner: DesktopCommandRunner): Promise<WindowEvidence | null> {
  let id: number | undefined;
  try {
    id = parseX11WindowId((await runner('xdotool', ['getactivewindow'])).stdout);
  } catch {
    return null;
  }
  if (id === undefined) return null;
  const [title, className] = await Promise.all([
    windowTextEvidence(runner, ['getwindowname', `${id}`]),
    windowTextEvidence(runner, ['getwindowclassname', `${id}`]),
  ]);
  return { id, title, className };
}

async function windowTextEvidence(runner: DesktopCommandRunner, args: string[]): Promise<string | null> {
  try {
    const value = (await runner('xdotool', args)).stdout.trim();
    return value ? value.slice(0, 512) : null;
  } catch {
    return null;
  }
}

export function parseX11WindowId(output: string): number | undefined {
  const value = output.trim();
  if (!/^\d+$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 && id <= 0xffff_ffff ? id : undefined;
}

async function drag(action: ControlAction, runner: DesktopCommandRunner = run): Promise<void> {
  const args = dragCommandArguments(action);
  try {
    await runner('xdotool', args);
  } catch (error) {
    // A failed xdotool sequence can leave button 1 held. This recovery is the
    // only second subprocess used by a drag.
    await runner('xdotool', ['mouseup', '1']).catch(() => undefined);
    throw error;
  }
}

export function keypressCommandArguments(keys: string[]): string[] {
  return ['key', '--clearmodifiers', ...keys.map(normalizeKeypress)];
}

export function keypressReportedUnknownKey(stdout: string, stderr: string): boolean {
  return /No such key name/i.test(`${stdout}\n${stderr}`);
}

function normalizeKeypress(keypress: string): string {
  return keypress.split('+').map((key) => keyAliases.get(key.toLowerCase()) ?? normalizeFunctionKey(key)).join('+');
}

function normalizeFunctionKey(key: string): string {
  return /^f(?:[1-9]|[12]\d|3[0-5])$/i.test(key) ? key.toUpperCase() : key;
}

const keyAliases = new Map([
  ['alt', 'alt'],
  ['backspace', 'BackSpace'],
  ['control', 'ctrl'],
  ['ctrl', 'ctrl'],
  ['del', 'Delete'],
  ['delete', 'Delete'],
  ['down', 'Down'],
  ['end', 'End'],
  ['enter', 'Return'],
  ['esc', 'Escape'],
  ['escape', 'Escape'],
  ['home', 'Home'],
  ['ins', 'Insert'],
  ['insert', 'Insert'],
  ['left', 'Left'],
  ['meta', 'meta'],
  ['pagedown', 'Page_Down'],
  ['pageup', 'Page_Up'],
  ['pgdn', 'Page_Down'],
  ['pgup', 'Page_Up'],
  ['return', 'Return'],
  ['right', 'Right'],
  ['shift', 'shift'],
  ['space', 'space'],
  ['super', 'super'],
  ['tab', 'Tab'],
  ['up', 'Up'],
]);

export function dragCommandArguments(action: Pick<ControlAction, 'fromX' | 'fromY' | 'toX' | 'toY' | 'durationMs'>): string[] {
  const durationMs = action.durationMs ?? 0;
  const steps = durationMs === 0 ? 1 : Math.max(1, Math.min(120, Math.ceil(durationMs / 16)));
  const args = ['mousemove', `${action.fromX}`, `${action.fromY}`, 'mousedown', '1'];
  for (let step = 1; step <= steps; step += 1) {
    if (durationMs > 0) args.push('sleep', `${durationMs / steps / 1_000}`);
    const progress = step / steps;
    const x = Math.round(action.fromX! + (action.toX! - action.fromX!) * progress);
    const y = Math.round(action.fromY! + (action.toY! - action.fromY!) * progress);
    args.push('mousemove', '--sync', `${x}`, `${y}`);
  }
  args.push('mouseup', '1');
  return args;
}

async function run(command: string, args: string[], stdin?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env: desktopHelperEnvironment(process.env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new QubiclError('command_failed', `${command} exited with code ${code}: ${stderr.trim()}`, 500));
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export async function readClipboard(): Promise<{ text: string; truncated?: boolean }> {
  const result = await run('xclip', ['-selection', 'clipboard', '-o']);
  const bounded = truncateUtf8(result.stdout, MODEL_TEXT_BUDGET_BYTES);
  return { text: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) };
}

export async function writeClipboard(text: string): Promise<void> {
  const child = spawn('xclip', ['-selection', 'clipboard', '-i'], {
    detached: true,
    env: desktopHelperEnvironment(process.env),
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  await new Promise<void>((resolvePromise, reject) => {
    child.once('spawn', resolvePromise);
    child.once('error', (error) => reject(new QubiclError('clipboard_failed', error.message, 500)));
  });
  child.stdin.end(text);
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (child.exitCode && child.exitCode !== 0) throw new QubiclError('clipboard_failed', `xclip exited with code ${child.exitCode}.`, 500);
}
