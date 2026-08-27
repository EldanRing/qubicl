# Changelog

All notable Qubicl changes are recorded here. Supported releases will follow Semantic Versioning and Keep a Changelog.

## Unreleased

### Added

- Versioned client-conformance requirements and acceptance schema 4 now require
  exact versions and post-freeze hashed evidence for Codex, Claude Code,
  OpenCode, OpenClaw, Hermes Agent, Open WebUI, retained desktop/editor clients,
  and the applicable MCP, OpenAPI, and Open Terminal surfaces. Schema-3 v0.1
  evidence remains verifiable but cannot satisfy a v0.2 release.
- A versioned platform support matrix now separates support policy from direct
  test evidence and binds schema-4 acceptance to exact Linux, macOS, and Windows
  through WSL 2 host facts without promoting best-effort platforms.

### Changed

- Platform documentation now gives macOS Docker Desktop preflight and recovery
  steps plus a shorter WSL 2 install, doctor-report, pinned-launcher, and Windows
  browser-handoff path while retaining the WSL 1 and native-Windows boundaries.

### Fixed

- Multi-platform release candidates now scan independently filtered amd64 and
  arm64 OCI views and reject retained Trivy reports whose image configuration,
  compressed layers, or rootfs diff IDs do not match the selected platform.
- Failed late-stage candidates can be preserved and resumed through verification
  only, without rebuilding, rescanning, or rerunning artifact acceptance; all
  candidate verification remains pinned to the clean reviewed revision.

## 0.1.1 - 2026-08-27

### Fixed

- Refreshed the npm package description and README so the npm page presents
  the current product overview, installation flow, capabilities, supported
  clients, platform support, and security boundary.
- Updated the official light and dark Qubicl marks used by GitHub and npm.

## 0.1.0 - 2026-08-26

### Added

- Windows 11 host support through WSL 2 and Docker Desktop, including explicit
  WSL detection, Windows-backed state-path rejection, Windows browser handoff,
  and pinned `wsl.exe` launchers for every stdio client adapter.
- Apple Silicon macOS host support exercised with Docker Desktop, including
  image builds, workstation creation, desktop control, and Codex connectivity.
- Authenticated viewers show a logo-green pointer at the agent's latest
  confirmed desktop or browser point action. The position persists only while
  agent control remains active, click pulses are brief, no typed content is
  included, and the indicator can be disabled locally in the viewer.
- Sole `qubicl setup` onboarding with interactive/deterministic flows, explicit preset/custom selection, structured local-Docker preflight, resource/disk/image preview, offline mode, bind probe, recoverable transaction, capability verification, and token-free handoff.
- Four shared-layer computer targets: headless `file-system`, minimal Chromium `browser`, selected-XFCE `computer`, and development/office `workstation`.
- Canonical version-1 computer capability manifests and OCI labels, exact tool/OpenAPI filtering, optional viewer routing, expected-manifest health enforcement, and per-preset limits/startup profiles.
- State format 3 with requested/resolved/content/manifest image identities, preset/custom compatibility, capabilities, exact defaults, and recoverable v1/v2 config/secrets/metadata/transaction migration.
- Secret-free declarative manifest version 2 with an explicit v1 parser.
- Local five-image OCI candidate order, exact per-platform digest/size catalog generation, embedded SBOM/provenance inspection, ten Trivy reports, and exact-candidate artifact acceptance.
- Per-preset local performance sizes plus optional recommendation workload/startup/60-second-idle measurements.
- Existing daemonless lifecycle, MCP/OpenAPI/stdio access, fenced leases, viewer takeover, durable homes, ownership repair, trash, recovery, diagnostics, custom images, and declarative reconciliation.
- Capability-gated desktop-session application tools for safe human handoff. Allowlisted Writer/Calc/Impress or selected desktop applications can remain open across takeover while ordinary lease-owned commands are fenced and terminated.
- Effective cgroup-v2 CPU, memory, and PID limits in computer status, explicitly separated from host-derived values exposed by ordinary system interfaces.
- Stable, actionable file-operation errors; native command timeouts and bounded signal selection; explicit terminal/termination and truncation metadata; and automatic lease-refresh disclosure.
- A dedicated Open WebUI client adapter plus narrowly scoped loopback-browser CORS for authenticated OpenAPI discovery and tool calls, avoiding Docker network changes for same-host user tool servers.
- One resource-bounded computer container supervises its controller, command runner, persistent browser/desktop session, local web extractor, and optional SSH endpoint. A shared gateway provides authenticated routing plus policy-aware outbound proxy and credential brokerage.
- Persistent bounded browser automation, native MCP/Open Terminal image responses, token-efficient static tool profiles, lease-transparent stdio/Open Terminal sessions, compact paginated results, and an enforced tool-catalog byte budget.
- Authenticated loopback port discovery/previews, per-computer network profiles and temporary approvals, destination-scoped host-side secret brokerage, checksummed/encrypted home backups, checkpoints/clones, bounded devcontainer import, loopback SSH/editor access, host-mediated Git workflows, and a bounded private audit trail.
- Exact preview-versus-supported candidate policy, detached Ed25519 signing and acceptance-evidence validation, aggregate vulnerability/secret reporting, exact applicability records, and explicit safe computer upgrades.
- Six reviewed Qubicl-native core skills for planning and document work, durable agent-editable working copies, explicit bounded local/immutable-Git imports, universal skill discovery/management tools, cross-agent native-directory projections, drift/reset recovery, and operator-owned activation/tool policy.
- Native keyless `web_search` and local `web_extract` tools in a localhost-only, unprivileged runner. Extraction supports bounded HTML, text, JSON/XML, and PDF handling, Trafilatura-first article extraction, readability/structural fallbacks, and managed-Chromium rendering for browser-capable presets.

### Security

- WSL setup and doctor fail closed on WSL 1 and on Qubicl state stored on
  DrvFS/Windows-backed 9P mounts. The gateway remains loopback-only across the
  Windows-to-WSL localhost boundary.
- Setup rejects root use, remote Docker contexts, non-Linux daemons, symlinked state paths, unsupported image contracts, and mismatched capabilities.
- Protected directories/files are tightened to `0700`/`0600`; state/root/image drift is audited without recursively changing durable contents.
- Setup/create/list/status/inspect/connect output cannot reveal bearer tokens. `--show-secrets` was removed; `qubicl token show` is the separate explicit retrieval path.
- `file-system` registers no screenshot, desktop, clipboard, viewer, or VNC surfaces.
- Computers retain one-home-only, localhost-gateway, private-network, non-privileged, no-socket/device/host-namespace boundaries.
- Human takeover invalidates stale lease proofs and terminates Qubicl-tracked managed process groups before agent tools can continue. It is a cooperative fence rather than a guarantee against deliberately evasive same-container code. Desktop-session launches use fixed executables/arguments, sanitized environments, bounded counts, and existing real paths confined below `/home/qubicl`.
- Model commands run without passwordless elevation and do not inherit gateway/control credentials in their environment; generic file tools remain confined to the durable home. Because workloads share the controller's computer/PID namespace, `/proc` inspection by deliberately hostile same-container code is explicitly not a secret boundary.
- Browser cross-origin access is limited to HTTP loopback origins, OpenAPI discovery/tool paths, exact GET/POST preflights, and the `Authorization`/`Content-Type` headers; MCP, viewer, and human-control routes remain excluded.
- Chromium runs unprivileged with its Linux namespace and renderer seccomp-BPF sandboxes enabled. Only browser-capable computer containers receive the pinned default-deny profile needed for Chromium's exact unprivileged namespace operations; they have no `SYS_ADMIN`, added capability, privileged mode, host namespace, or unconfined seccomp profile.
- Web extraction rejects credentials and non-public destinations, revalidates DNS and redirects, bounds time/download/decompression/rendered DOM, and obeys the same per-computer egress and tool policies as other calls.

### Changed

- Qubicl source code remains Apache-2.0, while specifically designated logo and
  brand artwork is explicitly available under CC BY 4.0 with attribution and
  permissive unofficial-fork guidance.
- The managed runtime is one shared gateway plus exactly one resource-bounded
  container per computer. The gateway also hosts each computer's policy-aware
  outbound proxy and credential broker; the computer supervises its controller,
  runners, optional display/browser, and optional SSH endpoint. Protocol-9
  split runtimes remain usable until `qubicl upgrade NAME` performs their
  rolling, home-preserving conversion.
- Human takeover is documented as a cooperative fence for Qubicl-tracked
  process groups, not as a hostile-code or same-container secret boundary.
- The public source tree now carries only Qubicl's reviewed native skill
  packages and a concise upstream provenance record; the audit-only bulk Hermes
  source snapshot and completed internal implementation reports are excluded.
- Release documentation now separates the concrete pre-1.0 publication path
  from the long-term 1.0 roadmap, and vulnerability status comes from the exact
  candidate's retained reports instead of a self-staling source snapshot.
- `qubicl init` now reports that it was replaced by `qubicl setup`.
- Setup default changes affect only future computers; stored exact identities do not silently follow CLI/catalog updates.
- Development full-image name is now `qubicl/workstation:dev`; the curated computer image uses `qubicl/desktop:dev` to preserve deterministic migration of the former `qubicl/computer:dev` baseline.
- Documentation, E2E, reboot preparation, performance, release preflight, and candidate tooling now describe the preset/state-v3 system.
- Build, test, scan, and release automation remains local; no Actions workflows
  or repository runners are used. Dependabot may propose dependency updates but
  never executes Qubicl's test or release commands.
- Default setup output omits successful preflight noise; fully specified `setup --yes` runs without redundant TTY prompts. Default `create` output is concise, while `--json` retains the complete machine-readable result.
- Client connection guidance now states that Qubicl does not edit client configuration. The Codex adapter prints the token-free `codex mcp add` command and explains that a new task is required.
- Desktop input results now distinguish dispatch from semantic verification, accept an optional confirmed target window, report bounded before/after focus evidence, normalize common X11 key aliases, and reject ambiguous modifier sequences.
- The normal Docker runtime is one literal `qubicl` project containing `gateway` and one literal-name service/container per computer. Protocol-9 split runtimes and legacy UUID-scoped primary runtimes migrate transactionally.
- Curated preset contents are progressive: the headless image carries only the native web provider and compatible skill catalog, browser adds Chromium/OCR/PDF inspection, computer adds XFCE/document/SSH helpers, and workstation adds LibreOffice and development tools.
- HTML extraction now prefers main-content structure and can supplement rendered pages with bounded high-signal JSON-LD, microdata, price attributes, and accessible labels without exposing cookies or arbitrary network responses.

### Fixed

- The setup bind probe now runs with the host UID/GID, uses the directory-bind
  shape of computer homes, and tolerates brief metadata propagation. This fixes
  false permission failures from capability-dropped computer images on WSL.
- noVNC WebSocket URLs no longer duplicate the viewer route prefix; `qubicl doctor` verifies the authenticated viewer page and WebSocket upgrade.
- Rebuilding source development images no longer makes an unrelated retained computer block targeted create/start/stop/restart/restore operations. Gateway recreation reconnects running computers directly, and recovery remains compatible with pending state-format-3 setup journals.
- Source image rebuild failures identify the development recovery command, validate every preset contract, and avoid implying that an unavailable historical development image can be pulled from a public registry.
- Missing paths, incompatible destinations, failed moves/copies, and unavailable filesystem birth times now return stable results without misleading generic errors or Unix-epoch creation timestamps.
- Workstation images include common network inspection tools and suppress LibreOffice's first-run tip while retaining the existing container security boundary.
- Viewer ownership follows the controlling WebSocket and releases after a bounded reconnect grace period; explicit recovery remains available after interruptions and restarts.
- Browser and desktop screenshots no longer duplicate base64 into model-visible text, and Open WebUI receives native PNG responses.
- `qubicl upgrade` replaces one computer's disposable image/runtime safely while preserving its ID, token, resources, policies, and durable home.
- Open WebUI file previews support both the current `/files/serve/*` route and the earlier `/files/view` compatibility route while remaining confined to the durable home.
- Open WebUI compatibility now includes file-display handoff, bounded filename/content search, complete file-list metadata, filesystem-backed chat uploads, system-guidance discovery, and HTTP proxying for explicitly published ports only.
- Chromium no longer launches with `--no-sandbox` or `--disable-dev-shm-usage`; browser-capable sessions use the enabled Linux sandbox and their dedicated 1 GiB shared-memory allocation without suppressing the warning cosmetically.
