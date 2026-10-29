# Observable computers and workstation applications

Status: accepted for 0.8; implemented and locally verified on Linux x64; not released.

Qubicl already provides a persistent computer. The reviewed gaps concerned
reliable observation, targeting and continuation, rather than replacing its
container boundary or making it an assistant platform.

The development contract adds authenticated captured browser reading, exact
snapshot continuation, native window inventory and AT-SPI refs, window-targeted
input, optional post-action observations, and normal app close. Observations
remain passive untrusted data; input uses existing interactive ownership.
The native helper and applications share one guest-owned session bus and run
as the workload user. No host desktop or new external service is required.

Search keeps keyless DDGS. URL domain filters are enforced locally; provider
date/language requests are labeled honestly and unsupported combinations fail.
Retrieval timestamps are not publication timestamps. Support is tied to the
pinned backend implementation and should be revisited when that dependency changes.

The user chose GIMP, Inkscape, Blender, FreeCAD and Kdenlive as workstation
defaults. Other presets keep their existing application packages. Skills track
actual preset dependencies; a fixed number of bundled skills is not a design
requirement. Existing operator activation choices remain authoritative.

Bounded captures, native snapshots and timeouts protect resources and keep tool
results usable. Continuations must not silently skip omitted content. Bounds
are revisited when a concrete workload cannot be completed through pagination,
subtrees or an explicit screenshot fallback. Missing app accessibility is
reported rather than fabricated. Dispatch and API acceptance do not imply
verified task success.

The changes use development control protocol 12. Package versions and published
0.7 artifacts stay unchanged until a separately approved release. Current
verification and remaining release/platform qualification belong in the
maintenance records; [desktop control](../desktop-control.md) and
[web research](../web-research.md) describe implemented behavior.

The subsequent audit implementation preserves original data when a conversion,
edit or update cannot establish success. Dispatch receipts control automatic
retries; operation uncertainty requires observation. File save guards and service
readiness/restarts are optional. Render manifests identify captured source bytes
and exact generated pages without claiming visual fidelity.

The Office follow-up implements the previously restricted operations: chart-slide
duplication copies owned package parts and workbooks independently; spreadsheet
structure edits transform native table schemas and dependent formulas/drawings;
Word reading projects final/original views and exposes both with anchored revision
records in markup mode. These operations no longer use blanket refusals or
incomplete-view warnings. Chart caches refresh from available source values;
formula-derived values use normal workbook recalculation. Text projection and
package preservation do not certify identical layout in every Office application.
Office conversion blocks macros and untrusted external links separately;
LibreOffice's broad active-content switch is not used because it also removes
embedded charts from otherwise successful conversions. Revisit these individual
controls when the converter changes, preserving visible chart content and testing
that external linked images are not fetched.
These choices are implemented, not release gates.

Shared-computer observation and app publication lifetimes are independent of
interactive input ownership. Repeated snapshots reuse unchanged DOM references;
only genuinely new elements consume the bounded reference cache. Input ownership
is checked by the session against the controller between input steps, including
batched actions. Ordinary release and takeover preserve previews for retained
apps, while explicit revocation and runtime/policy resets retain their authority.
This separation prevents passive observers and handoffs from disrupting ongoing
work without weakening input fencing.
