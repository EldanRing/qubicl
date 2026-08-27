# Custom computer images

Root filesystem changes are disposable. A derived image is the supported way to make system packages or machine-wide configuration permanent.

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
