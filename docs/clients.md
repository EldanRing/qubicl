# Client setup

`qubicl connect` prints validated setup instructions. It never runs them, edits a client configuration, or restarts a client.

## Token-free local adapters

These adapters invoke `qubicl mcp <computer>` and contain no bearer token:

| Client | Command | Suggested target |
| --- | --- | --- |
| Codex | `qubicl connect computer-name --client codex` | Codex MCP configuration (`~/.codex/config.toml` by default) |
| Claude Code | `qubicl connect computer-name --client claude-code` | `.mcp.json` |
| Claude Desktop | `qubicl connect computer-name --client claude-desktop` | `claude_desktop_config.json` |
| Cursor | `qubicl connect computer-name --client cursor` | `.cursor/mcp.json` or `~/.cursor/mcp.json` |
| VS Code | `qubicl connect computer-name --client vscode` | `.vscode/mcp.json` or user MCP settings |
| OpenCode | `qubicl connect computer-name --client opencode` | `opencode.json` or `opencode.jsonc` |
| OpenClaw | `qubicl connect computer-name --client openclaw` | `~/.openclaw/openclaw.json` |
| Hermes Agent | `qubicl connect computer-name --client hermes-agent` | `~/.hermes/config.yaml` |
| Generic stdio | `qubicl connect computer-name --client stdio` | The client's MCP server settings |

For Codex, Qubicl prints this command but does not run it:

```sh
codex mcp add qubicl-computer-name -- qubicl mcp computer-name
```

The stdio process owns and refreshes one fenced lease for the connection. Its tool catalog omits lease lifecycle tools and every lease argument, while disconnect still releases control and terminates ordinary connection-owned managed processes. Direct HTTP MCP/OpenAPI remain explicit proof-bearing compatibility surfaces because their request lifecycle is not assumed to represent one model session.

Select a smaller static stdio catalog when a task does not need the full computer:

```sh
qubicl connect computer-name --client codex --profile files
qubicl mcp computer-name --profile browser-semantic
```

Profiles are `full` (default), `files`, `browser-semantic`, `browser-visual`, and `desktop`. Atomic visual wrappers remain available; the two browser profiles intentionally choose semantic/ref or screenshot/coordinate surfaces without deleting either implementation. Results default to one JSON text representation. `--result-mode structured` uses structured MCP content for a verified client, and `--result-mode compatible` deliberately mirrors both forms only when legacy interoperability requires it.

Run it yourself, then start a new Codex task. Tasks that were already open may not discover MCP servers added after they started. The command contains no bearer token.

For the other adapters, paste the printed configuration into the shown target yourself. The `qubicl` executable must be on the environment `PATH` used to launch the client. The bridge resolves the name and reads protected state each time, so rotating a token does not change the snippet.

### Windows-hosted clients with Qubicl in WSL

When the client application runs on Windows but Qubicl runs inside WSL 2, add
`--client-host windows` to any stdio adapter:

```sh
qubicl connect computer-name --client codex --client-host windows
qubicl connect computer-name --client claude-desktop --client-host windows
qubicl connect computer-name --client cursor --client-host windows
qubicl connect computer-name --client vscode --client-host windows
```

This is not a Codex-specific bridge. Qubicl emits the normal adapter shape with
`wsl.exe` as its command, pins the current distribution, and invokes the
absolute Node and Qubicl entrypoint paths from the installation that printed
the snippet. The Windows application therefore does not depend on its own
`PATH` or on a WSL shell profile. WSL interoperability must be enabled. Re-run
`connect` after moving or reinstalling Node or Qubicl because the printed paths
are intentionally absolute.

The default `--client-host local` remains correct for a client process that
runs inside the same WSL distribution. Direct HTTP MCP and OpenAPI use the
printed `127.0.0.1` URLs from either WSL or the Windows host; they do not use the
stdio launcher option.

## HTTP MCP and OpenAPI

The generic adapter can select a transport:

```sh
qubicl connect computer-name --client generic --transport stdio
qubicl connect computer-name --client generic --transport http
qubicl connect computer-name --client generic --transport openapi
```

The `http` and `openapi` shortcuts select those transports directly. Their headers contain this placeholder, never a literal credential:

```text
<token from: qubicl token show computer-name>
```

Run the token command separately only when a local HTTP/OpenAPI client needs it. Treat that output as a password: do not commit it, paste it into an issue, or expose it in shell history or screenshots.

When the operator has explicitly configured the optional TLS listener, select
the remote endpoint instead of silently changing existing adapters:

```sh
qubicl connect computer-name --client generic --transport http --access remote
qubicl connect computer-name --client generic --transport openapi --access remote
```

Remote mode still prints only a token placeholder. Stdio remains local and
token-free; combining stdio with `--access remote` is rejected. Browser-hosted
clients must use an exact HTTPS origin included in the gateway's
`--trusted-origins` policy. See [Optional remote access](remote-access.md).

## Open WebUI on the same computer

Qubicl presents each computer as an isolated Open Terminal-compatible service for Open WebUI:

```sh
qubicl connect computer-name --client open-webui
```

The output maps to **Admin Panel → Settings → Integrations → Open Terminal → Add**:

- ID: the printed `id`
- name: the printed `name`
- URL: the printed `url`
- OpenAPI path: the printed `path`
- authentication: Bearer
- key: replace the printed placeholder with the output of `qubicl token show computer-name`
- enabled: on

Open WebUI should verify the server as **Terminal**. Its native file browser can list, read, view, upload, create, move, delete, and download a bounded multi-path ZIP within that computer's durable `/home`. The compatibility API can start, list, attach to, page output from, send bounded input to, and stop retained non-PTY processes. The compatibility OpenAPI also presents the computer's normal tools while owning a fenced Qubicl lease transparently, so a model is not asked to manufacture or renew lease proofs. Human viewer takeover still preempts that lease, fences compatibility processes, and makes calls fail closed until human control is released and a fresh lease is obtained.

Enabled `web_search`, `web_extract`, `skills_list`, `skill_view`, and `skill_manage` tools project through Open Terminal exactly like MCP and direct OpenAPI. Operator-disabled tools are absent from discovery and cached calls fail closed. DDGS search needs no API key; local extraction needs no scraping service. Browser rendering remains available only on browser-capable presets. Native file browsing supports Open WebUI's current `/files/serve/*` preview route as well as the earlier `/files/view` compatibility route; both remain confined to the computer's durable home and enforce the same download bound. It also provides bounded filename/content search, file-display metadata for chat-created artifacts, writable/size/modified directory metadata, and filesystem-backed chat uploads. Search skips hidden paths unless requested, limits pages to 100 results, scans at most 1 MiB per file, and applies aggregate file and byte budgets.

Open WebUI's path-based `/files/serve/*` route keeps active documents seamless
without trusting Open WebUI's iframe settings. For HTML, HTM, and SVG, Qubicl
returns a self-contained static document through Open WebUI's existing file
proxy, so a browser reaching Open WebUI over a LAN address, VPN, or reverse
proxy does not need direct access to Qubicl's loopback-only `.localhost`
preview hostname. The response enforces its own sandbox, CSP, no-referrer
policy, and permissions restrictions. Qubicl parses HTML and SVG into static
markup: scripts, event handlers, embedded documents, form/navigation targets,
refresh directives, and SVG href animation are removed. Bounded
directory-relative stylesheets, raster images, and media are embedded as
passive data; browser fetches and external resources are blocked by the
response policy. The initially selected active document must be a regular
named file rather than a symbolic link, and asset traversal outside its named
parent directory fails closed. Changing Open WebUI's outer iframe to
same-origin mode cannot remove the response-enforced sandbox. Direct JavaScript
and TypeScript clicks display source text. `/files/view` keeps HTML, HTM,
JavaScript, TypeScript, and SVG as explicit downloads.

When HTML contains scripts or event handlers, the safe document adds a
Qubicl-owned **Run interactive preview** action. Nothing executes until the
Open WebUI user selects that action. Qubicl embeds the exact selected-file
snapshot in an inert form inside the already authenticated response; the
five-minute button activates it in place instead of navigating back through
Open WebUI, and no Open WebUI or computer credential is placed in the document.
The interactive document remains sandboxed without same-origin access, forms,
embedded frames, popups, downloads, or top navigation, and sends no referrer.
It does permit scripts and external browser requests so trusted self-contained
applications such as WebGL simulations can run. That traffic uses the
operator's browser network, not the Qubicl computer's egress policy, and the
confirmation states this boundary explicitly. Relative active subresources are
not fetched through Open WebUI's authenticated proxy; package them into the
document or use externally CORS-enabled resources. Keep the static view for
files you do not trust.

On `browser`, `computer`, and `workstation` presets, that tool list includes navigation, semantic page snapshots and element refs, screenshots, history/wait, persistent tab management, and screenshot-grounded browser computer actions. Prefer snapshot refs first; use viewport screenshots and coordinate actions only for visual controls without refs. The compatible API name `browser_reset` is displayed as **Reset tabs** and closes tabs without erasing cookies, site data, or the durable Chromium profile; full profile clearing is a separate host-only confirmed CLI action. The browser stays visible in Qubicl's viewer and survives human takeover, while agent tool access remains fenced until release. Semantic and coordinate browser point actions drive the persistent viewer-only green agent cursor immediately before dispatch; it clears with the agent lease or human takeover. Typed data, URLs, selectors, refs, and page content are never placed in that feed.

Open Terminal serves both desktop and browser screenshot operations as native `image/png` responses. MCP likewise uses native image content and keeps only dimensions and other small metadata in structured/text results, avoiding a second base64 copy in the model context.

The default generated URL uses Docker Desktop's `host.docker.internal` route so the Open WebUI backend can reach the host-loopback Qubicl gateway without joining a Qubicl-managed network. If Open WebUI runs directly on the host rather than in Docker, replace that hostname with `127.0.0.1`. A deliberately remote Open WebUI deployment can instead use the separately configured TLS origin; include its exact browser origin in `--trusted-origins` and keep the per-computer token restricted to the intended connection. Open WebUI stores the separately retrieved token in its admin settings; restrict the connection's Open WebUI access grants accordingly.

Compatibility intentionally reports `terminal: false` and `notebooks: false`, while advertising its existing `/system` guidance endpoint. It provides bounded non-PTY process management and ZIP download, not an interactive terminal emulator or notebooks. Process count, lifetime, command/input, queued stdin, retained records, output pages, per-process output, and aggregate output are capped; record or byte exhaustion marks paged output as truncated, and expired/deleted records fence surviving members before removal. ZIP input stays below `/home/qubicl`, rejects links and special files, and applies path, entry, ancestry-metadata, file, aggregate-byte, output, creation-time, and transfer-time limits. At most two ZIP creations/downloads can reserve output space on one computer at once. Open WebUI's `/ports` and `/proxy/{port}/...` routes expose only live ports that were explicitly published through Qubicl; an arbitrary listener never becomes reachable merely because it exists. Existing MCP, OpenAPI, viewer, and human-control routes remain unchanged.

## Requirements

- Qubicl and the selected computer must be running.
- Stdio adapters require the local `qubicl` executable.
- Direct URLs require the computer's bearer token.
- The gateway binds to localhost by default. A hosted service can use Qubicl's
  explicit TLS listener only after the operator configures the interface,
  certificate, client networks, and trusted origins; Qubicl does not configure
  DNS, firewalls, or tunnels.
- A `file-system` computer has MCP/OpenAPI tools but no viewer. Use `browser`, `computer`, or `workstation` when human viewing is required.

Run `qubicl doctor` for connection failures. Run `qubicl token rotate computer-name` if a token may have been exposed.

## Release conformance evidence

An adapter or reference-protocol test is not by itself evidence that a real
client version works. For v0.2 and later release acceptance, the versioned
[client conformance requirements](../conformance/client-conformance-v1.json)
keep application and protocol results separately identified.

Application evidence covers Codex, Claude Code, OpenCode, OpenClaw, Hermes
Agent, and Open WebUI. Claude Desktop, Cursor, and VS Code remain in the matrix
so their existing adapter claims do not disappear when the six primary clients
are added. Standards-level evidence separately covers MCP stdio, MCP HTTP,
OpenAPI, and Open Terminal rather than treating a protocol probe as a named
application run.

Every required application or protocol row records an exact installed version, its
transport, the required `workstation` preset, a tester identity, a UTC test
time, and a SHA-256-bound local evidence file. It also records a passing result
and hashed evidence for every applicable surface from this set: discovery, MCP
stdio, MCP HTTP, OpenAPI, Open Terminal, result modes, screenshots, files,
browser control, and human takeover. Non-applicable transport surfaces are
omitted according to the versioned matrix; adding or removing a surface ad hoc
fails validation.

All timestamps must be at or after the signed release set was created. The
acceptance bundle carries an exact copy and SHA-256 of the reviewed requirements
file, and its detached signature binds the final acceptance JSON. Qubicl does
not download clients, inspect online version feeds, or manufacture these
results. Maintainers must supply the real-client binaries/accounts and retain
the actual post-freeze evidence. A signed pre-1.0 `initial` v0.2 bundle requires
Codex, Open WebUI, and all four protocol rows. A `supported` bundle requires the
full nine-application matrix; omitted rows cannot be presented as supported
coverage.

Remote support is separately bound by the versioned
[remote-access requirements](../conformance/remote-access-v1.json). Those rows
exercise real remote MCP HTTP, OpenAPI, Open Terminal, viewer, and isolated
preview traffic. The pre-1.0 `initial` profile requires the native-Linux path;
the `supported` profile adds both Docker Desktop/NAT paths. Passing the local
client matrix alone cannot satisfy either remote gate.
