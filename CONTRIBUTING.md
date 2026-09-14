# Contributing to Qubicl

Qubicl is under active pre-1.0 development. Focused issues and pull requests
are welcome; public interfaces and state formats may still change before 1.0.

## Before opening a change

- Search existing issues and pull requests.
- Open an issue before a substantial behavior, architecture, state-format, or public-interface change.
- Keep a pull request focused and explain the user-visible outcome.
- Describe effects on persistence, mounts, networking, authentication, privileges, clients, and supported platforms.
- Never include credentials, tokens, private routes, viewer tickets, unredacted diagnostics, or `~/.qubicl` contents.

By contributing, you confirm that you have the right to submit the work. Code,
documentation, and other non-artwork contributions are licensed under
Apache-2.0. Contributions incorporated into the designated artwork paths in
[BRANDING.md](BRANDING.md) are licensed under CC BY 4.0.

## Development setup

Use a supported Node.js version, Docker Engine or Docker Desktop, and Docker Compose. Run Qubicl as your normal host user, not with `sudo`.

```sh
npm ci
npm run build:types
# Select the compiled tests relevant to the change, for example:
node --test dist-tests/unit/contracts.test.js
```

For documentation-only changes, inspect the diff and check links and claims;
no dependency installation or runtime build is needed. For code, choose checks
from the [change-to-check guide](docs/development.md#choose-checks-for-the-change).
`npm run check` is the full source gate, and Docker acceptance is a separate
gate for affected runtime workflows. Docker runs build large images and change
local Docker state temporarily, so let one run finish before starting another.

## Local-only project automation

Qubicl does not use GitHub Actions, repository self-hosted runners, paid CI, or paid build/release services. Maintainers run tests and release preparation directly on controlled local hosts. External contributors should report the exact commands and environment they tested; maintainers independently run the required local gates before merging or releasing.

Do not add a workflow file as part of a contribution.

## Pull-request checklist

- Add or update tests for behavior changes.
- Report the focused checks you ran and any relevant checks still outstanding.
- Run relevant Docker acceptance, or explain why it does not apply.
- Update documentation and `CHANGELOG.md` for user-visible changes.
- Keep generated output and local candidates out of commits.
- Confirm no credential, private state, or unrelated host information is included.

The public [roadmap](ROADMAP.md) summarizes product direction without promising
dates. Security reports belong in the private process described in
[SECURITY.md](SECURITY.md), never in a public issue.
