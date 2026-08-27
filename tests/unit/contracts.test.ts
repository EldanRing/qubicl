import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOpenApi,
  buildOpenTerminalOpenApi,
  compactToolDefinitionBytes,
  enabledToolNames,
  jsonSchemaForTool,
  mcpToolResult,
  modelInputSchemaForTool,
  PRESET_DEFINITIONS,
  QUBICL_MODEL_INSTRUCTIONS,
  toolDefinitions,
  toolNames,
  toolNamesForProfile,
  toolTitle,
  type ToolName,
} from '@qubicl/core';
import { invokeTool, mcpResult } from '@qubicl/control/contract';
import { ToolExecutor } from '@qubicl/control/executor';
import { toolNamesFromOpenApi, TransparentLeaseBridge } from '../../packages/cli/dist/mcp.js';

test('OpenAPI exposes exactly the shared MCP tool catalog', () => {
  const document = buildOpenApi('00000000-0000-4000-8000-000000000001');
  const paths = document.paths as Record<string, { post: { operationId: string; requestBody: { content: { 'application/json': { schema: unknown } } } } }>;
  assert.deepEqual(Object.values(paths).map(({ post }) => post.operationId).sort(), [...toolNames].sort());
  for (const name of toolNames) {
    assert.deepEqual(paths[`/v1/tools/${name}`]!.post.requestBody.content['application/json'].schema, jsonSchemaForTool(name));
    assert.ok(toolDefinitions[name].description.length > 0);
  }
});

test('browser_reset keeps its API name while clients present it as Reset tabs', () => {
  assert.equal(toolNames.includes('browser_reset'), true);
  assert.equal(toolTitle('browser_reset'), 'Reset tabs');
  assert.match(toolDefinitions.browser_reset.description, /^Reset tabs/);
  assert.match(toolDefinitions.browser_reset.description, /persistent browser profile/);

  const document = buildOpenApi('00000000-0000-4000-8000-000000000001') as {
    paths: Record<string, { post: { operationId: string; summary: string; description?: string } }>;
  };
  const operation = document.paths['/v1/tools/browser_reset']!.post;
  assert.equal(operation.operationId, 'browser_reset');
  assert.equal(operation.summary, 'Reset tabs');
  assert.equal(operation.description, toolDefinitions.browser_reset.description);
});

test('process and desktop tool contracts expose the additive safety controls and dispatch semantics', () => {
  const execSchema = jsonSchemaForTool('exec_command') as { properties: Record<string, { maximum?: number }> };
  const stopSchema = jsonSchemaForTool('stop_process') as {
    properties: Record<string, { enum?: string[]; default?: string }>;
  };
  assert.equal(execSchema.properties.timeoutMs?.maximum, 86_400_000);
  assert.deepEqual(stopSchema.properties.signal?.enum, ['SIGTERM', 'SIGINT', 'SIGHUP']);
  assert.equal(stopSchema.properties.signal?.default, 'SIGTERM');
  assert.match(toolDefinitions.edit_file.description, /exact-text replacements/);
  assert.match(toolDefinitions.edit_file.description, /unified diff/);
  assert.match(QUBICL_MODEL_INSTRUCTIONS, /verify application effects/);
  assert.match(toolDefinitions.control_computer.description, /confirm an X11 target/);
  assert.match(toolDefinitions.exec_command.description, /Combined output/);

  const applicationSchema = jsonSchemaForTool('open_desktop_application') as {
    properties: Record<string, unknown>;
    additionalProperties?: boolean;
  };
  assert.deepEqual(Object.keys(applicationSchema.properties).sort(), ['application', 'lease', 'paths']);
  assert.equal(applicationSchema.additionalProperties, false);
  for (const unsafeInput of ['command', 'executable', 'args', 'arguments', 'cwd', 'environment', 'env', 'url']) {
    assert.equal(Object.hasOwn(applicationSchema.properties, unsafeInput), false);
  }
  assert.match(toolDefinitions.open_desktop_application.description, /No executable, shell, arbitrary arguments/);

  const lease = { id: 'a'.repeat(32), generation: 1, epoch: 'b'.repeat(16) };
  assert.equal(toolDefinitions.control_computer.input.safeParse({
    lease,
    action: { type: 'keypress', keys: ['ctrl+End', 'Return'], targetWindowId: 42 },
  }).success, true);
  assert.equal(toolDefinitions.control_computer.input.safeParse({
    lease,
    action: { type: 'keypress', keys: ['ctrl', 'End'] },
  }).success, false, 'separate modifier entries must not masquerade as a simultaneous chord');
  assert.equal(toolDefinitions.control_computer.input.safeParse({
    lease,
    action: { type: 'keypress', keys: ['Control_L', 'End'] },
  }).success, false, 'explicit X11 modifier names must also be part of the chord');
  assert.equal(toolDefinitions.control_computer.input.safeParse({
    lease,
    action: { type: 'keypress', keys: ['ctrl + End'] },
  }).success, false, 'keypress chords must reject whitespace ambiguity');
});

test('browser capability matches the Terminal1 semantic and screenshot-grounded contract', () => {
  const expected = [
    'browser_navigate',
    'browser_snapshot',
    'browser_screenshot',
    'browser_click',
    'browser_type',
    'browser_select',
    'browser_press',
    'browser_scroll',
    'browser_history',
    'browser_wait',
    'browser_tabs',
    'browser_use_tab',
    'browser_new_tab',
    'browser_close_tab',
    'browser_reset',
    'browser_click_at',
    'browser_double_click_at',
    'browser_hover_at',
    'browser_drag',
    'browser_scroll_at',
    'browser_type_focused',
    'browser_inspect_at',
    'browser_computer',
  ];
  const browserTools = enabledToolNames(PRESET_DEFINITIONS.browser.capabilities).filter((name) => name.startsWith('browser_'));
  assert.deepEqual(browserTools, expected);
  const coordinate = jsonSchemaForTool('browser_click_at') as { properties: { x: { maximum: number }; y: { maximum: number } } };
  assert.equal(coordinate.properties.x.maximum, 1439);
  assert.equal(coordinate.properties.y.maximum, 899);
  const computer = jsonSchemaForTool('browser_computer') as { properties: { actions: { maxItems: number } } };
  assert.equal(computer.properties.actions.maxItems, 20);
  assert.match(QUBICL_MODEL_INSTRUCTIONS, /untrusted data/);
});

test('model-facing schemas retain date-time semantics and Zod defaults without llama.cpp-incompatible generated patterns', async () => {
  const releaseSchema = jsonSchemaForTool('release_lease') as {
    properties: { lease: { properties: { expiresAt: { type: string; format: string; pattern?: string } } } };
  };
  assert.deepEqual(releaseSchema.properties.lease.properties.expiresAt, {
    type: 'string',
    format: 'date-time',
  });
  assert.equal(toolDefinitions.release_lease.input.safeParse({
    lease: { id: 'a'.repeat(32), generation: 1, epoch: 'b'.repeat(16), expiresAt: 'not-a-date' },
  }).success, false, 'runtime validation must remain strict');

  const modelSchema = modelInputSchemaForTool('exec_command');
  const validated = await modelSchema['~standard'].validate({
    lease: { id: 'a'.repeat(32), generation: 1, epoch: 'b'.repeat(16) },
    command: 'true',
  });
  assert.equal('issues' in validated && validated.issues !== undefined, false);
  assert.deepEqual('value' in validated ? validated.value : undefined, {
    lease: { id: 'a'.repeat(32), generation: 1, epoch: 'b'.repeat(16) },
    command: 'true',
    cwd: '/home/qubicl',
    yieldTimeMs: 10_000,
    maxOutputBytes: 24_000,
    outputMode: 'combined',
  });
  const advertised = modelSchema['~standard'].jsonSchema.input() as {
    $schema?: string;
    required?: string[];
    properties: { lease: { properties: { expiresAt: { pattern?: string } } } };
  };
  assert.equal(advertised.properties.lease.properties.expiresAt.pattern, undefined);
  assert.equal(advertised.$schema, undefined);
  assert.deepEqual(advertised.required, ['lease', 'command']);
});

test('Open Terminal compatibility owns leases and exposes the remaining exact tool catalog', () => {
  const document = buildOpenTerminalOpenApi('00000000-0000-4000-8000-000000000001') as {
    servers: { url: string }[];
    paths: Record<string, {
      post?: { operationId: ToolName; requestBody: { content: { 'application/json': { schema: { properties?: Record<string, unknown>; required?: string[] } } } }; responses: { '200': { content: Record<string, unknown> } } };
      get?: { operationId: string; parameters: Array<{ name: string }> };
    }>;
  };
  assert.deepEqual(document.servers, [{ url: '/computers/00000000-0000-4000-8000-000000000001/open-terminal' }]);
  assert.equal(Object.hasOwn(document.paths, '/v1/tools/acquire_lease'), false);
  assert.equal(Object.hasOwn(document.paths, '/v1/tools/renew_lease'), false);
  assert.equal(Object.hasOwn(document.paths, '/v1/tools/release_lease'), false);
  for (const { post } of Object.values(document.paths).filter((operation) => operation.post !== undefined)) {
    assert.ok(post);
    const schema = post.requestBody.content['application/json'].schema;
    assert.equal(Object.hasOwn(schema.properties ?? {}, 'lease'), false, post.operationId);
    assert.equal(schema.required?.includes('lease') ?? false, false, post.operationId);
  }
  assert.deepEqual(Object.keys(document.paths['/v1/tools/browser_screenshot']!.post!.responses['200'].content), ['image/png']);
  assert.deepEqual(Object.keys(document.paths['/v1/tools/take_screenshot']!.post!.responses['200'].content), ['image/png']);
  assert.deepEqual(Object.keys(document.paths['/v1/tools/read_file']!.post!.responses['200'].content), [
    'application/json', 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  ]);
  assert.deepEqual(Object.keys(document.paths['/v1/tools/browser_snapshot']!.post!.responses['200'].content), ['application/json']);
  assert.equal(document.paths['/files/display']!.get?.operationId, 'display_file');
  assert.deepEqual(document.paths['/files/display']!.get?.parameters.map(({ name }) => name), ['path', 'inline', 'page']);
});

test('default MCP results use one canonical text representation', async () => {
  const executor = {
    async call(name: ToolName, input: unknown): Promise<unknown> {
      return { tool: name, input, nested: { exact: true } };
    },
  };
  for (const name of toolNames) {
    const outcome = await invokeTool(executor, name, { example: name });
    assert.equal(outcome.status, 200);
    const mcp = mcpResult(outcome);
    assert.equal(mcp.isError, undefined);
    assert.equal(mcp.structuredContent, undefined, name);
    assert.equal(mcp.content[0]!.type, 'text', name);
    if (mcp.content[0]!.type === 'text') assert.deepEqual(JSON.parse(mcp.content[0]!.text), outcome.value, name);
  }
});

test('every tool has identical strict validation errors through both presentations', async () => {
  const executor = new ToolExecutor();
  for (const name of toolNames) {
    const outcome = await invokeTool(executor, name, { unexpected: true });
    assert.equal(outcome.ok, false, name);
    assert.equal(outcome.status, 400, name);
    assert.equal((outcome.value as { error: { code: string } }).error.code, 'invalid_arguments', name);
    const mcp = mcpResult(outcome);
    assert.equal(mcp.isError, true, name);
    assert.equal(mcp.structuredContent, undefined, name);
    assert.equal(mcp.content[0]!.type, 'text', name);
    if (mcp.content[0]!.type === 'text') assert.deepEqual(JSON.parse(mcp.content[0]!.text), outcome.value, name);
  }
});

test('image tool results include native MCP image content without duplicating base64 in text', () => {
  const value = { path: '/tmp/image.png', mimeType: 'image/png', width: 1, height: 1, data: 'aGVsbG8=' };
  const result = mcpResult({ ok: true, status: 200, value });
  assert.deepEqual(result.content[0], { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' });
  assert.equal(result.content[1]?.type, 'text');
  if (result.content[1]?.type === 'text') {
    assert.deepEqual(JSON.parse(result.content[1].text), { path: '/tmp/image.png', mimeType: 'image/png', width: 1, height: 1 });
  }
  assert.equal(result.structuredContent, undefined);
});

test('MCP result modes never repeat a full payload unless compatibility is explicitly requested', () => {
  const value = { payload: 'x'.repeat(1000) };
  const text = mcpToolResult(value);
  assert.equal(text.structuredContent, undefined);
  assert.match((text.content[0] as { text: string }).text, /"payload"/);

  const structured = mcpToolResult(value, false, 'structured');
  assert.deepEqual(structured.structuredContent, value);
  assert.doesNotMatch((structured.content[0] as { text: string }).text, /x{100}/);

  const compatible = mcpToolResult(value, false, 'compatible');
  assert.deepEqual(compatible.structuredContent, value);
  assert.match((compatible.content[0] as { text: string }).text, /x{100}/);
});

test('lease-transparent workstation catalog stays within its golden budget and profiles remain static subsets', async () => {
  const workstation = enabledToolNames(PRESET_DEFINITIONS.workstation.capabilities);
  assert.ok(compactToolDefinitionBytes(workstation, { leaseTransparent: true }) < 26_000);
  const transparent = toolNamesForProfile(workstation, 'full', true);
  assert.equal(transparent.includes('acquire_lease'), false);
  assert.equal(transparent.includes('renew_lease'), false);
  assert.equal(transparent.includes('release_lease'), false);
  const transparentExec = jsonSchemaForTool('exec_command', true) as { properties: Record<string, unknown> };
  assert.equal(Object.hasOwn(transparentExec.properties, 'lease'), false);
  const validated = await modelInputSchemaForTool('exec_command', true)['~standard'].validate({ command: 'true' });
  assert.equal('issues' in validated && validated.issues !== undefined, false);
  assert.equal('value' in validated && Object.hasOwn(validated.value as object, 'lease'), false);
  const files = toolNamesForProfile(workstation, 'files', true);
  assert.ok(files.includes('read_file'));
  assert.equal(files.includes('browser_snapshot'), false);
  assert.equal(files.includes('control_computer'), false);
  for (const profile of ['browser-semantic', 'browser-visual'] as const) {
    const browser = toolNamesForProfile(workstation, profile, true);
    assert.equal(browser.includes('web_search'), true, profile);
    assert.equal(browser.includes('web_extract'), true, profile);
  }
});

test('stdio bridge derives its exact tool surface from the computer OpenAPI contract', () => {
  const enabled = enabledToolNames(PRESET_DEFINITIONS['file-system'].capabilities);
  assert.deepEqual(toolNamesFromOpenApi(buildOpenApi('files', enabled)), enabled);
  assert.equal(enabled.includes('take_screenshot'), false);
  assert.throws(() => toolNamesFromOpenApi(null), /invalid OpenAPI/);
  assert.throws(() => toolNamesFromOpenApi({ paths: [] }), /valid paths object/);
  assert.throws(() => toolNamesFromOpenApi({ paths: {} }), /no callable tools/);
  assert.throws(() => toolNamesFromOpenApi({ paths: { '/bad': { post: { operationId: 'unknown_tool' } } } }), /unknown tool/);
  assert.throws(() => toolNamesFromOpenApi({
    paths: {
      '/first': { post: { operationId: 'read_file' } },
      '/second': { post: { operationId: 'read_file' } },
    },
  }), /more than once/);
});

test('stdio bridge owns, refreshes, and releases an opaque lease outside model calls', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  let generation = 0;
  let execCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const name = new URL(String(input)).pathname.split('/').pop()!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ name, body });
    if (name === 'acquire_lease') {
      generation += 1;
      return Response.json({ id: 'a'.repeat(32), generation, epoch: 'b'.repeat(16) });
    }
    if (name === 'exec_command') {
      execCalls += 1;
      if (execCalls === 2) return Response.json({ error: { code: 'stale_lease', message: 'stale' } }, { status: 409 });
      return Response.json({ output: 'ok', running: false, terminalState: 'exited', exitCode: 0 });
    }
    if (name === 'release_lease') return Response.json({ released: true });
    return Response.json({ error: { code: 'unexpected', message: name } }, { status: 500 });
  }) as typeof fetch;

  const bridge = new TransparentLeaseBridge('http://computer.test', 'token');
  assert.equal((await bridge.call('exec_command', { command: 'true' })).ok, true);
  assert.equal((await bridge.call('exec_command', { command: 'true' })).ok, true);
  await bridge.release();
  assert.deepEqual(calls.map(({ name }) => name), [
    'acquire_lease',
    'exec_command',
    'exec_command',
    'acquire_lease',
    'exec_command',
    'release_lease',
  ]);
  const injected = calls.filter(({ name }) => name === 'exec_command').map(({ body }) => body.lease as { generation: number });
  assert.deepEqual(injected.map(({ generation: value }) => value), [1, 1, 2]);
  assert.equal(calls.at(-1)!.body.lease && (calls.at(-1)!.body.lease as { generation: number }).generation, 2);
});
