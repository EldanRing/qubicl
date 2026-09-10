# Development and local testing

All development, tests, scans, and candidate assembly run on maintainer-controlled local machines. Qubicl uses no GitHub Actions, repository runners, paid CI, telemetry, or hosted build service.

## Workspace setup

Install a supported Node/npm and local Docker Engine/Desktop with Compose, then:

```sh
npm ci
npm run build:types
# Run the compiled tests relevant to your change, for example:
node --test dist-tests/unit/contracts.test.js
```

The repository pins npm 10.9.3 through `packageManager`/`devEngines`. `.nvmrc` pins normal Node development; release validation separately covers minimum Node 22 and Node 24 targets.

Use `npm run build` when bundled artifacts are needed. `npm run test:unit` runs all unit tests after type compilation. These commands are alternatives selected for the changed surface, not prerequisites to repeat before `npm run check`.

`npm run check` performs strict TypeScript, Oxlint, unit/integration tests with coverage floors, and a high-severity npm audit. `npm run performance -- --no-build` reuses the existing bundle and records no build timing; use it only after verifying the bundle matches the source under measurement. The default `npm run performance` includes build timing and checks package/CLI/all-six-image size budgets; add `-- --runtime` for one controlled four-preset startup/workload/60-second-idle run.

Run `npm run tokens:audit` to print exact compact tool-definition bytes for every preset and static profile. The command fails if the lease-transparent full `workstation` catalog reaches the 26,000-byte regression ceiling, including skills and native web research. Set `QUBICL_TOKEN_METRICS=1` on a control service or stdio bridge to log size-only per-tool result/catalog events to stderr without logging tool arguments or result content.

The pinned Python closure for the local web service is in `images/computer/web-requirements.txt`, including Trafilatura and the readability-lxml fallback. The smaller permissive browser PDF/OCR closure is in `images/computer/browser-skills-requirements.txt`; the fuller permissive document closure shared by `computer` and `workstation` is independently locked in `images/computer/skills-requirements.txt`. License summaries and retained dependency license texts ship with the relevant image. AGPL/commercial-only PyMuPDF packages are intentionally excluded. OCI SBOM and vulnerability gates inspect these installed packages, including the web extractor closure.

Qubicl's six native skill baselines live under `skills/core`; the pinned generated record is `skills/core-catalog.json`. After an intentional package or definition change, run `npm run skills:catalog:update`. Every normal build runs `scripts/verify-skill-catalog.mjs` and fails if files, frontmatter, compatible presets, required tools, security findings, or reviewed digests drift. [Skill provenance](../skills/PROVENANCE.md) records the upstream reference and adaptation boundary; the complete Hermes source tree is not vendored, copied into release images, or exposed as a selectable catalog.

For a focused browser-reference regression with an installed Chromium or Chrome
executable, run:

```sh
npm run build:types
QUBICL_TEST_BROWSER_EXECUTABLE=/usr/bin/chromium node --test dist-tests/integration/browser-refs.test.js
```

This test uses a temporary headless browser with network requests blocked. It
checks insertion, reordering, replacement, and navigation without connecting to
an existing browser profile. It skips when the executable variable is absent.

For the optional real Office conversion regression, set
`QUBICL_TEST_OFFICE_PYTHON` to a local Python with `python-docx` and `python-pptx`,
then run `node --test dist-tests/integration/office-preview-real.test.js` after
`npm run build:types`. It requires LibreOffice and Poppler, creates temporary
DOCX/PPTX fixtures, checks PDF text and page counts, and removes its files.
The ordinary Office unit tests cover failures, limits, cancellation, and cleanup
without requiring LibreOffice.

## Image and setup acceptance

Build all local development targets once:

```sh
npm run images:build
```

Use this full image build for acceptance that needs all presets. Focused source or documentation changes do not automatically require rebuilding every image. The command rebuilds the gateway, isolated dashboard, and all four preset images from the current checkout, then validates the dashboard asset contract and each preset's exact capability contract. If setup reports that a local `:dev` manifest digest does not match the catalog, rerun `npm run images:build` from the repository root before retrying setup.

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
bytes are frozen, the pre-1.0 `initial` profile requires exact post-freeze
native Linux x64 evidence. The `supported` profile additionally requires Apple
Silicon through Docker Desktop and Windows 11 x64 through WSL 2/Docker Desktop.
Use an actual external client path, not a second loopback process.

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

Release checks require a locally installed, checksum-verified Gitleaks 8.30.1,
or a separately reviewed compatible build. The v0.5 candidate tooling also
requires Trivy 0.74.0 and rejects a different scanner version. Confirm both
executables before starting candidate work:

```sh
gitleaks version
trivy --version
npm run scan:secrets
```

The command scans reachable history and worktree with redacted findings. Before public cutover, also scan every retained remote branch/PR ref in a temporary bare clone; worktree checks cannot remove GitHub-owned PR refs. `npm run check:release` already runs `npm audit signatures`; reuse that result for the same dependency bytes and review Trivy reports in candidate output. Repeat external security checks when their advisories, trust data, or required freshness change.

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

For a stable pre-1.0 candidate using the focused signed `initial` acceptance
profile:

```sh
npm run candidate:release
```

Its schema-2 release set contains the complete Linux x64 candidate. Publication
still requires signed schema-4 Linux lifecycle and native-Linux remote-access
evidence from the frozen bytes. Beginning with v0.5, it also requires all nine
clients, all four protocols, and the complete Linux/macOS/iPhone dashboard
matrix described below.

For the strict full-matrix supported-release policy:

```sh
npm run candidate:local
```

The builder creates six multi-architecture OCI archives (gateway, dashboard, and four
presets), checks contracts/provenance/SBOM, and scans independently filtered
amd64 and arm64 OCI views. Each retained Trivy report must match the selected
manifest, configuration, compressed layers, and rootfs diff IDs. The builder
records those platform-view bindings as schema 2, which is mandatory when a
v0.2-or-later candidate is verified; legacy schema-1 bindings remain readable
only for v0.1 candidate evidence. For v0.2 and later, it also writes a mandatory
`oci-efficiency.json` report from the exact archives and embedded SPDX
attestations. The report accounts for logical, deduplicated, shared, unique, and
duplicate compressed/expanded layer bytes and package identities across all
six images on both platforms. Verification regenerates it rather than trusting
editable summary data. The builder then generates exact digest/size catalog
data and builds/tests the npm and native artifacts against those exact bytes.
To reduce local candidate latency without overwhelming Docker, the six BuildKit
image jobs run with a fixed limit of two. Exact-artifact acceptance remains
serial because those lifecycle-heavy runs share the Docker daemon; each run
still receives a disjoint port range and unique temporary image tags. Concurrent
image work is drained before a failure is handled, so preserved staging cannot
keep changing in the background. Trivy scans, OCI-efficiency inspection, image
loading, catalog generation, and final verification also remain serial because
their shared caches, memory use, or ordering make additional parallelism unsafe
or immaterial.
Output remains ignored under
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


## Dashboard development and v0.5 acceptance

`npm run build` typechecks and bundles the static dashboard, asset server, and
host helper. `node scripts/build-dashboard.mjs` builds only the static package;
no Docker daemon is required. The normal bundle includes the frontend manifest,
image context, notices and dependency evidence in npm/native artifacts. Image
catalog schema 2 binds the sixth image to its exact asset-manifest digest.

Focused dashboard tests use disposable files and loopback/mock servers. They do
not install services or mutate managed Docker state. A complete candidate now
requires twelve architecture-specific image scan reports. For v0.5, even the
initial release tier requires all nine client profiles, four protocol profiles,
and retained Linux, macOS and real iPhone dashboard evidence with OS/browser
versions. Source browser mocks do not satisfy these physical acceptance rows.

Each dashboard row records `qubiclVersion` matching the release set, exact
`osVersion` and `browserVersion`, and the normal `passed`, `testedBy`, `testedAt`
and hashed `evidence` fields. Native rows qualify the helper on the tested host;
they do not extend the release tier's general platform support matrix.

| Dashboard row | Required identities |
| --- | --- |
| `linux` | `platform: linux`, `deviceClass: desktop`, `architecture: x64`, `serviceManager: systemd-user`, `serviceIdentifier: org.qubicl.dashboard.<16hex>.service` |
| `macos` | `platform: macos`, `deviceClass: desktop`, `architecture: arm64`, `serviceManager: launch-agent`, `serviceIdentifier: org.qubicl.dashboard.<16hex>` |
| `iphone` | `platform: ios`, `deviceClass: phone`, `browserName: safari`, an iPhone `deviceModel`, and `physicalDevice: true` |

Native rows also record `tlsHostname`, `tlsProtocol` (`TLSv1.2` or `TLSv1.3`)
and `certificateFingerprint256` (`sha256:<64 lowercase hex digits>`). Their
checks include `helperServicePassed`, `tlsPassed`
and `physicalRebootPassed`, plus keyboard navigation and all six common UI
checks. The iPhone row requires touch navigation and `physicalDevicePassed`
alongside the common checks. The initial tier's Linux platform row must also
pass its physical reboot check. Missing or false qualification results fail
acceptance; retain the actual service, TLS and reboot observations in the
referenced evidence rather than filling fields from source tests.

See [dashboard operations](dashboard.md) and the
[host-management decision](decisions/0001-host-owned-dashboard.md).
