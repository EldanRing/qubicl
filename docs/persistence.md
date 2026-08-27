# Persistence and recovery

Qubicl has one durable computer boundary: the bind-mounted `/home`.

## What survives

| Data | Durable? | Notes |
| --- | --- | --- |
| Files under `/home` | Yes | Host path: `~/.qubicl/computers/<uuid>/home`. |
| Chromium profile | Yes | Cookies, site data, preferences, history, and sessions live under the computer's `/home`; the viewer identifies the profile as durable. |
| UUID, name, preset, capabilities, exact image identity, CPU, memory | Yes | State format 3 in protected host configuration. |
| External token/internal credentials | Until rotation/delete | Raw values exist only in mode-`0600` host state. |
| Runtime roots and system packages | No guarantee | Recreation discards them. Use a custom image. |
| `/tmp`, display state, managed processes | No | Runtime-only. |
| Compose, routes, networks, containers | No | Rebuilt from durable intent. |

Stop/start may make root changes appear durable because the same runtime containers remain. That is incidental. Recreation, image replacement, migration, or recovery may remove them without warning.

### Chromium profile lifecycle

The managed Chromium profile is fixed at
`/home/qubicl/.local/share/qubicl/browser-profile`. `browser_reset` is **Reset
tabs** only and deliberately retains it. Full-home upgrade, delete/restore,
backup/restore, checkpoint, and clone flows preserve or copy the profile with
the rest of `/home`; purge destroys it with the trashed home.

To clear only the managed profile, run `qubicl browser profile wipe COMPUTER`.
Qubicl stops a stable running computer before inventory, prints normalized
domains with stored cookies/site data without reading cookie values, lists
cookies, local storage, history, preferences, and sessions as removed, and
states that `/home/qubicl/Downloads` plus all other paths outside the profile
remain. It requires the exact computer name or `--yes`, refuses partial or
unstable runtime groups and substituted path components, and restores a
previously running computer after cancellation or success. Existing backups,
checkpoints, clones, recoverable trash, and external copies are unchanged and
may retain or restore prior profile data. There is no silent profile-exclusion
mode for full-home copies.

## Setup and exact defaults

`qubicl setup` stores the selected gateway and default computer identity: requested reference, resolved exact reference, local content ID, and capability-manifest digest. A later plain `qubicl create` uses that stored identity. Updating the CLI does not silently move existing computers or future defaults.

Rerunning setup can refresh the default for computers created later. Existing computer image, capabilities, resources, token, ID, home, and running/stopped state remain unchanged.

To intentionally move one existing computer to the latest image for its stored preset and recreate its disposable runtime, run:

```sh
qubicl upgrade research --offline
```

Omit `--offline` to allow Qubicl to obtain the catalog image. The operation preserves the computer ID, name, token, CPU/memory allocation, network and SSH settings, environment, route, and durable `/home`. It replaces the pinned image capability contract and recreates the non-durable runtime. Custom computers reuse their requested image reference, or may be moved explicitly with `--image`; `--preset` intentionally changes the capability preset. Upgrade is transactionally recoverable after interruption.

## Protected host state

The state root, runtime, backup, trash, computer, and home directories are real user-owned directories tightened to mode `0700`. Configuration, metadata, secrets, routes, Compose, and journals are mode `0600`. Setup rejects symlinked state paths and a root-owned/unwritable parent.

Do not hand-edit state or generated runtime files. Use `setup`, `config`, `export`, and `apply`.

## Home ownership

New homes are initialized for the current numeric host UID/GID. Normal startup never recursively scans or changes existing durable contents.

After importing a home or changing its host owner, stop the computer and explicitly run:

```sh
qubicl repair ownership research
```

The confirmed operation works only in that home through a network-isolated one-shot container, does not follow symlinks, and leaves a small idempotent repair journal if interrupted. Preserve unfamiliar data before changing metadata.

## Interrupted work

Setup, create, upgrade, rename, delete, restore, token rotation, configuration, and manifest application write `transaction.yaml` before crossing durable/runtime boundaries. The journal records the complete intended target. The next applicable command rolls it forward; `doctor` reports runtime work still waiting for Docker.

State v1/v2 migration first writes an exact checksummed backup of config/secrets under `backups/`, then uses `state-migration.yaml` for resumability. Migration preserves IDs, names, tokens, internal keys, homes, trash, resources, port, and legacy image strings. It does not inspect Docker, recreate containers, or start anything. Newer unsupported formats fail closed.

Do not delete a journal. Preserve the state root, fix the reported prerequisite, then rerun `qubicl setup` or `qubicl up` as directed.

## Delete, restore, purge

```sh
qubicl delete research
qubicl restore research
qubicl purge research --yes
```

Delete removes runtime access, invalidates the token, and moves the same UUID/home to trash. Restore moves it back and issues a new token. Purge is the only Qubicl command that permanently destroys a trashed home and cannot be undone by Qubicl.

## Backups

Use the first-class home-only backup workflow instead of copying a live home:

```sh
qubicl backup create research --quiesce
qubicl backup list research
qubicl backup verify BACKUP_ID
qubicl backup restore BACKUP_ID restored-research
qubicl backup prune research --keep 5 --yes
```

`--stopped` requires the source computer to be stopped. Optional `--encrypt --passphrase-file FILE` uses a local passphrase without persisting it in Qubicl state. Archives have checksummed manifests, explicit retention, and contain only the durable home—not runtime roots or credentials. Verification and restore copy the exact archive through a no-follow, size-bounded descriptor, validate its complete regular-file/directory/confined-link graph, repeat the metadata and byte identity checks during extraction, and no-follow walk the staged tree before promotion. Traversal, duplicate or canonically aliased paths, cycles, special or sparse entries, unsafe permissions, and over-budget metadata or expansion fail closed. Migration snapshots are not backups of computer homes, and secret-free `export` intentionally omits credentials and file contents. A separate private backup of the complete state root is still required for disaster recovery of computer identities, tokens, policies, SSH keys, and trash.
