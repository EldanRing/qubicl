# Architecture

Qubicl is a daemonless host CLI around Docker Compose. The CLI owns durable intent; Docker owns runtime containers.

## Components

### Host CLI

`qubicl` validates a local Docker host, owns state under `~/.qubicl`, resolves exact image identities, renders runtime files, and invokes Compose. It leaves no resident host daemon. Mutations take a private lock and write a recovery journal before durable or runtime changes.

`qubicl setup` is the sole onboarding path. Its pure setup plan separates review from mutation: host/preset/resource checks and preview occur before confirmation; exact image acquisition, contract inspection, a no-network bind probe, and the setup transaction occur afterward.

### Image catalog and presets

The CLI embeds a schema-validated catalog for the gateway and four preset images. Development entries use local tags and unknown registry sizes. Release entries must contain the multi-architecture index digest, per-platform manifest digest, measured download/expanded bytes, capability-manifest digest, limits, and startup budget.

Each computer image embeds a canonical version-1 manifest and matching OCI labels. The control service uses it to register the exact MCP/OpenAPI tool set. The host stores its expected digest; a mismatch prevents health from succeeding. Control protocol version 10 uses one bounded container per computer while retaining lease-transparent stdio sessions, compact/paginated model results, static and per-computer tool profiles, operator-controlled skills, explicit MCP result modes, the desktop-session handoff contract, Open Terminal compatibility, persistent browser automation, keyless web research, bounded rendered-DOM handoff, and authenticated port previews.

| Preset | Startup profile | Tool surface |
| --- | --- | --- |
| `file-system` | Headless single-container computer; no Playwright or display assets | Lease, managed process, bounded read, atomic write, exact-edit, port, file, skill, and web-research tools |
| `browser` | Xvfb + Openbox + Chromium + Playwright + OCR/document inspection + VNC | Previous plus desktop/viewer and semantic, tab, screenshot, and visual browser tools |
| `computer` | Browser base + selected XFCE + document environment + managed SSH support | Browser contract plus ordinary desktop apps |
| `workstation` | Computer base + compiler toolchain + LibreOffice | Computer contract plus development and office tools |

The Docker stages follow that same progression. The common headless layer carries six verified Qubicl core-skill baselines and broadly useful CLI utilities, while Playwright and display assets branch only into the three viewer-capable images. At first initialization, Qubicl copies those baselines into one editable durable working store and projects enabled packages into common agent discovery roots. OCR and permissively licensed PDF helpers begin at the browser layer; the fuller document Python closure, minimal XFCE components, editors, and OpenSSH begin at `computer`; LibreOffice and the compiler toolchain remain `workstation`-only. The AGPL/commercial PyMuPDF family is intentionally not distributed.

### Gateway

The normal `~/.qubicl` installation is one Compose project named `qubicl`. Its only published container is `gateway`; computer Compose services and containers use their literal Qubicl names, so Docker Desktop presents the same operator-facing structure as the CLI. The gateway binds to `127.0.0.1` (port `3211` by default) and reads a generated route file from a read-only mount. Explicit custom `QUBICL_HOME` installations instead derive Compose, container, and network names from the stable installation UUID, allowing isolated development/test installations to coexist on different host ports. The route contains external token hashes and per-computer internal credentials, not raw bearer tokens.

For immutable ID `<id>`, applicable endpoints are:

```text
/computers/<id>/mcp
/computers/<id>/openapi.json
/computers/<id>/health
/computers/<id>/open-terminal/  Open WebUI native files and lease-safe tools
/computers/<id>/previews/      authenticated loopback port previews
/computers/<id>/view          viewer-capable presets only
```

Non-viewer routes return a capability-specific unsupported response instead of proxying to nonexistent VNC services. Viewer sessions use a bounded, authenticated, long-polled in-memory cursor feed. Content-ID-bound viewer images declare an exact baked authentication contract: the gateway derives and injects the computer's internal viewer key after removing spoofed headers, a root-owned isolated plugin validates it, and a dedicated viewer UID reaches x11vnc only through protected Unix sockets. Old unlabeled images retain their legacy route; incomplete or incompatible hardened contracts fail before mutation, and gateway replacement reconnects only computers that were already running. Desktop intent is recorded immediately before dispatch; the isolated session publishes browser intent through a separate narrow credential after resolving the semantic target and immediately before Playwright input. Updates are accepted only for the active lease generation. Confirmation retains the last position, failure restores the prior confirmed point, and release, expiry, preemption, policy revocation, epoch reset, human takeover, or runtime restart clears it. Events contain only lifecycle, type, sequence, display coordinates, button, and timestamp; typed data, refs, URLs, titles, selectors, and page content are excluded. Browser viewport coordinates are mapped through Chromium's live window metrics, then the gateway maps display coordinates through the actual noVNC canvas rectangle rather than assuming the viewer and framebuffer share an origin or aspect ratio. The logo-green arrow remains visible while the agent owns control, click rings fade independently, and neither webpages, the desktop framebuffer, nor screenshots are modified. Route reloads do not restart unrelated computers.

### Computer runtime

Each computer is exactly one container. A small supervisor starts the controller, managed-command runner, local web extractor, optional display/browser/desktop session, and optional SSH endpoint inside that container. Model commands, browser processes, desktop applications, and SSH sessions run as the normal `qubicl` user without passwordless elevation. Internal runner subprocesses receive only narrow derived credentials through explicit environment allowlists; model-controlled commands receive none of Qubicl's control variables. Only the assigned home is host-mounted writable. Viewer-capable computers have bounded shared memory, and the computer's CPU, memory, and PID settings form one enforceable cgroup boundary rather than additive sidecar ceilings.

The shared gateway also owns the authenticated outbound proxy and credential broker. A restricted computer has one private per-computer network and can reach the Internet only through that gateway proxy; a `developer` computer's one network permits direct egress. The gateway is dynamically connected to each computer network, while computers never share a network with one another. No computer receives the Docker socket, privileged mode, host namespaces/network, host devices, unrelated mounts, or the raw external bearer token.

## Request and control path

An AI uses either:

1. `qubicl mcp <name>`, a local stdio bridge that reads protected state, owns one fenced connection lease, and forwards lease-free model calls to the localhost gateway; or
2. authenticated Streamable HTTP MCP/OpenAPI through the gateway.

Open WebUI may instead use `/open-terminal/`. That compatibility namespace exposes an OpenAPI document without caller-supplied lease fields and a bounded native file API rooted in `/home/qubicl`, including metadata, filename/content search, display handoff, filesystem-backed chat uploads, descriptor-streamed ZIP downloads, and retained non-PTY process execution with bounded input and independently paginated output. Native and generic file operations share the same descriptor-anchored, no-follow traversal and atomic mutation boundary, so validation is not separated from use by a pathname race. It internally acquires and refreshes the same fenced lease used by ordinary tools, so it remains mutually exclusive with agents and human control. Its Open WebUI port projection lists and proxies only currently listening ports that were explicitly published through Qubicl. It does not advertise an interactive PTY or notebooks.

The `browser`, `computer`, and `workstation` contracts expose the same bounded Playwright surface used by the Terminal1 reference implementation: navigation and accessibility snapshots, ref-based interactions, history/wait, a five-tab persistent profile, viewport screenshots, and screenshot-grounded coordinate actions. Qubicl drives the image's existing Chromium rather than downloading another browser. Browser operations are serialized, snapshot refs expire on page/tab changes, output and action counts are bounded, and the browser session is independent of ordinary lease-owned commands so it remains visible during human takeover.

Chromium runs as the unprivileged `qubicl` user with its Linux namespace and renderer seccomp-BPF sandboxes enabled. Browser-capable computer containers use Qubicl's pinned default-deny Chromium-compatible seccomp profile. That profile is based on the minimum-supported Docker 24.0 default allowlist, keeps later Docker's `io_uring` restriction, and adds only the precise `clone`/`unshare` namespace flag sets Chromium requires. The computer remains non-privileged, has no `SYS_ADMIN` or added capability, enables `no-new-privileges`, and uses the curated preset's dedicated 1 GiB shared-memory allocation instead of `--disable-dev-shm-usage`. The maintained source profile records each Qubicl-specific rule and is derived from [Moby's Apache-2.0 Docker 24.0 default seccomp profile](https://github.com/moby/moby/blob/v24.0.0/profiles/seccomp/default.json).

The gateway authenticates the external token and reaches the controller on that computer's private network. The controller uses independently derived, localhost-only credentials for the runner processes. Exclusive leases carry an unguessable ID, fencing generation, and server epoch. Expiry, preemption, or control restart invalidates stale proofs and terminates tracked managed process groups. Human ownership follows the controlling viewer WebSocket: a 10-second grace period permits ordinary reconnects, after which the gateway releases abandoned control and retries release while a computer restarts. Because all computer functions share one PID namespace, this is a cooperative managed-process fence: an intentionally evasive process that daemonizes outside its tracked process group may survive until the computer container is restarted.

`web_search` and `web_extract` are ordinary lease-fenced tools. The first provider implementations are `ddgs` and `local`; their stable public schemas do not expose provider-specific responses. Direct extraction validates public DNS answers locally in developer mode or delegates that validation to the authenticated gateway egress service on private restricted networks; every redirect is revalidated, time, redirect, download, and decompressed-byte budgets are bounded, and supported content is parsed locally. HTML extraction then runs Trafilatura, readability-lxml only when the primary result is not meaningful, and finally a bounded structural heuristic over the same fetched bytes. Non-HTML handlers remain direct. Browser rendering reuses the computer's Chromium only for the established render modes and sparse/JavaScript signals, validates each HTTP(S) request, blocks non-public destinations, waits within a fixed content-stability budget, and sends at most 1.5 MB of sanitized rendered DOM through a localhost-authenticated route. The same Trafilatura/readability pipeline handles that DOM and may recover bounded high-signal JSON-LD, microdata, price attributes, and accessible market labels. It does not create another browser stack or expose page credentials, cookies, response headers, or arbitrary network responses. Tool policy, transport profile, network policy, and audit behavior are unchanged.

`computer` and `workstation` contracts additionally expose `open_desktop_application`, `list_desktop_applications`, and `close_desktop_application`. These tools are a deliberately separate desktop-session lifecycle: applications are selected from a fixed per-image allowlist, launched directly without a shell, use fixed arguments and a sanitized environment, accept only bounded existing paths that resolve beneath `/home/qubicl`, and are capped and tracked. Workstation LibreOffice instances receive a fixed-shape unique profile so a launch cannot hand off to an untracked existing process. These applications survive human takeover; ordinary `exec_command` processes—including GUI applications launched that way—remain lease-owned and are always terminated on release, expiry, gateway-epoch change, and takeover. During human control all agent tools stay fenced, and continuation after release requires a fresh lease.

Coding-oriented tools keep that lease and process architecture while bounding model-facing output. Text reads default to 2,000 lines and 24 KB with explicit continuation offsets; supported image reads and screenshots become native MCP image content. Commands return one combined 24 KB tail by default (split streams are opt-in) and disclose the temporary retained-log path only after inline truncation; retained logs are capped at 100 MB and removed one hour after process exit. Directory listings are deterministic, root-relative, and cursor-paginated. Writes and exact-match multi-edits serialize per path; edits preserve UTF-8 BOMs and line endings and reject ambiguous or overlapping replacements.

## State format 3

```text
~/.qubicl/                       mode 0700
├── config.yaml                  state v3; mode 0600
├── secrets.yaml                 raw tokens/internal credentials; mode 0600
├── transaction.yaml             temporary lifecycle journal; mode 0600
├── state-migration.yaml         temporary migration journal; mode 0600
├── audits/<uuid>.jsonl          bounded private per-computer tool/control events
├── backups/                     migration evidence and checksummed home archives
├── computers/<uuid>/
│   ├── metadata.yaml            exact preset/image/capability/policy identity
│   ├── ssh/                     optional private operator identity
│   └── home/                    the computer's durable /home
├── trash/                       recoverable deleted computers
└── runtime/
    ├── compose.yaml             generated, disposable
    ├── preferences.json         private local-only operator preferences
    ├── image-contracts.json     exact inspected runtime image evidence
    ├── legacy-runtime-migration.json temporary verified runtime-name migration journal
    ├── legacy-runtime-namespace.pending durable marker before legacy resource discovery
    └── routes.json              generated token hashes/routes
```

State records requested and resolved image references, local content ID, expected manifest digest, preset/custom compatibility, capabilities, and resources. Compose uses the resolved identity; `doctor` reports content or catalog drift rather than silently changing a computer.

## Lifecycle invariants

- Setup default changes affect only computers created later.
- `qubicl upgrade NAME` is the explicit image-replacement boundary: it preserves identity, credentials, operator settings, and durable `/home`, while transactionally replacing the pinned capability contract and disposable runtime.
- `qubicl upgrade --all` reviews one immutable plan, acquires and inspects every deduplicated exact target before mutation, then rolls forward gateway-first while preserving each computer's prior running/stopped/absent state. Read-only status and preview paths never recover or rewrite a pending journal.
- Immutable UUID, home, token, image, resources, and route survive rename and setup reruns.
- Delete invalidates access and moves state to trash; restore retains ID/home and issues a new token; purge permanently destroys it.
- State v1/v2 migrations make checksummed backups and never start containers.
- Legacy global Docker names are claimed only when labels and bind mounts prove ownership by the active state root; migration preserves running/stopped lifecycle state and is recoverable.
- The primary runtime is presented as `qubicl/{gateway,<computer-name>,...}` at both the Compose-service and container layers: one gateway plus one container per computer. Protocol-9 split runtimes remain renderable during a rolling upgrade; `qubicl upgrade NAME` converts that computer and removes its verified old sidecars, workspace network, and display volume. The one-time move from older UUID-scoped primary runtimes records and verifies ownership before recreating containers, preserves running/stopped state and every `/home`, and is recoverable after interruption. A primary computer rename recreates that computer so Docker's immutable Compose service label matches the new name; the ID, token, configuration, and durable `/home` remain unchanged, while non-durable root-layer state follows the normal recreation contract. Custom `QUBICL_HOME` runtimes remain UUID-scoped and stable across computer renames.
- Only `/home` is durable. Container root is not part of any lifecycle guarantee.

See [Persistence and recovery](persistence.md) and the [Security model](security-model.md).
