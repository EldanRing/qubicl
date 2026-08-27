# Verifying Qubicl artifacts

Qubicl releases retain checksums, a candidate manifest, SBOMs, vulnerability
summary, and exact image catalog. A detached project signature may also be
published when the release notes identify its public-key fingerprint.

## Local candidates

`npm run candidate:release` writes the initial pre-1.0 candidate beneath:

```text
release/candidates/<version>-<revision>/<target>/
```

`npm run candidate:binary` writes only the current host's native archive and evidence. Neither command uploads or publishes anything.

From the exact source revision recorded in `candidate.json`, run the single manifest-driven verifier from the repository root:

```sh
node scripts/verify-candidate.mjs release/candidates/VERSION-REVISION/TARGET
```

Do not rename, add, remove, regenerate, or extract files before verification. The verifier:

- checks that `SHA256SUMS` and `candidate.json` cover the complete directory with no missing, extra, nested, or path-traversing entries;
- binds the image catalog's exact release version, full revision, normalized source URL, platform matrix, requested references, and immutable digests to the candidate;
- installs and inspects the staged npm tarball and extracts the staged native archive without packing or rebuilding;
- proves the build used a clean exported source tree and fresh `npm ci`, with
  exact lockfile, registry, dependency inventory, audit, and registry-signature evidence;
- proves that npm and native executable code embeds the candidate's exact catalog/versioned image references, contains no development system-image defaults, and matches the retained SPDX documents;
- validates npm package/bin identity, native executable target and legal/readme payloads, and SPDX root/namespace version-source-revision identity;
- compares the metafile-derived SPDX component inventories with `THIRD_PARTY_NOTICES.txt`, including bundled gateway/control dependencies and excluding test-only dependencies;
- derives all five OCI archive checks from the manifest and validates both platforms, labels, preset manifests, SLSA provenance, and OCI SPDX attestations;
- validates all ten Trivy reports, binds each report to the exact OCI archive,
  index, platform manifest, config, layers, DiffIDs, scanner options, scanner
  version, and fresh vulnerability-database bytes, rejects builder-path
  disclosure, and recomputes `trivy-summary.json`; and
- rejects every secret or HIGH/CRITICAL finding that lacks one exact, reviewed,
  unexpired exception or `not_affected` applicability statement under the
  supported-release policy.

A complete candidate contains gateway, file-system, browser, computer, and workstation OCI archives plus one Trivy report for each Linux amd64/arm64 image variant. Do not use the lower-level OCI inspector by hand as a substitute for the directory verifier; the directory verifier supplies its required version, revision, source, preset, and expected-manifest arguments.

## Client conformance acceptance

Acceptance schema 3 remains verifiable for v0.1 release sets. A v0.2 or later
release set requires schema 4 and the exact
[`client-conformance-v1.json`](conformance/client-conformance-v1.json) contract.
The acceptance directory contains a byte-identical sibling copy of that file;
the validator checks its SHA-256 against the reviewed source revision before it
examines any client result.

Schema 4 separates real application runs from standards-level protocol probes.
It requires exact installed versions for Codex, Claude Code, OpenCode, OpenClaw,
Hermes Agent, Open WebUI, Claude Desktop, Cursor, and VS Code, plus independent
MCP stdio, MCP HTTP, OpenAPI, and Open Terminal rows. Every row is exercised on
the `workstation` preset and has its own tester, post-freeze UTC timestamp, and
hashed evidence reference.

Each applicable discovery, transport, result-mode, screenshot, file, browser,
and human-takeover surface also has a passing post-freeze result and hashed
evidence reference. One comprehensive report may support multiple surface rows,
but each surface remains a distinct result in the acceptance record; a matching
hash proves only which bytes were reviewed. Missing, extra, failed, pre-freeze,
unhashed, or detached surface records fail acceptance.

The validator performs no network lookup and does not run or install clients.
Passing evidence must come from maintainer-supplied real clients and accounts;
the schema and its unit tests are not a claim that those runs occurred.

## Platform conformance acceptance

Acceptance schema 4 also requires the exact
[`platform-support-v1.json`](conformance/platform-support-v1.json) matrix. The
acceptance directory carries a byte-identical sibling copy and records it under
`platformConformance`; the validator checks that copy against the clean reviewed
source revision before accepting any platform row. Schema-3 v0.1 evidence keeps
its original five-row validation and does not require this newer file.

The matrix separates support policy from evidence status. Linux x64, Apple
Silicon macOS, and Windows 11 x64 through Ubuntu 24.04 on WSL 2 retain their
directly tested baseline. Linux ARM64 and Intel macOS remain best-effort, while
other WSL 2 distributions and Windows on ARM are explicitly best-effort outside
the five-row acceptance set. Native Windows and WSL 1 are unsupported. Every
host still runs Qubicl computers as Linux containers rather than native host
workloads or a VM security boundary.

Each schema-4 platform row is checked against its reviewed host OS,
architecture, execution mode, Linux-container runtime, exact version fields,
and required restart/reboot results. macOS rows additionally require an exact
Docker Desktop version and Docker Desktop restart result. The Windows row must
identify Windows 11 x64 and Ubuntu 24.04, and retains the WSL shutdown, Windows
reboot, Linux-filesystem, DrvFS rejection, localhost, pinned stdio launcher, and
viewer-handoff checks. Each row still requires a tester, post-freeze UTC time,
passing result, and SHA-256-bound local evidence file.

The matrix and validator do not perform hardware tests. A v0.2 acceptance
bundle can pass only after maintainers execute these rows on the frozen
candidate bytes and retain the actual reports. Completing a best-effort row for
one candidate does not by itself change the public support policy.

## Native archives

Windows users run the Linux archive/package inside a supported WSL 2
distribution with Docker Desktop; Qubicl does not publish a native Windows
archive. See [Windows Subsystem for Linux](docs/wsl.md).

Use the archive matching the host OS and CPU. Every native archive must contain:

- the `qubicl` executable;
- the Apache-2.0 `LICENSE`;
- `THIRD_PARTY_NOTICES.txt`;
- `NODE_LICENSE` for the embedded Node runtime;
- `README.md`;
- `SBOM.spdx.json`; and
- the exact image catalog and runtime assets.

Candidate assembly extracts and runs the staged archive's binary for its version/revision smoke check. Complete Linux candidates additionally run Docker E2E through that same staged archive.

## npm tarball

`npm run test:install` is the ordinary development preflight and creates a fresh temporary package. Candidate assembly packs once, retains that tarball, and passes its pathname to preflight and E2E. The verifier requires its complete normalized manifest to equal reviewed source, forbids consumer lifecycle scripts and unexpected dependency/configuration fields, and tests a normal installation without suppressing lifecycle behavior. Those candidate checks never invoke `npm pack` or rebuild the package.

The staged npm artifact contains `dist/SBOM.spdx.json`; `qubicl-npm.spdx.json` is the byte-identical retained copy bound by the candidate checksums.

## Vulnerability applicability and exceptions

The maintained policy and distinction between source records and exact
candidate evidence are summarized in
[security/README.md](security/README.md).

`security/vulnerability-applicability.json` records exact CVE, binary package,
installed-version, image, and architecture scopes. `under_investigation` is
non-approving and remains blocking for a supported candidate. A `not_affected`
statement requires evidence, an identified reviewer different from the owner,
review and expiry times, and HTTPS references. It expires after at most 90 days.
Unused, stale, overlapping, future-dated, or expired statements fail
verification. Every accepted not-affected match remains visible in
`trivy-summary.json`.

For an initial pre-1.0 candidate, unfixed distribution findings remain visible
in `trackedFindings`; secrets and scanner-reported available fixes still fail.
The stricter supported/1.0 candidate requires every remaining HIGH or CRITICAL
finding to be covered by a narrow current review record.

Exceptions expire after at most 90 days. Chromium exceptions affecting browser-bearing presets expire after at most 30 days and must explicitly analyze hostile input and verify that Qubicl's Chromium namespace and renderer seccomp-BPF sandboxes remain enabled under the constrained session profile. Any record that does not preserve this posture fails verification. Unused, overlapping, future-dated, expired, or blanket exception scopes fail verification. Secrets can never be excepted.

“No vendor fix” means only that the current package feed offers no fix; it is not an automatic acceptance.

## What the evidence proves

- A checksum proves that a file matches the reviewed manifest after the manifest is trusted.
- Embedded OCI provenance records how Buildx created the image; it is not a project signature.
- A bundle-derived SBOM inventories discovered shipped components; it is not a vulnerability guarantee.
- A scan and its reviewed exceptions are time-bound security decisions, not proof that an image is safe.
- Platform acceptance proves behavior only on the recorded OS, CPU, runtime, version, revision, catalog, and artifact bytes.

When a detached signature is published, verify it using the exact Ed25519 public
key and commands in [RELEASING.md](RELEASING.md). Checksums without a trusted
signature detect corruption after the manifest is obtained but do not prove who
created it.
