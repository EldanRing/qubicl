# Releasing Qubicl

Qubicl releases are built and published from maintainer-controlled local
hardware. Nothing uses GitHub Actions, and publication never rebuilds a tested
artifact.

The instructions below describe the currently enforced candidate and publisher
contract. The [0.6 design](docs/decisions/0002-v0.6-capabilities-and-constraints.md)
adds exact change-impact analysis, representative affected clients, and
identity/freshness-bound evidence reuse. Candidate, release-set, verifier, and
publisher metadata enforce that impact identity. Publication still uses one
complete immutable signed candidate containing all six images. Candidate
construction may reuse an unchanged image archive, scan report, and efficiency
report when their recorded inputs and freshness still satisfy the verifier.

Before selecting gates, identify changed source/dependencies, resulting
artifacts, affected state/protocol/platform behavior, and reusable evidence with
its exact input identities and freshness. Development-only documentation checks
do not require a release candidate. Publication still needs the reviewed,
implemented validator/publisher path and explicit approval for the version.

## The practical pre-1.0 policy

Qubicl remains a pre-1.0 series. The supported-host policy covers Linux x64,
Apple Silicon macOS with Docker Desktop, and Windows 11 x64 through Ubuntu
24.04 on WSL 2 with Docker Desktop. Their directly tested classifications
record historical v0.1.0 evidence baselines; they do not claim that every
current candidate repeats the full macOS and Windows matrices. Native Windows
and WSL 1 are unsupported; Linux ARM64, Intel macOS, Windows on ARM, and other
WSL distributions are best-effort.
The initial v0.1 series allowed missing external-client or best-effort hardware
coverage. That exception ended with v0.1: every v0.2-or-later publication,
including one built with the `initial` candidate tier, requires the signed
schema-4 release-set acceptance bundle. The signed tier selects the acceptance
profile: `initial` records the exact Linux x64 general platform, lifecycle, and
native remote-access evidence required for an honest pre-1.0 release, while
`supported` retains the complete cross-platform and independent-review matrix.
For v0.5, both tiers require the complete real-client/protocol matrix plus
dashboard-specific native Linux x64, Apple Silicon macOS, and physical-iPhone
Safari evidence. For v0.6 and later, the exact release-impact document selects
affected protocols and platforms; every selected row needs applicable signed
evidence, and missing coverage cannot pass. The narrower dashboard rows do not
establish general current-candidate macOS or Windows testing.
The versioned [platform support matrix](conformance/platform-support-v1.json)
is the source of truth for these support and evidence classifications.

An initial candidate must still:

- come from a clean, privacy-checked public source revision;
- pass source, package, native, and Docker acceptance on the release host;
- contain exact amd64/arm64 OCI archives, catalogs, SBOMs, provenance, checksums,
  and twelve retained Trivy reports;
- bind post-freeze client, protocol, Linux x64 lifecycle, native-Linux
  remote-access, and applicable dashboard evidence in schema 4;
- bind an exact `release-impact.json` for v0.6 and later, including the prior
  release commit, candidate commit, changed paths, artifacts, checks, protocols,
  platforms, and evidence-reuse rule;
- contain no scanner-detected secrets; and
- reject every HIGH/CRITICAL finding for which the scanner reports an available
  fix unless an exact current review record covers it.

Unfixed distribution findings are retained in `trivy-summary.json` and release
evidence. They are not silently described as fixed or safe. The stricter
`candidate:local` policy—independent review for every remaining HIGH/CRITICAL
finding plus the full client/platform acceptance record—remains the supported
and 1.0 gate.

## Public source identity

Release only from the privacy-checked root history of the official repository.
The maintained project identity is
`Qubicl Maintainers <contact@qubicl.org>`. Before building a candidate, run:

```sh
npm run public:check
npm run public:export -- --destination /absolute/path/to/qubicl-public
```

The export command is a recovery tool if the public source root ever needs to
be recreated. Its output contains only the committed tree: no `.git`, old
refs, local state, ignored artifacts, candidate output, or Git identity. Any
new public root must use the maintained identity above and pass the same source
and secret checks before it is pushed.

`PUBLIC_HISTORY_POLICY.json` makes that boundary executable. The guarded
publisher requires a linear `main` history descended from the exact reviewed
public root, verifies that `HEAD` and `origin` match the candidate, rejects
merge-connected or alternate-root ancestry, and reruns the public-source
privacy check before any publication action.

### npm identity and tags

npm adds the publishing account's email address to public package metadata,
and changing the account later does not rewrite metadata for an already
published version. Before publishing the stable candidate, set **Account
Settings → Email address added to package metadata** to a project-specific
public address and verify it with `npm profile get`. See npm's
[profile guidance](https://docs.npmjs.com/managing-your-profile-settings/) and
[threat model](https://docs.npmjs.com/threats-and-mitigations/).

Inspect `npm dist-tag ls qubicl-cli` before announcing a release.
Prereleases belong on `dev` or `next`; `latest` must identify the stable
release. The guarded publisher verifies the candidate under `next` and moves
`latest` only after the npm, GHCR, Git tag, and GitHub Release checks succeed.

## Build the exact candidate

Prerequisites on the Linux x64 release host:

- the Node/npm versions pinned by this repository;
- Docker Engine/Desktop, Compose, and a multi-platform Buildx builder;
- checksum-verified Gitleaks 8.30.1, or a separately reviewed compatible build;
- Trivy 0.74.0, which the candidate tooling enforces; and
- a clean checkout of the new public repository at the release revision.

Run the source gates once after the intended source is stable:

```sh
gitleaks version
trivy --version
npm ci
npm run release:check
```

`release:check` owns source-level checks, including source Docker E2E. Candidate
construction later runs the exact npm and native artifacts against the selected
image catalog; it does not repeat the source E2E. For a suspected lifecycle or
migration problem, inspect the bounded diagnostic plan and then run that exact
scenario before freezing source:

```sh
npm run release:diagnose -- --candidate /path/to/last-complete-candidate
npm run release:diagnose -- --candidate /path/to/last-complete-candidate --execute
# For an upgrade-specific check, also pass --upgrade-from /path/to/old/qubicl.
```

The diagnostic command never creates release evidence or builds images, scans,
native archives, or signatures. Its default is read-only; `--execute` runs one
scenario once. It does not retry or start another candidate after a failure.

Commit the frozen source, generate its impact document, and ask the candidate
builder for a read-only plan. Supply the most recent complete candidate for the
same version when one exists:

```sh
npm run release:impact -- --base v0.5.1 --output /secure/release-impact-v0.6.0.json
npm run candidate:release -- \
  --impact /secure/release-impact-v0.6.0.json \
  --reuse /path/to/previous-0.6.0/linux-x64
```

Review `buildImages`, `reuseImages`, `scanImages`, and the recorded reasons. Only
the explicit execution form performs expensive work:

```sh
npm run candidate:release -- \
  --impact /secure/release-impact-v0.6.0.json \
  --reuse /path/to/previous-0.6.0/linux-x64 \
  --execute
```

Generate the impact document only after the release commit is frozen. The
command resolves both revisions and refuses to overwrite an existing output.
The candidate verifier recomputes the Git name-only diff and classifier, then
checks the embedded document's hash and exact base/candidate identity. This 0.6
source range affects shared contracts and therefore classifies as `full`.

If a late candidate check fails, Qubicl preserves the staging directory under
`release/candidates/.failed-*` instead of deleting completed images, scans, and
packages. After correcting an external verification-only condition, return to
the same clean reviewed revision and resume without rebuilding:

```sh
npm run candidate:resume -- release/candidates/.failed-VERSION-REVISION-TARGET.PID
```

Resume runs only the complete candidate verifier before promoting the unchanged
bytes; it does not rebuild images, rerun Trivy, or rerun artifact acceptance. If
failure occurred before the manifest and checksums were complete, the directory
remains available for diagnosis or explicit cleanup but cannot be promoted. A
failed command is terminal: release tooling never launches a replacement build
or loops until one passes.

`candidate:release` first exports the reviewed commit into a disposable clean
worktree, runs a fresh `npm ci`, and retains lockfile, registry, installed-tree,
audit, and registry-signature evidence. Candidate schema 7 adds
`image-inputs.json`: every image records its originating commit, a hash of the
mapped Git-tree entries and image-relevant root manifest fields, the release
version, and its original build toolchain. An origin must be an ancestor of the
candidate and reproduce the same versioned input hash. Unknown input paths
invalidate every image.
Current host tool versions do not invalidate already immutable image bytes;
their original toolchain remains recorded.

The builder copies only archives selected for reuse and checks each copy against
the donor manifest. Changed image inputs rebuild only their mapped image group.
A candidate that reuses every image also carries forward the verified dashboard
asset identity and skips the preliminary image-context build; final candidate
verification still requires the npm/native build to reproduce that identity.
A fresh scan set can be copied when its scanner/database identity is still
valid; stale scan evidence causes a rescan of the selected immutable archives,
not an image rebuild. When all images are unchanged, the exact efficiency report
is copied and the final verifier regenerates it from the archives. The catalog
and final candidate still contain all six images.

For newly required scans, the builder refreshes the Trivy vulnerability database
and rejects metadata whose next-update time has already passed or whose scan,
database, or check-bundle time is in the future. Each amd64/arm64 Trivy run
receives its own one-manifest OCI view;
the builder verifies the selected index, manifest, configuration, compressed
layers, rootfs diff IDs, and report identity before retaining the report. It
writes `oci-efficiency.json` for v0.2 and later from those exact archives and
their embedded SPDX attestations, recording shared/unique compressed and expanded
layers plus normalized package overlap. Candidate verification regenerates the
report from the retained bytes using the OCI inspections already performed by
that verification call. The builder generates the exact catalog, builds the npm
and native artifacts once against it, and runs their exact-artifact acceptance
serially. Publication includes the retained evidence.
The builder writes an ignored candidate beneath:

```text
release/candidates/0.6.0-<revision>/linux-x64/
```

From the same clean reviewed revision, verify it without rebuilding or rerunning
acceptance:

```sh
node scripts/verify-candidate.mjs /path/to/candidate
```

If the candidate fails because source or dependencies must change, commit the
fix and generate a new plan against the last complete candidate. Rebuild only
the inputs that plan invalidates. Never edit candidate contents in place.

## Mandatory detached signature

The publisher requires an offline Ed25519 signature over the exact candidate
manifests. It can be added without changing the candidate:

```sh
npm run candidate:sign -- keygen /secure/offline/qubicl-release
npm run candidate:sign -- sign /path/to/candidate \
  /secure/offline/qubicl-release.private.pem /path/to/candidate.signature.json
npm run candidate:sign -- verify /path/to/candidate \
  /secure/offline/qubicl-release.public.pem /path/to/candidate.signature.json
```

Keep the private key outside the repository and backups intended for public
distribution.

## Preview and publish

Install Skopeo on the release host before publication; it copies the exact
multi-platform OCI archives to GHCR without rebuilding them. Authenticate npm
and `gh`. The publisher dry run is local and does not require `origin/main` to
have moved. It verifies the candidate, signatures, acceptance bundle, release
notes, and local checkout, then prints the exact publication plan.

Inspect the publication plan before any push:

```sh
npm run release:publish -- --candidate /path/to/candidate \
  --public-key /secure/offline/qubicl-release.public.pem \
  --signature /path/to/candidate.signature.json \
  --release-set /path/to/release-set.json \
  --release-set-signature /path/to/release-set-signature.json \
  --acceptance /path/to/acceptance.json \
  --acceptance-signature /path/to/acceptance-signature.json
```

The dry run verifies the full candidate and the exact checkout but performs no
remote mutation. Actual publication requires separate authorization to
fast-forward the exact reviewed release commit to `origin/main`; build, signing,
or publication preparation does not substitute for that push approval. Push
only that reviewed commit, then confirm the remote-tracking branch resolves to
it:

```sh
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git push origin HEAD:main
git fetch origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
```

After explicit publication approval:

```sh
QUBICL_RELEASE_APPROVAL=0.6.0 npm run release:publish -- \
  --candidate /path/to/candidate \
  --public-key /secure/offline/qubicl-release.public.pem \
  --signature /path/to/candidate.signature.json \
  --release-set /path/to/release-set.json \
  --release-set-signature /path/to/release-set-signature.json \
  --acceptance /path/to/acceptance.json \
  --acceptance-signature /path/to/acceptance-signature.json \
  --publish --yes
```

The guarded publisher:

1. logs Skopeo into GHCR using the active GitHub CLI token without printing it;
2. copies and verifies all six exact versioned OCI indexes;
3. verifies that all six GHCR packages permit anonymous pulls;
4. publishes the exact npm tarball under a temporary `next` tag and verifies its
   registry integrity;
5. creates and pushes the annotated tag for the candidate version;
6. creates the GitHub release with the native archive, checksums, catalog,
   candidate manifest, SBOMs, and vulnerability summary; and
7. includes the exact release-impact document in the GitHub release; and
8. only after those checks pass, moves the GHCR and npm `latest` tags.

GitHub creates container packages pushed from the command line as private and
does not provide a supported package-visibility REST operation. On the first
run, the publisher therefore stops after the verified versioned image upload
and prints the six package-settings links. Set each package to **Public**, then
rerun the same command. The npm package is not published until all six image
packages report public visibility, so `qubicl setup` cannot be stranded behind
private images.

Publication is retry-safe when existing versioned npm/image objects match the
candidate and fails if they do not. Existing GitHub releases must also match
the exact commit, title, notes, state, asset set, sizes, and SHA-256 values. It
never changes repository or package visibility.

## After publication

From a clean user environment:

```sh
npm install -g qubicl-cli@0.6.0
qubicl setup
qubicl doctor
```

Create one computer, connect one real client, open the viewer, and verify an
upgrade while preserving the computer's home. If that smoke fails, do not move
or advertise additional mutable tags; document and fix the release.

## Current supported-tier requirements

The full cross-platform/reboot matrix, complete real-client evidence,
independent security review, and individually reviewed remaining
HIGH/CRITICAL findings are requirements of the current `supported` tier. The
`initial` tier has its own enforced requirements described above. Future 1.0
qualification must be reviewed against the implemented product and release
policy rather than inferred from a historical candidate checklist.

The current release-set format, introduced in v0.2, is schema 2. An `initial` set contains the one
complete Linux x64 candidate. A `supported` set additionally aggregates the
Linux ARM64 and both macOS native candidates. Create and sign either tier from
its exact candidate directory:

```sh
npm run candidate:release-set -- release/candidates/VERSION-REVISION
node scripts/release-set.mjs sign release/candidates/VERSION-REVISION/release-set.json \
  /secure/offline/qubicl-release.private.pem /path/to/release-set-signature.json
node scripts/acceptance-evidence.mjs sign \
  release/candidates/VERSION-REVISION/release-set.json /path/to/acceptance.json \
  /secure/offline/qubicl-release.public.pem /path/to/release-set-signature.json \
  /secure/offline/qubicl-release.private.pem /path/to/acceptance-signature.json
```

The publisher requires all four extra paths through `--release-set`,
`--release-set-signature`, `--acceptance`, and `--acceptance-signature` for a
supported release or any v0.2-or-later publication. The versioned acceptance
schema hashes every referenced report and records concrete tool/platform
versions and UTC timestamps. The signed release-set tier and the acceptance
`profile` must match exactly; a supported candidate cannot use the initial
profile.

For v0.2 and later release sets, acceptance schema 4 is mandatory; schema-3
evidence remains readable only for v0.1. Schema 4 hash-binds the reviewed
`client-conformance-v1.json` requirements and requires exact installed versions
plus post-freeze evidence for every applicable surface in each required row.
For v0.2 through v0.4, the initial profile requires Codex, Open WebUI, MCP
stdio, MCP HTTP, OpenAPI, and Open Terminal. The supported profile requires all
nine named applications and all four protocol probes. v0.5 requires the complete
nine-application and four-protocol matrix for both tiers. For v0.6 and later,
the release-impact document selects the affected protocol surfaces; adapters
whose inputs changed require their real client rows. Adding this gate does not
produce evidence: required real-client runs must still be performed against the
frozen candidate before acceptance is signed.

For schema-7 candidates, `qualificationStartedAt` is the immutable candidate
commit time. Evidence may be collected after that boundary and before all native
members are assembled into `release-set.json`; creating the release set no
longer invalidates work already performed against the same frozen candidate.

Schema 4 also hash-binds `platform-support-v1.json`. The initial profile
requires the exact Linux x64 host/runtime versions plus minimum-version and
restart results. It requires upgrade, crash-safe backup, restart,
full-topology performance, multi-computer, and remote-gateway workflows. The
supported profile requires all five platform rows, every reviewed restart and
reboot check, sustained dogfooding, and independent owner/reviewer/approver
identities. Its Windows row remains constrained to Windows 11 x64 and Ubuntu
24.04 WSL 2; macOS rows require Docker Desktop restart evidence. Native Windows
and WSL 1 remain unsupported. Every row actually required by the selected
profile needs post-freeze, hash-bound evidence from the frozen candidate.

Remote gateway support adds a third immutable contract:
`remote-access-v1.json`. The initial profile requires the native Linux x64
direct-network row. The supported profile additionally requires Apple Silicon
Docker Desktop and Windows 11 x64 through WSL 2/Docker Desktop. Each row records
non-loopback source and container-observed address
families plus an exact same/different comparison for direct or NAT-translated
behavior, exact client/browser versions, TLS identity,
and passing results for remote MCP HTTP, OpenAPI, Open Terminal, viewer static
and WebSocket traffic, and isolated HTTP/WebSocket previews. The exact security,
lifecycle, local-loopback preservation, revoke, doctor/status, mTLS, CIDR,
origin, bearer-isolation, and durable-data checks are mandatory, as is the
top-level `remoteGateway` workflow and `remoteExposure` security-review topic.
Focused source tests cannot substitute for these physical-host and real-client
records. Raw source and observed network addresses are excluded from published
evidence so the release record does not disclose local network topology.
