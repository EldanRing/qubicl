# Security policy

## Supported versions

Published `0.1.x` releases receive security fixes on a best-effort basis. The
`main` branch may change without notice. Pre-1.0 releases do not promise API or
state-format stability across minor versions.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
**Security → Report a vulnerability** form for this repository. If that form is
unavailable, contact [contact@qubicl.org](mailto:contact@qubicl.org).

In the first message, include only enough information to establish the affected revision or version, likely impact, and a secure follow-up channel. Do not send live Qubicl tokens, `secrets.yaml`, private viewer URLs, or unrelated personal data. Detailed reproduction material can be coordinated privately.

Maintainers aim to acknowledge a report within seven days and will coordinate disclosure after a fix or mitigation is available.

## Security boundary

Qubicl is a capable Docker development computer, not a VM-grade sandbox for hostile custom images or Docker/kernel compromise. Model commands and Chromium run as an unprivileged user without passwordless elevation. They do not receive Qubicl control credentials in their environment, but they share the computer container and PID namespace with its controller; human takeover is therefore a cooperative fence for Qubicl-tracked processes, not a hostile-workload security boundary. Browser-capable computers retain Chromium's Linux namespace and renderer seccomp-BPF sandboxes through a computer-only default-deny seccomp profile; they do not use `--no-sandbox`, `SYS_ADMIN`, privileged mode, or an unconfined container profile. Outbound access follows the selected per-computer network profile; the default `developer` profile is unrestricted. Only the computer's bind-mounted `/home` is durable.

Read the complete [security model](docs/security-model.md) for trust assumptions, enforced boundaries, limitations, credential handling, and remote-access consequences.
