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

The repository defaults to Node.js 22.23.4 and npm 10.9.9. Node must satisfy
its patched engine range; development accepts npm `>=10.9.9 <13`. The
`packageManager` pin is the default release toolchain, not a requirement to
downgrade a compatible development npm. Candidate evidence records actual
tool versions. Verify the affected dependency/build behavior when changing them.

Use `npm run build` when bundled artifacts are needed. `npm run test:unit` builds the current artifacts and runs all unit tests. These commands are alternatives selected for the changed surface, not prerequisites to repeat before `npm run check`.

`npm run check` builds/typechecks once, lints source, runs the compiled tests
and release-workflow `.mjs` tests, and checks documentation. It does not contact
advisory services, start Docker acceptance, or run benchmarks. `npm test` builds
and runs the same tests; `npm run test:built` reuses an already-current build.
`npm run test:unit` builds the artifacts its CLI tests need before running the
unit and release-workflow tests, so it cannot silently use an old CLI bundle.

Coverage is available through `npm run test:coverage` as an optional report;
there are no blanket percentage floors. `npm run docs:check` validates local
links, heading anchors, and documented commands without enforcing marketing
phrases. `test:contracts` remains a compatibility alias for that documentation
check; release-impact tests are now included in the normal test commands.

Run `npm run check:security` when current npm advisory/signature and source-secret
checks are needed. `release:check` combines source/privacy/security checks;
`check:release` is an alias. Docker E2E, performance measurements, and token-size
reports are separate explicit commands selected for the change, not hidden steps
in either aggregate. Reuse applicable evidence rather than running both aliases.

`npm run performance -- --no-build` measures an already-current bundle without
rebuilding it. Default performance mode includes build timing and reports package,
CLI, and available image sizes. `--runtime` additionally starts four preset
workloads and includes a shared 60-second idle measurement. Select that cost
explicitly when needed. Reports have no universal size, latency, or RSS gates;
compare relevant measurements on comparable hardware and inspect actual failures.

`npm run tokens:audit` reports compact tool-definition bytes and rough token
estimates for each preset and profile. There is no fixed catalog-size ceiling
that blocks a useful tool or clearer description. Profiles remain available
when a client needs a smaller catalog.
Set `QUBICL_TOKEN_METRICS=1` on a control service or stdio bridge to log
size-only per-tool result/catalog events to stderr without logging tool
arguments or result content.

The pinned Python closure for the local web service is in `images/computer/web-requirements.txt`, including Trafilatura and the readability-lxml fallback. The smaller permissive browser PDF/OCR closure is in `images/computer/browser-skills-requirements.txt`; the fuller permissive document closure shared by `computer` and `workstation` is independently locked in `images/computer/skills-requirements.txt`. License summaries and retained dependency license texts ship with the relevant image. AGPL/commercial-only PyMuPDF packages are intentionally excluded. OCI SBOM and vulnerability gates inspect these installed packages, including the web extractor closure.

Qubicl's native skill baselines live under `skills/core`; the pinned generated record is `skills/core-catalog.json`. After an intentional package or definition change, run `npm run skills:catalog:update`. Every normal build runs `scripts/verify-skill-catalog.mjs` and fails if files, frontmatter, compatible presets, required tools, security findings, or reviewed digests drift. [Skill provenance](../skills/PROVENANCE.md) records the upstream reference and adaptation boundary; the complete Hermes source tree is not vendored, copied into release images, or exposed as a selectable catalog.

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

## Choose checks for the change

These are starting points, not a requirement to run every row. Report exact
commands and outcomes, including skipped browser/hardware cases. Run a broader
gate when shared behavior, dependencies, or unresolved failures justify it.

| Changed surface | Focused verification | When to broaden |
| --- | --- | --- |
| Documentation only | `git diff --check`, inspect local links and anchors, compare claims and examples with the relevant source | Executable examples or package contents changed; no image rebuild for prose alone |
| Dashboard frontend | Type compilation, lint for touched source, relevant dashboard tests, browser inspection of the affected flow | Helper/API contract, auth, responsive input, or accessibility behavior changed; qualify affected physical platforms for release |
| Core schema or tool contract | Type compilation and contract, policy, migration, or adapter tests using that schema | A shared contract affects several transports, state readers, or runtime images |
| Control, browser, gateway | Relevant unit/integration tests; real-browser regression when browser behavior changes | End-to-end ownership, credentials, egress, or socket lifetime crosses service/container boundaries |
| Host CLI or lifecycle | Relevant CLI, state, and transaction tests | Mounts, Compose, image acquisition, recovery, or persistent data require isolated Docker acceptance |
| Image packages or startup | Build/inspect affected runtime inputs and exercise the affected preset | Shared layers, manifests, catalogs, or release coupling invalidate additional artifacts |
| Release tooling | Relevant manifest, signature, acceptance, and publisher tests | A candidate or publication policy changes; complete the enforced release gates before publication |
| Platform-specific behavior | Tests for the changed host path and real acceptance on affected hardware | Service installation, Docker/WSL restart, networking, or mobile input cannot be established by mocks |

After `npm run build:types`, run selected compiled files with
`node --test dist-tests/unit/NAME.test.js` or the corresponding integration
path. For touched-source lint, use `npx --no-install oxlint --deny-warnings PATH`.
Reuse compilation and successful results while their source, dependencies,
artifacts, environment, and relevant external evidence remain applicable.
Recompile after changing a test or its source; do not test stale `dist` output.

`npm run check` is the available aggregate source check. Full suites, Docker acceptance,
all-image builds/scans, and candidate construction are distinct operations;
do not run them merely to validate a documentation edit. For 0.6 and later,
generate and verify
the exact [release-impact document](decisions/0002-v0.6-capabilities-and-constraints.md)
before candidate work. It selects required evidence, while the current publisher
still requires a complete signed candidate. Unchanged image bytes may be carried
forward with exact per-image provenance instead of being rebuilt.

## Image and setup acceptance

Build all local development targets once:

```sh
npm run images:build
```

Use this full image build for initial source setup or acceptance that needs all
presets. It rebuilds the gateway, isolated dashboard, and all four preset images,
then validates the asset/capability contracts. The current `image build-system`
CLI does not expose a per-preset switch. A source change alone does not require
running it: first identify which bundle, image, or catalog changed. If setup
actually reports a stale local `:dev` manifest/catalog identity, this full build
is the supported refresh command. Do not bypass a contract mismatch or use it
as a recovery command for a published image. Documentation-only verification
requires no runtime refresh.

The artifact harness covers state v1/v2 migration and recovery, sole `setup` onboarding, no-start/no-empty-gateway behavior, all four capability/startup profiles, custom derivation from every baseline, offline behavior, secret-free output, MCP/OpenAPI parity, viewer takeover, lifecycle continuity, persistence, and isolation:

```sh
npm run test:e2e:source
npm run test:e2e:npm
npm run test:e2e:binary
npm run test:e2e:all
```

These are large local Docker runs. Start one and let that exact process finish; do not overlap or repeatedly launch acceptance builds.

To reproduce one source-level failure against an existing candidate catalog
without starting release construction, use the read-only diagnostic plan and
then execute it once:

```sh
npm run release:diagnose -- --candidate /path/to/complete-candidate
npm run release:diagnose -- --candidate /path/to/complete-candidate --execute
```

Add `--upgrade-from /path/to/old/qubicl` for the isolated upgrade scenario. It
retains that fixture for inspection and creates no candidate, image, scan,
signature, or acceptance evidence.

## Remote-access acceptance

The versioned
[remote-access requirements](../conformance/remote-access-v1.json) are an
standard schema-4 release gate, not an automatic test runner. After candidate
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
or a separately reviewed compatible build. Candidate tooling requires Trivy
0.74.0 and rejects a different scanner version. Confirm both
executables before starting candidate work:

```sh
gitleaks version
trivy --version
npm run scan:secrets
```

The command scans reachable history and worktree with redacted findings. Before public cutover, also scan every retained remote branch/PR ref in a temporary bare clone; worktree checks cannot remove GitHub-owned PR refs. `npm run check:security` runs `npm audit signatures`; reuse that result for the same dependency bytes and review Trivy reports in candidate output. Repeat external security checks when their advisories, trust data, or required freshness change.

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

Follow [RELEASING.md](../RELEASING.md) for the active procedure. New candidates
use schema 8, image inputs schema 2, and per-report scan bindings schema 3.
The CLI/catalog version can advance while unchanged images retain their
original versions and digests. Version-only workspace metadata changes do not
invalidate runtime bytes; real runtime inputs and dependency integrity do.

```sh
npm run release:impact -- --base vPREVIOUS --output /secure/release-impact.json
npm run candidate:release -- --impact /secure/release-impact.json --reuse /path/to/previous/linux-x64
# Review buildImages, reuseImages, and scanImages; then append --execute once.
```

The builder verifies copied bytes, builds changed images, rescans only affected
or stale images, and builds/tests the exact npm/native artifacts against the
catalog. It does not repeat aggregate source checks. Original toolchain identity
stays with reused bytes. A failed late step does not justify starting over:
inspect its evidence, resume a complete candidate, or use verified failed
staging as a donor. The complete candidate still contains all six image
references and platform scans, without requiring every image to be rebuilt.

Schema-3 release sets select native artifact targets explicitly. Signed
qualification records passed, failed, and unverified impact-selected checks.
Gaps require a publication decision and matching public release-note disclosure;
no unavailable hardware or client result is silently counted as passing.
The normal publisher verifies this evidence and artifact signatures. Legacy
schema-4 acceptance remains an optional strict historical path, not an extra
matrix to run after qualification.

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


## Dashboard development and acceptance

`npm run build` typechecks and bundles the static dashboard, asset server, and
host helper. `node scripts/build-dashboard.mjs` builds only the static package;
no Docker daemon is required. The normal bundle includes the frontend manifest,
image context, notices and dependency evidence in npm/native artifacts. Image
catalog schema 2 binds the sixth image to its exact asset-manifest digest.

Focused dashboard tests use disposable files and loopback/mock servers. They do
not install services or mutate managed Docker state. Select real browser,
service, TLS, mobile, and reboot checks when the changed behavior warrants them.
Record the tested device, OS/browser/client versions, artifact identities,
commands, and results. Source mocks do not establish physical-platform support.
Use the signed qualification path in [RELEASING.md](../RELEASING.md) to record
unavailable or failed checks honestly. Historical schema-4 dashboard acceptance
rows retain their original validation rules only when that legacy path is used.

See [dashboard operations](dashboard.md) and the
[host-management decision](decisions/0001-host-owned-dashboard.md).

## Focused desktop development checks

The new native helper uses the guest's X11 and AT-SPI session. Run
`tests/e2e/native-desktop-test.py` in a disposable graphical guest with the new
image dependencies, a window manager, and its own session bus. It exercises a
local GTK fixture, including disabled controls, text edits, continuation, stale
geometry/refs and a normal-close save dialog.

`tests/e2e/workstation-apps-test.py` checks startup windows for the workstation
applications. Optional executable names restrict the check after a specific
launch failure. Both scripts create only test-owned processes and use no models
or external web calls. These focused checks support development; they do not
add universal release quotas or replace impact-selected release qualification.
