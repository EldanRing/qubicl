<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/EldanRing/qubicl/main/assets/brand/qubicl-mark-dark.svg">
  <img alt="Qubicl" src="https://raw.githubusercontent.com/EldanRing/qubicl/main/assets/brand/qubicl-mark.svg" width="180">
</picture>

<h1>Qubicl</h1>

### Give any AI agent a real, private computer on your machine.

Durable files. Terminal access. Web research. A persistent browser and desktop.
Human takeover whenever you want it. No Qubicl account, cloud control plane, or
model lock-in.

[![npm](https://img.shields.io/npm/v/qubicl-cli?color=cb3837&label=npm)](https://www.npmjs.com/package/qubicl-cli)
[![License](https://img.shields.io/badge/license-Apache--2.0-6f42c1)](https://github.com/EldanRing/qubicl/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-22%20%7C%2024-339933)](https://github.com/EldanRing/qubicl/blob/main/package.json)
[![Docker](https://img.shields.io/badge/runtime-Docker-2496ED)](https://www.docker.com/)

</div>

---

```sh
npm install -g qubicl-cli
qubicl setup
```

Qubicl turns local Docker into observable computers for external AI agents.
The agent stays in Codex, Claude, Open WebUI, Cursor, VS Code, or another MCP or
OpenAPI client. Qubicl supplies the machine it works on.

```text
your model or agent
        │
        │  MCP / OpenAPI / Open Terminal
        ▼
 localhost-only Qubicl gateway
        │
        ├── terminal + managed processes
        ├── durable, host-visible files
        ├── keyless web search + local extraction
        ├── persistent Chromium + desktop
        ├── packaged, operator-controlled skills
        └── live viewer + human takeover
```

## Why Qubicl

| | |
| --- | --- |
| **Bring your own model** | One computer works with any compatible client. Switch models without rebuilding the workspace. |
| **See the work** | Watch the live desktop, take control, finish a task yourself, and hand the same session back. |
| **Keep the files** | The computer's `/home` is visible on the host and survives restarts, upgrades, and runtime recreation. |
| **Do more than code** | Terminal, Git, web research, browser automation, desktop apps, office workflows, previews, backups, and SSH. |
| **Control every computer** | Choose its resources, network policy, exposed tools, active skills, credentials, and lifecycle. |
| **Stay local** | No Qubicl account, telemetry backend, database, hosted daemon, or Docker socket inside the computer. |

## Quick start

Requirements: Node.js 22 or 24, Docker Engine 24.0 or Docker Desktop 4.29+, and
Docker Compose 2.24+. Directly tested hosts are Linux x64, Apple Silicon
macOS with Docker Desktop, and Windows 11 x64 through Ubuntu 24.04 on WSL 2
with Docker Desktop. Linux ARM64, Intel macOS, Windows on ARM, and other WSL 2
distributions are best-effort. Native Windows and WSL 1 are unsupported;
Qubicl computers remain Linux containers on every host. See the versioned
[Platform support](https://github.com/EldanRing/qubicl/blob/main/docs/platforms.md)
matrix before installing on a best-effort host.

```sh
qubicl setup
qubicl create computer-name --preset computer
qubicl connect computer-name --client codex
```

The setup wizard checks Docker, compares four progressive computer presets,
previews resource and image effects, obtains only the selected image plus the
gateway, and can create the first computer. Run Qubicl as your normal user,
never with `sudo`.

## Computer presets

| Preset | Includes | Viewer | Suggested limit |
| --- | --- | :---: | ---: |
| `file-system` | Shell, processes, Git, durable files, web research | — | 1 CPU / 512m |
| `browser` | Everything above plus persistent Chromium, OCR, PDF inspection | ✓ | 2 CPU / 2g |
| `computer` | Browser plus a lightweight XFCE desktop, editors, document tools, SSH | ✓ | 2 CPU / 3g |
| `workstation` | Full development and office environment with LibreOffice | ✓ | 2 CPU / 4g |

Every preset includes native keyless `web_search`, local `web_extract`, and
verified Qubicl-native skill baselines with durable, agent-editable working
copies. Operators choose the tools and skills each computer exposes:

```sh
qubicl tools computer-name
qubicl skills computer-name
```

Disabled tools disappear from MCP, OpenAPI, and Open Terminal, and cached calls
fail closed.

## Connect any agent

```sh
qubicl connect computer-name --client codex
qubicl connect computer-name --client claude-code
qubicl connect computer-name --client cursor
qubicl connect computer-name --client opencode
qubicl connect computer-name --client openclaw
qubicl connect computer-name --client hermes-agent
qubicl connect computer-name --client open-webui
```

Adapters cover Codex, Claude Code, Claude Desktop, Cursor, VS Code, OpenCode,
OpenClaw, Hermes Agent, Open WebUI, generic stdio and HTTP MCP, and direct
OpenAPI. `connect` prints configuration; it never edits client files or prints
a bearer token.

For Open WebUI, copy the generated configuration into **Admin Panel → Settings
→ Integrations → Open Terminal**. Qubicl supplies native durable-file browsing,
chat uploads, screenshots, browser tools, and explicitly published local
previews without joining Open WebUI's Docker network.

## Watch and take over

```sh
qubicl view computer-name
```

Observation is passive. **Take control** fences agent tools and terminates its
ordinary managed commands before handing you the keyboard and mouse. Persistent
browser and managed desktop applications remain visible so you can continue the
same task. Qubicl's green pointer shows the agent's latest desktop or browser
position in the viewer. The viewer states that Chromium's profile is durable
across restarts and upgrades. Current viewer images also require a
gateway-injected internal credential for noVNC files and WebSocket traffic and
expose no raw TCP VNC listener.

Agent-facing `browser_reset` is presented as **Reset tabs** and retains the
durable profile. A host operator can separately run `qubicl browser profile
wipe COMPUTER` to preview domains with stored cookies/site data and the exact
removal/preservation scope before explicit confirmation; Downloads remain.

## Security boundary

Computers run without privileged mode, a Docker socket, host namespaces,
arbitrary mounts, or passwordless elevation. The gateway listens only on
`127.0.0.1`. Qubicl is a Docker-based computer for trusted or
operator-supervised workloads, not a VM boundary against hostile code.

Read the complete [security model](https://github.com/EldanRing/qubicl/blob/main/docs/security-model.md)
before relying on the boundary.

Qubicl `0.1.x` is the initial public series. Interfaces and state formats may
evolve before 1.0. Linux x64, Apple Silicon macOS with Docker Desktop, and
Windows 11 x64 through Ubuntu 24.04 on WSL 2 with Docker Desktop are directly
tested. Linux ARM64, Intel macOS, Windows on ARM, and other WSL 2 distributions
remain best-effort. Native Windows and WSL 1 are unsupported; Qubicl computers
remain Linux containers on every host. Read the
[platform matrix](https://github.com/EldanRing/qubicl/blob/main/docs/platforms.md)
and [WSL guide](https://github.com/EldanRing/qubicl/blob/main/docs/wsl.md) for
the exact boundaries. Back up important computer homes before upgrades.

Explore the [source and full documentation](https://github.com/EldanRing/qubicl).
Source code and documentation are Apache-2.0. Designated Qubicl brand artwork
is CC BY 4.0.
