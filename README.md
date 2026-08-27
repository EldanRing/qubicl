<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/qubicl-mark-dark.svg">
  <img alt="Qubicl" src="assets/brand/qubicl-mark.svg" width="180">
</picture>

<h1>Qubicl</h1>

### Give any AI agent a real, private computer on your machine.

Durable files. Terminal access. Web research. A persistent browser and desktop.
Human takeover whenever you want it. No Qubicl account, cloud control plane, or
model lock-in.

[![npm](https://img.shields.io/npm/v/qubicl-cli?color=cb3837&label=npm)](https://www.npmjs.com/package/qubicl-cli)
[![License](https://img.shields.io/badge/license-Apache--2.0-6f42c1)](LICENSE)
[![Node](https://img.shields.io/badge/node-22%20%7C%2024-339933)](package.json)
[![Docker](https://img.shields.io/badge/runtime-Docker-2496ED)](https://www.docker.com/)

[Quick start](#quick-start) · [Why Qubicl](#why-qubicl) · [Computers](#choose-a-computer) · [Clients](#connect-any-agent) · [Security](#security-boundary) · [Docs](#documentation)

</div>

---

```sh
npm install -g qubicl-cli
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

Requirements: Linux with Docker Engine or Docker Desktop, macOS with Docker
Desktop, or Windows 11 through WSL 2 and Docker Desktop—plus Node.js 22 or 24
and Docker Compose 2.24+. Native Windows execution and WSL 1 are not supported;
WSL installations must keep Qubicl state and computer homes in the WSL Linux
filesystem under `/home`. See [Platform support](docs/platforms.md) before
installing on a best-effort host.

```sh
qubicl setup
```

The setup wizard checks Docker, compares computer presets, previews disk and
resource use, obtains the selected images, and can create the first computer.
Run Qubicl as your normal user, never with `sudo`.

Create another computer and connect an agent:

```sh
qubicl create computer-name --preset computer
qubicl connect computer-name --client codex
```

`connect` prints the client configuration; it never edits client files or
prints a bearer token. For local stdio clients, the configuration is token-free.

<details>
<summary><strong>Build from source</strong></summary>

```sh
git clone https://github.com/EldanRing/qubicl.git
cd qubicl
npm ci
npm run images:build
npm install -g --prefix "$HOME/.local" ./packages/cli
export PATH="$HOME/.local/bin:$PATH"
qubicl setup
```

</details>

## Choose a computer

Presets share layers while exposing different capability contracts. Tools that
the selected computer cannot support are absent from discovery.

| Preset | Includes | Viewer | Suggested limit |
| --- | --- | :---: | ---: |
| `file-system` | Shell, processes, Git, durable files, web research | — | 1 CPU / 512m |
| `browser` | Everything above plus persistent Chromium, OCR, PDF inspection | ✓ | 2 CPU / 2g |
| `computer` | Browser plus a lightweight XFCE desktop, editors, document tools, SSH | ✓ | 2 CPU / 3g |
| `workstation` | Full development and office environment with LibreOffice | ✓ | 2 CPU / 4g |

Every preset includes native keyless `web_search`, local `web_extract`, and six
verified Qubicl-native skill baselines with durable, agent-editable working
copies. Operators choose which tools and skills each computer exposes:

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

Adapters cover Codex, Claude Code, Claude Desktop, Cursor, VS Code, Open WebUI,
generic stdio and HTTP MCP, and direct OpenAPI. Static profiles can expose a
smaller file, semantic-browser, visual-browser, or desktop catalog.

For Open WebUI, copy the generated configuration into **Admin Panel → Settings
→ Integrations → Open Terminal**. Qubicl supplies native durable-file browsing
and search, filesystem-backed chat uploads, screenshots, browser tools, and
explicitly published local previews without joining Open WebUI's Docker network.

See [Client setup](docs/clients.md) for exact instructions.

## Watch and take over

```sh
qubicl view computer-name
```

Observation is passive. **Take control** fences agent tools and terminates its
ordinary managed commands before handing you the keyboard and mouse. The
persistent browser and explicitly managed desktop applications remain visible,
so you can continue the exact task instead of starting over.

While the agent is acting, the viewer keeps Qubicl's green pointer at its latest
desktop or managed-browser position and briefly pulses the exact click target.
Semantic browser clicks are mapped from the page element through Chromium and
the live noVNC canvas, so the indicator stays aligned through viewer resizing
and letterboxing. It appears before input dispatch, survives viewer reloads,
and clears when the agent loses its lease or a human takes control. It remains
viewer-only—human input, webpages, and agent screenshots are untouched—and you
can toggle it off from the viewer header. The viewer also identifies Chromium's
profile as durable: cookies, site data, preferences, and browser state remain in
the computer's `/home` across ordinary restarts and upgrades.

Agent-facing `browser_reset` is labeled **Reset tabs** and keeps that profile.
To deliberately remove cookies, local storage, history, preferences, and
sessions while preserving Downloads and every file outside the managed profile,
the host operator uses an explicit preview and confirmation:

```sh
qubicl browser profile wipe computer-name
```

Viewer tickets and cookies terminate at the shared gateway. Current viewer
images additionally require a gateway-injected internal credential for both
noVNC files and WebSocket traffic; the computer exposes no raw TCP VNC listener,
and that internal credential is not passed to workload child processes.

If a controlling viewer disappears, Qubicl releases abandoned control after a
short reconnect grace period. The operator can always recover explicitly:

```sh
qubicl control release computer-name
```

## Built for daily use

- Publish an agent-started local web app through an authenticated loopback preview.
- Back up, verify, encrypt, restore, clone, and checkpoint durable homes.
- Preview and deliberately wipe one durable Chromium profile without deleting Downloads.
- Apply `offline`, `web-only`, `developer`, or custom egress policies.
- Broker narrowly scoped credentials without placing the secret in the workload.
- Import bounded devcontainer definitions and use host-mediated Git workflows.
- Enable loopback-only SSH for editors and ordinary `ssh`/`scp`.
- Inspect a private, content-free audit trail and diagnose topology with `doctor`.
- Preview pending curated image updates and their acquisition sizes with `status`.
- Upgrade one computer or use confirmed `upgrade --all` while preserving IDs,
  tokens, policies, resources, homes, and prior running/stopped/absent state.
- Preview exact cleanup candidates; ambiguous daemon-global images and Docker
  volumes remain manual because one installation cannot prove exclusive ownership.

Use `qubicl help` or `qubicl <command> --help` to explore the full CLI.

Update notices are local, default off, and compare only against the catalog
bundled with the installed CLI. Enable or disable them explicitly with
`qubicl config set --update-notifications on|off`; they perform no network
check, telemetry, image pull, or automatic mutation.

## Security boundary

Qubicl keeps every computer inside one explicit Docker resource and filesystem
boundary. Computers run without privileged mode, a Docker socket, host
namespaces, arbitrary mounts, or passwordless elevation. The gateway listens
only on `127.0.0.1`; Chromium retains its Linux namespace and renderer
seccomp-BPF sandboxes; model-facing files are confined to the durable home.
Controller and workload processes share the computer container, so human
takeover is a cooperative managed-process fence rather than a hostile-code boundary.

Qubicl is a Docker-based computer for trusted or operator-supervised workloads,
not a VM boundary against hostile custom images, kernel exploits, Docker
compromise, or another user who controls the host account. The default
`developer` network profile permits outbound access. Read the complete
[security model](docs/security-model.md) before relying on the boundary.

## Release status

Qubicl `0.1.x` is the initial public series. It is ready for real use, but its
interfaces and state format may evolve before 1.0. Linux x64, Apple Silicon
macOS with Docker Desktop, and Windows 11 x64 through Ubuntu 24.04 on WSL 2
with Docker Desktop are directly tested for the first release. Linux ARM64,
Intel macOS, Windows on ARM, and other WSL 2 distributions remain best-effort.
Native Windows and WSL 1 are unsupported; Qubicl computers remain Linux
containers on every host. The versioned [Platform support](docs/platforms.md)
matrix is authoritative. Back up important computer homes before upgrades.

## Documentation

| Topic | Guide |
| --- | --- |
| Architecture and boundaries | [Architecture](docs/architecture.md) · [Security model](docs/security-model.md) |
| Persistence and recovery | [Persistence](docs/persistence.md) · [Troubleshooting](docs/troubleshooting.md) |
| Host platforms | [Platform support](docs/platforms.md) · [Windows Subsystem for Linux](docs/wsl.md) |
| Clients and workflows | [Client setup](docs/clients.md) · [Daily-driver workflows](docs/daily-driver.md) |
| Skills and research | [Skills](docs/skills.md) · [Web research](docs/web-research.md) |
| Custom environments | [Custom images](docs/custom-images.md) |
| Roadmap | [Public product direction](ROADMAP.md) |
| Development and releases | [Development](docs/development.md) · [Release process](RELEASING.md) · [Verification](VERIFYING.md) · [Vulnerability evidence](security/README.md) |

**Licensing:** source code and documentation are Apache-2.0; the designated
Qubicl logo and official brand artwork are CC BY 4.0. See
[BRANDING.md](BRANDING.md) for permitted brand use and attribution.

Contributions are welcome—start with [CONTRIBUTING.md](CONTRIBUTING.md), and
report vulnerabilities through the repository's private security-reporting
form described in [SECURITY.md](SECURITY.md).
