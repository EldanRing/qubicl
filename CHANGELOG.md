# Changelog

All notable Qubicl changes are recorded here. Supported releases will follow Semantic Versioning and Keep a Changelog.

## Unreleased

## 0.6.0 - 2026-09-14

### Added

- Named per-client credentials with independent scopes, rotation, revocation,
  one-time delivery, dashboard management, and connection examples. The legacy
  computer token remains as a compatibility credential.
- Retained tasks with bounded records and logs, list/show/wait/input/stop
  controls, explicit session-scoped execution, declared restartable services,
  and interactive PTY tools for MCP and Open Terminal clients.
- Dynamic installed-application discovery and launch with a bounded built-in,
  user, and system desktop-entry catalog, resolved executable identity, safe
  document paths, observable lifecycle, and explicit unsaved-work
  acknowledgement before close.
- Scoped custom-network CIDR and TCP-port grants, live-tunnel revocation, and
  `explain_capability`, network-policy, and secret-scope explanations.
- App-lifetime preview publications with root-path proxying, isolated origins,
  normal app cookies, and separately expiring/revocable remote shares.
- Storage reporting and quota guidance, explicit update checks and notification
  preferences, resumable recovery status, encrypted dashboard backups, and
  passphrase-encrypted full-installation export/inspect/import.
- Guest-only devcontainer lifecycle hooks and harmless forwarded-port metadata,
  with bounded parsing, offline checks, and host-boundary validation.
- Exact release-impact documents for 0.6 candidates. Builder, verifier,
  release-set, and publisher metadata bind the base/candidate revisions, changed
  paths, required artifacts, checks, protocols, platforms, and evidence-reuse
  rules.
- Executable documentation contracts that validate local links, CLI examples,
  synchronized root/npm claims, and retired constraint language.

### Changed

- State format 5 and control protocol 11 separate interactive ownership from
  observation, file work, retained tasks, services, and operator-owned SSH.
  Migration preserves IDs, homes, credentials, and explicit user policy.
- Runtime names are scoped to the installation, including the primary state
  root, so multiple installations cannot collide and `gateway` is available as
  an ordinary computer name.
- Human control follows the connected viewer with a visible configurable
  5–300-second reconnect grace (10 seconds by default). Takeover immediately
  fences old interactive browser, desktop, session-process, and PTY input while
  retained work continues.
- Chromium uses a normal durable profile with logins, extensions, downloads,
  and continued human use. The agent-open tab budget is visible and fails
  explicitly instead of silently evicting tabs.
- Git workflows run inside the computer, so repository configuration receives
  computer authority rather than host-maintainer authority.
- Dashboard routine saves execute directly. Local authentication survives a
  same-tab refresh through `sessionStorage`; logout and tab close clear it.
  Reauthentication remains for destructive, interrupting, or
  authority-expanding operations. Computer details report the managed browser's
  effective sandbox, durable-profile, extension, password-store, extraction,
  tab-budget, engine-version, and sanitized diagnostic posture.
- Backup and update workflows report clearer outcomes, preserve interrupted
  state for explicit recovery, and avoid blind replay. Ordinary jobs retain
  interrupted records after runtime replacement; only declared services restart.
- Public docs and maintainer rules now distinguish host/security boundaries,
  configurable resource defaults, implementation limits, support evidence, and
  explicit maintainer approval gates.
- The reviewed full-workstation tool-definition ceiling is 38 KB for the 0.6
  catalog; focused static profiles remain available to reduce client context.

### Fixed

- Operator release of human control now requires the computer's internal
  operator key; the workload bearer can no longer invoke that route.
- Queued browser work rechecks ownership immediately before dispatch, late
  results are discarded after a handoff, failed process fencing can be retried,
  and cleanup for an old owner no longer revokes a newer unrelated lease.
- Browser typing honors append mode, desktop application launches reserve
  capacity before asynchronous preparation, and dropped-UID LibreOffice
  sessions own their isolated profile files.
- Interactive Chromium restores phishing, update, extension, popup, keyring,
  process-protection and HTTPS/storage features disabled by Playwright's test
  defaults while keeping its sandbox required. Rendered public extraction uses
  an isolated context without saved logins.
- Browser tabs have stable IDs and a visible 24-tab agent-open budget. Qubicl
  no longer closes older or idle tabs automatically, large snapshots report
  their scan boundary, long action batches are rejected, and full-page capture
  is bounded before raster allocation.
- Managed desktop launch accepts any installed executable name available from
  the approved user/system bin directories, keeps document paths inside the durable home, and no
  longer applies arbitrary file-extension walls. Programmatic close requires
  an explicit acknowledgement that unsaved changes may be discarded.
- Managed commands now default to retained, labeled computer tasks that survive
  client disconnect and human desktop takeover. Callers can request a
  lease-scoped session process, and a new process listing lets later clients
  inspect and stop retained work without exposing command text or output.
- Devcontainer JSONC preserves comma-like string contents, nested build paths
  resolve from the configuration file, escaped workspace paths are rejected,
  and offline imports refuse implicit image builds before contacting Docker.
- Dashboard credential forms preserve exact secret values, including leading
  and trailing whitespace.
- Dashboard backup planning now accepts passphrases for encrypted create,
  verify, and restore operations, rejects mismatched encryption inputs, and
  scrubs operation-only passphrases from retained history.
- Preview revocation and network-rule expiry/revocation now close associated
  upgraded connections and tunnels instead of only refusing new requests.
- PTY resize and input messages arriving in one pipe read are drained together;
  buffered control input can no longer remain invisible behind `select()` and
  leave an interactive shell waiting indefinitely.
- Audit events are validated and bounded before persistence, and centralized
  rotation no longer depends on renaming a file bind-mounted into computers.
- Configuration can change the viewer reconnect grace and safely rebuild or
  reconnect the gateway only when that behavior actually changes.
- Observation-only browser calls no longer attempt to validate a missing
  interactive lease, Open Terminal sessions sharing one client credential no
  longer compete for separate compatibility leases, and protocol-10 computers
  continue to use the unified runtime during a coordinated upgrade.
- The CLI accepts every documented 0.6 management option, including task,
  storage, network-CIDR, import-root, credential-template, and viewer-grace
  values. Storage reports include current and legacy audit paths, and network
  explanations evaluate literal IPv4 and IPv6 CIDR matches.
- The gateway image advertises protocol 3 consistently with its runtime health
  and viewer-routing contract, so source and packaged artifact acceptance no
  longer reject the 0.6 image as a legacy gateway.
- Gateway requests now allow bounded browser operations to finish before the
  idle cutoff, so slow navigation returns the browser's actual result instead
  of an ambiguous post-dispatch timeout.
- Managed Chromium initializes and unlocks its durable Secret Service with a
  per-computer credential, so first navigation cannot stall behind an invisible
  keyring password prompt.

### Security

- Browser images keep Chromium's namespace and renderer sandboxes, remove
  unsafe Playwright testing flags, enable `no-new-privileges`, use a
  Chromium-compatible seccomp profile and dedicated shared memory, and expose
  launch diagnostics.
- Rendered public extraction uses an anonymous ephemeral browser context without
  persistent cookies, extensions, saved logins, or service workers, and checks
  public destinations independently of the normal browser profile.
- Client authorization is scoped to named identities, and internal credentials,
  operator release authority, route data, and workload command environments are
  separated. Revoking one client no longer disconnects every client.
- Gateway requests, sessions, tickets, connections, route bodies, and audit
  metadata have explicit bounds. Preview and egress authority is checked for the
  lifetime of managed upgraded connections.
- Installation archives use authenticated encryption, bounded no-follow archive
  inspection, exact manifest/state identity checks, a new installation ID on
  import, safe replacement of any archived ownership-marker link,
  stopped-by-default recovery, and no imported remote administration.

## 0.5.1 - 2026-09-10

### Added

- Native host management helper and responsive light/dark dashboard, with
  first-run setup, computer lifecycle/resources, controller/process metadata,
  preview access, tools/skills/network policy, write-only scoped credentials,
  manual home backups/checkpoints/clones, recovery, and operation history.
- Optional login-time systemd user service or macOS LaunchAgent, a foreground
  mode, and an authenticated local recovery interface independent of Docker.
- Private direct HTTPS administration with host-supplied certificates, distinct
  administrator/viewer identities, session management, and local password reset.
- A sixth, isolated static dashboard image and catalog-bound asset manifest;
  candidate, provenance, scan, packaging, and publisher checks cover all six
  images on both architectures. v0.5 acceptance requires all nine clients, four
  protocols, and explicit Linux/macOS/iPhone dashboard evidence.
- Explicit `qubicl recover` for validated state, backup, and upgrade journals.

### Changed

- State format 4 requires an explicitly approved, backed-up migration; older
  CLIs refuse the migrated state. Dashboard records use a separate schema 1 and
  the image catalog uses schema 2.
- Upgrade-all records accepted targets and checkpoints so interrupted updates
  can resume only with matching catalog, platform, state and runtime identities.
- Security maintenance follows the latest stable minor release line.

### Fixed

- Diagnostics and orphan cleanup recognize the configured dashboard container
  and private asset network as current managed resources.
- Initial-release acceptance no longer requires a physical host reboot;
  physical reboot evidence remains mandatory for the supported release tier.
- Candidate construction refreshes and validates the Trivy vulnerability
  database before capturing scanner metadata, so the retained database
  timestamp and digest describe the same scans.
- Release documentation distinguishes the v0.1.0 directly tested platform
  baselines from the narrower v0.5 initial candidate evidence. Publisher
  examples include every mandatory signed-evidence input and the separately
  authorized `origin/main` fast-forward prerequisite, and release prerequisites
  identify the enforced Trivy 0.74.0 version.
- Fresh core skill working copies report their catalog integrity as unchanged,
  including skills whose reviewed packages contain nested resource files.
- Fresh dashboard setup recognizes an absent Docker container and creates it
  instead of reporting a conflicting runtime identity.
- The static dashboard uses a dedicated ordinary bridge so Docker reliably
  publishes its loopback-only asset port.
- The root and npm README capability tables have real column headers so the
  first row renders correctly.
- Local preview token URLs continue to return their content directly; dashboard
  tickets and remote preview tokens still redirect once to scrub credentials.
- Network-policy changes detach the gateway from disposable per-computer
  networks before Compose recreates them, avoiding active-endpoint failures.
- Artifact verification recognizes the dashboard as a first-party SBOM
  component while keeping it out of third-party notices.
- Stopped dashboard containers can restart using their retained loopback port
  configuration; running containers still require verified active publication.
- Dashboard preview handoffs use the isolated preview origin, and plan Cancel
  and Close controls work without submitting or validating password fields.
- Backup recovery retains its journal when unpause leaves an unsafe or
  inconsistent runtime. Absent-start recovery verifies the pinned image before
  adopting a running computer.
- v0.5 release acceptance requires native Linux x64 and Apple Silicon dashboard
  service, TLS and reboot evidence in addition to browser/device checks.
- Completed-process cleanup closes each output descriptor only once, preserving
  unrelated requests when the operating system reuses file descriptor numbers.
- Dashboard computer creation keeps connection handoffs out of helper logs.
- Read-only backup verification, token display and credential listing leave
  pending transactions untouched until explicit recovery.
- Interrupted computer lifecycle changes retain exact container bindings for
  recovery; upgrade recovery rejects replacement of an unreviewed container.
- Dashboard recovery preserves stop/disable intent, and explicit starts adopt
  the current bundled dashboard image and verified asset contract.
- Dashboard updates, network approvals, diagnostics, settings and operation
  streams use the host API contracts. Operation history stays chronological
  after restarting the helper.
- Dashboard error recovery, keyboard navigation, recovery-state actions and
  phone navigation remain usable under the administrative security policy.
- Cloning a running computer requires confirmation of its temporary pause.
- Dashboard candidate builds pass the asset digest explicitly and OCI checks
  verify the embedded manifest bytes as well as labels and provenance.
- Start, stop and restart reject partial or inconsistent runtime groups and use
  verified immutable container identities instead of broad name-based changes.
- Network/resource/credential replacement uses the lifecycle recovery journal.
- Backup creation journals exact paused containers, recovers interruption, and
  publishes complete verified captures. Retention selects immutable source IDs
  so renamed computers cannot remove another computer's backups.
- Backup pruning rejects ambiguous reused historical names and preserves
  archives with malformed metadata instead of treating them as retention targets.

### Security

- The guarded publisher requires the reviewed commit on canonical remote
  `main`, binds the supplied signing key to the release-notes trust anchor, and
  verifies every versioned image through an isolated anonymous registry client
  before npm publication. Native executable builds no longer embed their
  private source/build paths and reject those bytes before packaging.
- The locked Hono runtime is updated to 4.13.7, resolving the current path
  traversal, nested-form denial-of-service, and URL-fragment parsing advisories.
- Administrator certificates reject additional IP, URI, email or DNS identities.
  Expired and terminally rejected plans promptly discard retained credential
  inputs without requiring another plan request.
- Idle browser polling does not renew administrator sessions. Closing an
  administrative listener terminates active event streams and connections.
- Administrative passwords use bounded asynchronous scrypt; sessions enforce
  user-idle and absolute expiry, rotation on reauthentication, memory-only local
  authorization (no cross-port ambient cookie), Secure remote cookies, CSRF/origin/Host
  checks, rate limits, and protected host storage.
- Workloads and frontend containers receive no administrative authority.
  Browser assets are checked against trusted path/type/size/digest contracts;
  remote administration fails closed on unavailable or invalid trusted assets.
- Management actions use session-bound expiring previews, final state/runtime
  checks, interruption confirmation, sensitive-action reauthentication, and
  private idempotent acceptance receipts without credential values.
- Operator process/preview inspection bypasses agent lease acquisition only
  through narrowly authenticated internal routes; metadata omits commands,
  working directories, process output, credential values and lease proofs.

## 0.2.1 - 2026-09-04

### Fixed

- Browser snapshot references retain the original DOM element when nearby
  controls are inserted or reordered. Removed or replaced targets are rejected
  instead of redirecting agent input to a different element.
- Open Terminal content search enforces its aggregate byte and attempted-file
  budgets even for oversized or unreadable files, and reports incomplete
  content searches as truncated while retaining filename matches.
- Open WebUI's native editor reads complete UTF-8 files up to 20 MB and rejects
  larger files instead of exposing a prefix that could overwrite the original.
  Model reads also report truncated single lines correctly.
- Open WebUI command and edit tools now use its folder/refresh operation names;
  relative file paths and default command directories follow each chat's folder.
  MCP and generic OpenAPI names and parameters remain compatible.
- Search prunes hidden and Git-ignored directories before descent, returns partial
  results at traversal limits, and reuses bounded content-search pages.
- `audit prune --keep 0` now retains zero events.
- Planning guidance no longer mandates a file write during read-only planning;
  model guidance distinguishes enabled skills from untrusted external content.

### Added

- Workstation DOCX/PPTX PDF previews with bounded conversion, temporary profiles,
  cancellation on disconnect or takeover, and unchanged original downloads.

### Changed

- Browser snapshot metadata checks overlap up to 16 requests; semantic browser
  actions no longer impose a fixed 300 ms delay after Playwright completes.
- Directory metadata reads have bounded concurrency. Performance measurements can
  reuse a verified existing bundle with `--no-build` and omit build timing.
- Client documentation explicitly describes shared computers across chats,
  supported preview paths, app-cookie limits, and the isolated WebSocket route.

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

- Local multi-platform candidate builds now run at most two BuildKit image jobs
  concurrently, while lifecycle-heavy exact-artifact acceptance remains serial
  with disjoint ports and unique temporary image tags. Scans, OCI analysis, and
  final verification also remain serial, and failed concurrent work is drained
  before staging is preserved.
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

- Browser-capable computers now create the durable Chromium profile and
  Downloads directory as the unprivileged computer user. Startup narrowly
  repairs empty root-owned directories left by prerelease session supervision
  while refusing nonempty or unrelated ownership mismatches with the existing
  explicit ownership-repair guidance.
- Runtime performance and reboot-acceptance harnesses now execute bounded,
  current package workloads in the unified protocol-10 computer container
  while retaining legacy split-topology coverage; the CLI RSS guard also has
  measured v0.2 runtime headroom instead of a flaky v0.1 ceiling, and image
  budgets use the selected catalog's verified download measurements.
- Stopped gateway replacement and legacy runtime migration now use a Docker
  Compose command whose dependency-suppression flags are supported by the
  documented Compose baseline, so configuring remote access while the gateway
  is stopped can recover without starting it. Remote-access doctor checks also
  report a manual external probe instead of a false TLS failure when a specific
  host bind intentionally excludes the host itself from its client allowlist.
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
