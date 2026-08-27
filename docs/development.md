# Development and local testing

All development, tests, scans, and candidate assembly run on maintainer-controlled local machines. Qubicl uses no GitHub Actions, repository runners, paid CI, telemetry, or hosted build service.

## Workspace setup

Install a supported Node/npm and local Docker Engine/Desktop with Compose, then:

```sh
npm ci
npm run build
npm run test:unit
npm run check
```

The repository pins npm 10.9.3 through `packageManager`/`devEngines`. `.nvmrc` pins normal Node development; release validation separately covers minimum Node 22 and Node 24 targets.

`npm run check` performs strict TypeScript, Oxlint, unit/integration tests with coverage floors, and a high-severity npm audit. `npm run performance` checks package/CLI/all-five-image size budgets; add `-- --runtime` for one controlled four-preset startup/workload/60-second-idle run.

Run `npm run tokens:audit` to print exact compact tool-definition bytes for every preset and static profile. The command fails if the lease-transparent full `workstation` catalog reaches the 26,000-byte regression ceiling, including skills and native web research. Set `QUBICL_TOKEN_METRICS=1` on a control service or stdio bridge to log size-only per-tool result/catalog events to stderr without logging tool arguments or result content.

The pinned Python closure for the local web service is in `images/computer/web-requirements.txt`, including Trafilatura and the readability-lxml fallback. The smaller permissive browser PDF/OCR closure is in `images/computer/browser-skills-requirements.txt`; the fuller permissive document closure shared by `computer` and `workstation` is independently locked in `images/computer/skills-requirements.txt`. License summaries and retained dependency license texts ship with the relevant image. AGPL/commercial-only PyMuPDF packages are intentionally excluded. OCI SBOM and vulnerability gates inspect these installed packages, including the web extractor closure.

Qubicl's six native skill baselines live under `skills/core`; the pinned generated record is `skills/core-catalog.json`. After an intentional package or definition change, run `npm run skills:catalog:update`. Every normal build runs `scripts/verify-skill-catalog.mjs` and fails if files, frontmatter, compatible presets, required tools, security findings, or reviewed digests drift. [Skill provenance](../skills/PROVENANCE.md) records the upstream reference and adaptation boundary; the complete Hermes source tree is not vendored, copied into release images, or exposed as a selectable catalog.

## Image and setup acceptance

Build all local development targets once:

```sh
npm run images:build
```

Run this after updating the source and before exercising `qubicl setup`. The command rebuilds the gateway and all four preset images from the current checkout, then validates each preset's exact capability contract. If setup reports that a local `:dev` manifest digest does not match the catalog, rerun `npm run images:build` from the repository root before retrying setup.

The artifact harness covers state v1/v2 migration and recovery, sole `setup` onboarding, no-start/no-empty-gateway behavior, all four capability/startup profiles, custom derivation from every baseline, offline behavior, secret-free output, MCP/OpenAPI parity, viewer takeover, lifecycle continuity, persistence, and isolation:

```sh
npm run test:e2e:source
npm run test:e2e:npm
npm run test:e2e:binary
npm run test:e2e:all
```

These are large local Docker runs. Start one and let that exact process finish; do not overlap or repeatedly launch acceptance builds.

## Remote-access acceptance

The versioned
[remote-access requirements](../conformance/remote-access-v1.json) are an
additional schema-4 release gate, not an automatic test runner. After candidate
bytes are frozen, retain exact, post-freeze evidence for all three required
profiles: native Linux x64, Apple Silicon through Docker Desktop, and Windows
11 x64 through WSL 2/Docker Desktop. Use an actual external client path, not a
second loopback process.

Each profile records the source-client and container-observed address families,
attests that both paths are non-loopback, and records whether the addresses were
the same (direct) or different (NAT-translated). Exercise TLS identity,
Host/SNI, allowed and denied CIDRs, ignored forwarded headers, cross-computer
bearer rejection, exact trusted/untrusted browser origins, remote operator-route
denial, optional client certificates, exact Docker publication, local-loopback
preservation, running and stopped gateway transitions, revoke, status/doctor,
and durable-data preservation. Exercise remote MCP HTTP, OpenAPI, Open Terminal,
viewer static/WebSocket, and isolated preview HTTP/WebSocket surfaces with the
exact client and browser versions recorded in the evidence.

The acceptance bundle hash-binds the requirements copy, every row and surface
report, the `remoteGateway` workflow, and the `remoteExposure` security review.
Do not retain certificate private keys, bearer tokens, viewer tickets, session
cookies, protected state, or durable-home contents in evidence. Qubicl does not
change the firewall or router for this gate. Do not retain the raw source or
observed network addresses; the signed comparison and bounded evidence report
are sufficient and avoid publishing local network topology.

## Secret and dependency review

Release checks require a locally installed, checksum-verified Gitleaks 8.30.1 (or separately reviewed compatible version):

```sh
gitleaks version
npm run scan:secrets
```

The command scans reachable history and worktree with redacted findings. Before public cutover, also scan every retained remote branch/PR ref in a temporary bare clone; worktree checks cannot remove GitHub-owned PR refs. Run `npm audit signatures` and review Trivy reports in candidate output.

Dependency review is manual and local. The repository does not configure
Dependabot or another bot to open routine public update pull requests. Review
proposed package changes against exact lockfile bytes, licenses, bundled output,
offline/online audit evidence, and the focused tests they invalidate before
including them in an ordinary maintainer-reviewed branch. Hosted security
alerts are a separate repository setting, not an automated update-PR workflow.

## Physical reboot acceptance

Reboot remains a separate operator-controlled gate:

```sh
npm run test:reboot:prepare
# Reboot, log in, and start Docker yourself if the platform requires it.
npm run test:reboot:verify
npm run test:reboot:cleanup
```

The isolated harness verifies running/stopped policy, stale lease rejection, process loss, `/home` survival, and disposable root. Qubicl never reboots a host or starts Docker.

## Local candidate assembly

From a clean reviewed Linux x64 checkout:

```sh
npm run candidate:preview
```

This assembles an unsupported prerelease candidate. It rejects secrets and
scanner-reported available fixes, while retaining genuinely unfixed
HIGH/CRITICAL findings as visible `preview-only` tracking data. It cannot pass
the supported-release acceptance validator.

For the strict supported-release policy:

```sh
npm run candidate:local
```

The builder creates five multi-architecture OCI archives (gateway plus four
presets), checks contracts/provenance/SBOM, and scans independently filtered
amd64 and arm64 OCI views. Each retained Trivy report must match the selected
manifest, configuration, compressed layers, and rootfs diff IDs. The builder
then generates exact digest/size catalog data and builds/tests the npm and native
artifacts against those exact bytes. Output remains ignored under
`release/candidates/`; there is no push, publish, tag, release, or visibility
operation.

If a complete late-stage candidate is preserved under
`release/candidates/.failed-*`, return to its clean reviewed revision and run:

```sh
npm run candidate:resume -- release/candidates/.failed-VERSION-REVISION-TARGET.PID
```

Resume verifies and promotes the unchanged candidate. It does not rebuild
images, rerun Trivy, or rerun artifact acceptance; incomplete staging remains
diagnostic-only.

Additional native hosts must use the exact generated catalog:

```sh
node scripts/build-local-candidates.mjs --binary-only --catalog /path/to/image-catalog.json
```

Hardware not locally validated remains a supported-1.0 blocker. An initial or preview
must identify only the platforms actually tested and make no broader support
claim. Read [RELEASING.md](../RELEASING.md); publication always needs a separate
explicit decision.

Retained candidates, native builds, package tarballs, and SBOMs are intentionally outside ordinary `npm run clean`. List eligible ignored artifacts without changing them:

```sh
npm run clean:artifacts
```

Passing paths without confirmation is also a dry run:

```sh
npm run clean:artifacts -- release/candidates/VERSION-REVISION
```

Deletion requires both `--confirm` and the exact repo-relative paths reviewed in the dry run:

```sh
npm run clean:artifacts -- --confirm release/candidates/VERSION-REVISION
```

The command refuses paths outside its candidate/package/SBOM/native allowlist, tracked or non-ignored content, overlapping targets, and paths with symlink components. It never selects deletion targets implicitly.

## Repository rules

- The root workspace stays private to npm; only `packages/cli` is distributable.
- Never commit `dist`, candidates, OCI exports, tarballs, state, credentials, or reports containing private data.
- Preserve localhost, local-Docker, one-home, capability, privilege, and network boundaries.
- Update tests/docs with public behavior.
- Do not add hosted workflows or register a development machine as a runner.
