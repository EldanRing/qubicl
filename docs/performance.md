# Local performance measurements

Performance checks run only on the current maintainer-controlled host and upload nothing.

```sh
npm run performance
```

The default command builds source, dry-runs the npm package, samples CLI
help/version latency and peak RSS, and inspects available local image metadata.
It reports measurements without enforcing fixed package/image sizes or
machine-dependent latency/RSS thresholds. Missing images are reported rather
than pulled or built. This command is optional and is not part of `check` or
`release:check`. Use `--no-build` when the existing artifacts match your source.

For preset recommendations, run one explicit container session and wait for it to finish:

```sh
npm run performance -- --runtime --output "$HOME/qubicl-performance.json"
```

Runtime mode starts the four exact local preset images with their recommended CPU/memory/PID/shared-memory limits and `--pull never`. It measures health startup, runs the representative shell/browser/desktop/development/office workload, waits one shared 60-second idle interval, samples CPU/memory/PIDs once, then removes its containers and temporary homes. It does not publish or contact a benchmark service.

Compare reports from equivalent artifacts, hardware, and cache conditions.
Investigate meaningful regressions against a selected baseline instead of
raising arbitrary ceilings until a run passes. Package size includes runtime
assets, skill baselines, and license/SBOM material; it is not just JavaScript.

Runtime mode still fails when a command, health check, or representative
workload fails. Normal product startup timeouts and resource limits continue to
apply; removing benchmark quotas does not hide a failed workload.
Reports use schema 3 and contain raw measurements without the former `budgets`
array. Historical schema-2 reports retain their original data.

Use `--binary PATH` to sample an already-built native candidate and `--json` for machine-readable stdout. Reports include only revision/dirty state, tool/platform versions, and measurements—never username, hostname, home path, IP, or credentials.

Multi-computer scaling and cold/warm hardware comparisons remain separate local acceptance records because they require an isolated host and controlled cache state.

Complete image candidates from v0.2 onward also carry `oci-efficiency.json`. That immutable report compares both
architectures across all six exact OCI archives. It records compressed and
expanded layer sharing and a bounded normalized package inventory derived from
each platform's embedded SPDX attestation. Candidate verification regenerates the
report, so package/layer optimization decisions can be reviewed against the
same bytes that would be published.

## Historical v0.2 image audit

The 2026-08-27 local audit built all five OCI archives for `linux/amd64` and
`linux/arm64`, then changed only the workstation's LibreOffice package
selection. Installing Writer, Calc, and Impress directly retains every office
application Qubicl exposes while omitting the unused Base UI and drivers, Math,
report builder, and Python-UNO integration.

| Platform | OCI download content | Expanded layer content | SPDX package identities |
| --- | ---: | ---: | ---: |
| amd64 | 864,846,153 → 857,318,928 bytes (-0.87%) | 2,405,104,128 → 2,382,855,680 bytes (-0.93%) | 871 → 862 |
| arm64 | 849,017,285 → 841,719,019 bytes (-0.86%) | 2,418,248,704 → 2,395,713,536 bytes (-0.93%) | 869 → 860 |

The audit retained Chromium/X11/VNC, desktop tools, document inspection,
development compilers, network diagnostics, and skill runtimes because each is
part of a supported preset capability or acceptance workload. Bypassing Debian
package dependencies for smaller incidental savings was rejected as a larger
compatibility and maintenance risk. These measurements document the controlled
source decision; the release candidate must regenerate the report from its own
post-freeze bytes.
