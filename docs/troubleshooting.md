# Troubleshooting

Start with:

```sh
qubicl doctor
```

Doctor audits host/runtime versions, local Docker context, protected state, pending recovery, exact images and drift, localhost routing, optional TLS exposure state/publications, capability manifests, mounts, limits, privileges, and networks. `--json` is available for scripts.

## Remote gateway exposure

Start with the read-only report:

```sh
qubicl gateway status --json
qubicl doctor
```

If exposure is configured but unavailable, confirm that the selected address is
still assigned, the external port is free, the certificate is current and
covers the configured hostname, and the configured gateway image declares
`direct-tls-v1`. If it does not, run `qubicl status` and `qubicl upgrade --all`
before retrying. Re-run `qubicl gateway expose` with the intended certificate
to renew or correct it. Use `qubicl gateway revoke` to return to loopback-only
operation; it also detects and previews stale managed publication/key state.
If `--preview-domain` is rejected for a computer, update its curated image with
`qubicl upgrade --all` or provide a custom image that declares the exact
`dynamic-v1` preview-access contract and recreate that retained runtime.

An external TLS probe can fail with `network_not_allowed` when the CIDR list
does not include the socket peer observed inside the gateway. Docker Desktop or
host NAT may replace the original client address. Do not trust
`X-Forwarded-For` as a workaround: Qubicl intentionally ignores it. Prefer a
specific host interface and use TLS, bearer authentication, and optionally a
client CA. Verify DNS, router, and host firewall rules yourself; doctor reports
them as manual because Qubicl does not control those systems. Remote previews
also require wildcard DNS and certificate coverage for the configured preview
domain.

## Setup preflight fails

Qubicl does not install, upgrade, open, or start Docker. Confirm your normal user can run:

```sh
docker version
docker compose version
docker context show
```

Start Docker Engine/Desktop yourself, select a local context, then rerun `qubicl setup`. Qubicl rejects `tcp://`, `ssh://`, remote daemons, non-Linux Docker servers, root execution, unsupported architectures, and symlinked state paths.

If the port is occupied, choose another explicitly:

```sh
qubicl setup --preset browser --gateway-port 4321 --no-create --yes
# Existing installation:
qubicl config set --gateway-port 4321
```

Qubicl never scans silently for a different port.

### macOS and Docker Desktop

Apple Silicon macOS with Docker Desktop is directly tested; Intel macOS is
best-effort. Confirm the Mac is using the native Qubicl/npm architecture and
that Docker Desktop's local Linux engine is ready:

```sh
uname -m
docker context show
docker version
docker compose version
docker info --format '{{.OSType}}/{{.Architecture}}'
qubicl doctor
```

If the daemon is unavailable, start Docker Desktop and wait for its engine
rather than retrying setup with `sudo`. If doctor reports a remote context or
`DOCKER_HOST`, explicitly restore a local Docker Desktop context and remove the
unintended override. A non-Linux Docker server is unsupported. For a bind-probe
failure, confirm Docker Desktop may share the selected local `QUBICL_HOME` path
and that the normal user owns it. See [Platform support](platforms.md) for the
architecture and evidence boundaries.

### Windows through WSL 2

Qubicl supports Windows 11 through WSL 2 and Docker Desktop, not through native
Windows execution. Keep Qubicl state on the WSL Linux filesystem; DrvFS and
Windows-backed 9P mounts are rejected even when mounted somewhere other than
`/mnt/c`. Enable Docker Desktop integration for the active distribution. See
the complete [WSL guide](wsl.md).

From PowerShell, confirm `wsl --list --verbose` reports version 2. From the
selected distribution, confirm `$WSL_DISTRO_NAME`, `cmd.exe /c echo interop-ok`,
`docker version`, and `qubicl doctor`. The `--client-host windows` adapter
prints a pinned `wsl.exe` launcher configuration but never edits the Windows
client's files.

## Offline setup fails

`--offline` performs local inspection only. It never pulls or builds an image. The error names the missing exact reference. Provide that exact image locally, or rerun without `--offline` when network retrieval/building is acceptable.

Partially downloaded Docker layers after an online failure are ordinary reusable cache; setup does not commit new defaults until both images and the bind-mount probe pass.

## An image contract or health check fails

Curated and custom images require matching manifest/OCI labels. Unknown contract versions, unknown capability shapes, mismatched startup profiles, or local content drift fail closed.

When running from a source checkout, rebuild stale local development images after pulling or switching revisions:

```sh
npm run images:build
qubicl setup
```

The rebuild command is development-only. It is not a recovery step for published or custom images.

```sh
qubicl inspect computer-name
qubicl logs computer-name
qubicl doctor
```

Derive custom images from the matching official/development base. Do not overwrite a mutable tag behind stored state; rerun setup or explicitly apply a newly validated identity.

## A computer is stopped or unhealthy

```sh
qubicl status computer-name
qubicl logs computer-name
qubicl restart computer-name
qubicl doctor
```

For an imported/moved home ownership warning, keep it stopped and run `qubicl repair ownership computer-name` before starting it.

## An all-computer upgrade is blocked or interrupted

Run `qubicl status` first. It reports bundled-catalog targets without applying
them and reports any pending recovery separately. `qubicl upgrade --all` blocks
before acquisition when a runtime inventory is partial, unstable, substituted,
or cannot be inspected exactly. Restore local Docker access and reconcile the
named container conflict; do not remove or rename containers by guesswork.

The preview's required-space number is a conservative image-acquisition bound.
Docker Engine/Desktop does not expose one portable remaining capacity value for
its image store or VM disk, so Qubicl labels available capacity unknown rather
than claiming host filesystem free space is usable by Docker.

After confirmation, all targets are acquired and inspected before mutation.
If a later gateway or computer step fails, the completed prefix is not rolled
back and the transaction journal remains. Fix the exact Docker/image/health
error and rerun the directed lifecycle command so Qubicl can roll forward from
immutable container/image bindings. Never delete `transaction.yaml`. A status
or cleanup/upgrade preview reads that journal without migrating, rewriting, or
recovering it.

Cleanup is similarly conservative. If `qubicl cleanup --orphans --images`
preserves an image or volume for manual review, that is expected: images are
shared across every state root using the Docker daemon, and volume names are
mutable. Qubicl does not run a global prune or infer exclusive ownership from
OCI labels. Inspect other installations and Docker references yourself before
performing any separate manual removal.

## Docker Desktop still shows UUID-style Qubicl names

The primary `~/.qubicl` installation should appear as one `qubicl` group containing exactly `gateway` plus one literal-name container per computer. Protocol-9 installations may temporarily show suffixed executor/session/web/egress/SSH sidecars until each computer is converted with `qubicl upgrade NAME`; the rolling conversion preserves its ID, token, settings, and durable `/home`, then removes its verified legacy containers, workspace network, and display volume. Docker Desktop's project list uses Compose service labels while its details view shows container names; both should use operator-facing names rather than UUID services. If an unrelated Docker container already owns `gateway` or a selected computer name, Qubicl refuses to replace it; rename or remove that unrelated container explicitly before retrying.

Explicit custom `QUBICL_HOME` installations intentionally keep UUID-scoped names so development/test environments can coexist without claiming the primary project's Docker resources.

## A viewer is unavailable

`file-system` intentionally has no desktop, viewer process, VNC ports, screenshot/clipboard tools, or view route. Create a `browser`, `computer`, or `workstation` computer when a display is required.

Viewer launch links are intentionally short-lived and single-use. If a copied
link reports an expired ticket before the viewer session is established, run
`qubicl view NAME` again instead of reusing or sharing the old URL.

## A GUI application closed during human takeover

Applications started with `exec_command` are ordinary lease-owned commands, even when they have a visible window. They are intentionally terminated on lease release, expiry, gateway restart, and human takeover.

For a workflow intended for handoff, use `open_desktop_application` on a `computer` or `workstation` contract and choose an application allowed by that preset. Workstation Writer accepts existing `.odt`, `.doc`, `.docx`, `.rtf`, or `.txt` files below `/home/qubicl`. The viewer states the policy before takeover and reports how many desktop-session applications were preserved and how many managed commands were stopped. After **Release control**, the agent must acquire a fresh lease before it can list, continue using, or close the preserved application.

## Human control remained active after the viewer closed

Human control follows the controlling VNC WebSocket and is released automatically if it does not reconnect within 10 seconds. If the browser or network left an unusual stale session, run `qubicl control release NAME`. Restarting a computer also reconciles gateway ownership before reporting success.

## A client cannot connect

Regenerate the snippet with `qubicl connect`, ensure Qubicl is running, and ensure local clients can find `qubicl` on `PATH`. Direct HTTP/OpenAPI clients need a token retrieved separately with `qubicl token show <name>`. Rotate it if exposure is possible.

For a Windows-hosted client connecting to Qubicl inside WSL 2, regenerate its
adapter from WSL with `qubicl connect <name> --client <client> --client-host
windows`. The generated configuration pins the active distribution plus the
absolute Node and Qubicl paths without a bearer token. A local adapter remains
correct when the client itself runs inside WSL.

For Open WebUI, regenerate the adapter with `qubicl connect <name> --client open-webui` and add it under **Admin Panel → Settings → Integrations → Open Terminal**. Docker Desktop installations should use the printed `host.docker.internal` URL; Open WebUI running directly on the host should use `127.0.0.1`. Confirm the advanced OpenAPI path is `/openapi.json`, authentication is Bearer, and the key is the separate output of `qubicl token show <name>`. Verification should identify the service as **Terminal**. A 404 usually means the Qubicl computer image predates the compatibility route and must be rebuilt/refreshed; a 401 means the token is wrong; `human_control_active` means the viewer currently owns the computer.

Qubicl exposes Open WebUI's managed process and ZIP-download compatibility, but
continues to report interactive terminal and notebook capabilities as disabled.
Process or archive limit errors are intentional and name the exceeded boundary;
split the work or download fewer/smaller paths rather than raising limits in a
running computer. Only two archive creations/transfers can be active for one
computer at once; wait for an existing download when `archive_busy` appears.
Human takeover or a policy change invalidates the compatibility lease and fences
its retained processes.

If a llama.cpp-backed model reports `Failed to initialize samplers: failed to parse grammar`, fetch the compatibility OpenAPI document and confirm model-facing `date-time` fields contain `format: date-time` without a generated regex `pattern`. Current Qubicl builds sanitize that presentation while retaining strict runtime validation.

## A root-installed package disappeared

That is expected after recreation. Only `/home` is durable. Put permanent system packages in a [custom image](custom-images.md).

## A command was interrupted

Ctrl-C exits 130. Before the setup journal exists, prior defaults are unchanged; Docker may retain cache. After journaling, state contains a recoverable target. Do not edit YAML. Preserve the state root, restore Docker if needed, and run the exact follow-up named by the error—normally `qubicl setup` or `qubicl up`—then `qubicl doctor`.

## Sharing diagnostics

Save a structured report locally when it helps:

```sh
qubicl doctor --json > qubicl-doctor.json
```

Review the doctor JSON before sharing it and include only the fields needed to
reproduce the failure. Qubicl does not upload reports automatically.

Remove bearer tokens, `secrets.yaml`, viewer tickets, private URLs/data, home contents, and unrelated host paths. Security reports use the private process in [SECURITY.md](../SECURITY.md), not a public issue.
