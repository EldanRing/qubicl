# Support

Qubicl `0.5.x` is a public pre-1.0 release series. Interfaces and state formats
may still evolve before 1.0.

## Platform status for 0.5

| Component | Supported range |
| --- | --- |
| Supported host policy | Linux x64; Apple Silicon macOS; Windows 11 x64 through Ubuntu 24.04 on WSL 2 |
| Historical v0.1.0 directly tested baselines | Linux x64; Apple Silicon macOS; Windows 11 x64 through Ubuntu 24.04 on WSL 2 |
| v0.5 initial release evidence | Linux x64 general platform acceptance; dashboard-specific native Linux x64 and Apple Silicon macOS; physical iPhone Safari |
| Best-effort hosts | Linux ARM64; Intel macOS; Windows on ARM through WSL 2; other current WSL 2 distributions |
| Container runtime | Docker Engine 24.0 or newer, or Docker Desktop 4.29 or newer |
| Compose | Docker Compose 2.24 or newer through `docker compose` |
| npm CLI | Node.js `^22.14.0 || ^24.0.0` |
| Native CLI | Version-matched Qubicl binary; no host Node.js required |

Native Windows, WSL 1, musl-only Linux distributions, 32-bit systems, remote
Docker contexts, Podman, and alternative Compose implementations are outside
the current support contract. Newer major Node.js lines remain unsupported
until the package engine range and local release matrix include them.

Best-effort targets have compatible release artifacts or documented paths, but
do not carry a directly tested claim. Platform-specific defects may take longer
to reproduce and fix. The v0.1.0 baseline labels do not claim that the current
v0.5 candidate repeated general macOS or Windows/WSL acceptance. Its macOS and
iPhone evidence is limited to the dashboard-specific rows. The versioned
[platform matrix](conformance/platform-support-v1.json) is authoritative.

## Getting help

Read [Troubleshooting](docs/troubleshooting.md) and run `qubicl doctor`. For a reproducible non-security bug, use the repository bug template after the project opens publicly.

Include the Qubicl revision, host OS and architecture, Node version when using npm, Docker version, `docker compose version`, the failing command, and redacted diagnostics. Never post tokens, `secrets.yaml`, private viewer URLs, or unredacted `~/.qubicl` contents.

Report security problems privately as described in [SECURITY.md](SECURITY.md).
