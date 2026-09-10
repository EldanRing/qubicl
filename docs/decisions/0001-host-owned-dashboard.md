# Host-owned management and isolated dashboard assets

Status: implemented for v0.5.1; release acceptance pending.

Qubicl management can change Docker resources, durable homes and credentials.
Giving the gateway or browser frontend unrestricted host authority would extend
that boundary to workloads and rendered content. The native CLI helper therefore
owns the administrative HTTP origin, authentication, TLS, API and operations.
Its typed application adapter calls shared host functions under a request-local
root/output/lock context. It does not spawn CLI commands or parse their output.

A sixth static-only image supplies the browser application. It appears in the
same Compose project but uses a dedicated bridge shared with no other Qubicl
service, loopback-only publication, a read-only filesystem and no mounts,
credentials or Docker socket. The bridge is non-internal because Docker does
not publish host ports for containers attached only to an internal network, so
the static container has ordinary egress but no administrative authority. The
helper verifies its catalog-bound manifest and assets and never forwards browser
authority. An embedded local recovery interface remains available without that
container. Remote access fails closed rather than using the recovery interface.

Administrative and viewer origins use distinct hostnames and private keys.
Local HTTP uses explicit memory-only authorization rather than ambient cookies,
because cookies ignore ports even when the helper validates Host and Origin.
Remote HTTPS retains HttpOnly Secure cookies and separate certificate identities.
Remote administration accepts only direct private HTTPS with an explicit client
network policy. Password bootstrap, TLS import, password reset and all-session
revocation remain host operations. There is one administrator, no multi-user
authorization system, public mode or reverse-proxy authority.

Five-minute plans and final fingerprints cover desired state, secrets, runtime
identities and recovery journals. Accepted job receipts contain no operation
inputs or credentials. Existing exact-identity lifecycle transactions, durable
upgrade checkpoints and backup pause journals own recovery; request bodies are
never blindly replayed. State format 4 makes the explicit migration boundary
visible to older CLIs. Dashboard documents use their own schema 1, and the image
catalog uses schema 2. This adds a frontend artifact and host service to release
verification without changing existing agent tool contracts.
