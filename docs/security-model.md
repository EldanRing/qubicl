# Security model

Qubicl separates convenient AI workspaces from unrelated host files and one another. It is not a VM, adversarial sandbox, or defense against a compromised Docker daemon/kernel.

## Trust assumptions

The operator trusts the host OS, local Docker runtime, Qubicl CLI/images, AI client, and selected image. A workload is trusted with its computer's `/home` and the outbound access selected by its network profile. Model commands run as the unprivileged computer user without passwordless elevation. A custom image remains trusted code: its image startup and packaged setuid/root components execute before Qubicl's unprivileged workload boundary and can read/modify the assigned home.

Do not place secrets in a Qubicl home that you would not give to container-root code in that computer.

## Enforced boundaries

- Setup accepts only a local Docker endpoint and Linux daemon; remote `tcp://`/`ssh://` contexts fail closed.
- The gateway publishes only on `127.0.0.1` by default. An operator can add a
  distinct HTTPS/WSS publication through the explicit, confirmed
  `qubicl gateway expose` workflow. It stays in the same gateway container;
  computer ports are never published directly, and the local listener remains
  loopback-only.
- Each computer is one resource-bounded container. Its controller, command runner, local web extractor, optional display/browser/desktop session, and optional SSH endpoint share that container's PID and network namespaces. Internal runner processes receive independently derived localhost-only credentials through explicit allowlists; model-controlled command environments exclude all `QUBICL_*` control variables and inherited credentials.
- Computers are unprivileged and receive no Docker socket, host network/PID/IPC namespace, devices, or unrelated mounts. They receive no added capability, `SYS_ADMIN`, privileged mode, or unconfined security profile.
- The only writable host mount in a computer is its `/home`, plus its bounded audit file. Operator policy and the per-computer dynamic preview-access directory are mounted read-only. The latter contains only local and optional remote preview base URLs, allowing expose/revoke to update retained computers without recreating them. The shared gateway receives the read-only generated runtime directory and one writable audit-file mount per computer so it can enforce egress and broker policy without mounting computer homes or protected state.
- External bearer tokens remain in mode-`0600` host state. Routes contain hashes; a computer gets an independent internal credential.
- Browser OpenAPI/Open Terminal calls require the same per-computer bearer
  token. Local CORS is reflected only for HTTP loopback origins. On the optional
  TLS listener it is reflected only for exact configured HTTPS origins; wildcard,
  null, path-bearing, and unlisted origins fail closed. Preflight permits only
  each route's required method and bounded headers.
- Remote gateway configuration stores only bind/origin/network policy and
  immutable TLS metadata in config; the validated certificate/key snapshot is
  paired in mode-`0600` protected secrets and transaction state. Compose and
  routes contain fixed runtime paths, never PEM bytes or source key paths. The
  gateway revalidates hashes, key match, dates, SANs, and private modes before
  opening its TLS 1.2+ listener. The external surface enforces the actual socket
  peer CIDR, exact TLS SNI/Host, per-computer bearer isolation, bounded requests,
  connections, tickets, sessions, and rate buckets, while ignoring forwarded
  address headers. Operator routes remain local. Remote viewer cookies are
  host-only `__Host-` cookies with Secure, HttpOnly, SameSite=Strict, and
  `Path=/`; preview content requires a separate wildcard-isolated origin, and a
  different registrable site is recommended for defense in depth.
- Tool calls require authentication and a current fenced lease. The local stdio bridge and Open Terminal compatibility own that proof outside model-visible calls; direct HTTP MCP/OpenAPI callers provide it explicitly. Human takeover makes the old proof stale immediately, terminates tracked managed process groups, and leaves agent tools fenced until release and a fresh lease. In the single-container architecture this is a cooperative process fence, not a cgroup or hostile-code boundary: a deliberately daemonized/reparented process can evade tracked process-group termination and requires a computer restart to clear reliably.
- Only applications opened through the capability-gated desktop-session tools can survive takeover. Their executable and arguments come from a fixed allowlist; input paths must already exist and resolve below `/home/qubicl`; URLs, shell input, arbitrary executable/argument/environment input, and internal control credentials are excluded. Tracked application count is bounded. Human control belongs to the live controlling viewer connection, permits a 10-second reconnect grace period, and is then released automatically; the authenticated local operator may also release it explicitly.
- Browser-capable images use a dedicated persistent Chromium profile and a bounded Playwright controller. Chromium remains the unprivileged `qubicl` user and its Linux user/PID/network-namespace plus renderer seccomp-BPF sandboxes stay enabled. The browser-capable computer container receives a default-deny seccomp profile derived from Docker 24.0's default profile: it preserves the default restrictions (including the later `io_uring` denial) while admitting only Chromium's exact unprivileged namespace `clone`/`unshare` flag combinations. The computer also enables `no-new-privileges`, receives no `SYS_ADMIN`, added capability, privileged mode, host namespace, or unconfined profile, and has a dedicated 1 GiB `/dev/shm`; `--no-sandbox` and `--disable-dev-shm-usage` are not used. Operations are serialized, tabs and semantic refs are capped, URLs are limited to HTTP(S) without embedded credentials, screenshot payloads are capped, and webpage content is explicitly untrusted. The managed browser and its profile survive takeover, restart, and supported upgrade; the viewer discloses that durability, while browser tools remain lease-fenced.
- `browser_reset` closes tabs but retains the durable profile. The separate host-only profile wipe stops a stable runtime, queries only fixed bounded domain/origin columns rather than cookie values, refuses symlinked database companions, substituted profile components, or nested mount boundaries, removes only the fixed profile, preserves Downloads, and requires explicit operator confirmation. Same-computer runtime membership, ownership, role, identity, and state are checked again before deletion; cancellation restores a previously running runtime.
- Viewer tickets are short-lived and exchanged for an HttpOnly cookie. For content-ID-bound hardened images, the gateway strips any caller-supplied viewer-authentication header and injects a key derived from that computer's protected internal key for both static noVNC requests and WebSocket upgrades. A root-owned isolated authentication plugin validates the key; a dedicated viewer user owns protected Unix RFB relays, and no raw TCP VNC listener is opened. The key is absent from routes, URLs, logs, the durable home, and workload-child environments. Exact legacy images remain usable without claiming this boundary; incomplete, mismatched, missing, or drifted hardened-image evidence fails before routes or runtime state are changed.
- Lifecycle operations are host-only, not AI tools.
- Lifecycle replacement journals bind full container IDs, exact names, images, installation/role labels, and expected topology before deletion or recreation. A changed, partial, wrong-role, wrong-image, or uninspectable runtime fails closed; read-only status and cleanup/upgrade previews do not rewrite or recover journals. Cleanup removes only immediately revalidated immutable candidates and preserves daemon-global images plus mutable-name volumes for manual cross-installation review.
- Capability manifests and OCI labels are checked before state commit and again at runtime; unsupported tools/routes are absent.
- Generic file tools and Open Terminal file routes are confined to `/home/qubicl` through a descriptor-anchored Linux filesystem boundary. Every user-controlled component is traversed without following a replacement link; final reads use already-opened descriptors, while writes, edits, copies, moves, overwrites, and deletes use staged or quarantined entries plus no-replace renames and identity revalidation. Unsupported descriptor/rename capabilities fail closed. Ordinary path errors remain stable, and user-visible recovery outcomes distinguish an uncommitted failure from committed cleanup or durability uncertainty. These operations cannot use `/proc` or the container root to inspect control-plane state.
- Open Terminal compatibility processes share the ordinary command-runner boundary and current lease. Counts, command/input bytes, queued stdin, lifetime, retained record metadata, output files, aggregate bytes, waits, and page sizes are bounded. Journal files live beneath a pinned private directory and are reopened no-follow only when their device/inode, link count, type, and size still match. Policy reload, lease loss, record deletion, expiry, and takeover fence tracked process groups before ownership is discarded. An ambiguous split-runner response is never replayed: Qubicl fences the owning lease's processes and reports explicitly if that fencing cannot be confirmed.
- Open Terminal ZIP creation accepts only bounded regular files and directories from the descriptor-anchored home boundary. Links and special files are rejected; streaming enumeration, compact ancestry evidence, path/entry/metadata, per-file, aggregate-input, output, concurrency, creation-time, and transfer-time budgets are enforced. Client disconnects cancel in-progress creation or transfer and release its reservation. Output is written from creation to a read-only-mode Linux unnamed temporary inode, identity-checked, and streamed through its retained descriptor, so a same-user pathname substitution cannot redirect the download or cleanup.
- Backup archives are copied through a checksum-bound no-follow descriptor into private staging before parsing. Verification budgets compressed bytes, expanded bytes, entry count, path metadata, link resolution, and decompression; accepts only regular files, directories, and confined acyclic symbolic or hard links; rejects special/sparse entries, aliases, and unsafe permissions; repeats exact byte and metadata checks during extraction; and no-follow walks the staged result before transaction promotion. Archive contents remain untrusted durable-home data after restore.
- `developer` egress is unrestricted by design. `web-only`, `offline`, and `custom` profiles place the computer on a private per-computer network whose only Internet bridge is the gateway's authenticated proxy; restricted profiles deny private/loopback/link-local/metadata destinations and custom policies require allowlisted domains. Temporary approval is explicit and expires.
- `web_extract` additionally accepts only HTTP(S), rejects embedded credentials, validates every DNS answer and redirect, blocks non-public/loopback/private/link-local/metadata targets, limits redirects, request time, downloaded bytes, and decompressed bytes, and never executes downloaded files. Browser fallback independently applies public-destination validation to page requests. Its local runner strips executable/non-content nodes and transfers at most 1.5 MB of rendered DOM over an authenticated loopback route; cookies, authentication headers, and arbitrary network responses are not transferred. `web_search` and extraction still traverse the same egress boundary; `offline` denies both.
- Search and extracted page content are untrusted model input. Public search endpoints can rate-limit or change behavior; Qubicl returns explicit bounded failures and never silently selects a paid or credentialed provider.
- Web, browser, screenshot, and clipboard results carry compact Qubicl-owned `contentTrust` provenance. MCP text also places those results in a collision-resistant untrusted-data frame; native screenshots remain binary images with equivalent metadata. A bounded advisory scanner records finding IDs—not captured content—in the local audit log. A clean scan is reported as `no-known-patterns`, never as a claim that content is safe. These signals reinforce the model boundary but do not replace container, credential, egress, lease, or takeover enforcement.
- Qubicl's six core skill baselines are file-list locked, fully scanned, SHA-256 verified during every build, and reviewed against declared tool/preset requirements. Qubicl does not distribute the bulk Hermes catalog or jailbreak-oriented packages. Explicit local or immutable-commit Git imports reject symlinks, hard links, nested repositories, traversal, excessive packages, and blocking content patterns. Imported and core working copies are deliberately agent-editable inside the durable home; bounded host and control inspection rejects substituted store/discovery parents and reports drift or corruption without following agent-created links. Operator activation, import, reset, and removal remain outside `skill_manage` authority.
- Broker credentials are resolved by the host from protected state, environment/file references, Linux Secret Service, or macOS Keychain and injected only into an allowed HTTPS origin/path/method by the shared gateway egress service. Values are absent from computer and workload environments and results.

## Setup/privacy behavior

Setup does not edit client files, send telemetry, call a Qubicl backend, or use GitHub APIs. Online acquisition delegates only the exact image pull to Docker; source-development mode may build a missing bundled target. `--offline` forbids pull/build acquisition.

Setup, create, list, status, inspect, and connect do not print raw tokens. HTTP/OpenAPI snippets always contain a placeholder. The only retrieval command is deliberately separate:

```sh
qubicl token show research
```

Protect its output like a password. Rotating a token invalidates the previous external credential.

The Open WebUI adapter prints only a token placeholder. Supplying the separately retrieved token places that credential in Open WebUI's admin connection settings. Use Open WebUI access grants to restrict who can use it, and do not configure an untrusted Open WebUI deployment. The compatibility service is separately namespaced, confined to the assigned `/home`, owns one fenced lease, and cannot bypass human takeover. Its process API is non-PTY and its archive API is bounded; it does not expose an interactive terminal emulator or notebooks. Desktop and browser screenshots are returned as native PNG responses through this compatibility surface; MCP image results omit duplicate base64 from structured/text metadata. Seamless HTML and SVG file previews are parser-normalized into self-contained static responses with a Qubicl-enforced CSP sandbox: authored script, scripted network, embedded-document, form, refresh, navigation, outside-directory asset traversal, and initial-final-symlink paths fail closed while bounded passive styles, raster images, and media are embedded. The browser therefore does not connect directly to Qubicl's loopback preview hostname. Scripted HTML can execute only after the Open WebUI user selects a Qubicl-owned trusted-interactive action. The exact selected-file bytes are carried inertly in the authenticated response, without an Open WebUI or computer credential; the action expires after five minutes and activates those bytes in place rather than issuing a second authenticated navigation. The document remains sandboxed without same-origin, form, frame, popup, download, or top-navigation grants and sends no referrer. It does allow scripts and browser network requests; the confirmation warns that this explicitly trusted traffic is outside the computer's Qubicl egress policy.

State directories are real, private, user-owned paths. Setup rejects symlink components and root execution. Journals/config/secrets are never placed in process arguments. Compose/routes contain no raw external token. Each computer also has a bounded private JSONL audit stream; it records operation metadata and status, not command text, file content, broker values, or request bodies.

## Limitations

- Docker shares the host kernel; runtime/kernel escape is out of scope.
- Docker itself is a privileged host boundary.
- Standard Linux discovery commands inside a container can report Docker-host or Docker-VM metadata—including CPU model/logical CPUs, total memory, kernel, uptime, load, and backing-filesystem capacity. These observations are not the computer's usable budget; Qubicl's cgroup CPU, memory, and PID ceilings are the enforced limits reported by `get_computer_status`.
- Depending on the Docker implementation, mount tables can reveal a backing-path label for the computer's assigned home. This metadata does not make that path or unrelated host directories accessible; `/home` remains the only assigned writable host mount.
- The default `developer` profile allows outbound internet, so workloads can exfiltrate data they can read. Restricted egress is an application-layer HTTP(S) control, not a defense against a malicious custom image or Docker/kernel compromise.
- Internal control services and agent workloads share one computer PID namespace. The controller credential is excluded from model-command environments, but the one-container design is not a secret boundary against deliberately hostile same-container code, process inspection, or a malicious custom image. Human takeover is dependable for Qubicl-managed cooperative processes, not an adversarial workload guarantee.
- A process controlling the operator account can read Qubicl state, replace the CLI, or control Docker.
- Localhost is not a boundary against other processes under that account.
- Qubicl can configure a direct TLS listener but does not create DNS records,
  issue or renew certificates, configure routers/firewalls, or install a tunnel
  or mesh VPN. Docker Desktop/NAT may obscure the original socket peer, so CIDR
  enforcement can fail closed or be unsuitable as the primary client boundary;
  interface selection, TLS, per-computer bearer authentication, and optional
  client certificates remain authoritative. Verify the host firewall manually.
  Port previews and optional SSH remain loopback-only unless a preview is
  explicitly projected through the isolated remote gateway origin. Open
  Terminal `/ports` and `/proxy/{port}` remains fail-closed: it projects only
  live ports with an unexpired explicit Qubicl publication and does not turn an
  arbitrary listener into a preview.
- Direct browser integration uses loopback HTTP by default. When remote access
  is configured, browser API origins must be exact trusted HTTPS origins and
  remote previews require separate wildcard DNS/certificate coverage. The
  recommended same-host Dockerized Open WebUI path can continue using Docker
  Desktop's host gateway and local listener.

Use Qubicl for capable operator-supervised work, not deliberately hostile samples or mutually untrusted users on one host. Report vulnerabilities through [SECURITY.md](../SECURITY.md).
