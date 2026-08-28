# Local performance contract

Performance checks run only on the current maintainer-controlled host and upload nothing.

```sh
npm run performance
```

The baseline builds source, dry-runs the npm package, samples CLI help/version latency and peak RSS, inspects the exact local gateway plus all four preset images, and enforces initial size budgets. It uses `docker image inspect` only; missing images are reported rather than pulled/built.

For preset recommendations, run one explicit container session and wait for it to finish:

```sh
npm run performance -- --runtime --output "$HOME/qubicl-performance.json"
```

Runtime mode starts the four exact local preset images with their recommended CPU/memory/PID/shared-memory limits and `--pull never`. It measures health startup, runs the representative shell/browser/desktop/development/office workload, waits one shared 60-second idle interval, samples CPU/memory/PIDs once, then removes its containers and temporary homes. It does not publish or contact a benchmark service.

Current guardrails:

The npm package deliberately includes the six verified Qubicl core-skill baselines,
runtime build assets, and legal/SBOM material needed for source-local operation;
the packed-package budget therefore measures more than the JavaScript CLI
bundle. Container layers are measured separately below.

| Artifact | Maximum |
| --- | ---: |
| npm package | 7 MB packed |
| CLI help p95 | 125 ms |
| CLI help peak RSS | 96 MiB |
| gateway image | 65 MB expanded platform content |
| file-system image | 205 MB |
| browser image | 625 MB |
| computer image | 675 MB |
| workstation image | 925 MB |

Each preset also must become healthy inside its catalog startup budget and complete its workload without OOM/PID exhaustion. These are regression guardrails, not cross-machine marketing promises. Recommendations are raised if real acceptance lacks reasonable headroom; they are not lowered to improve appearance.

Use `--binary PATH` to sample an already-built native candidate and `--json` for machine-readable stdout. Reports include only revision/dirty state, tool/platform versions, and measurements—never username, hostname, home path, IP, or credentials.

Multi-computer scaling and cold/warm hardware comparisons remain separate local acceptance records because they require an isolated host and controlled cache state.

Complete v0.2 image candidates also carry `oci-efficiency.json`. Unlike the
local expanded-size guardrails above, that immutable report compares both
architectures across all five exact OCI archives. It records compressed and
expanded layer sharing and a bounded normalized package inventory derived from
each platform's embedded SPDX attestation. Candidate verification regenerates the
report, so package/layer optimization decisions can be reviewed against the
same bytes that would be published.

## v0.2 image audit

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
