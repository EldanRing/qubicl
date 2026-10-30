# Native desktop observation and control

Native inspection shipped in 0.8. This guide also describes the pending 0.8.1
text, geometry and launcher improvements. Browser, computer and workstation
images expose native inspection; managed app launching remains available on
computer and workstation.

Existing computers retain their enabled tools. Follow the
[0.8 upgrade sequence](daily-driver.md#lifecycle-and-local-update-review) to update
the gateway and add the new native tools to the saved policy.

`list_desktop_windows` returns X11 client-window IDs, titles, process IDs,
geometry, stacking order, visibility, window types, modal/transient relationships
and a `geometryToken`. Follow `nextCursor` to read more windows. This is a live
inventory, so refresh after applications open, close or reorder windows.
Inventory includes `desktopBounds`, `workArea` and its source (window-manager
data or screen fallback), frame extents when provided, and client `visibleBounds`
clipped to the workarea. This clipping is not an occlusion test. `clientToScreen`
maps native client pixels to screen pixels; app content mapping is null when
chrome offsets are unknown. Browser screenshots/snapshots separately expose
`screenMapping`, explicitly estimated from browser inner/outer window metrics.

`desktop_snapshot` accepts `windowId`, optional `ref` for a subtree, and bounded
`limit`/`maxBytes` budgets. It returns AT-SPI roles, names, states, text, geometry
and named actions. By default only elements with both AT-SPI `visible` and
`showing` states are returned. Editable/focused elements and dialog controls come
first, followed by other controls and text, then structural containers. Set
`includeHidden: true` to also return hidden elements after the visible elements.
Screen/window geometry also deprioritizes offscreen elements even when a toolkit
keeps its `showing` flag set. Visibility is not proof that another window does
not cover the control. Window matching refreshes toolkit caches and compares
title, role and geometry so a newly opened modal can replace a stale main-window
match.
`keyBindings` keeps each action's actual AT-SPI keybinding string separate from
its name; null means the app did not provide one. The native string may contain
mnemonic/menu/accelerator components separated by semicolons. Qubicl does not
invent a shortcut from a menu label.

Follow `nextCursor` with the same window ID; cursors retain the initial visibility
selection and cannot be replayed after consumption. Omit `includeHidden` on
continuation or repeat its initial value. The bounded candidate order is captured
on the first call; element content is read live as pages are returned. Take a new
snapshot to discover newly added or newly visible controls. Hidden parents are
still traversed because some toolkits expose visible children beneath them.
Parent refs can refer to records returned later or omitted by the visibility
filter, and remain usable for subtree inspection. Native refs retain
actual accessibility objects across pages and snapshots.
They expire after five minutes or eviction from the four retained snapshots.
Changed, detached or defunct elements are rejected before actions.

`take_screenshot` with a window ID and observed geometry token captures the
intersection of its client bounds and the screen, including oversized or partly
off-screen windows. The result reports `windowBounds`, `visibleBounds`, actual
`origin`, `clipped`/`offscreen` and `capture: visible_screen_region`; overlapping
windows may appear (`occlusion: not_checked`). Use `clipToScreen: false` to require
the full window to fit. A fully off-screen window yields an explicit error. Both
pre/post capture checks reject stale geometry, and capture never moves or resizes
windows. Explicit `region` coordinates remain strictly screen-bounded.

Snapshots return at most 200 elements and 18 KB of encoded element content per
call, plus bounded window metadata. Text per element is capped at 1,500
characters with an explicit truncation flag; password text is omitted. A
snapshot scans at most 2,000 nodes, retains at most 2,000 refs, and bounds depth
and pending traversal work. Only returned elements need full text/geometry reads.
`scopeLimitReached` distinguishes that bound from ordinary page continuation.
Inspect a smaller subtree when available. `unreadableElements` reports nodes
that could not be inspected, for example because an app removed them mid-read.
`hiddenElementsOmitted` reports the visibility filter's omissions. These limits protect the controller
from very large or unresponsive application trees; adjust them based on concrete
missed-control evidence rather than treating them as product goals.

Virtual tables such as Calc sheets are sampled through AT-SPI Table rather than
walking millions of child cells. A table exposes dimensions, the sampled range,
cell row/column coordinates and `table.read`/`table.nextTableRange` arguments.
Use its `ref` with `tableRange: {row, column, rows, columns}` to inspect an exact
zero-based rectangle; defaults are 12 rows by 8 columns and the maximum is 200
cells per request. `tableRanges` records the sampled areas, and bounded sampling
reports partial content coverage. Follow the range continuation or select the
needed coordinates; a small visible sample is not the entire sheet.

An element with text includes `textRead` arguments. Call `desktop_snapshot` with
its `windowId`, `ref` and `textOffset: 0` (or another Unicode code-point offset)
to capture the full text. Follow `nextTextCursor` using `windowId`, `textCursor`
and optional `maxBytes`. This is independent of the element `nextCursor`.
`captureId`, `capturedAt`, `consistency: captured_text`, `totalCharacters` and
`totalBytes` describe the immutable captured string; edits after capture do not
change later pages. Offsets count Unicode code points, unlike browser UTF-16
offsets. Passwords cannot be captured. Captures last five minutes; four captures
share 16 MB, with an explicit 8 MB per-capture bound. Expired/evicted captures or
closed windows require a new read. Large document files can be read through the
document/file interfaces rather than silently losing a native text tail.

Applications may expose incomplete or no accessibility information. The result
then names `take_screenshot` as a fallback, including for sparse startup trees.
Do not infer that an empty native tree means the application has no controls.
`usefulTree` evaluates returned text/actions as well as control roles in the
requested window or subtree (`usefulnessScope`). A useful single text element
does not receive a sparse-tree warning. Usefulness is distinct from content
coverage: `contentCoverage: partial` and `coverageGaps` identify directory panes
whose inspected tree exposes no named file/icon items. This does not establish
that a directory is empty. Thunar's current icon-view toolkit can expose only
an empty panel even through AT-SPI Collection; use the reported screenshot
fallback. When the toolkit supplies item names/actions, they retain normal refs.
`exposed_tree` means no such gap was detected, not proof of complete application
content. Budget truncation and unreadable elements remain separately reported.
Blender's custom UI generally needs screenshot control. Qt and office dialogs
can differ from their main windows; inspect the currently visible window.
The workstation includes LibreOffice's GTK bridge for native Office inspection
and Noto CJK fallback fonts. Japanese sample rendering is checked; this does not
promise every language or every explicitly selected font has full coverage.

`desktop_element_action` supports `invoke` with an observed `actionName`,
`focus`, and `set_text` with explicit `text`. A single available action may be
invoked without its name. Disabled or stale elements reject the action. API
acceptance is reported separately from `verified: false`: it does not establish
that the user's intended task succeeded.
Numeric controls expose `value` with their AT-SPI current value, minimum, maximum
and increment when available. Use `action: "set_value"` and numeric `value` to
change that model directly; out-of-range values are rejected before mutation.
The receipt includes `requestedValue`, model readback and `valueReadbackMatches`,
while retaining `verified: false` for the application outcome. `set_text` only
replaces text and need not commit a spin control's numeric model.
If the control disappears after mutation, `valueReadbackStatus: unavailable` and
null readback fields preserve the dispatch receipt without inventing a value.
For `set_text`, `undoGrouping: application_defined` and
`singleUndoGuaranteed: false` describe the AT-SPI limitation:
[EditableText](https://docs.gtk.org/atspi2/iface.EditableText.html) provides no
transaction/grouping API. Mousepad may separate deletion and insertion
into distinct Undo steps. Inspect each Undo result; one step can leave an empty
buffer. Qubicl does not issue compensating edits or alter the clipboard to emulate
an application undo stack.

`control_computer` retains screen-coordinate input. Mouse actions can specify
`targetWindowId` and must then include the observed `geometryToken`. Qubicl
activates the window, checks its current geometry and rejects points outside
its client area or covered by another window. Targeted scrolling requires x/y;
drag endpoints must both belong to the target window. Keyboard actions retain
the existing optional window targeting and also accept a geometry token. These
checks reduce wrong-window input; they cannot make a changing desktop atomic.
Typing normalizes CRLF and lone CR to LF and sends each newline as a Return
event, retaining tabs and Unicode in ordinary multiline editors. International
text uses normal xdotool pacing for temporary X11 key mappings. Clipboard text,
file lists and binary formats are untouched. These are keyboard events: an app
can handle Return as submit or apply indentation/formatting. Read or save/reopen
the resulting content when exact text matters; dispatch is not insertion proof.
Set `action.stopOnFocusChange: true` on typing to recheck the active window before
each chunk (at most 64 Unicode code points) and each individual Return event.
If focus changes, dispatch stops with `dispatch: interrupted` and a `typing`
record containing `nextOffset`, total/remaining input lengths and
`offsetUnit: utf16`. Offsets refer to the original input, so CRLF consumes two
units even though it dispatches one Return. Remaining input is never replayed.
The guard is opt-in and cannot interrupt an already dispatched chunk or detect
focus moving between controls within one window. Inspect the new state before
resuming; the offset counts dispatch, not verified insertion.
For desktop `keypress`, `action.keys` is a sequence: `["ctrl+End", "Return"]`
sends one chord and then Return. `["ctrl", "End"]` is rejected; combine modifiers
with `+` within an entry. Browser `browser_press` uses a single chord string such
as `Control+End`; `browser_computer` keypress arrays instead describe one chord
(`keys: ["Control", "End"]`), with separate actions for sequential keypresses.

Desktop input and native actions accept `observe: windows|snapshot|screenshot`
to return resulting state in the same call. The default is `none`. Observations
are immediate and may precede an app's asynchronous update. An observation error
does not undo an already dispatched action; inspect before retrying. MCP returns
screenshot content as a native image without repeating base64 in text. Native
observations remain untrusted application data and require the interactive
credential scope, but do not claim the input lease. Queued input rechecks
ownership before dispatch, including after human takeover.

`desktop_window_action` requests focus, normal close, or explicit `action: "fit"`
through the window manager. Fit exits maximized/fullscreen state and requests a
size/position within the current workarea, accounting for known frame extents.
It does not run automatically; `verified: false` means observe the resulting
geometry before coordinate input. `close_desktop_application` defaults to normal close of a tracked
app's windows and returns `close_requested`. Handle Save/Discard/Cancel dialogs
using fresh observations. Termination requires `mode: terminate` and
`discardUnsavedChanges: true`; this retains the process-group TERM/KILL path.
For compatibility, the older call with only `discardUnsavedChanges: true`
still selects termination. Neither normal close path escalates automatically.

The helper runs as the workload user, with a bounded private JSON channel and
the guest's own D-Bus session. It receives neither host desktop access nor
controller credentials. A timeout invalidates its refs and reports that an
action's effect may be unknown. Observe before retrying timed-out input.

`read_clipboard` negotiates text targets and returns `status: text` or
`unavailable`. `ownerAvailable` is true/false when X11 ownership is detectable,
otherwise null. An image-only selection reports `text_format_unavailable`; it
does not claim the clipboard is empty. A known empty text selection has `status:
text` and zero sizes. X server, permission, timeout and invalid-encoding failures
remain errors. Available formats are bounded and carry `formatsTruncated`.

Text reads return `captureId`, `capturedAt`, `totalBytes`, `totalCharacters`,
UTF-16 `offset`/`nextOffset`, and `nextCursor`. Continue with `cursor` and optional
`maxBytes` (512–16,000). Pages reconstruct the same captured string even if another
application replaces the clipboard; Unicode pairs and leading U+FEFF characters
are preserved. Captures expire after five minutes; four captures share 16 MB,
with an explicit 8 MB per-capture bound. A new read captures the current owner.

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
For tracked single-instance text-editor/file-manager handoffs, open returns the
canonical `applicationId` with `disposition: reused` when handoff completes in the
short launch window. A later successful handoff retains the returned launcher ID
as an alias of the running app; inventory exposes aliases and close resolves them.
New processes report `started`. A reused ID represents the app, not just the newly
opened document, so a normal close may present save dialogs for its other tabs.

Handoffs to an already running external text-editor/file-manager daemon also
retain an `applicationId`, observed `windowIds` and PID identity, with
`processOwnership: external` and `disposition: reused`. Normal close targets only
those observed windows after rechecking their identity. Explicit termination is
rejected for an external daemon, and runtime shutdown never kills it.

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
