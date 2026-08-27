# Daily-driver workflows

All commands below are host-side operator actions. None is exposed as an agent
lifecycle tool, and destructive or remote mutations require explicit flags.

## Ports

Agents can discover only listeners owned by the computer user, then explicitly
publish one with `publish_port`. The returned unguessable URL is routed through
the existing localhost gateway, supports HTTP and WebSocket upgrades, expires,
and is revoked on lease loss. There is no LAN mode; refusing non-loopback
publication is stricter than accepting an ambiguous bind.

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
storage, safe extraction checks, and optional scrypt/AES-256-GCM encryption.
They are not whole-container snapshots. Quiescing pauses the computer
container for archive creation and always attempts to resume it.

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

## Audit, doctor, cleanup

`qubicl audit show NAME` reads recent private JSONL metadata. Export and pruning
are explicit. Command text, file content, request bodies, and secret values are
not recorded. `qubicl doctor` validates exact gateway/computer network topology
and reports labeled orphans. Only `qubicl cleanup --orphans --yes` removes those
reviewed resources; `--images` separately asks Docker to remove dangling
Qubicl-contract images while preserving referenced layers.

`qubicl status NAME` reports the computer's single CPU, memory, and PID boundary.
Ordinary system tools in a container may still show host/VM-derived totals.
