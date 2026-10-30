# Browser history and integrated preview origins

Status: accepted for the 0.8.1 development branch; implemented and checked with
local Chromium and isolated HTTP/WebSocket fixtures. Installed-image upgrade and
release qualification are separate from these source checks.

Keep Chromium's back-forward cache disabled with the currently pinned Playwright.
In the reproduced history flow, enabling it restores a visible iframe without
restoring that frame to Playwright's inventory, and replays diagnostics with the
wrong current-page attribution. Ordinary history retains the tested edited form
value and restores discoverable frames. This trades instant document restoration
for reliable browser observation; it does not promise preservation of arbitrary
JavaScript heap state. Revisit the flag when Playwright correctly handles restored
child frames and history diagnostic attribution in the representative fixture.

Owner previews need distinct host-browser and integrated-browser origins because
localhost resolves in different network namespaces. Unified runtimes expose the
guest URL on a publication-specific localhost hostname, routed by the controller
listener exclusively to the existing preview manager. Exact host, loopback peer,
Origin and publication authorization checks preserve application isolation;
preview origins cannot enter controller API routes. Host/remote gateway routing
keeps its existing boundaries. Legacy split runtimes explicitly lack this guest
route rather than advertising a nonfunctional URL. Revisit that limitation only
with an equally isolated route across their separate namespaces.

Tool observation URLs are display metadata: redact recognized credential fields
and matching title echoes while retaining stable tab/document IDs for targeting.
Caller-requested page content remains untrusted visible content, not a promised
secret-free transcript. This is response minimization, not a credential store or
an access boundary against code running in the same computer.
