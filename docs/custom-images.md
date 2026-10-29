# Custom computer images

User-installed Python/npm tools persist in the home. System packages need an
image; common apt additions now have a managed recipe, so you do not need to
write a Dockerfile for them.

## Install everyday software

Inside the computer, use ordinary commands:

```sh
python -m pip install requests
npm install --global typescript
```

The default Python environment is under
`~/.local/share/qubicl/python/current`; npm installs under `~/.local`. Their
executables are on the workload PATH. Normal recreation, upgrades, and home
backups retain them. Python environments are separated by interpreter major/minor
version. If an image changes that ABI, Qubicl creates a fresh environment, keeps
the old one, and reports that its packages need reinstalling. Startup makes no
network requests. Project-specific virtualenvs remain available as usual.

For system packages, run this on the host that owns the computer:

```sh
qubicl software research --apt ripgrep,jq
qubicl software research --remove jq
qubicl software research --refresh
qubicl software research
qubicl upgrade research
qubicl upgrade --all
```

The first command adds to a saved package list, builds a derived image from the
inspected base, validates its Qubicl contract, and replaces the runtime through
the existing upgrade transaction. It preserves the home, ID, credentials,
resources, policy, and running/stopped state. Named upgrades reapply the saved
list to the current catalog base. Bulk upgrades also include managed recipes,
prepare every needed derived image before runtime changes, and retain exact
prepared image identities for interrupted-upgrade recovery. On a named upgrade,
a custom base follows its requested image reference. `--image` or `--preset` on a named upgrade intentionally rebases the
recipe. `--remove` removes selected packages from the saved list and rebuilds
from the base; removing the final package returns to that base. A package built
into the base is unaffected by recipe removal. Adding a different version of an
already saved package replaces its pin. `software --reset` returns to the base
while preserving the home.

`--offline` requires the matching derived image to already exist locally and
never downloads or builds packages. The command is for compatible Debian apt
bases with Qubicl's root entrypoint; it grants no guest sudo or host Docker
access. Package repository access happens during the operator's image build,
not through the running guest's egress policy. Package names may include exact
versions; otherwise current repository versions are used and build caching may
retain an earlier successful install. Use `--refresh` to bypass that cache and
rerun apt against the recorded package list; it cannot combine with `--offline`.
Refresh does not discard explicit version pins. This is a setup recipe, not a
lockfile.

Recipe computers retain their base identity as well as their derived image.
`upgrade --all` advances recipes based on curated presets to the current catalog
base. Recipes based on a custom image keep their recorded base; choose a new base
with a named upgrade. Custom images without recipes remain operator-managed.
Bulk-upgrade previews list package builds separately from base-image downloads;
package download size and build workspace are not included in catalog estimates.
Recovery reuses prepared image bytes and fails if they were removed or changed.

## Move a software recipe to another host

```sh
qubicl export --output computers.yaml
# On the destination, after ordinary Qubicl setup:
qubicl apply computers.yaml --dry-run
qubicl apply computers.yaml
```

Exports include the package list and recorded base. Apply prints its recipe,
base, and download/build plan before acquisition, then builds against that base
instead of trying to pull the source host's locally derived tag. Existing named
computers keep their IDs and homes; new computers get new identities and empty
homes. Apply retains its existing behavior of starting declared computers.
Use `--offline` to require cached base and recipe images without downloading or
building; an uncached recipe fails before state/runtime replacement. The preview
is read-only and does not contact Docker or recover pending operations.

Recipe-bearing configuration, manifests, and pending software upgrades require
the new CLI; older strict readers reject the new fields. Existing manifests
without recipes remain supported. Manifests do not include credentials, home
contents, or image archives. Full-installation backups retain recipes and homes
but do not bundle Docker images. A custom base must be available on the
receiving host or from its registry; a recipe cannot recreate a missing base.
Package availability can change unless versions are pinned. Use a Dockerfile
for more complex setup.

## Choose a compatibility baseline

Derive from the smallest preset that supplies the required interface:

```dockerfile
# Source-development example; supported releases use exact published digests.
FROM qubicl/file-system:dev

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ripgrep \
    && rm -rf /var/lib/apt/lists/*
```

Development bases are:

| Compatibility | Base |
| --- | --- |
| `file-system` | `qubicl/file-system:dev` |
| `browser` | `qubicl/browser:dev` |
| `computer` | `qubicl/desktop:dev` |
| `workstation` | `qubicl/workstation:dev` |

Build and validate through Qubicl:

```sh
qubicl image build qubicl/research:dev ./my-image
qubicl create research --image qubicl/research:dev
```

Or make it the exact default for computers created later:

```sh
qubicl setup --image qubicl/research:dev
# Advanced non-wizard equivalent:
qubicl config set --default-image qubicl/research:dev
```

Setup warns that trusted custom-image startup code can access its assigned durable home. Runtime egress then follows the computer's selected network policy.

## Capability contract

A compatible image retains `/opt/qubicl/computer-manifest.json`, the matching `dev.qubicl.*` OCI labels, entrypoint, control service, expected ports, `/home` mount, and startup profile inherited from its base. Qubicl records the user-facing preset as `custom` and the inherited curated compatibility baseline. Missing, unknown, or mismatched contracts fail closed.

Do not claim capabilities that the image does not implement. Contract version 1 permits only the documented curated capability shapes; deriving unchanged from a matching Qubicl image is the safest path. The baselines are progressive: `file-system` has no Playwright/display/document bundle, `browser` adds Openbox/Chromium/OCR and small PDF helpers, `computer` adds minimal XFCE/full document helpers/managed SSH support, and `workstation` adds the compiler and office layers. The compatible skill catalog is present in each baseline, while initial skill activation remains an operator policy rather than an image capability.

Qubicl-generated runtime configuration will not grant a Docker socket, host mounts, privileged mode, devices, host namespaces, host networking, or extra capabilities.

## Change an existing computer

Use the explicit upgrade boundary to validate a new image and recreate only that computer's disposable runtime:

```sh
qubicl upgrade research --image qubicl/research:dev
```

Changing an image recreates the disposable computer container. The immutable ID, token, operator settings, and mounted home remain; root filesystem changes do not.

For reviewed multi-computer reconciliation, export a secret-free manifest, replace the intended image-identity/contract fields, run `qubicl apply FILE --dry-run`, and then apply it. Manifest application never embeds credentials or home contents.

Use immutable digests when exact bytes matter. Qubicl's development images intentionally resolve Debian packages at build time and are not byte-reproducible release artifacts.
