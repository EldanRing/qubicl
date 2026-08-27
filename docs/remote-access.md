# Optional remote gateway access

Qubicl remains loopback-only after setup. Remote access is a durable, explicit
operator choice; it is never enabled by `setup`, `up`, an image upgrade, or a
manifest. It uses a second TLS listener in the existing shared gateway process
and container. It does not add a sidecar, expose a computer container directly,
or replace the local HTTP listener.

## Expose one host interface

An existing installation must first use a gateway image whose immutable
contract includes `direct-tls-v1`. Review `qubicl status` and run `qubicl
upgrade --all` when it reports a gateway update; `gateway expose` refuses an
older or unbound gateway before changing state.

Remote previews additionally require every configured computer image to
declare the `dynamic-v1` preview-access contract. `upgrade --all` updates
curated computers and retained mounts. A legacy or custom computer can still
use remote MCP, OpenAPI, Open Terminal, and viewer access, but Qubicl refuses
`--preview-domain` until that computer's exact image and retained mount are
compatible.

Prepare a certificate whose DNS or IP subject alternative name covers the
gateway hostname. Keep the unencrypted private-key file readable only by the
current user (`0600`). Then review an exposure:

```sh
qubicl gateway expose \
  --bind 192.168.1.20 \
  --port 8443 \
  --hostname qubicl.example.net \
  --cert /secure/qubicl-chain.pem \
  --key /secure/qubicl-key.pem \
  --allow-networks 192.168.1.0/24 \
  --trusted-origins https://client.example.net
```

The external port must differ from the local gateway port. Qubicl safely reads
and validates bounded regular PEM files, proves that the key matches the leaf
certificate, checks validity and SAN coverage, displays the fingerprint and
scope, and copies the exact material into protected Qubicl state. It never
stores or mounts the source paths. The confirmation recreates only the shared
gateway when necessary, reconnects computers that were already running, and
preserves computer IDs, bearer tokens, policies, resources, runtime state, and
durable homes.

Binding every IPv4 or IPv6 interface requires a separate acknowledgement:

```sh
qubicl gateway expose ... --bind 0.0.0.0 --all-interfaces
```

`--bind ::` has the same `--all-interfaces` requirement. A network entry with a
`/0` prefix additionally requires `--allow-all-clients`. `--yes` skips the typed
confirmation only; it does not bypass either safety acknowledgement. Prefer a
specific interface and narrow network list whenever possible.

`--trusted-origins` controls browser CORS and accepts exact HTTPS origins only.
Non-browser MCP/OpenAPI/Open Terminal clients still need the assigned
computer's bearer token. Add `--client-ca FILE` to require a client certificate
signed by that CA in addition to the bearer token.

## Connect and view

Local stdio remains the preferred token-free path. To print a remote HTTP or
OpenAPI configuration deliberately:

```sh
qubicl connect research --client generic --transport http --access remote
qubicl connect research --client generic --transport openapi --access remote
qubicl view research --access remote --no-open
```

These commands print placeholders or one-time viewer URLs; they do not print a
bearer token. Retrieve a token separately with `qubicl token show research` and
treat it as a password.

Remote workload previews need a separate wildcard DNS origin so untrusted app
content never shares the gateway/viewer origin. Configure a domain and a
certificate containing its wildcard SAN:

```sh
qubicl gateway expose ... --preview-domain preview.example.net
```

Prefer a preview domain on a different registrable site from the gateway (for
example, `gateway.example.com` with `preview.example.net`). Qubicl uses a
host-only `__Host-` viewer cookie so sibling preview hosts cannot shadow the
remote viewer session, but separate sites provide a stronger browser boundary
for any workload-controlled cookies and storage.

`publish_port` continues to return its existing local `url` and adds a
`remoteUrl` when this boundary is configured. Without a preview domain, remote
previews are unavailable while local `*.localhost` previews continue to work.

## Inspect, renew, and revoke

```sh
qubicl gateway status
qubicl gateway status --json
qubicl doctor
qubicl gateway revoke
```

Running `expose` again replaces the protected certificate snapshot and policy.
`status` reports an exposure active only when the live listener confirms the
exact desired non-secret configuration identity and no transaction is pending
recovery.
`revoke` removes the external Docker publication and managed TLS files, proves
their absence, and preserves the loopback gateway and all computer data. If
configuration already says remote access is off but a stale managed
publication or TLS snapshot remains, `revoke` presents a drift-cleanup preview
instead of claiming success.

## Boundaries and platform caveats

- The external listener is HTTPS/WSS only with TLS 1.2 or later. Local
  `http://127.0.0.1` remains unchanged.
- The gateway enforces the configured network list against the socket peer and
  ignores `Forwarded` and `X-Forwarded-*`. Docker Desktop or host NAT may hide
  the original client address; a peer-IP allowlist can therefore reject valid
  clients or be unsuitable as the primary boundary on that host. Use an exact
  interface, TLS, bearer authentication, and optionally client certificates.
- Qubicl does not create DNS records, issue or renew certificates, configure a
  router, open a host firewall, or install a tunnel/VPN. `doctor` validates what
  it can observe and reports those external controls as manual checks.
- The remote listener increases the reachable surface to every configured
  computer route. Tokens remain isolated per computer; possessing one does not
  authorize another computer.
- Operator-only gateway routes stay local. Remote browser origins must be
  explicitly trusted, viewer cookies are Secure/HttpOnly/SameSite=Strict, and
  remote preview content stays on its wildcard-isolated origin.
- Direct exposure has focused loopback TLS/security tests. A release support
  claim still requires the versioned
  [remote-access workflow](../conformance/remote-access-v1.json) plus applicable
  platform and real-client evidence, including Docker Desktop/NAT behavior.

Read the complete [security model](security-model.md) and verify the host
firewall before making an interface reachable from an untrusted network.
