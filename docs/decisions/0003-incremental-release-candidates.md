# Decision 0003: planned incremental release candidates

Status: accepted and implemented for Qubicl 0.6.

## Context

The old candidate command rebuilt six multi-platform OCI archives and repeated
source, package, native, scan, and archive inspection work after every late
source fix. The release-wide impact document describes everything changed since
the prior public version, so it cannot by itself decide whether bytes from a
newer unpublished candidate remain applicable. Commit labels also made a new
source revision look like an automatic reason to rebuild every image even when
none of that image's inputs changed.

This made a small host-CLI compatibility fix take hours and encouraged repeated
manual restarts. More repetition did not provide stronger evidence when the
underlying image inputs and archive bytes were unchanged.

## Decision

Candidate construction is read-only by default. It prints the images it will
build, reuse, and scan; only `--execute` starts one run. Failure terminates that
run and preserves complete staging when possible. No release command retries or
launches a replacement candidate automatically.

Schema-7 candidates include `image-inputs.json`. Each of the six images records:

- the release version;
- the ancestor commit that produced the archive;
- a SHA-256 over the Git tree entries mapped to that image and the
  image-relevant root manifest fields; and
- the original Node, npm, Docker, and Buildx identities.

The verifier recomputes the mapped input identity at both the origin and current
candidate commits. The origin must be an ancestor, the release version must be
the same, and unknown paths affect all images. A current build-tool difference
does not invalidate immutable bytes; it is retained as part of the old image's
origin evidence.

Fresh Trivy results can follow unchanged archive bytes. Their exact archive,
platform, layers, database, check bundle, version, and report hashes remain
verified. Expired or future-dated scan evidence triggers a scan of the immutable
archives without rebuilding them. If all images are unchanged, the exact OCI
efficiency report is copied and regenerated during final verification.

Source E2E belongs to the pre-freeze release check. Candidate construction runs
exact npm and native acceptance against the selected catalog once. Hashes and
full OCI inspections are cached within one verifier call so the catalog, scan,
and efficiency assertions share the same read.

The release set uses the immutable candidate commit time as the qualification
boundary. Evidence collected after source freeze stays applicable when native
members are assembled later. Publisher dry runs are local; remote-history
alignment remains a requirement only for an explicitly authorized publication.

## Consequences

Publication still carries one complete signed candidate and all six versioned
images. Per-image origin revisions can differ from the candidate revision, and
the catalog and packaged preset manifests must use those origins. Any mismatch,
deleted mapped input, different release version, missing provenance, stale scan,
unexpected path, or changed archive fails closed or selects a rebuild.

This decision reduces repeated construction. It does not turn old evidence into
a pass: final candidate verification, exact artifact acceptance, selected real
client/platform evidence, signatures, and explicit publication approval remain
required.
