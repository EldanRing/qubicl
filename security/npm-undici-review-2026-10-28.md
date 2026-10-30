# npm-bundled Undici review — 2026-10-28

Scope: initial-tier Qubicl 0.7.0 computer presets on Linux amd64 and arm64.
This is a release-specific, time-limited risk acceptance, not a clean-scan claim
or an independently reviewed supported/1.0 qualification.

## Evidence and reachability

The exact image reports locate Undici 6.29.0 at
`/usr/local/lib/node_modules/npm/node_modules/undici/package.json`, bundled by
upstream npm 12.2.1. The registry currently tags npm 12.2.1 as latest and 11.21.1
as next-11. Both inspected upstream archives bundle Undici 6.29.0. No released
compatible npm replacement containing the fixed dependency was found.

The npm 12.2.1 archive SHA-256 is `228bd64aaef23270dbdbd2cf3d5ef5c467602ef38c4066246cef1984adab9a67`.
Its `node_modules/node-gyp/lib/download.js` SHA-256 is
`e136afe6ae2828114abf0ddae296d1fdd0c8e418922f7f6f6363bc51761db5fe`. Static inspection of the archive's
JavaScript imports identifies node-gyp's downloader as the consumer of this
private Undici copy. Qubicl's gateway/control bundles do not import that copy.
This review does not assert that arbitrary guest code cannot import npm internals.

- [CVE-2026-109383](https://github.com/nodejs/undici/security/advisories/GHSA-2m5v-pch6-74hx)
  requires a function-valued `tls` option. The bundled downloader instead uses
  `connect`, `requestTls` and `proxyTls` for CA configuration, matching the
  upstream workaround. The reviewed downloader does not exercise that trigger.
- [CVE-2026-109869](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c)
  can crash the downloader process on a malicious encoded response. It remains
  reachable if an installation contacts a malicious or compromised endpoint.
- [CVE-2026-87018](https://github.com/nodejs/undici/security/advisories/GHSA-qrxm-fqhp-jwvm)
  can likewise crash the downloader through TLS 1.2 certificate renegotiation.
  It remains reachable; ordinary TLS validation alone does not prevent it.

## Decision and review condition

Retain the unmodified upstream npm release under exact, 14-day exceptions for
this package/version and the four computer presets. Package installation is
explicit and runs in the unprivileged computer, under its existing network and
resource policy. This limits impact to guest work; it does not make the
vulnerable component safe or prevent an interrupted installation. Prefer trusted
header sources. No gateway authentication, TLS verification or host boundary is
relaxed. Do not import npm's private Undici as an application dependency.

The machine-readable records in [vulnerability-exceptions.json](vulnerability-exceptions.json)
expire at `2026-11-12T01:36:44Z`. Replace npm
and remove them as soon as upstream ships the fix, or re-review before expiry.
Expiry governs release evidence, not the runtime lifetime of installed computers.
The findings and accepted risks remain in candidate scans and release notes.
Brotli is separately upgraded to 1.2.1; it receives no exception.


## 0.8.0 revalidation — 2026-10-29

The same exact package/version and four computer-preset scope applies to the
initial-tier 0.8.0 candidate. Official npm dist-tags still select 12.2.1 for
latest/next-12 and 11.21.1 for next-11. The retained npm 12.2.1 archive and
node-gyp downloader match the hashes above; the bundled Undici remains 6.29.0.
The new desktop applications and control tools do not change this npm-private
consumer. Candidate scans must still identify the exact affected bytes and
apply the scoped records; this review does not approve other findings.

The original expiry remains `2026-11-12T01:36:44Z`; preparing 0.8 does not extend
it. The accepted availability risks and TLS applicability limits remain as
stated above and must stay disclosed in the 0.8 release notes.


## 0.8.1 revalidation — 2026-10-30

Official npm registry dist-tags still select 12.2.1 for latest/next-12 and
11.21.1 for next-11. The retained upstream 12.2.1 archive and node-gyp downloader
again match the hashes above; bundled Undici remains 6.29.0. The 0.8.1 browser,
desktop and document changes do not change this private downloader consumer.
The same exact four-preset initial-tier scope and original November 12 expiry
apply. Candidate scans must verify the affected bytes; no other finding is
approved and no exception is extended by this revalidation.
