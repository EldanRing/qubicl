# Daily-driver workflows

The `qubicl ...` commands below run in the host operator's terminal. Names such
as `publish_port` are agent tools used through a connected client. Lifecycle,
backup, and host configuration remain operator actions.

These workflows describe the 0.6 interface. The [design decision](decisions/0002-v0.6-capabilities-and-constraints.md)
and [constraint register](constraints.md) explain its remaining boundaries.

## Browser and document handoff

Create a browser-capable computer, [connect a client](clients.md), and run
`qubicl view NAME` to observe the same session. The browser profile survives
restart and handoff. **Reset tabs** closes tabs without signing out of sites;
the separate profile-wipe workflow below removes the stored profile.

For documents on `computer` or `workstation`, use the client's file tools to
create or upload files below `/home/qubicl`. Where supported by the preset,
`list_desktop_applications` returns running apps plus a bounded catalog of safe
built-ins and installed user/system desktop entries. Open an available
executable name with `open_desktop_application`. Managed applications and the
browser survive human takeover. Qubicl records launch identity and capacity;
programmatic close requires explicit acknowledgement that unsaved changes may
be lost.

Observe without taking control when the agent should continue using the GUI.
**Take control** fences queued and future GUI input. Retained tasks and services
continue, while lease-scoped session work stops. A disconnected controlling
viewer gets a visible 10-second reconnect grace by default; configure 5–300
seconds with `qubicl config set --viewer-reconnect-grace SECONDS`. **Release
control** lets the agent obtain fresh interactive ownership.

## Ports

Agents can discover only listeners owned by the computer user, then explicitly
publish one with `publish_port`. The returned owner URL is routed through the
existing localhost gateway on a publication-specific origin, supports ordinary
root paths, cookies, streams, and WebSocket upgrades, and remains available
while the app is listening. `share_preview` creates a separate expiring remote
credential; `revoke_preview_share` removes share access without closing owner
access. Explicit revocation or expiry closes the corresponding active
connections. The preview never binds the computer port directly to the host.

## Optional remote gateway

```sh
qubicl gateway status
qubicl gateway expose --bind 192.168.1.20 --port 8443 \
  --hostname qubicl.example.net --cert /secure/chain.pem \
  --key /secure/key.pem --allow-networks 192.168.1.0/24
qubicl gateway revoke
```

Remote access is off by default and uses a second TLS listener in the existing
gateway container. The expose/revoke preview preserves the loopback listener,
computer data, and prior running/stopped/absent state. All-interface binds and
allow-all CIDRs need independent safety flags. Qubicl does not manage DNS,
certificate issuance, firewalls, routers, or tunnels. Review
[Optional remote access](remote-access.md) before enabling it.

## Backup, checkpoint, clone

Backups are manual operator actions. There is no built-in backup schedule.

```sh
qubicl backup create research --quiesce
qubicl backup create research --stopped --encrypt --passphrase-file /secure/passphrase
qubicl backup list research
qubicl backup verify BACKUP_ID --passphrase-file /secure/passphrase
qubicl backup restore BACKUP_ID restored-research
qubicl checkpoint research
qubicl clone research research-copy
qubicl backup prune research --keep 5 --yes
```

Archives contain only the durable home, have SHA-256 manifests, mode-0600
storage, and optional scrypt/AES-256-GCM encryption. Verification and restore
use a checksum-bound private stream, validate the complete bounded file/link
graph, repeat that validation during extraction, and require the extracted tree
to match before promotion. Special files, sparse metadata, escaping or cyclic
links, duplicate/aliased paths, and over-budget archives fail closed. Archives
are not whole-container snapshots. Quiescing pauses the computer container for
archive creation and always attempts to resume it.

The Chromium profile is part of the durable home, so full-home backups,
checkpoints, restores, and clones include its cookies, site data, history,
preferences, and sessions. Resetting browser tabs does not erase that data. To
clear only the managed profile while preserving `/home/qubicl/Downloads` and
every other path outside it, review the domain-only inventory and exact scope,
then type the computer name at the prompt:

```sh
qubicl browser profile wipe research
```

Use `--yes` only after reviewing the same printed preview. Existing backups,
checkpoints, clones, trash, and external copies are not rewritten and can still
contain or later restore the old browser state.

For a stopped whole-installation move or disaster-recovery bundle, keep the
output outside the source state root and use mandatory encryption:

```sh
qubicl down
qubicl dashboard stop
qubicl installation export --output /secure/qubicl-installation.qbi \
  --passphrase-file /secure/passphrase
qubicl installation inspect /secure/qubicl-installation.qbi \
  --passphrase-file /secure/passphrase --target-root /new/qubicl-state
qubicl installation import /secure/qubicl-installation.qbi \
  --target-root /new/qubicl-state \
  --passphrase-file /secure/passphrase
QUBICL_HOME=/new/qubicl-state qubicl doctor
```

Import assigns a new installation ID, preserves computer IDs, client
credentials, homes, browser profiles, and SSH identities, disables the imported
dashboard and its remote exposure, starts nothing, and writes an import report.
The source installation and bundle remain unchanged.

## Tasks, terminals, and storage

Managed commands default to retained tasks that survive client disconnect and
human GUI takeover. Services are declared restartable; after runtime recreation
Qubicl restarts services only, retains ordinary task records and logs, and does
not replay arbitrary commands. Interactive terminals are bounded PTYs with
explicit geometry, reconnectable output, input, resize, signal, and close.

```sh
qubicl tasks show research
qubicl tasks set research --max-concurrent 24 --max-lifetime 604800 \
  --max-output 100000000 --retention 604800
qubicl tasks stop-all research
qubicl storage show research
qubicl storage set research --home-warning 30g --backup-warning 80g
```

Storage totals cover the durable home, caches, downloads, browser profile,
retained task output, audits, and attributed backups. Warning thresholds do not
pretend to reserve Docker Desktop VM or host filesystem capacity.

## Network and credentials

```sh
qubicl network set research web-only
qubicl network set research custom --allow-domains api.example.com,*.github.com
qubicl network set research custom --allow-cidrs 10.20.0.0/16 --allow-tcp-ports 5432
qubicl network explain research db.internal.example:5432
qubicl network approve research temporary.example --duration 1800
qubicl network revoke research temporary.example
qubicl network set research offline
```

`developer` is the default for new computers. Restricted profiles use one
private per-computer Docker network and the gateway's authenticated egress
service. Custom policy can authorize exact domains, CIDRs, and TCP ports;
temporary rules close the tunnels they authorized when they expire or are
revoked. `network explain` reports the effective route without making a request.
Changing the profile recreates disposable runtime roots but keeps `/home`.

Scoped broker entries bind one secret to an HTTPS base URL, path prefix,
methods, header, and optional expiry. Direct values arrive on stdin; safer
references use an environment variable, private host file, Linux Secret
Service (`secret-tool`), or macOS Keychain (`macos-keychain`). Only the gateway
egress service receives the resolved value.

`qubicl secret add research NAME --template openai` starts from a reviewed
provider template. `qubicl secret explain research NAME` reports destination,
methods, expiry, and provider kind without revealing the secret.

## SSH and editors

```sh
qubicl ssh enable research
qubicl ssh config research
qubicl ssh rotate research
qubicl ssh disable research
```

SSH is a loopback-only endpoint inside the computer container, key-only, with no
root/password login, and uses a private Ed25519 identity independent of MCP. Paste the printed host block
into OpenSSH configuration for VS Code or Cursor Remote SSH, JetBrains Gateway,
or Zed. Ordinary `ssh` and `scp` use the printed command directly. SSH sessions
are operator-owned and are not killed by an agent lease takeover.

## Devcontainers and Git

`qubicl devcontainer inspect DIR` explains the bounded import. `import` accepts
JSONC, paths relative to the configuration file, an image or a local Docker
build, harmless forwarded-port metadata, and guest `onCreateCommand`,
`updateContentCommand`, `postCreateCommand`, and `postStartCommand` hooks. Hooks
run inside the computer. It rejects Compose, devcontainer feature plugins,
privilege/capability changes, host mounts, host hooks, and variable-substituted
environment values. Offline import refuses implicit builds before contacting
Docker.

`qubicl git` clone/import/status/diff/patch/worktree/push operations execute Git
inside the computer, so repository hooks, filters, includes, fsmonitor,
textconv, alternate directories, and SSH command overrides cannot execute with
host authority. A narrowly scoped transport supplies only the selected remote
credential. `git push` still requires `--yes`; no agent-facing Qubicl tool
stores or publishes with host credentials.

## Lifecycle and local update review

```sh
qubicl status
qubicl upgrade research
qubicl upgrade --all
qubicl update check
qubicl config set --update-notifications on
```

`status` compares the stored curated gateway, default, and computer identities
with exact targets in the CLI's bundled catalog. Custom images are reported as
manual. `upgrade --all` prints one deterministic preview before confirmation:
current and exact image identities, runtime state, deduplicated acquisition
targets, expected compressed download and expanded bytes, and the required
space bound. Docker does not expose portable remaining image-store or VM
capacity, so Qubicl states that limit instead of inventing a free-space value.

Confirmation occurs before any acquisition. Qubicl then obtains and inspects
every exact target before the first state/runtime mutation and rolls forward in
gateway-then-computer order. Computer IDs, tokens, policies, resources, durable
homes, and running/stopped/absent state remain unchanged. A failure after the
first mutation leaves a recovery journal and reports the completed prefix; fix
the stated prerequisite and rerun a normal lifecycle command rather than
deleting the journal.

`qubicl recover status` is read-only and names every recognized migration,
state, backup, lifecycle, and upgrade journal, its phase, and the exact
roll-forward command. Recorded operations are not labelled cancellable when a
durable prefix may already have completed.

Local update notices are default off. Enabling them writes only a private local
preference. Eligible human-readable commands may then print one stderr notice
based on the bundled catalog; there is no telemetry, background task, network
check, pull, or automatic mutation. Use `off` to disable them again.
`qubicl update check` is a separate explicit, five-second bounded npm registry
lookup that compares the installed CLI, bundled catalog, and latest published
version and prints the exact preservation/interruption consequences. Add
`--offline` to skip that network request.

## Audit, doctor, cleanup

`qubicl audit show NAME` reads recent private JSONL metadata. Events use a
separately bounded metadata schema; malformed tool input cannot copy arbitrary
request content into the audit record. Stable-file compaction keeps the
bind-mounted stream bounded without disconnecting writers. Export and pruning
remain explicit; review private metadata before sharing it. `qubicl doctor` validates exact gateway/computer network topology
and reports labeled orphans. `qubicl cleanup --orphans [--images]` first prints
the exact immutable inventory and preservation reasons; adding `--yes` removes
only candidates that still match an immediate reinspection. Current, running,
attached, unrelated, or ambiguously owned resources are preserved, and a
partial Docker failure returns an error without hiding what was removed.
Daemon-global images can be shared by another Qubicl state root, and Docker
volumes have only mutable names, so both remain manual. `--images` can remove
only obsolete private image-contract cache records whose references have been
revalidated; it never performs a global or dangling-image prune.

`qubicl status NAME` reports the computer's single CPU, memory, and PID boundary.
Ordinary system tools in a container may still show host/VM-derived totals.
