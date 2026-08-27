import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionClients, connectionInstructions, connectionSnippet } from '../../packages/cli/dist/client-config.js';

const base = {
  computerName: 'research',
  endpoints: {
    mcp: 'http://127.0.0.1:3211/computers/id/mcp',
    openapi: 'http://127.0.0.1:3211/computers/id/openapi.json',
  },
};

test('every named client produces explicit, token-safe setup output', () => {
  for (const client of connectionClients) {
    const snippet = connectionSnippet({ ...base, client });
    const instructions = connectionInstructions(snippet);
    assert.equal(snippet.includesSecret, false, client);
    assert.doesNotMatch(snippet.content, /sensitive-token/, client);
    assert.ok(snippet.target.length > 0, client);
    if (snippet.format === 'json') assert.doesNotThrow(() => JSON.parse(snippet.content), client);
    assert.match(instructions.before[0]!, /Qubicl did not modify/, client);
    assert.match(instructions.before.join('\n'), /contains no bearer token/, client);
  }
});

test('client-specific adapters emit their documented stdio shapes', () => {
  assert.deepEqual(JSON.parse(connectionSnippet({ ...base, client: 'claude-code' }).content), {
    mcpServers: { 'qubicl-research': { command: 'qubicl', args: ['mcp', 'research'] } },
  });
  assert.deepEqual(JSON.parse(connectionSnippet({ ...base, client: 'cursor' }).content), {
    mcpServers: { 'qubicl-research': { command: 'qubicl', args: ['mcp', 'research'] } },
  });
  assert.deepEqual(JSON.parse(connectionSnippet({ ...base, client: 'vscode' }).content), {
    servers: { 'qubicl-research': { type: 'stdio', command: 'qubicl', args: ['mcp', 'research'] } },
  });
  assert.deepEqual(JSON.parse(connectionSnippet({ ...base, client: 'opencode' }).content), {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      'qubicl-research': { type: 'local', command: ['qubicl', 'mcp', 'research'], enabled: true },
    },
  });
  assert.deepEqual(JSON.parse(connectionSnippet({ ...base, client: 'openclaw' }).content), {
    mcp: {
      servers: {
        'qubicl-research': {
          transport: 'stdio',
          command: 'qubicl',
          args: ['mcp', 'research'],
          enabled: true,
        },
      },
    },
  });
  assert.equal(connectionSnippet({ ...base, client: 'hermes-agent' }).content, [
    'mcp_servers:',
    '  qubicl-research:',
    '    command: "qubicl"',
    '    args: ["mcp","research"]',
    '    enabled: true',
  ].join('\n'));
  const codex = connectionSnippet({ ...base, client: 'codex' });
  assert.equal(codex.format, 'shell');
  assert.equal(codex.content, 'codex mcp add qubicl-research -- qubicl mcp research');
  assert.match(codex.activationHint ?? '', /After running the command, start a new Codex task/);
  const instructions = connectionInstructions(codex);
  assert.match(instructions.before[0]!, /Qubicl did not modify Codex MCP configuration/);
  assert.match(instructions.before.join('\n'), /contains no bearer token/);
  assert.match(instructions.before.join('\n'), /Run the following command yourself/);
  assert.match(instructions.after.join('\n'), /start a new Codex task/);
});

test('every stdio adapter can target a Windows-hosted client through a pinned WSL launcher', () => {
  const stdioClients = ['generic', 'stdio', 'codex', 'claude-code', 'claude-desktop', 'cursor', 'vscode', 'opencode', 'openclaw', 'hermes-agent'];
  const stdioLauncher = {
    command: 'wsl.exe',
    argsPrefix: [
      '-d', 'Ubuntu', '--', '/usr/bin/node',
      '/home/user/.local/lib/node_modules/qubicl-cli/dist/qubicl.mjs',
    ],
  };
  for (const client of stdioClients) {
    const snippet = connectionSnippet({ ...base, client, clientHost: 'windows', stdioLauncher });
    assert.match(snippet.content, /wsl\.exe/, client);
    assert.match(snippet.content, /Ubuntu/, client);
    assert.match(snippet.content, /\/usr\/bin\/node/, client);
    assert.match(snippet.content, /qubicl\.mjs/, client);
    assert.match(snippet.activationHint ?? '', /Windows-hosted client/, client);
  }
});

test('Windows client host mode is explicit and stdio-only', () => {
  assert.throws(
    () => connectionSnippet({ ...base, client: 'codex', clientHost: 'windows' }),
    /requires a WSL stdio launcher/,
  );
  assert.throws(
    () => connectionSnippet({
      ...base,
      client: 'generic',
      clientHost: 'windows',
      transport: 'http',
      stdioLauncher: { command: 'wsl.exe', argsPrefix: [] },
    }),
    /available only for stdio connections/,
  );
  assert.throws(() => connectionSnippet({ ...base, client: 'codex', clientHost: 'remote' }), /local or windows/);
});

test('stdio adapters can select a static tool profile and result representation', () => {
  assert.deepEqual(JSON.parse(connectionSnippet({
    ...base,
    client: 'claude-code',
    profile: 'files',
    resultMode: 'structured',
  }).content), {
    mcpServers: {
      'qubicl-research': {
        command: 'qubicl',
        args: ['mcp', 'research', '--profile', 'files', '--result-mode', 'structured'],
      },
    },
  });
  assert.equal(
    connectionSnippet({ ...base, client: 'codex', profile: 'browser-semantic' }).content,
    'codex mcp add qubicl-research -- qubicl mcp research --profile browser-semantic',
  );
  assert.deepEqual(
    JSON.parse(connectionSnippet({ ...base, client: 'opencode', profile: 'files' }).content).mcp['qubicl-research'].command,
    ['qubicl', 'mcp', 'research', '--profile', 'files'],
  );
  assert.match(
    connectionSnippet({ ...base, client: 'hermes-agent', resultMode: 'structured' }).content,
    /args: \["mcp","research","--result-mode","structured"\]/,
  );
  assert.throws(() => connectionSnippet({ ...base, client: 'open-webui', profile: 'files' }), /only for stdio/);
});

test('HTTP and OpenAPI always point to the explicit token command', () => {
  for (const client of ['http', 'openapi', 'open-webui'] as const) {
    const safe = connectionSnippet({ ...base, client });
    assert.equal(safe.includesSecret, false);
    assert.match(safe.content, /qubicl token show research/);
  }
});

test('Open WebUI uses the admin Open Terminal form without embedding a token', () => {
  const snippet = connectionSnippet({ ...base, client: 'open-webui' });
  assert.equal(snippet.transport, 'openapi');
  assert.equal(snippet.target, 'Open WebUI Admin Panel → Settings → Integrations → Open Terminal');
  assert.deepEqual(JSON.parse(snippet.content), {
    id: 'qubicl-research',
    name: 'Qubicl research',
    url: 'http://host.docker.internal:3211/computers/id/open-terminal',
    path: '/openapi.json',
    auth_type: 'bearer',
    key: '<token from: qubicl token show research>',
    config: { chat_uploads: 'filesystem' },
    enabled: true,
  });
  assert.match(snippet.activationHint ?? '', /admin Open Terminal connection/);
  assert.match(snippet.activationHint ?? '', /host\.docker\.internal/);
  assert.match(snippet.activationHint ?? '', /does not advertise an interactive PTY/);
  assert.match(snippet.activationHint ?? '', /file-backed chat uploads/);

  const remote = connectionSnippet({
    ...base,
    client: 'open-webui',
    endpoints: {
      mcp: 'https://gateway.example.test/computers/id/mcp',
      openapi: 'https://gateway.example.test/computers/id/openapi.json',
    },
  });
  assert.equal(JSON.parse(remote.content).url, 'https://gateway.example.test/computers/id/open-terminal');
  assert.match(remote.activationHint ?? '', /explicitly configured remote gateway endpoint/i);
  assert.doesNotMatch(remote.activationHint ?? '', /host\.docker\.internal|use 127\.0\.0\.1/i);
  assert.throws(() => connectionSnippet({ ...base, client: 'open-webui', transport: 'http' }), /uses openapi/);
});

test('unknown clients and incompatible options are rejected', () => {
  assert.throws(() => connectionSnippet({ ...base, client: 'whatever' }), /Unknown client/);
  assert.throws(() => connectionSnippet({ ...base, client: 'cursor', transport: 'http' }), /uses stdio/);
  assert.throws(() => connectionSnippet({ ...base, client: 'generic', transport: 'sse' }), /Transport must/);
});
