export const connectionClients = [
  'generic',
  'stdio',
  'http',
  'openapi',
  'codex',
  'claude-code',
  'claude-desktop',
  'cursor',
  'vscode',
  'opencode',
  'openclaw',
  'hermes-agent',
  'open-webui',
] as const;

export type ConnectionClient = typeof connectionClients[number];
export type ConnectionTransport = 'stdio' | 'http' | 'openapi';
export type ConnectionClientHost = 'local' | 'windows';

export interface ConnectionEndpoints {
  mcp: string;
  openapi: string;
}

export interface ConnectionSnippetOptions {
  client: string;
  computerName: string;
  endpoints: ConnectionEndpoints;
  transport?: string;
  profile?: string;
  resultMode?: string;
  clientHost?: string;
  stdioLauncher?: { command: string; argsPrefix: string[] };
}

export interface ConnectionSnippet {
  client: ConnectionClient;
  transport: ConnectionTransport;
  format: 'json' | 'toml' | 'yaml' | 'shell';
  target: string;
  includesSecret: boolean;
  content: string;
  activationHint?: string;
}

export interface ConnectionInstructions {
  before: string[];
  after: string[];
}

export function connectionSnippet(options: ConnectionSnippetOptions): ConnectionSnippet {
  if (!isConnectionClient(options.client)) {
    throw new Error(`Unknown client ${options.client}. Supported clients: ${connectionClients.join(', ')}.`);
  }
  const client = options.client;
  const requestedTransport = parseTransport(options.transport);
  const adapterTransport = client === 'http' ? 'http' : ['openapi', 'open-webui'].includes(client) ? 'openapi' : 'stdio';
  const transport = requestedTransport ?? adapterTransport;
  const clientHost = parseClientHost(options.clientHost);
  if ((options.profile || options.resultMode) && transport !== 'stdio') {
    throw new Error('--profile and --result-mode are available only for stdio connections.');
  }
  if (client !== 'generic' && requestedTransport && requestedTransport !== adapterTransport) {
    throw new Error(`Client ${client} uses ${adapterTransport}; --transport is only needed with --client generic.`);
  }
  if (client !== 'generic' && ['codex', 'claude-code', 'claude-desktop', 'cursor', 'vscode', 'opencode', 'openclaw', 'hermes-agent', 'stdio'].includes(client) && transport !== 'stdio') {
    throw new Error(`Client ${client} currently uses Qubicl's token-free stdio bridge.`);
  }
  if (clientHost === 'windows' && transport !== 'stdio') throw new Error('--client-host windows is available only for stdio connections. Windows clients can use the printed localhost HTTP/OpenAPI URL directly.');
  if (clientHost === 'windows' && !options.stdioLauncher) throw new Error('--client-host windows requires a WSL stdio launcher.');
  const serverName = `qubicl-${options.computerName}`;
  const stdioArgs = [
    'mcp',
    options.computerName,
    ...(options.profile ? ['--profile', options.profile] : []),
    ...(options.resultMode ? ['--result-mode', options.resultMode] : []),
  ];
  const stdio = options.stdioLauncher
    ? { command: options.stdioLauncher.command, args: [...options.stdioLauncher.argsPrefix, ...stdioArgs] }
    : { command: 'qubicl', args: stdioArgs };
  const windowsHint = clientHost === 'windows'
    ? 'The Windows-hosted client launches the installed Qubicl entrypoint inside the pinned WSL distribution.'
    : undefined;
  if (client === 'codex') {
    return {
      client,
      transport: 'stdio',
      format: 'shell',
      target: clientHost === 'windows' ? 'Windows Codex MCP configuration (%USERPROFILE%\\.codex\\config.toml by default)' : 'Codex MCP configuration (~/.codex/config.toml by default)',
      includesSecret: false,
      activationHint: `After running the command, start a new Codex task; existing tasks may not discover newly added MCP servers.${windowsHint ? ` ${windowsHint}` : ''}`,
      content: `codex mcp add ${serverName} -- ${[stdio.command, ...stdio.args].map(powerShellArgument).join(' ')}`,
    };
  }
  if (client === 'vscode') {
    return withActivationHint(jsonSnippet(client, 'stdio', '.vscode/mcp.json or the user MCP configuration', false, {
      servers: { [serverName]: { type: 'stdio', ...stdio } },
    }), windowsHint);
  }
  if (client === 'claude-code') {
    return withActivationHint(jsonSnippet(client, 'stdio', '.mcp.json', false, { mcpServers: { [serverName]: stdio } }), windowsHint);
  }
  if (client === 'claude-desktop') {
    return withActivationHint(jsonSnippet(client, 'stdio', 'claude_desktop_config.json', false, { mcpServers: { [serverName]: stdio } }), windowsHint);
  }
  if (client === 'cursor') {
    return withActivationHint(jsonSnippet(client, 'stdio', '.cursor/mcp.json or ~/.cursor/mcp.json', false, { mcpServers: { [serverName]: stdio } }), windowsHint);
  }
  if (client === 'opencode') {
    return withActivationHint(jsonSnippet(client, 'stdio', 'opencode.json or opencode.jsonc', false, {
      $schema: 'https://opencode.ai/config.json',
      mcp: { [serverName]: { type: 'local', command: [stdio.command, ...stdio.args], enabled: true } },
    }), windowsHint);
  }
  if (client === 'openclaw') {
    return withActivationHint(jsonSnippet(client, 'stdio', '~/.openclaw/openclaw.json', false, {
      mcp: {
        servers: {
          [serverName]: { transport: 'stdio', command: stdio.command, args: stdio.args, enabled: true },
        },
      },
    }), windowsHint);
  }
  if (client === 'hermes-agent') {
    return {
      client,
      transport: 'stdio',
      format: 'yaml',
      target: '~/.hermes/config.yaml',
      includesSecret: false,
      ...(windowsHint ? { activationHint: windowsHint } : {}),
      content: [
        'mcp_servers:',
        `  ${serverName}:`,
        `    command: ${JSON.stringify(stdio.command)}`,
        `    args: ${JSON.stringify(stdio.args)}`,
        '    enabled: true',
      ].join('\n'),
    };
  }
  if (client === 'open-webui') {
    const baseUrl = openWebUiContainerUrl(options.endpoints.openapi).replace(/\/openapi\.json$/, '/open-terminal');
    const remoteEndpoint = new URL(options.endpoints.openapi).protocol === 'https:';
    return {
      ...jsonSnippet(client, 'openapi', 'Open WebUI Admin Panel → Settings → Integrations → Open Terminal', false, {
        id: serverName,
        name: `Qubicl ${options.computerName}`,
        url: baseUrl,
        path: '/openapi.json',
        auth_type: 'bearer',
        key: `<token from: qubicl token show ${options.computerName}>`,
        config: { chat_uploads: 'filesystem' },
        enabled: true,
      }),
      activationHint: [
        'Add this as an admin Open Terminal connection and replace the key placeholder with the separately retrieved token; Open WebUI should detect it as a Terminal.',
        remoteEndpoint
          ? 'The generated HTTPS URL is the explicitly configured remote gateway endpoint; its certificate and network policy must be reachable from Open WebUI.'
          : 'The generated host.docker.internal URL is for Docker Desktop. If Open WebUI runs directly on the host, use 127.0.0.1 instead.',
        'This compatibility exposes Qubicl files, file-backed chat uploads, lease-safe tools, and explicitly published port previews, but intentionally does not advertise an interactive PTY.',
      ].join(' '),
    };
  }
  if (transport === 'stdio') {
    const value = client === 'stdio' ? stdio : { mcpServers: { [serverName]: stdio } };
    const snippet = jsonSnippet(client, transport, 'client MCP configuration', false, value);
    return withActivationHint(snippet, windowsHint);
  }

  const token = `<token from: qubicl token show ${options.computerName}>`;
  const authorization = `Bearer ${token}`;
  const value = transport === 'http'
    ? { type: 'http', url: options.endpoints.mcp, headers: { Authorization: authorization } }
    : { type: 'openapi', url: options.endpoints.openapi, headers: { Authorization: authorization } };
  return jsonSnippet(client, transport, 'client connection configuration', false, value);
}

export function isConnectionClient(value: string): value is ConnectionClient {
  return (connectionClients as readonly string[]).includes(value);
}

export function connectionInstructions(snippet: ConnectionSnippet): ConnectionInstructions {
  const noun = snippet.format === 'shell' ? 'command' : `${snippet.format.toUpperCase()} configuration`;
  return {
    before: [
      `Qubicl did not modify ${snippet.target}.`,
      snippet.format === 'shell'
        ? 'Run the following command yourself to add the token-free Qubicl MCP server:'
        : `Copy the following ${noun} into ${snippet.target} yourself:`,
      `The printed ${noun} contains no bearer token.`,
    ],
    after: snippet.activationHint ? [snippet.activationHint] : [],
  };
}

function parseTransport(value: string | undefined): ConnectionTransport | undefined {
  if (value === undefined) return undefined;
  if (!['stdio', 'http', 'openapi'].includes(value)) throw new Error('Transport must be stdio, http, or openapi.');
  return value as ConnectionTransport;
}

function parseClientHost(value: string | undefined): ConnectionClientHost {
  if (value === undefined || value === 'local') return 'local';
  if (value === 'windows') return 'windows';
  throw new Error('Client host must be local or windows.');
}

function jsonSnippet(
  client: ConnectionClient,
  transport: ConnectionTransport,
  target: string,
  includesSecret: boolean,
  value: unknown,
): ConnectionSnippet {
  return { client, transport, format: 'json', target, includesSecret, content: JSON.stringify(value, null, 2) };
}

function withActivationHint(snippet: ConnectionSnippet, activationHint: string | undefined): ConnectionSnippet {
  return activationHint ? { ...snippet, activationHint } : snippet;
}

function openWebUiContainerUrl(value: string): string {
  const url = new URL(value);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) url.hostname = 'host.docker.internal';
  return url.toString();
}

function powerShellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@=+,-]+$/.test(value) ? value : `'${value.replaceAll("'", "''")}'`;
}
