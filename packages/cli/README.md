# Qubicl CLI

Qubicl is a local computer layer for AI agents. It gives a compatible MCP or OpenAPI client a private Docker computer with durable files, bounded terminal/process tools, keyless web research, optional Chromium/desktop workflows, and explicit human takeover. The model stays outside Qubicl.

Qubicl `0.1.x` is the initial pre-1.0 release series. Interfaces and state
formats may evolve; back up important homes before upgrades.

Install and start onboarding with:

```sh
npm install -g qubicl-cli
qubicl setup
```

The setup wizard uses ordinary numbered/text prompts. Type `back` to revisit the previous step or `cancel` to leave before confirmation without obtaining images or changing Qubicl state.

Setup compares four progressive presets: lean headless `file-system` (1 CPU/512m), Openbox/Chromium `browser` with OCR and document inspection (2 CPU/2g), minimal-XFCE `computer` with document helpers and managed SSH (2 CPU/3g), and broad development/office `workstation` (2 CPU/4g). It validates a local Docker daemon, previews the exact image and resource effects, obtains only the selected image plus gateway, and optionally creates the first computer. Every image carries native keyless `web_search`, local `web_extract`, and the full compatible skill catalog. New computers activate `plan` on `file-system`; `plan`, `pdf`, and `ocr-and-documents` on `browser`; and all six core skills on `computer` and `workstation`.

Connect without placing a bearer token in client configuration:

```sh
qubicl connect computer-name --client codex
qubicl connect computer-name --client opencode
qubicl connect computer-name --client openclaw
qubicl connect computer-name --client hermes-agent
```

Adapters are available for Codex, Claude Code, Claude Desktop, Cursor, VS Code, OpenCode, OpenClaw, Hermes Agent, Open WebUI, generic stdio, HTTP MCP, and OpenAPI. `connect` only prints setup instructions and never edits client files. HTTP/OpenAPI snippets point to the explicit `qubicl token show computer-name` command; they cannot print a raw token themselves.

For a client on the same Linux/macOS host, Codex prints `codex mcp add qubicl-computer-name -- qubicl mcp computer-name`; Qubicl does not run it. When the client runs on Windows and Qubicl runs inside WSL 2, add `--client-host windows` to any stdio adapter. Qubicl then emits that client's normal configuration with a pinned `wsl.exe`, distribution, Node executable, and Qubicl entrypoint. For other clients, copy the printed configuration into the client yourself. The stdio bridge owns its fenced lease, so lease proofs are absent from model-visible tools. Optional `--profile files|browser-semantic|browser-visual|desktop` arguments select smaller static catalogs; `--result-mode structured|compatible` is available for clients that require a non-default MCP result representation.

For a same-host Open WebUI, run `qubicl connect computer-name --client open-webui` and copy the printed fields into **Admin Panel → Settings → Integrations → Open Terminal**. The generated Docker Desktop URL uses `host.docker.internal`; replace it with `127.0.0.1` only when Open WebUI runs directly on the host. Retrieve the token separately and treat it as a password. The compatibility connection supplies native durable-file browsing and search, filesystem-backed chat uploads, lease-safe Qubicl/browser tools, native PNG screenshots, and explicitly published loopback port previews, but not an interactive PTY.

Every computer has an immutable ID, independent credentials, lease fencing, one explicit resource-bounded container, and a host-mounted `/home`. **Only `/home` is durable.** Files and packages elsewhere may disappear on recreation; use a compatible custom image for permanent system packages.

The gateway listens only on localhost. Computers receive no Docker socket, privileged mode, host namespaces, devices, added capabilities, or arbitrary host mounts. Browser-capable computers keep Chromium's Linux namespace and renderer seccomp-BPF sandboxes enabled through a constrained seccomp profile—without `--no-sandbox`, `SYS_ADMIN`, or an unconfined container. Controller and workload processes share the computer container, so takeover is a cooperative managed-process fence rather than a hostile-code boundary. Qubicl is not a VM-grade hostile-code sandbox.

Requirements are Node.js `^22.14.0 || ^24.0.0`, Docker Engine 24.0 or
Docker Desktop 4.29 or newer, and Docker Compose 2.24 or newer. Linux x64,
Apple Silicon macOS with Docker Desktop, and Windows 11 x64 through Ubuntu
24.04 on WSL 2 with Docker Desktop are directly exercised for the first
release. Linux ARM64, Intel macOS, Windows on ARM, and other WSL distributions
are best-effort. Native Windows execution and WSL 1 are not supported, and
Qubicl computers remain Linux containers on every host.

Useful commands:

```sh
qubicl help
qubicl doctor --json
qubicl list --json
qubicl create computer-name --json
qubicl upgrade computer-name --offline
qubicl skills computer-name
qubicl tools computer-name
qubicl control release computer-name
qubicl network show computer-name
qubicl backup create computer-name --quiesce
qubicl --version
```

The source, security model, documentation, and Apache-2.0 license are in the [Qubicl repository](https://github.com/EldanRing/qubicl).
