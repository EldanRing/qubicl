# Qubicl roadmap

Qubicl is a public, pre-1.0 project intended for real local use, while
interfaces and the state format may still evolve. The roadmap
below describes product direction rather than a promise of dates or a hidden
release checklist.

## Qubicl 0.6

The [0.6 design](docs/decisions/0002-v0.6-capabilities-and-constraints.md)
is implemented in the source tree. It provides persistent ordinary browsing,
installed-app support, retained tasks independent of GUI ownership, isolated
previews, scoped HTTP/TCP networking, recoverable installation migration, and
simpler dashboard flows. Release impact metadata binds the exact source range
to its required artifacts and evidence; candidate qualification is pending.

The [constraint register](docs/constraints.md) records what is retained,
replaced, or deferred and why. This work keeps the existing platform footprint,
manual backups, and operator-managed remote DNS/certificates. It does not claim
that 0.6 has been qualified or published.

## Toward 1.0

- Stabilize the CLI, state format, capability contracts, and client adapters.
- Complete the maintained Linux ARM64 and macOS hardware matrices.
- Expand repeatable compatibility coverage for MCP, OpenAPI, Open WebUI,
  Codex, Claude, Cursor, VS Code, and other supported clients.
- Continue hardening lifecycle recovery, filesystem boundaries, browser and
  desktop control, human takeover, egress policy, and release integrity.
- Publish a supported-release policy with complete platform, client, security,
  and exact-candidate vulnerability evidence.

## Product direction

- Continue improving the local dashboard's observability, recovery, and
  administrative workflows while keeping the CLI as the source of truth.
- More portable templates and devcontainer workflows while keeping Qubicl's
  capability manifests authoritative.
- Richer browser diagnostics and artifact workflows in the persistent managed
  Chromium session, with anonymous public extraction isolated from its logins.
- Safer, more convenient network and credential policies that preserve local,
  account-free operation.
- Additional runtime and platform compatibility where it can preserve Qubicl's
  persistence, isolation, and human-handoff contracts.

Qubicl is deliberately not becoming a model host, hosted agent service,
multi-agent orchestrator, or Kubernetes platform. See the
[architecture](docs/architecture.md), [security model](docs/security-model.md),
and [release process](RELEASING.md) for the maintained contracts.
