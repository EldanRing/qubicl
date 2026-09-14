# Local management dashboard

The dashboard is part of Qubicl 0.6. Source and focused checks alone do not
constitute physical Linux, macOS, iPhone, or release acceptance evidence.

The [0.6 design](decisions/0002-v0.6-capabilities-and-constraints.md)
adds same-tab refresh continuity, risk-based reauthentication, encrypted backup
operations, named client credentials, and retained-task inspection. The
supported host footprint is unchanged.

## Enable and sign in

On native Linux x64 or Apple Silicon macOS, run Qubicl as the normal owner:

```sh
qubicl dashboard enable
qubicl dashboard open
```

Enable prompts for an administrator password in the local terminal. Use at
least 15 characters; passwords never belong in command arguments or URLs.
The helper uses a systemd user service on Linux or a LaunchAgent on macOS.
It starts at user login, never starts Docker, and does not enable lingering or
pre-login operation. Use `qubicl dashboard enable --foreground` or
`qubicl dashboard serve` where a login service is unavailable.

Open `http://qubicl-admin.localhost:3212`. That exact hostname must resolve only
to `127.0.0.1` and/or `::1`; configure a local hosts mapping yourself if your
resolver does not support it. Qubicl does not edit DNS or fall back to a shared
gateway hostname. `--port` and `--asset-port` change the default 3212 and 3213
ports during first enable. Keep them distinct from gateway and remote ports.

Before core setup, enable creates only protected dashboard state and a
provisional installation identity. Web setup adopts that identity, reviews
preset/resources/image acquisition, and optionally creates the first computer.
Closing a setup preview leaves core state uninitialized. Existing installations
require an explicitly approved, backed-up migration to state format 5.

## Management

The interface provides status, controller and client attribution, computer creation and
lifecycle, resources and embedded-catalog updates, recoverable deletion and
restore, tools and skills, network policy, scoped credentials, named client
credentials, process/task inspection, encrypted home backups,
diagnostics, operations, settings, and browser sessions. Computer process views
contain managed identifiers and lifecycle metadata; commands, working
directories, terminal output, and file contents are not exposed. Published
previews and desktop viewers open in separate tabs with bounded access tickets.

Mutations use a five-minute plan bound to the authenticated session and the
current state/runtime. Routine saves apply directly. Destructive, interrupting,
or authority-expanding actions receive a review plan; disruptive operations
require interruption confirmation. Security-sensitive changes require password
reauthentication only after the bounded reauthentication grace. A changed
runtime or journal invalidates the plan. One
installation mutation runs at a time. Browser disconnects do not cancel accepted
work; reconnect to Operations to inspect its durable receipt. The helper never
blindly replays an interrupted request.

Expired plans discard their retained inputs even when no further browser
requests arrive. Plans rejected because their reviewed state is stale also
discard their inputs; prepare a fresh plan before retrying.

Interrupted start, stop and restart operations retain a private lifecycle
journal. `qubicl recover --yes` or the dashboard recovery action resumes only
validated runtime identities; unrelated mutations stay blocked until recovery
finishes. Upgrade recovery also checks the originally reviewed container IDs.

Dashboard diagnostics cover durable state checks. Use `qubicl doctor` on the
host for the more detailed runtime, image, route and security checks.

Updates show gateway/computer changes and dashboard image drift separately.
The dashboard image action or `qubicl dashboard restart` adopts the exact
dashboard image bundled with the installed CLI. It does not update the host
CLI itself; install a newer CLI separately before reviewing its image catalog.

Credential add/replace forms accept a new value and its HTTPS destination,
path, methods, and header. Values and computer tokens cannot be retrieved from
the dashboard. After rotating a computer token, use the host CLI to generate
new client connection instructions. Git skill imports require a credential-free
HTTPS URL and an exact 40-character commit. Local paths, archive uploads,
general shell commands, and public publication are outside the management API.

Backups are manual durable-home archives. They may contain browser cookies,
logged-in sessions, credentials and personal data. The dashboard can create,
verify, and restore passphrase-encrypted backups; the passphrase exists only in
memory for the accepted operation and is omitted from receipts and history.
Unencrypted choices state their exposure. Quiesced capture
temporarily pauses verified runtime containers; stopped capture requires an
already stopped computer. Restore creates a new computer. Retention previews
identify exact archives for the immutable source computer, and pruning is
permanent. There is no scheduled backup. Full-installation export/import is a
stopped, mandatory-encryption host CLI workflow because it includes
administrator and computer secrets.

## Private remote administration

Remote administration is optional direct HTTPS on an exact private host
interface. Supply a certificate containing only the exact administrator DNS
name and its owner-only private key on the host. Additional DNS, IP address,
URI, or email subject alternative names are rejected:

```sh
qubicl dashboard expose --bind 192.168.1.10 --hostname admin.example.test \
  --port 3214 --allow-networks 192.168.1.0/24 \
  --cert /absolute/path/admin.crt --key /absolute/path/admin.key
```

The browser must trust this certificate and resolve the name to the chosen
interface. LAN and Tailscale private addresses are supported by the listener
policy; actual host/network acceptance remains necessary. There is no public
mode, reverse-proxy trust, automatic certificate provisioning, or cloud account.

Remote desktop/preview access uses separately configured gateway TLS. The
administrator and gateway require different DNS identities and private keys;
a gateway wildcard certificate must not cover the administrator name. A port
difference alone does not isolate browser cookies. The helper checks TLS
identity, validity, binding and gateway overlap during operation and closes
remote administration on invalid configuration. Remote administration also
fails closed when its trusted frontend is unavailable. Workload and gateway
containers do not receive administrator cookies, passwords, or TLS material.

```sh
qubicl dashboard revoke              # Close remote administration
qubicl gateway revoke                # Separately revoke remote agent/viewer access
qubicl dashboard sessions revoke-all # Revoke all administrator browser sessions
qubicl dashboard password reset      # Local terminal password replacement
```

Local HTTP authentication uses an explicit token held in same-tab
`sessionStorage`, never a cookie or URL. A same-tab refresh keeps the session;
closing the tab or signing out clears it. This prevents another service on a
loopback port from receiving an ambient administrator cookie. Remote HTTPS uses
HttpOnly Secure cookies.
Sessions expire after 30 minutes without user activity or 12 hours absolutely.
Polling and event streaming do not extend the idle timeout. Browser session
lists are specific to the administrator listener being used. Password reset
and host `sessions revoke-all` invalidate sessions on every listener.

## Recovery and shutdown

The host helper serves a small authenticated local recovery page when Docker,
the gateway, or frontend assets are unavailable. Start Docker yourself when
needed; then review gateway start, dashboard restart, or recorded recovery.
Recovery respects exact container identities and the existing journals. The
host equivalent is `qubicl recover` (or reviewed non-interactive `--yes`).
Backup recovery retains its journal if the exact containers remain unsafe or
inconsistent after unpause. It does not start a coherently stopped computer.
Unjournaled interrupted results remain explicitly unconfirmed and require a
fresh review; successful recovery is not a claim that the original request
completed every intended effect.

`qubicl down` records the frontend as stopped. Login recovery honors that
intent. `qubicl dashboard stop` stops the frontend and helper;
`qubicl dashboard disable` also removes login startup. `start`/`restart` verify
the configured dashboard image before using it. Source development requires a
locally built dashboard image; releases use the exact embedded catalog and
never perform online host-version checks or host self-updates.

For complete host loss, use the host CLI's encrypted `installation export`,
`inspect`, and `import` workflow. Import uses a new target and installation ID,
retains computer identities, credentials, homes, browser profiles, and SSH
identity, removes imported dashboard remote exposure, disables the dashboard,
and starts nothing. Review the generated import report before enabling services.
Home backup restore alone does not recreate host settings or client credentials.
See [persistence](persistence.md).

## Interface and development

The interface uses Qubicl's paper/ink/lime visual palette and existing green
mark, with system light/dark mode and an override. It adapts to narrow phone
viewports and keyboard navigation. It does not modify or reproduce the public
website. Real iPhone/Safari acceptance is a release requirement.

`packages/dashboard` builds static browser assets and a minimal asset server.
The `qubicl.dashboard` Compose service uses a dedicated bridge shared with no
other Qubicl service, and its loopback-only port carries static assets. Docker
does not publish host ports for containers attached only to an internal network,
so this bridge permits ordinary container egress. The sidecar has no mounts,
credentials or Docker socket, and the native helper verifies the catalog's
manifest digest and each asset's path, content type, size and digest before
serving it with its own security headers. Image catalog schema 2 includes this
sixth image. See the
[architecture decision](decisions/0001-host-owned-dashboard.md).
