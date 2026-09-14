# Constraints and their reasons

This register records consequential limits, their owners, and the conditions
for changing them. “Owner” means the product surface responsible for the rule,
not a person to ask before every operation. Current mechanisms describe Qubicl
0.6; candidate-specific results live in the signed release evidence. The
[0.6 decision record](decisions/0002-v0.6-capabilities-and-constraints.md)
defines the intended behavior and its remaining evidence requirements.

## Security and authority

| Rule and class | Owner and protected resource | Current mechanism and user cost | Decision and review condition |
| --- | --- | --- | --- |
| Cooperative computer — trust boundary | Runtime; host and other computers | One container shares PID/network namespaces and a durable home. Same-computer arbitrary execution can inspect or affect shared work. | Retain this model. Use separate computers for separate workspaces; do not describe tool profiles or chat folders as hostile-code isolation. Revisit only with a separately reviewed architecture. |
| No host authority for workloads — security boundary | CLI/runtime; host files, Docker, administrator credentials | No Docker socket, privileged container, host namespaces, or unrelated mounts. Host lifecycle actions stay with the operator. | Retain. Capability expansion must work within the computer; repository Git configuration and devcontainer hooks must not execute on the host. |
| Chromium sandbox — security boundary | Browser/runtime images; browser process isolation | Namespace and renderer sandboxes require an appropriate runtime profile and shared memory. The 0.6 launch path removes unsafe Playwright defaults, supplies a bounded `/dev/shm`, and exposes diagnostics. | Retain the sandbox. Candidate acceptance must exercise actual launch arguments and behavior for each browser-capable preset. |
| File/archive confinement — security boundary | File and backup services; unrelated paths | Descriptor-based file operations and bounded archive verification can reject unsafe links, special files, or excessive work. | Retain confinement. Expand safe link handling only with extraction and host-path tests; restored links remain untrusted data. |
| Separate administrator authority — security boundary | Host helper/gateway; management credentials | Separate origins, host-only operator routes, and explicit administrator authentication add a distinct sign-in flow. Routine saves are direct and local same-tab refresh preserves the session. | Retain reauthentication for destructive, interrupting, or authority-expanding work without granting workloads administrator authority. |
| Private gateway by default — security boundary and operator choice | Gateway; published access | Loopback by default. Remote TLS requires exact origins, certificates, and allowed networks. Managed SSH is a separate loopback-only publication. | Retain local defaults. Guide remote setup; DNS/certificates remain operator-managed. Test external paths and revocation before broadening access. |

The [security model](security-model.md) describes the mechanisms and known
limitations. Do not infer that a current implementation fully enforces a
boundary merely because it has an admission check.

## Workflow and resource limits

| Rule and class | Owner and reason | Current cost or configurability | 0.6 disposition and acceptance |
| --- | --- | --- | --- |
| Interactive ownership — ownership mechanism | Control service and client adapters; serialize browser, desktop, and PTY input | Observation, file work, and retained tasks continue across client disconnects. Old-owner queued interactive work is fenced at takeover. | Keep resource-specific ownership and proof checks. Qualify queued-action fencing and compatibility adapters. |
| Retained tasks — resource/lifecycle default | Process manager; tracked cleanup | Tasks retain records and logs across lease loss and reconnect. Runtime replacement interrupts ordinary jobs. | Expose stop, wait, output, input, and attachment. Restart declared services after runtime restart; never replay arbitrary jobs. |
| Viewer reconnect grace — UX default | Gateway; recover human ownership after a dropped connection | Control releases after a visible, configurable grace of 5–300 seconds; the default is 10 seconds. | Keep connected-viewer ownership. Qualify disconnect, reconnect, takeover failure, and operator recovery. |
| Installed application discovery — capability with resource bounds | Desktop service; controlled launch and handoff | A bounded catalog combines built-ins with user/system desktop entries whose executables resolve inside approved computer bin directories. Shell launch, unsafe document paths, and unbounded capacity remain rejected. | Keep observable executable identity, lifecycle, close warnings, and resource bounds; do not treat discovery as same-computer isolation. |
| Browser tab budget — resource default | Browser controller; bound memory and retained handles | Agent-opened tabs have a visible 24-tab budget. Qubicl reports exhaustion instead of silently evicting browser state; human-opened state remains usable. | Keep a documented explicit budget until resource-aware admission has release evidence. Preserve bounded results and cancellation. |
| Anonymous public extraction — security mechanism | Web/browser services; JavaScript rendering | Rendered public extraction uses an ephemeral context without persistent cookies, extensions, or service workers and enforces public-destination policy. | Retain separation from the normal profile and qualify redirect/request mediation before release. |
| Scoped restricted egress — network scope | Gateway; explicit destination grants | `web-only` and `custom` use the authenticated proxy; custom rules support domains, CIDRs, and TCP ports. `developer` allows normal outbound access; `offline` denies it. | Preserve explicit restrictions during migration and terminate managed tunnels when their rule expires or is revoked. |
| App-lifetime previews — lifetime/compatibility mechanism | Preview gateway; controlled app access | Each publication has an isolated origin, root-path proxying, app cookies, and owner access tied to the listening app. Remote shares use separately expiring credentials. | Preserve the owner/share distinction and terminate upgraded connections on revoke. |
| Bounded devcontainer subset — compatibility and host boundary | CLI importer; safe guest setup | JSONC, relative paths, harmless metadata, forwarded-port metadata, and guest lifecycle hooks are supported. Compose, host hooks, privilege expansion, and feature plugins remain rejected. | Keep hooks inside the guest and qualify offline acquisition and failure recovery. |
| Manual backups — product scope | Host lifecycle; deliberate durable-data operations | Operator initiates backup, verification, restore, and pruning. | Retain manual operation for 0.6. Improve consistency and recovery; scheduling is outside scope. |

Use [daily workflows](daily-driver.md), [client setup](clients.md), and
[troubleshooting](troubleshooting.md) for the current commands. Resource limits
that bound bytes, concurrency, or time need an explicit failure or truncation
result. They should not silently discard useful work.

## Support and maintainer policy

| Rule and class | Owner and reason | Review condition |
| --- | --- | --- |
| Platform footprint — support limitation | Platform qualification; evidence for actual host behavior | Keep CLI support separate from dashboard support and historical tests separate from candidate results. A produced artifact does not establish tested support. See [platforms](platforms.md). |
| Exact development npm version — current toolchain contract | Workspace manifests; lockfile/build consistency | The current `engines` and `devEngines` enforce the pin. Broaden the development range only with implementation and compatibility checks; do not tell contributors to bypass it. |
| Impact-bound release evidence — release implementation | Release builder/verifier/publisher; immutable artifact provenance | The 0.6 builder binds an exact base/candidate diff to required artifacts, scans, clients, protocols, and platforms. The publisher still fails closed unless the complete signed candidate boundary is present. | Add a narrower publication mode only when artifact/version coupling is implemented and reviewed. See [releasing](../RELEASING.md). |
| Focused development checks — contributor workflow | Maintainers; useful regression evidence at reasonable cost | Select checks for affected behavior; broad integration and release gates remain separately applicable. Reuse a successful check only while its inputs and environment still match. |
| Local execution and explicit publication — maintainer policy | Maintainers; repository, machines, and public artifacts | Local-only testing and owner approval gates remain in force. A product UX change does not authorize commit, push, publication, live upgrades, or cleanup. |

For a new hard restriction, record its class, responsible surface, protected
resource or compatibility reason, user cost, available configuration, evidence,
and a concrete condition for removal or expansion. Review this register when
changing the corresponding contract; it is not a list of permanent prohibitions.
