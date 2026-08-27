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
