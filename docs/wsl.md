# Windows Subsystem for Linux

Qubicl supports Windows 11 x64 by running the CLI, state, and Docker-facing
runtime inside a WSL 2 distribution. Docker Desktop provides the validated
local Linux Docker daemon. Windows applications can connect over localhost or
launch Qubicl's stdio bridge through an explicit `wsl.exe` adapter.

Ubuntu 24.04 is the directly tested distribution. Other current WSL 2
distributions and Windows on ARM remain best-effort; native Windows and WSL 1
are unsupported. See the versioned [platform support matrix](platforms.md) for
the complete policy.

This is a host-platform contract, not a Codex integration:

| Boundary | Current support |
| --- | --- |
| Qubicl CLI | Runs inside WSL 2 as the normal Linux user |
| Docker | Docker Desktop WSL 2 engine with integration enabled for the distribution |
| State and computer homes | WSL Linux filesystem, normally below `/home` |
| WSL-local clients | Normal stdio, HTTP MCP, and OpenAPI adapters |
| Windows-hosted clients | HTTP/OpenAPI over localhost or any stdio adapter with `--client-host windows` |
| Viewer | Loopback URL opened in the Windows default browser through WSL interoperability |
| Not supported | Native Windows execution, WSL 1, Windows-backed Qubicl state, remote Docker contexts |

Ubuntu 24.04 on WSL 2 is the Windows release-validation distribution. Other
current WSL 2 distributions with the documented Node, Docker, Compose, and
glibc behavior may work, but should not be advertised as directly validated
until they complete the same matrix.

## Fast path

For a new supported Windows 11 x64 installation, open PowerShell and install or
update WSL, then confirm Ubuntu 24.04 reports version 2:

```powershell
wsl --install -d Ubuntu-24.04
wsl --update
wsl --list --verbose
```

Install Docker Desktop, enable **Use the WSL 2 based engine**, and enable the
Ubuntu 24.04 distribution under **Settings > Resources > WSL Integration**.
Start the distribution, install a supported Node.js 22 or 24 release as the
normal WSL user, and run:

```sh
node --version
npm install --global qubicl-cli
docker version
docker compose version
qubicl setup
qubicl doctor
```

Keep the checkout, npm installation, `QUBICL_HOME`, and every computer home in
the WSL Linux filesystem under `/home`. Do not install a second Docker Engine
inside the distribution. If any fast-path check fails, stop before creating a
computer and use the focused checks below.

## Host preparation

Install current WSL and Docker Desktop, then enable **Use the WSL 2 based
engine** and enable the selected distribution under **Settings > Resources >
WSL Integration**. Docker recommends current WSL, with WSL 2.1.5 as its
minimum. Do not also install Docker Engine or the Docker CLI directly in the
distribution because competing installations can select the wrong daemon or
credential configuration.

Microsoft and Docker document the relevant platform behavior in their
[WSL interoperability](https://learn.microsoft.com/windows/wsl/filesystems#run-windows-tools-from-linux),
[WSL networking](https://learn.microsoft.com/windows/wsl/networking),
[WSL filesystem](https://learn.microsoft.com/windows/wsl/filesystems), and
[Docker Desktop WSL](https://docs.docker.com/desktop/features/wsl/) guides.

From PowerShell:

```powershell
wsl --version
wsl --list --verbose
wsl --update
```

The selected distribution must report version 2. From WSL, run these checks as
the normal user, without `sudo`:

```sh
printf 'kernel=%s\ndistro=%s\n' "$(cat /proc/sys/kernel/osrelease)" "$WSL_DISTRO_NAME"
cmd.exe /c echo interop-ok
docker version
docker compose version
docker run --rm hello-world
```

If `cmd.exe` cannot run, update WSL and confirm interoperability is enabled in
`/etc/wsl.conf`. Apply a configuration change with `wsl --shutdown` from
PowerShell, then reopen the distribution:

```ini
[boot]
systemd=true

[interop]
enabled=true
appendWindowsPath=true
```

Qubicl itself can operate without Windows interoperability, but it is required
for Windows-hosted stdio clients, automatic Windows browser opening, and any
Windows credential helper invoked from WSL. Setup reports missing interop as a
warning; the dependent commands fail with corrective guidance.

## Linux filesystem requirement

Keep the checkout, `QUBICL_HOME`, and computer homes in the WSL Linux
filesystem, for example:

```sh
mkdir -p "$HOME/src"
export QUBICL_HOME="$HOME/.qubicl"
```

Do not use `/mnt/c`, another `/mnt/<drive>` location, or a symlink that resolves
there. Microsoft and Docker both recommend the Linux filesystem for
Linux-command performance, file-change notification, ownership, and bind
mount behavior. Qubicl parses the active WSL mount table and rejects DrvFS and
Windows-backed 9P state paths before setup mutates state. The rule follows the
filesystem type, so it still applies if WSL drive automounting uses a custom
prefix.

Windows can inspect Linux files through `\\wsl.localhost\<distribution>\...`.
That is convenient operator access, not an isolation boundary from the same
Windows account. Do not treat WSL as a VM security boundary against the host
user.

## Build and install from source

Use the Node version in `.nvmrc` and the exact npm version declared by the root
`packageManager` field. Clone into the WSL filesystem:

```sh
cd "$HOME/src"
git clone https://github.com/EldanRing/qubicl.git
cd qubicl
npm install --global npm@10.9.3
npm ci
npm run check
npm run images:build
npm install --global --prefix "$HOME/.local" ./packages/cli
export PATH="$HOME/.local/bin:$PATH"
qubicl version
```

Persist `$HOME/.local/bin` in the shell profile if it is not already on `PATH`.
The image build creates the gateway and all four preset images from the same
source revision as the CLI.

For a private checkout, use an SSH key or authenticated credential helper. Do
not place a token in the clone URL or repository configuration. If GitHub CLI
for Windows is already authenticated and available as `gh.exe`, WSL Git can
delegate only credential lookup to it:

```sh
gh.exe auth status --hostname github.com
git config --local credential.https://github.com.helper \
  '!gh.exe auth git-credential'
git ls-remote origin HEAD
```

## Setup and normal use

Interactive setup is the normal entry point. This deterministic run is useful
for release validation:

```sh
qubicl setup --preset computer --cpus 2 --memory 3g \
  --gateway-port 3211 --create qubicl-1 --yes
qubicl status qubicl-1
qubicl doctor
qubicl doctor --json > qubicl-doctor.json
curl --fail --silent --show-error http://127.0.0.1:3211/health
```

Setup and doctor identify WSL 1, interop availability, the state filesystem,
Docker context and server platform, Compose, resources, localhost port, and the
real bind behavior used by computer homes. The bind probe runs with the host
UID/GID and tolerates Docker Desktop's brief bind metadata propagation.

The JSON report is intended for diagnosis, not automatic upload. Review it
before sharing and remove unrelated local paths or host details. Never attach
credentials, bearer tokens, protected state, computer-home contents, or viewer
URLs. Record the exact Windows, WSL, kernel, distribution, Docker Desktop,
Docker Engine, Compose, Node, and Qubicl versions separately for acceptance.

`qubicl view qubicl-1` prints the one-time loopback viewer URL and opens it with
the Windows default browser through `explorer.exe`. With interoperability
disabled, use `qubicl view qubicl-1 --no-open` and paste the printed URL into a
Windows browser.

## Clients on either side of WSL

A client running inside the same WSL distribution uses the default local
adapter:

```sh
qubicl connect qubicl-1 --client codex
qubicl connect qubicl-1 --client claude-code
qubicl connect qubicl-1 --client stdio
```

For a client installed on Windows, use `--client-host windows` with any stdio
adapter:

```sh
qubicl connect qubicl-1 --client codex --client-host windows
qubicl connect qubicl-1 --client claude-desktop --client-host windows
qubicl connect qubicl-1 --client cursor --client-host windows
qubicl connect qubicl-1 --client vscode --client-host windows
qubicl connect qubicl-1 --client opencode --client-host windows
```

The generated configuration uses `wsl.exe`, pins `$WSL_DISTRO_NAME`, and pins
the absolute Node and Qubicl entrypoint paths. `connect` prints that pinned
launcher configuration; it does not create or edit client configuration files.
The launcher does not depend on the Windows application's `PATH` or on shell
startup files. Re-run `connect` after moving or reinstalling Node or Qubicl.

Windows reaches services listening in WSL on `localhost` under WSL's default
NAT networking, so generic HTTP MCP and OpenAPI snippets need no host rewrite:

```sh
qubicl connect qubicl-1 --client generic --transport http
qubicl connect qubicl-1 --client generic --transport openapi
```

Qubicl stays bound to `127.0.0.1`. Do not change it to `0.0.0.0` for WSL
convenience. Mirrored networking is optional and is not required for the
supported Windows-to-WSL localhost path.

## Candidate acceptance matrix

Record exact Windows, WSL, distribution, Docker Desktop, Docker Engine,
Compose, Node, and npm versions with the candidate. A Windows support claim
requires all of the following on the candidate bytes:

1. Run `npm run check`, build all five images, install the candidate CLI, and
   complete setup on a WSL Linux path.
2. Confirm `qubicl doctor` has no failures, and preserve its secret-free JSON
   output with `qubicl doctor --json`.
3. Reach gateway health from WSL with `curl` and from PowerShell with
   `curl.exe http://127.0.0.1:3211/health`.
4. Open the authenticated viewer in the Windows browser and complete one
   human-takeover and release cycle.
5. Complete one WSL-local stdio session and one Windows-hosted stdio session.
   Use different adapters if available so the result is not client-specific.
6. Exercise direct HTTP MCP or OpenAPI from a Windows-hosted client.
7. Restart Docker Desktop. Verify the gateway, the running/stopped container
   policy, route health, and durable-home contents.
8. Run `npm run test:reboot:prepare`, execute `wsl --shutdown` from PowerShell,
   reopen WSL after Docker integration is ready, then run
   `npm run test:reboot:verify` and `npm run test:reboot:cleanup`.
9. Reboot Windows once and repeat doctor, health, client reconnection, viewer,
   and durable-home checks.
10. Confirm setup rejects a disposable test `QUBICL_HOME` on `/mnt/c`, while
    unit coverage rejects WSL 1, missing interop for Windows stdio, and
    Windows-backed mount-table fixtures.

Do not retain credentials, bearer tokens, protected state, computer-home
contents, or viewer URLs in the acceptance evidence.

## Troubleshooting

- **Docker is unavailable:** start Docker Desktop and enable WSL integration
  for the exact distribution shown by `$WSL_DISTRO_NAME`. Remove competing
  Docker installations from the distribution.
- **State path fails:** move `QUBICL_HOME` below `/home` or another real Linux
  filesystem. Changing mount permissions does not make DrvFS supported.
- **Windows stdio client fails:** regenerate the snippet after reinstalling
  Node/Qubicl, confirm `wsl -l -v` still shows the pinned distribution name,
  and verify `cmd.exe /c echo interop-ok` inside WSL.
- **Windows cannot reach localhost:** verify gateway health inside WSL first,
  update WSL, and check Windows firewall/VPN policy. Qubicl does not open a LAN
  listener as a workaround.
- **Viewer does not open:** use `--no-open`, paste the printed URL immediately,
  and check interop with `explorer.exe https://example.com`.
- **Source identity changed:** rebuild all development images and reinstall the
  CLI before retrying setup.
- **A report is needed:** save `qubicl doctor --json` locally, review it, and
  share only the fields needed for diagnosis. Do not upload it automatically or
  include protected state, viewer URLs, tokens, or computer-home contents.
