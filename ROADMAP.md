# Qubicl roadmap

Qubicl is a public, pre-1.0 project intended for real local use, while
interfaces and the state format may still evolve. The roadmap
below describes product direction rather than a promise of dates or a hidden
release checklist.

## Qubicl 0.7 — in development

The current published release is 0.6.1. The unreleased
[0.7 design](docs/decisions/0004-practical-computers-and-releases.md) focuses on
ordinary computer use and simpler maintenance:

- Durable Python/npm installations and managed apt recipes with removal,
  refresh, bulk upgrades, and portable export/apply.
- Reliable gateway reconnection for retained stopped and running computers.
- User-installed desktop executables and SSH client connections.
- Runtime image reuse based on actual inputs, per-image scan refresh, and
  signed qualification with explicit results and limitations.
- Focused offline source checks and optional coverage/performance measurements.

These capabilities are implemented in the development branch. Release
qualification and publication remain separate work. The
[constraint register](docs/constraints.md) records retained limits and their
reasons; it is not a hidden release checklist.

## Toward 1.0

- Stabilize the CLI, state format, capability contracts, and client adapters.
- Expand platform support when real host evidence supports the claim.
- Expand repeatable compatibility coverage for MCP, OpenAPI, Open WebUI,
  Codex, Claude, Cursor, VS Code, and other supported clients.
- Continue hardening lifecycle recovery, filesystem boundaries, browser and
  desktop control, human takeover, egress policy, and release integrity.
- Publish a supported-release policy grounded in actual platform/client results,
  disclosed gaps, and exact-artifact security evidence.

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
