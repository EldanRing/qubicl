# 0004: Practical computers and releases

Status: accepted; implemented in the unreleased 0.7 work. Release qualification
and live-platform results remain separate from implementation verification.

## Problem

CLI version numbers, runtime image construction, and broad acceptance matrices
had become unnecessarily coupled. Ordinary software installation required too
much image authoring, desktop executable location checks duplicated a boundary
the shared computer does not provide, and remote clients needed a TLS deployment
when an existing SSH connection was sufficient.

## Decision

1. Image inputs and actual origin provenance determine reuse across CLI versions.
   A new release catalog may point to unchanged image digests. Scan freshness is
   per image; stale advisory evidence does not invalidate immutable bytes.
2. Qualification is a signed maintainer decision consumed by the normal publisher.
   Account for impact-selected checks, retain actual results, and disclose failed
   or unavailable checks publicly. Choose native artifact targets explicitly.
   Artifact integrity, trust roots, scan policy, and protected user data remain
   enforced. Historical acceptance schemas stay readable under their own rules.
3. User Python and npm tools live in the durable home. System packages use a
   managed apt recipe built into a derived image during an explicit named
   upgrade. Python ABI changes keep the previous environment and require package
   reinstallation; startup does not download packages. `upgrade --all` continues
   to leave custom/recipe images for named upgrades.
4. Desktop launches accept executable names, symlinks, and absolute executable
   paths. They run directly as the workload user with observable identity,
   bounded processes, confined document paths, and existing ownership rules.
   Executable location is not a same-computer security boundary.
5. Use upstream dependency releases and compatibility-aware remediation. Do not
   patch npm's private dependency tree to satisfy a scanner. Prefer a compatible
   fixed release, removal of an unused component, or a documented scoped security
   exception when applicable. Keep a default release toolchain pin while allowing
   a supported development npm range.
6. Qubicl can live on an always-on Linux host using that host's local Docker
   daemon. Client stdio can travel over OpenSSH without exposing the gateway or
   storing computer bearer credentials on the client. Host keys and account
   permissions remain OpenSSH's responsibility; Qubicl adds no cloud service.

## Compatibility and limits

No version is bumped by this implementation. Saved `software` configuration and
new executable-path tool inputs require the new CLI/runtime; older strict state
readers cannot read recipe-bearing configuration. Homes, tokens, and IDs are
preserved by the existing upgrade transaction. Managed recipes are local build
intent, not a reproducible package lock or a bundled backup of the derived image.
Secret-free manifest export still exports image identity, not the local recipe;
installation backups retain configuration. Pin package versions when required.

This decision supersedes the same-version reuse restriction in decision 0003,
the exact development npm rule in the constraints register, and blanket release
matrix requirements for the new qualification path. It does not expand claimed
platform support. Future restrictions need a protected resource or compatibility
reason and a review condition; historical test matrices are useful evidence,
not automatic quotas for every edit or release.

## Verification and review

Focused tests cover version-only reuse, dependency invalidation, evidence
integrity/disclosure, desktop launch locations, saved recipe validation, and SSH
configuration. A bounded Docker Desktop check built and validated a derived
apt image, verified offline reuse, and retained Python/npm packages across two
isolated containers using the same temporary home. Upstream npm 12.2.1 passed
that installation/executable check. Candidate construction, physical platforms,
and actual release publication require their own release evidence. Review the input map whenever
build inputs change and the npm range when a new major version is considered.
Review recipe behavior when changing the base distribution or Python ABI.
