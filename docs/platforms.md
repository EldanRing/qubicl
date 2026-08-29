# Platform support

The versioned
[platform support matrix](../conformance/platform-support-v1.json) is the
machine-readable release contract. Support policy and validation evidence are
separate:

- **Supported** means the Qubicl release policy covers that host shape.
- **Directly tested** means a maintainer completed the physical-host acceptance
  matrix recorded by the named evidence baseline.
- **Best-effort** means compatible artifacts and code paths exist, but the host
  shape does not carry a directly tested support claim.
- **Unsupported** means setup or the documented workflow must not be presented
  as supported.

One successful run does not silently promote a best-effort row. Changing a
public support claim requires reviewing and versioning the matrix as well as
retaining the corresponding release evidence.

| Host shape | Support | Validation | Current boundary |
| --- | --- | --- | --- |
| Linux x64 | Supported | Directly tested | Native Linux CLI with a local Linux Docker Engine or Docker Desktop |
| Linux ARM64 | Best-effort | Not directly tested | Native Linux CLI; ARM64 images and archive are produced, but no physical-host claim is made |
| Apple Silicon macOS | Supported | Directly tested | Native arm64 CLI with Docker Desktop's Linux VM |
| Intel macOS | Best-effort | Not directly tested | Native x64 CLI with Docker Desktop's Linux VM |
| Windows 11 x64 through Ubuntu 24.04 on WSL 2 | Supported | Directly tested | Linux CLI, state, and Docker access stay inside WSL 2; Docker Desktop supplies the Linux engine |
| Windows 11 x64 through another current WSL 2 distribution | Best-effort | Not directly tested | Must meet the same Node, glibc, filesystem, Docker, and interoperability contract |
| Windows on ARM through WSL 2 | Best-effort | Not directly tested | No physical-host claim is made |
| Native Windows CLI | Unsupported | Not directly tested | Qubicl publishes no native Windows archive |
| WSL 1 | Unsupported | Not directly tested | Setup and doctor fail closed |

Native Windows and WSL 1 are unsupported. Qubicl computers are Linux
containers on every host; macOS and Windows support does not mean native
macOS/Windows workloads. Those containers are also not a VM security boundary
against the host, Docker, or the host kernel. The gateway remains loopback-only
by default. Optional direct TLS exposure has focused source/loopback tests, but
peer-IP behavior behind Docker Desktop/NAT must be validated on the actual host
before relying on a CIDR allowlist. The separate versioned
[remote-access requirements](../conformance/remote-access-v1.json) require
post-freeze native-Linux evidence for a pre-1.0 initial release. A supported
remote-access claim additionally requires Apple Silicon Docker Desktop and
Windows WSL 2/Docker Desktop evidence; those rows do not promote any
best-effort platform by themselves.

## macOS with Docker Desktop

Apple Silicon is the directly tested macOS host. Intel macOS remains
best-effort until equivalent physical-host evidence is retained. Use the native
Qubicl archive or npm installation for the Mac's architecture; do not substitute
the other architecture through an emulation layer when recording acceptance.

Install a supported Node.js 22 or 24 release, Docker Desktop 4.29 or later, and
Docker Compose 2.24 or later. Start Docker Desktop and wait until its engine is
ready. Qubicl never installs, launches, or changes Docker Desktop for you.
Before setup, run as the normal macOS user:

```sh
node --version
docker context show
docker version
docker compose version
docker info --format '{{.OSType}}/{{.Architecture}}'
```

The Docker server must report Linux. Apple Silicon normally reports `arm64` and
Intel normally reports `x86_64` or `amd64`; retain the exact output while the
acceptance row records the normalized host architecture as `arm64` or `x64`.
Then run:

```sh
qubicl setup
qubicl doctor
qubicl doctor --json > qubicl-doctor.json
```

Review the JSON before sharing it. Doctor does not emit bearer tokens, but an
operator should still remove unrelated local paths or host details that are not
needed for diagnosis.

## macOS troubleshooting

- If the Docker client cannot reach the daemon, open Docker Desktop, wait for
  the engine to become ready, select its local context, and rerun `docker
  version`. Qubicl does not switch contexts or start Docker silently.
- If doctor reports a remote context or `DOCKER_HOST`, return explicitly to a
  local Docker Desktop context and remove the unintended remote override before
  retrying.
- If the Docker server reports a non-Linux OS, select Docker Desktop's Linux
  engine. Qubicl computers are Linux containers.
- If the bind probe fails, confirm Docker Desktop is allowed to share the
  selected local `QUBICL_HOME` path and that the normal user owns it. Do not run
  Qubicl with `sudo` to bypass the failure.
- After updating or restarting Docker Desktop, wait for the engine, run
  `qubicl doctor`, and verify an existing computer before changing state or
  rebuilding anything.

For Windows, continue with the focused [WSL 2 guide](wsl.md). General failures
and safe diagnostic sharing are covered in [Troubleshooting](troubleshooting.md).
