# Releasing Qubicl

Qubicl releases are built and published from maintainer-controlled local
hardware. Nothing uses GitHub Actions, and publication never rebuilds a tested
artifact.

## The practical pre-1.0 policy

`0.1.x` is an initial pre-1.0 series. Linux x64, Apple Silicon macOS with Docker
Desktop, and Windows 11 x64 through Ubuntu 24.04 on WSL 2 with Docker Desktop
are directly exercised hosts. Native Windows and WSL 1 are unsupported; Linux
ARM64, Intel macOS, Windows on ARM, and other WSL distributions are best-effort.
Missing external client or best-effort hardware coverage does not block 0.1.
That exception ends with the v0.1 series: every v0.2-or-later publication,
including one built with the `initial` candidate tier, requires the signed
schema-4 release-set acceptance bundle. The signed tier selects the acceptance
profile: `initial` records the exact Linux x64 evidence required for an honest
pre-1.0 release, while `supported` retains the complete cross-platform,
real-client, reboot, and independent-review matrix.
The versioned [platform support matrix](conformance/platform-support-v1.json)
is the source of truth for these support and evidence classifications.

An initial candidate must still:

- come from a clean, privacy-checked public source revision;
- pass source, package, native, and Docker acceptance on the release host;
- contain exact amd64/arm64 OCI archives, catalogs, SBOMs, provenance, checksums,
  and ten retained Trivy reports;
- bind post-freeze Codex, Open WebUI, all four protocol probes, Linux x64
  lifecycle, and native-Linux remote-access evidence in schema 4;
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

Inspect `npm dist-tag ls qubicl-cli` before announcing the public repository.
Prereleases belong on `dev` or `next`; `latest` must identify the stable
release. The guarded publisher verifies the candidate under `next` and moves
`latest` only after the npm, GHCR, Git tag, and GitHub Release checks succeed.

## Build the exact candidate

Prerequisites on the Linux x64 release host:

- the Node/npm versions pinned by this repository;
- Docker Engine/Desktop, Compose, and a multi-platform Buildx builder;
- the locally pinned Gitleaks and Trivy versions documented in
  [docs/development.md](docs/development.md); and
- a clean checkout of the new public repository at the release revision.

Run:

```sh
npm ci
npm run public:check
npm run check:release
npm audit signatures
npm run tokens:audit
npm run performance
npm run candidate:release
```

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
remains available for diagnosis or explicit cleanup but cannot be promoted.

`candidate:release` first exports the reviewed commit into a disposable clean
worktree, runs a fresh `npm ci`, and retains lockfile, registry, installed-tree,
audit, and registry-signature evidence. It then creates the five multi-platform
image archives first, generates their exact catalog, builds npm/native artifacts
once against that catalog, and reruns source/npm/native acceptance against the
staged bytes. Each amd64/arm64 Trivy run receives its own one-manifest OCI view;
the builder verifies the selected index, manifest, configuration, compressed
layers, rootfs diff IDs, and report identity before retaining the report. It
writes `oci-efficiency.json` for v0.2 and later from those exact archives and
their embedded SPDX attestations, recording shared/unique compressed and expanded
layers plus normalized package overlap. Candidate verification regenerates the
report from the retained bytes, and publication includes it as release evidence.
The builder writes an ignored candidate beneath:

```text
release/candidates/0.2.0-<revision>/linux-x64/
```

From the same clean reviewed revision, verify it without rebuilding or rerunning
acceptance:

```sh
node scripts/verify-candidate.mjs /path/to/candidate
```

If the candidate fails, fix the source or dependency, commit the change, and
build a new candidate. Never edit candidate contents in place.

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
and `gh`, then inspect the publication plan:

```sh
npm run release:publish -- --candidate /path/to/candidate \
  --public-key /secure/offline/qubicl-release.public.pem \
  --signature /path/to/candidate.signature.json
```

The dry run verifies the full candidate and the exact checkout but performs no
remote mutation. After explicit approval:

```sh
QUBICL_RELEASE_APPROVAL=0.2.0 npm run release:publish -- \
  --candidate /path/to/candidate \
  --public-key /secure/offline/qubicl-release.public.pem \
  --signature /path/to/candidate.signature.json --publish --yes
```

The guarded publisher:

1. logs Skopeo into GHCR using the active GitHub CLI token without printing it;
2. copies and verifies all five exact versioned OCI indexes;
3. verifies that all five GHCR packages permit anonymous pulls;
4. publishes the exact npm tarball under a temporary `next` tag and verifies its
   registry integrity;
5. creates and pushes the annotated tag for the candidate version;
6. creates the GitHub release with the native archive, checksums, catalog,
   candidate manifest, SBOMs, and vulnerability summary; and
7. only after those checks pass, moves the GHCR and npm `latest` tags.

GitHub creates container packages pushed from the command line as private and
does not provide a supported package-visibility REST operation. On the first
run, the publisher therefore stops after the verified versioned image upload
and prints the five package-settings links. Set each package to **Public**, then
rerun the same command. The npm package is not published until all five image
packages report public visibility, so `qubicl setup` cannot be stranded behind
private images.

Publication is retry-safe when existing versioned npm/image objects match the
candidate and fails if they do not. Existing GitHub releases must also match
the exact commit, title, notes, state, asset set, sizes, and SHA-256 values. It
never changes repository or package visibility.

## After publication

From a clean user environment:

```sh
npm install -g qubicl-cli@0.2.0
qubicl setup
qubicl doctor
```

Create one computer, connect one real client, open the viewer, and verify an
upgrade while preserving the computer's home. If that smoke fails, do not move
or advertise additional mutable tags; document and fix the release.

## Supported and 1.0 releases are deliberately stricter

The full cross-platform/reboot matrix, complete real-client evidence,
independent security review, and individually reviewed remaining
HIGH/CRITICAL findings are requirements for the `supported` tier and eventual
1.0—not artificial blockers for publishing an honest pre-1.0 `initial` release.

Every v0.2 release uses release-set schema 2. An `initial` set contains the one
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
The initial profile requires Codex, Open WebUI, MCP stdio, MCP HTTP, OpenAPI,
and Open Terminal. The supported profile requires all nine named applications
and all four protocol probes. Adding this gate does not produce the evidence:
the required real-client runs must still be performed against the frozen
candidate before acceptance is signed.

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
