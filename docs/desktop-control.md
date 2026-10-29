# Native desktop observation and control

These additions are implemented on the development branch for 0.8. Published
0.7 images retain their existing tools. Browser, computer and workstation source
images expose native inspection; managed app launching remains available on
computer and workstation.

Existing computers retain their enabled tools. Follow the
[0.8 upgrade sequence](daily-driver.md#lifecycle-and-local-update-review) to update
the gateway and add the new native tools to the saved policy.

`list_desktop_windows` returns X11 client-window IDs, titles, process IDs,
geometry, stacking order, visibility, window types, modal/transient relationships
and a `geometryToken`. Follow `nextCursor` to read more windows. This is a live
inventory, so refresh after applications open, close or reorder windows.

`desktop_snapshot` accepts `windowId`, optional `ref` for a subtree, and bounded
`limit`/`maxBytes` budgets. It returns AT-SPI roles, names, states, text, geometry
and named actions. Follow `nextCursor` with the same window ID; cursors advance a
live traversal and cannot be replayed after consumption. Native refs retain
actual accessibility objects across pages and snapshots.
They expire after five minutes or eviction from the four retained snapshots.
Changed, detached or defunct elements are rejected before actions.

Snapshots return at most 200 elements and 18 KB of encoded element content per
call, plus bounded window metadata. Text per element is capped at 1,500
characters with an explicit truncation flag; password text is omitted. A
snapshot retains at most 2,000 refs and bounds depth and pending traversal work.
`scopeLimitReached` distinguishes that bound from ordinary page continuation.
Inspect a smaller subtree when available. `unreadableElements` reports nodes
that could not be inspected, for example because an app removed them mid-read. These limits protect the controller
from very large or unresponsive application trees; adjust them based on concrete
missed-control evidence rather than treating them as product goals.

Applications may expose incomplete or no accessibility information. The result
then names `take_screenshot` as a fallback, including for sparse startup trees.
Do not infer that an empty native tree means the application has no controls.
Blender's custom UI generally needs screenshot control. Qt and office dialogs
can differ from their main windows; inspect the currently visible window.

`desktop_element_action` supports `invoke` with an observed `actionName`,
`focus`, and `set_text` with explicit `text`. A single available action may be
invoked without its name. Disabled or stale elements reject the action. API
acceptance is reported separately from `verified: false`: it does not establish
that the user's intended task succeeded.

`control_computer` retains screen-coordinate input. Mouse actions can specify
`targetWindowId` and must then include the observed `geometryToken`. Qubicl
activates the window, checks its current geometry and rejects points outside
its client area or covered by another window. Targeted scrolling requires x/y;
drag endpoints must both belong to the target window. Keyboard actions retain
the existing optional window targeting and also accept a geometry token. These
checks reduce wrong-window input; they cannot make a changing desktop atomic.

Desktop input and native actions accept `observe: windows|snapshot|screenshot`
to return resulting state in the same call. The default is `none`. Observations
are immediate and may precede an app's asynchronous update. An observation error
does not undo an already dispatched action; inspect before retrying. MCP returns
screenshot content as a native image without repeating base64 in text. Native
observations remain untrusted application data and require the interactive
credential scope, but do not claim the input lease. Queued input rechecks
ownership before dispatch, including after human takeover.

`desktop_window_action` requests focus or normal close through the window
manager. `close_desktop_application` now defaults to normal close of a tracked
app's windows and returns `close_requested`. Handle Save/Discard/Cancel dialogs
using fresh observations. Termination requires `mode: terminate` and
`discardUnsavedChanges: true`; this retains the process-group TERM/KILL path.
For compatibility, the older call with only `discardUnsavedChanges: true`
still selects termination. Neither normal close path escalates automatically.

The helper runs as the workload user, with a bounded private JSON channel and
the guest's own D-Bus session. It receives neither host desktop access nor
controller credentials. A timeout invalidates its refs and reports that an
action's effect may be unknown. Observe before retrying timed-out input.

Workstation additionally bundles GIMP, Inkscape, Blender, FreeCAD and Kdenlive,
with corresponding editable skills. Their packages are absent from the other
presets. Projects and source media belong under `/home/qubicl`; GPU acceleration
is not implied by having the applications installed. Existing skill selections
are preserved during upgrades; operators can enable compatible new skills with
`qubicl skills computer-name`.

Fresh computer/workstation homes receive standard XDG folders before the desktop
starts. Existing folder settings are preserved; a conflicting ordinary file is
kept and that location falls back to the home. This prevents empty-path startup
errors in applications such as Kdenlive. Workstation also includes its standard
frei0r/SWH video effects and icon assets.

## Launchers, crops and application workflows

`list_desktop_applications` reports desktop-entry identifiers such as
`desktop:org.inkscape.Inkscape.desktop`. Pass the identifier to
`open_desktop_application` to retain the launcher's fixed arguments and declared
file handling. Entries sharing an interpreter remain distinct. Execution uses
an argv array, never a shell. An absolute `Path=` is resolved to an existing
guest directory and retained as the launch working directory. `%f`/`%u` accept one existing home file, `%F`/`%U`
accept several, and `%i`, `%c`, `%k` and `%%` retain their desktop-entry meanings.
Unsupported/embedded field codes and terminal-only launchers are omitted rather
than silently changed. Built-in aliases and explicit executable names remain
available. A launcher may hand off to an existing application and exit; use
`list_desktop_windows` to observe the resulting documents and windows rather
than equating a launcher process with an application window.

`take_screenshot` accepts either a `region` (`x`, `y`, `width`, `height` in screen
pixels), or a `windowId` and its observed `geometryToken`. Window capture rejects
stale geometry before and after capture. A crop must fit inside the visible
screen and returns its `origin` for mapping local image coordinates back to
screen input. It captures the visible screen region, including any overlapping
window; it does not reveal occluded content. Omit both targets for the full
screen.

Bundled application records include the installed package version, editable
formats, export formats, automation interfaces and relevant skill. The small
`tests/e2e/workstation-workflows.py` fixtures exercise real save/reopen/export:
XCF/PNG, SVG/PNG/PDF, BLEND/CPU PNG, FCStd/STEP/STL and Kdenlive/MLT video.
`tests/integration/workstation-launchers-live.test.ts` opens the editable
fixtures through their actual desktop entries. These are representative checks,
not claims of compatibility with every project, codec, plugin or GPU.

Debian Blender can omit OpenImageDenoise. Portable CPU Cycles scripts should
turn denoising off unless support is confirmed. The supplied Blender skill
records this observed limitation.

The 4 GB workstation default remains a starting point for light combined use.
A local Linux x64 check on 2026-10-29, limited to 2 CPUs and 4 GB, opened a
sandboxed Chromium local page, a small Writer document and a Blender cube
simultaneously. Five samples over ten seconds used about 0.72–0.79 GiB, with
startup peak about 1.18 GiB and no OOM kills. This supports retaining the existing
default for that workload, not sizing large CAD models, video timelines or renders.
Increase the computer's memory for those projects based on observed use. The
optional `tests/e2e/workstation-memory.py` reproduces this bounded check; it is
not a universal release gate or a GPU/performance claim.
