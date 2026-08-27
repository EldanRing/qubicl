# Vulnerability evidence policy

Qubicl does not keep a point-in-time vulnerability scan in source and present
it as current. OS packages and vulnerability databases change independently of
the repository, so release decisions use reports generated from the exact
candidate images and retained with that candidate.

`security/vulnerability-applicability.json` is an empty source template for
narrowly scoped review records; point-in-time development findings do not live
in the public source tree. `under_investigation` records never permit a
supported release. `security/vulnerability-exceptions.json` is the separate
exception mechanism and is also empty by default.

For the initial pre-1.0 release, candidate verification:

- rejects detected secrets;
- rejects HIGH or CRITICAL findings for which the scanner reports an available
  fix unless an exact current review record permits them;
- retains unfixed distribution findings in the candidate's
  `trivy-summary.json`; and
- never describes “no vendor fix” as proof that a component is safe.

The supported/1.0 policy is stricter: every remaining HIGH or CRITICAL finding
must have a narrow, independently reviewed, unexpired applicability statement
or exception that matches the exact package, version, image, and architecture.

See [VERIFYING.md](../VERIFYING.md) for the artifact contract and
[RELEASING.md](../RELEASING.md) for the release commands. The candidate's
checksummed reports—not this directory—are the evidence for a particular
release.
