# Core skill provenance

Qubicl ships six Qubicl-native core skills under `skills/core`. Their current
instructions, helper scripts, compatibility declarations, file lists, security
scan results, and SHA-256 digests are recorded in `skills/core-catalog.json`.

Selected helpers and workflow ideas were adapted from the MIT-licensed
[Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/7d6db4efb885856078e4d19f804035226df81e0d) repository at
commit `7d6db4efb885856078e4d19f804035226df81e0d`. Each shipped package retains an
MIT license, and release artifacts include the corresponding attribution in
their third-party notices and SBOM metadata.

Qubicl does not vendor or distribute the complete Hermes Agent skill tree and
does not install Hermes Agent. The upstream revision is a provenance reference,
not a runtime dependency or a claim that other upstream skills are compatible
with Qubicl.

The maintained Qubicl packages were rewritten around Qubicl's actual tools,
durable-home boundary, dependency sets, and client-neutral `resourceRoot`.
`skills/reviews/core-skills.json` records the review scope. Every build verifies
the reviewed file list, declarations, content-security result, and digest; an
intentional package change requires `npm run skills:catalog:update` followed by
normal review and testing.
