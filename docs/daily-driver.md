# Daily-driver workflows

All commands below are host-side operator actions. None is exposed as an agent
lifecycle tool, and destructive or remote mutations require explicit flags.

## Ports

Agents can discover only listeners owned by the computer user, then explicitly
publish one with `publish_port`. The returned unguessable URL is routed through
the existing localhost gateway, supports HTTP and WebSocket upgrades, expires,
and is revoked on lease loss. If the operator has configured an isolated remote
preview domain, the tool adds a `remoteUrl` while retaining the existing local
`url`; it never binds a computer port to the host.

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

## Network and credentials

```sh
qubicl network set research web-only
qubicl network set research custom --allow-domains api.example.com,*.github.com
qubicl network approve research temporary.example --duration 1800
qubicl network revoke research temporary.example
qubicl network set research offline
```

`developer` is unrestricted. Restricted profiles use one private per-computer
Docker network and the gateway's authenticated egress service; they block private/loopback/link-local
destinations. Changing the profile recreates disposable runtime roots but keeps
`/home`.

Scoped broker entries bind one secret to an HTTPS base URL, path prefix,
methods, header, and optional expiry. Direct values arrive on stdin; safer
references use an environment variable, private host file, Linux Secret
Service (`secret-tool`), or macOS Keychain (`macos-keychain`). Only the gateway
egress service receives the resolved value.

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
an image or local Docker build only when the result already passes Qubicl's
manifest contract. It refuses Compose, privilege/capability changes, host
mounts, forwarded ports, lifecycle hooks, features, and variable-substituted
environment values.

Host-mediated `qubicl git` clone/import/status/diff/patch/worktree workflows
operate only inside one durable home. HTTPS credential helpers, `gh`/`glab`, or
the SSH agent remain on the host. `git push` requires `--yes`; no agent-facing
Qubicl tool stores or publishes with those credentials.

## Lifecycle and local update review

```sh
qubicl status
qubicl upgrade research
qubicl upgrade --all
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

Local update notices are default off. Enabling them writes only a private local
preference. Eligible human-readable commands may then print one stderr notice
based on the bundled catalog; there is no telemetry, background task, network
check, pull, or automatic mutation. Use `off` to disable them again.

## Audit, doctor, cleanup

`qubicl audit show NAME` reads recent private JSONL metadata. Export and pruning
are explicit. Command text, file content, request bodies, and secret values are
not recorded. `qubicl doctor` validates exact gateway/computer network topology
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
