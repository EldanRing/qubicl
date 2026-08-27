# Qubicl roadmap

Qubicl `0.1.x` is the first public, pre-1.0 series. It is intended for real
local use, while interfaces and the state format may still evolve. The roadmap
below describes product direction rather than a promise of dates or a hidden
release checklist.

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

- Better local observability for computers, leases, resources, audits, and
  published previews without replacing the CLI as the source of truth.
- More portable templates and devcontainer workflows while keeping Qubicl's
  capability manifests authoritative.
- Richer browser diagnostics and artifact workflows using the existing managed
  Chromium session rather than a second browser stack.
- Safer, more convenient network and credential policies that preserve local,
  account-free operation.
- Additional runtime and platform compatibility where it can preserve Qubicl's
  persistence, isolation, and human-handoff contracts.

Qubicl is deliberately not becoming a model host, hosted agent service,
multi-agent orchestrator, or Kubernetes platform. See the
[architecture](docs/architecture.md), [security model](docs/security-model.md),
and [release process](RELEASING.md) for the maintained contracts.
