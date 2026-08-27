# Skills

Every Qubicl computer has a durable, client-neutral skill store plus the universal `skills_list`, `skill_view`, and `skill_manage` tools. Those tools work through MCP, OpenAPI, and Open Terminal. Qubicl also projects enabled skills into `.agents/skills`, `.claude/skills`, `.codex/skills`, and `.hermes/skills` for agents that support native directory discovery.

## What ships

Qubicl ships six reviewed native core skills:

- `plan`
- `pdf`
- `docx`
- `xlsx`
- `powerpoint`
- `ocr-and-documents`

The packages use Qubicl tool names, resolve scripts through the canonical `resourceRoot`, and rely only on dependencies pinned in compatible curated images. Selected MIT-licensed helpers and workflow ideas were adapted from the exact upstream revision recorded in [the provenance record](../skills/PROVENANCE.md), but Hermes Agent itself and its bulk skill tree are not installed.

Default activation follows the image's tested dependencies:

| Preset | Enabled core skills |
| --- | --- |
| `file-system` | `plan` |
| `browser` | `plan`, `pdf`, `ocr-and-documents` |
| `computer` | all six |
| `workstation` | all six |

All six core working copies are installed in the durable home so an operator can enable a compatible package later. Activation does not manufacture missing image dependencies; the selector only offers core packages declared compatible with that computer's preset.

Qubicl refuses newly enabling an incompatible core package. If an older policy already contains one, it remains visible so the operator can disable it, but `skills_list` reports `availableOnPreset: false`/`supported: false` and `skill_view` fails with a capability error instead of presenting instructions whose dependencies are absent.

## Editable working copies

Core and imported skills have a reviewed baseline and one canonical working copy:

```text
~/.local/share/qubicl/skills/
├── installed/<name>/
├── baselines/imported/<name>/
├── custom/<name>/
├── trash/<timestamp>-<name>/
└── registry.json
```

The working copy is ordinary durable computer content. An agent or user with file access may edit or delete it. The four native discovery paths are relative directory symlinks to that same copy, so an edit made through any supported client is immediately visible to the others.

Qubicl reports `unchanged`, `modified`, `missing`, or `corrupt` by comparing a working copy with its recorded baseline. Routine materialization and upgrades preserve modified copies. `qubicl skills COMPUTER reset NAME --yes` is the explicit operation that discards local edits and restores a verified baseline. Core reset uses the image baseline; imported reset uses the snapshot captured at import time.

Editable packages remain bounded data. Qubicl refuses to follow symlinks or hard links—including substituted skill-store and native-discovery parent directories—and marks a working copy corrupt if it exceeds the package entry, file, path, per-file, or total-size limits. This prevents an agent edit from turning a later host-side inspection into an unbounded traversal or an out-of-home write. The operator can recover a corrupt core package with `qubicl skills COMPUTER reset NAME --yes`; imported packages reset only from their verified stored baseline.

An imported baseline also lives in the computer-owned durable home. Reset verifies
it against the operator-recorded digest and refuses if it was changed or deleted;
re-import the reviewed source in that case. A core baseline remains recoverable
from the read-only image even if the computer deletes every home copy.

This is intentionally not a privilege boundary. Qubicl protects operator activation policy, but it does not claim that instructions stored in an agent-writable home are immutable.

## Operator commands

Open the searchable selector:

```sh
qubicl skills research
```

Script core activation:

```sh
qubicl skills research --profile core --yes
qubicl skills research --disable pdf --yes
qubicl skills research enable pdf --yes
```

Import a local Agent Skills-compatible package. Imports are disabled by default:

```sh
qubicl skills research import ./example-skill --yes
qubicl skills research import ./example-skill --enable --yes
```

Import an immutable Git revision over HTTPS:

```sh
qubicl skills research import https://github.com/example/skills.git \
  --ref 0123456789abcdef0123456789abcdef01234567 \
  --path skills/example-skill \
  --yes
```

Inspect, update, reset, disable, and recover an imported package:

```sh
qubicl skills research inspect example-skill
qubicl skills research update example-skill ./example-skill --yes
qubicl skills research disable example-skill --yes
qubicl skills research reset example-skill --yes
qubicl skills research reset --all --yes
qubicl skills research remove example-skill --yes
qubicl skills research restore example-skill --yes
```

Git imports require a full 40-character commit SHA. Qubicl does not execute hooks, setup scripts, tests, or installers and does not perform automatic imports or updates.
Local-import metadata records only the selected directory name, not its absolute
host path. This avoids leaking host layout into the computer-owned registry.

## Import boundary

An imported package must have root `SKILL.md` YAML frontmatter with a lowercase kebab-case `name` matching the package directory and a bounded `description`. Qubicl:

- accepts regular files only and rejects symlinks, hard links, nested repositories, devices, sockets, and traversal;
- limits packages to 256 files, 2 MiB per file, 8 MiB total, and 240-byte resource paths;
- scans every text file and blocks known instruction-override, delimiter-forgery, concealment, and invisible-direction-control patterns;
- stores source provenance, the baseline SHA-256 digest, scan version, and findings outside the package content;
- preserves imported bytes and never follows URLs or instructions found inside the package;
- does not grant tools, credentials, egress, elevation, host mounts, or Docker access;
- does not certify third-party compatibility or install dependencies named by a package.

Imported skill packages are untrusted third-party instructions. Review them before import and again before activation. Detection is defense in depth, not proof that content is safe.

## Model-facing tools

- `skills_list` lists active, core, imported, or custom packages with sanitized provenance, preset availability, detected requirements, advisory-finding counts, the canonical editable root, current and baseline digests, and drift.
- `skill_view` reads a bounded resource from an enabled package's canonical working copy. A cached call for a disabled operator package fails closed.
- `skill_manage` creates, updates, enables, disables, or deletes agent-owned custom packages. It cannot alter operator-controlled core/imported activation, baselines, imports, resets, or removals.

Changing operator activation or imported baseline content refreshes runtime policy and revokes an active agent lease. Disabled packages disappear from Qubicl discovery and from managed native projections, while their durable working files remain available to the computer through ordinary shell/file access. Therefore disablement is a discovery and tool-policy control, not secrecy from a workload that already owns its home.

## Core catalog maintenance

Core definitions live in `skills/core-definitions.json`; packages live in `skills/core`; the generated reviewed catalog is `skills/core-catalog.json`.

After an intentional core package change:

```sh
npm run skills:catalog:update
npm run build
npm run test:unit
```

Normal builds verify the exact file list, digest, frontmatter, compatible presets, required Qubicl tools, review record, and current content-security findings. They never regenerate evidence implicitly.
