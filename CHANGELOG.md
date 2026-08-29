# Changelog

All notable Qubicl changes are recorded here. Supported releases will follow Semantic Versioning and Keep a Changelog.

## Unreleased

## 0.2.0 - 2026-08-29

### Added

- Versioned client-conformance requirements and acceptance schema 4 now bind
  exact installed versions and post-freeze hashed surface evidence. The signed
  pre-1.0 `initial` profile requires Codex, Open WebUI, all four protocol probes,
  and Linux x64; the `supported` profile retains the complete application and
  platform matrix plus independent approval and review. Schema-3 v0.1 evidence
  remains verifiable but cannot satisfy a v0.2 release.
- A versioned platform support matrix now separates support policy from direct
  test evidence and binds schema-4 acceptance to exact Linux, macOS, and Windows
  through WSL 2 host facts without promoting best-effort platforms.
- The live viewer now states that Chromium profile data is durable across
  computer restarts and upgrades.
- A host-only `qubicl browser profile wipe COMPUTER` command previews domains
  with stored cookies/site data, the exact durable-profile scope, and preserved
  Downloads before requiring typed-name confirmation or an explicit `--yes`.
- `qubicl upgrade --all` previews exact curated gateway/default/computer
  targets, acquisition and expanded sizes, preserved runtime state, and
  deterministic gateway-first order before confirmation. Pending updates also
  appear in `status`, with default-off bundled-catalog notices available as a
  private local preference.
- Open Terminal compatibility now includes bounded non-PTY process execution,
  listing, attachment, stdin, output pagination, and cleanup plus bounded
  multi-path ZIP download for regular files and directories.
- Optional remote access can be enabled explicitly with `qubicl gateway
  expose`. The existing gateway container keeps its loopback HTTP endpoint and
  adds a separate TLS-only HTTPS/WSS listener; `gateway status` reports the
  local and remote endpoints while refusing to call a stale or recovering
  listener active, and `gateway revoke` removes the external
  publication without changing computers or durable homes.
- Versioned remote-access conformance requirements now prevent schema-4 v0.2
  acceptance from passing without post-freeze native-Linux evidence for the
  remote client surfaces, security boundaries, lifecycle transitions, and
  local-loopback preservation. The `supported` profile additionally requires
  Apple Silicon and Windows/WSL 2 Docker Desktop/NAT evidence.
- Every v0.2 image candidate now retains and publishes exact
  `oci-efficiency.json` evidence: per-platform compressed and expanded layer
  sharing plus bounded, normalized installed-package inventories derived from
  the candidate's embedded SPDX attestations.

### Changed

- The workstation image now installs the supported LibreOffice Writer, Calc,
  and Impress applications directly instead of the full suite meta-package,
  removing unused Base, Math, report-builder, and Python-UNO packages from both
  architectures.
- Platform documentation now gives macOS Docker Desktop preflight and recovery
  steps plus a shorter WSL 2 install, doctor-report, pinned-launcher, and Windows
  browser-handoff path while retaining the WSL 1 and native-Windows boundaries.
- Authenticated-viewer image contracts are bound to exact image content IDs.
  Legacy unlabeled viewer images remain compatible, while a hardened computer
  cannot be started or changed through an incompatible gateway.
- The existing `browser_reset` API name remains compatible but is now presented
  and described unambiguously as **Reset tabs**; it retains the durable browser
  profile rather than clearing cookies or site data.
- Upgrade, full-home backup, checkpoint, clone, delete, restore, and purge
  previews now state whether durable Chromium profile data is preserved,
  copied, restored, or permanently removed.
- Verified orphan/cache cleanup now previews a deterministic immutable
  inventory and reinspects every candidate before deletion. Daemon-global
  images and mutable-name volumes remain manual because one Qubicl state root
  cannot prove exclusive ownership.
- Routine dependency review is manual and local; the repository no longer
  configures Dependabot to create public dependency-update pull requests.
- Published previews retain their local `.localhost` URL and add a remote URL
  only when an isolated wildcard preview domain and matching certificate were
  explicitly configured.

### Fixed

- Gateway and computer upgrades now reconstruct a target viewer contract from
  the exact acquired image while requiring the retained old runtime to match
  the transaction's immutable source binding, so v0.1-to-v0.2 roll-forward no
  longer mistakes the expected old container for target-image drift.
- Authenticated viewer containers now retain the validated `header-v1` mode
  through viewer startup instead of restarting on an unset shell variable.
- Candidate publication now permits ordinary linear descendants of the exact
  reviewed public root while rejecting alternate roots, merge commits, a wrong
  branch, a wrong origin, or a checkout detached from the signed candidate.
- v0.2 publication can no longer inherit the v0.1 initial-tier acceptance
  exemption, and v0.2 candidate verification now requires schema-2 Trivy
  evidence bound to independently filtered platform views.
- Multi-platform release candidates now scan independently filtered amd64 and
  arm64 OCI views and reject retained Trivy reports whose image configuration,
  compressed layers, or rootfs diff IDs do not match the selected platform.
- Failed late-stage candidates can be preserved and resumed through verification
  only, without rebuilding, rescanning, or rerunning artifact acceptance; all
  candidate verification remains pinned to the clean reviewed revision.
- Full-home backups now omit Chromium's transient singleton lock, cookie, and
  socket links, so durable browser-profile backups remain verifiable without
  weakening the archive boundary against absolute links.
- Gateway compatibility checks now retry bounded transient loopback health
  timeouts and restart the same managed gateway once when Docker Desktop leaves
  its declared loopback publication unresponsive during network recreation.
- Renaming a computer under a non-primary Qubicl state root now binds and
  replaces the exact retained runtime instead of validating its old name
  against the already-committed new configuration.

### Security

- Durable-home reads and mutations, including Open Terminal file routes, now
  traverse descriptor-anchored Linux paths with no-follow checks and atomic
  no-replace renames. Copy, move, overwrite, and delete operations reject
  symlink and destination replacement races without escaping `/home/qubicl`.
- Hardened viewer images now require a gateway-injected internal credential for
  static noVNC content and WebSocket upgrades. Raw VNC is confined to protected
  Unix sockets owned by a dedicated viewer user; spoofed headers are replaced,
  credentials do not enter workload-child environments or durable homes, and
  missing or drifted image-contract evidence fails before runtime mutation.
- Backup verification and restore now inspect a checksum-bound private archive
  stream before extraction, accept only bounded regular files, directories,
  and confined symbolic or hard links, and reject traversal, alias collisions,
  cycles, sparse or special entries, decompression excess, and archive changes
  between inspection and extraction. A no-follow post-extraction walk must
  match the reviewed graph before a restored home can be promoted.
- Browser-profile clearing validates the fixed durable path without following
  links or crossing mounts, inventories only bounded domain/origin metadata,
  stops a stable managed runtime before inspection and deletion, and restores
  its prior running state on cancellation or success. Partial deletion and
  restart failures remain explicit and fail closed.
- Lifecycle replacement and recovery bind exact container IDs, roles,
  topology, image identities, and preserved running/stopped/absent state;
  read-only status and preview paths cannot rewrite or resurrect a pending
  journal.
- Open Terminal process journals and ZIP inputs/outputs use private,
  descriptor-pinned identities with bounded record and inventory metadata.
  Policy or lease changes and ambiguous runner responses fence work without
  replay; links, special files, pathname swaps, hidden-start failures, output
  substitution, excess archive concurrency, and disconnected transfers fail
  closed. The direct `/files/view` route keeps active files as downloads. Open
  WebUI's path-based HTML and SVG previews instead receive a self-contained,
  parser-normalized static document through its existing file-proxy route, so
  browsers do not need direct access to a Qubicl `.localhost` preview host.
  Scripts, scripted requests, embeds, forms, refresh/navigation primitives,
  outside-directory asset traversal, and initially selected final symlinks fail
  closed under a response-enforced sandbox and deny-by-default CSP. JavaScript
  and TypeScript clicks display source, while bounded same-directory styles,
  raster images, and media are embedded in the static response. Scripted HTML
  exposes a separate, explicit **Run interactive preview** action for the exact
  file snapshot already returned through Open WebUI's authenticated proxy. The
  action remains available for five minutes and activates in place, without a
  second navigation or browser-visible credential. Its sandbox permits scripts
  but not same-origin access, forms, frames, popups, downloads, or top
  navigation; the confirmation warns that trusted code can contact external
  services using the operator browser outside the computer's Qubicl network
  policy.
- Remote gateway exposure is absent by default and requires a reviewed bind
  address, distinct external port, matching certificate and private key,
  allowed client networks, exact HTTPS browser origins, and explicit consent
  for all-interface or allow-all-client policies. External requests use the
  socket peer rather than forwarded headers, preserve per-computer bearer
  isolation, deny operator-only routes, enforce listener-specific Host, SNI,
  CORS, cookie, timeout, connection, and rate boundaries, and never publish a
  computer container directly.

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
