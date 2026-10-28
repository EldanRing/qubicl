# Releasing Qubicl

This is the active release procedure for the 0.7 design. It supersedes the
same-version image reuse and blanket qualification requirements of earlier
release procedures. Historical candidates remain verifiable under their
original schemas. See [decision 0004](docs/decisions/0004-practical-computers-and-releases.md).

Build and publish on maintainer-controlled local hardware. Do not use GitHub
Actions, repository runners, or paid build/test services. A request to ship a
named version authorizes its required checks, commits, push, tag, and publication;
it does not authorize deleting user data. Keep private keys and private worklogs
outside the public repository.

## Select the work and verification

Prepare a short plan of included commits, changelog entries, compatibility or
migration impact, affected artifacts, and relevant checks. Accumulate changes
under `Unreleased`; bump workspace manifests and the lockfile together only when
preparing an approved release. Add dated notes in `release-notes/vVERSION.md`.

Select focused source checks for the actual change. `release:check` is an
available aggregate, not a mandatory sequence to repeat for every release.
Use [development guidance](docs/development.md#choose-checks-for-the-change)
and retain exact commands, outcomes, and input identities. Real-client or
physical-platform claims require observations of those clients or machines.
Mock tests and produced native archives do not establish that support.

The supported publisher accepts a signed qualification decision. Every
impact-selected check is recorded as **passed**, **failed**, or **unverified**,
with an explanation. Passed and failed rows reference hashed evidence. An
incomplete or failed row requires `publish-with-limitations` and an exact public
release-note disclosure. Never change a failed result to passing or quietly
remove a selected check. Maintainers decide whether the stated limitations are
acceptable for the requested release; a new session does not invalidate useful
evidence. This process does not bypass artifact, signature, vulnerability,
source-history, or integrity verification.

## Build and reuse exact artifacts

Use a patched Node version from the declared engine range. Development accepts
npm `>=10.9.9 <13`; `packageManager` retains the default release toolchain pin.
The candidate records actual Node/npm/Docker/Buildx versions. Use the reviewed
Trivy version enforced by `scripts/candidate-evidence.mjs` and a locally
checksum-verified Gitleaks build. Check source/privacy with `npm run public:check`.

Freeze the reviewed source commit before generating its impact document:

```sh
npm run release:impact -- --base vPREVIOUS --output /secure/release-impact.json
npm run candidate:release -- --impact /secure/release-impact.json \
  --reuse /path/to/previous-candidate/linux-x64
```

The first command binds the exact Git range. The second is read-only and prints
`buildImages`, `reuseImages`, and `scanImages`. Omit `--reuse` for the first build.
After reviewing that plan, construct once:

```sh
npm run candidate:release -- --impact /secure/release-impact.json \
  --reuse /path/to/previous-candidate/linux-x64 --execute
```

`candidate:release` selects the pre-1.0 initial tier. `candidate:local` selects
the supported tier; it uses the same qualification path described below.

Candidate schema 8 carries image-input schema 2. The CLI/catalog release version
is independent of image origin versions. Root/workspace version-only changes do
not rebuild images. Runtime sources, external dependency versions and integrity,
Dockerfiles, and mapped build inputs remain significant. The lockfile identity
includes the relevant runtime dependency closure and build tools. An unclassified
input invalidates every image. An origin must be an ancestor of the candidate,
reproduce its per-image input identity, and retain its actual version and build
toolchain. Legacy provenance is verified before conversion to the new map.

The catalog uses the current release tags with exact immutable image digests.
Unchanged bytes retain their original embedded version, revision, manifests,
SBOMs, and attestations; publication adds current-version aliases. Do not rebuild
an image just to make its embedded version match the CLI. Native/npm packages
carry preset manifests matching those actual image origins.

The builder copies and verifies unchanged archives, builds only changed images,
and refreshes only affected or stale image scans. Scan-binding schema 3 records
scanner/database provenance per report; each image still has amd64 and arm64
reports bound to its exact OCI platform bytes. Expired advisory data requires a
rescan, not a rebuild. The efficiency report is reused when its archives are
unchanged and verified from those bytes. A complete publication still contains
six image references and the exact npm/Linux x64 artifacts; this is not a
partial or unsigned publication mode.

The builder uses an isolated source checkout, clean dependency installation,
SBOMs, audit/signature evidence, exact npm/native artifact acceptance, and final
candidate verification. It never publishes. If the advisory endpoint is down,
`QUBICL_AUDIT_REUSE_PATH` may supply the existing bounded audit-reuse mechanism;
the verifier still checks identity and freshness. Security exceptions and
applicability statements remain explicit, scoped, dated records in `security/`.

## Recover a failed construction

Diagnose the specific failed step. Do not start another full candidate because a
process is quiet or a late check failed. Preserve completed bytes and their logs.

```sh
npm run candidate:resume -- release/candidates/.failed-VERSION-REVISION-TARGET.PID
```

Resume verifies a complete preserved candidate without rebuilding or repeating
acceptance. For incomplete staging, plan with `--reuse-failed DIRECTORY`, then
append `--execute`. That recovery path currently requires the same release
version. A complete candidate can donate unchanged images across versions.
Source changes require a new commit and plan; never edit an immutable candidate.

## Release set and qualification

Place the complete member under `RELEASE_DIRECTORY/linux-x64`. Optional native
members must be built on the actual target hardware with `--binary-only`, the
same `--impact`, the same tier (`--initial` for initial releases), and `--catalog`
pointing to the complete member's catalog. Keep its adjacent `image-inputs.json`
so native packaging preserves the image origins. Copy each verified member to
its named target directory.

Schema-3 release sets select native targets explicitly, defaulting to Linux x64:

```sh
npm run candidate:release-set -- /path/to/RELEASE_DIRECTORY
# Or select only the native archives being shipped:
npm run candidate:release-set -- /path/to/RELEASE_DIRECTORY \
  --targets linux-x64,linux-arm64,darwin-arm64
```

Do not run both examples against the same existing output. A native target's
presence is an artifact declaration, not a claim that its hardware acceptance
passed. Broader 1.0 support policy must be an explicit product decision, not an
inherited four-platform or nine-client quota.

Create a release key only if one does not already exist. Sign the candidate and
release set, then create the qualification template:

```sh
npm run candidate:sign -- sign /path/to/RELEASE_DIRECTORY/linux-x64 \
  /secure/release.private.pem /path/to/candidate-signature.json
node scripts/release-set.mjs sign /path/to/RELEASE_DIRECTORY/release-set.json \
  /secure/release.private.pem /path/to/release-set-signature.json
npm run candidate:qualification -- plan /path/to/RELEASE_DIRECTORY/release-set.json \
  /path/to/qualification.json
```

Fill the template's exact selected rows. Set the maintainer identity, approval
time, and publication decision. Evidence files must be regular files beneath
the qualification directory, at most 16 MiB each, with SHA-256 hashes. Retain
commands, target versions, tested artifact identities, and actual results in
those files; reuse is justified by matching relevant inputs, not by editing a
timestamp. Use distinct filenames because GitHub release assets share a flat
namespace. Remove secrets and personal/host data from evidence before hashing.

For every gap, release notes must contain the literal line text
`CHECK_ID: STATUS — REASON` from qualification. Then sign:

```sh
npm run candidate:qualification -- sign /path/to/RELEASE_DIRECTORY/release-set.json \
  /path/to/qualification.json /secure/release.private.pem \
  /path/to/qualification-signature.json
```

Legacy signed schema-4 `--acceptance` / `--acceptance-signature` bundles remain
supported with their original release-set and matrix rules. They are an optional
strict path for historical workflows, not additional requirements on the new
qualification path.

## Preview and publish

Install Skopeo and authenticate npm and GitHub CLI. Use the project identity
`Qubicl Maintainers <contact@qubicl.org>` for commits and public metadata. Keep
npm's public metadata email set to the project address. For agent-driven npm
authentication use `npm_config_browser=false` and the printed authentication URL.

```sh
npm run release:publish -- --candidate /path/to/RELEASE_DIRECTORY/linux-x64 \
  --public-key /secure/release.public.pem --signature /path/to/candidate-signature.json \
  --release-set /path/to/RELEASE_DIRECTORY/release-set.json \
  --release-set-signature /path/to/release-set-signature.json \
  --qualification /path/to/qualification.json \
  --qualification-signature /path/to/qualification-signature.json
```

This dry run verifies the exact checkout, candidate, release set, signatures,
evidence hashes, and release-note disclosures. It prints limitations and exact
publication objects without remote mutation. Notes also need the release-key
trust anchor enforced by the publisher. Review the plan, push the reviewed
commit to `main`, verify `origin/main` matches it, then repeat the command with
`QUBICL_RELEASE_APPROVAL=VERSION` and `--publish --yes`.

The publisher preserves the reviewed public root and linear history. It copies
exact OCI bytes, verifies versioned digests and anonymous GHCR access, publishes
the retained npm tarball under `next`, verifies npm integrity, tags the exact
source commit, uploads release artifacts and signed evidence, and only then
moves `latest`. Existing versioned objects must match; it never rewrites them
or changes package visibility. An npm HTTP 202 is an accepted upload still being
processed: wait for metadata and verify integrity rather than rebuilding or
republishing it.

## After publication

Verify published artifact identities and perform the small user-facing smoke
selected by the release plan. Record actual outcomes, limitations, commit/tag,
artifact hashes, and follow-up in the private worklog. A release does not
silently upgrade existing computers. Upgrade a named live installation only
when requested, preserving its durable data and runtime state.
