# Support

Qubicl `0.1.x` is an initial public release series. Fixes and support are
best-effort while interfaces and state formats settle before 1.0.

## Platform status for 0.1

| Component | Supported range |
| --- | --- |
| Directly validated host | Linux x64 with glibc 2.28 or newer |
| Best-effort hosts | Linux ARM64; macOS 13+ on Intel or Apple silicon |
| Container runtime | Docker Engine 24.0 or newer, or Docker Desktop 4.29 or newer |
| Compose | Docker Compose 2.24 or newer through `docker compose` |
| npm CLI | Node.js `^22.14.0 || ^24.0.0` |
| Native CLI | Version-matched Qubicl binary; no host Node.js required |

Windows, musl-only Linux distributions, 32-bit systems, remote Docker contexts, Podman, and alternative Compose implementations are outside the 1.0 support contract. Newer major Node.js lines remain unsupported until the package engine range and local release matrix include them.

Best-effort targets are supported by the product contract and release images,
but absence of maintainer-controlled hardware does not block a pre-1.0 release.
Platform-specific defects may take longer to reproduce and fix.

## Getting help

Read [Troubleshooting](docs/troubleshooting.md) and run `qubicl doctor`. For a reproducible non-security bug, use the repository bug template after the project opens publicly.

Include the Qubicl revision, host OS and architecture, Node version when using npm, Docker version, `docker compose version`, the failing command, and redacted diagnostics. Never post tokens, `secrets.yaml`, private viewer URLs, or unredacted `~/.qubicl` contents.

Report security problems privately as described in [SECURITY.md](SECURITY.md).
