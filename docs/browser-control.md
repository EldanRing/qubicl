# Browser action safety

Existing computers retain their enabled tools. Follow the
[0.8 upgrade sequence](daily-driver.md#lifecycle-and-local-update-review) to update
the gateway and enable `browser_read` alongside the new native tools.

The 0.8 development contract distinguishes actions rejected before dispatch from
actions with uncertain results. A stale/background lease error includes
`details.dispatch: "not-started"` only when the server established non-execution.
The CLI bridge may refresh ownership and retry that rejection once. After
execution starts, ownership loss returns `action_result_uncertain`; inspect the
page before deciding what to do next. Older servers without dispatch receipts
are handled conservatively: their errors are returned without an automatic retry.
A receipt is evidence about dispatch, not proof that the application accepted it.

Popups no longer change the agent's selected tab automatically. Use
`browser_use_tab` with the popup's stable ID to act in it; `browser_new_tab`
continues to select the tab it explicitly creates. Navigation, semantic input
and visual-batch receipts include
`actedOnTabId`, `activeTabId`, `openedTabs` and `openedTabsTruncated`. The URL/title
describe the acted-on page for semantic input, while a visual batch's screenshot
describes its final observed page. Snapshots also identify their tab.
Up to 20 newly observed tabs are included, with bounded URLs. Semantic actions
briefly observe popup events (up to 300 ms) because a click can return before the
new page is announced. Later script-created popups remain visible in
`browser_tabs`; an empty list is an observation, not a guarantee against a future
popup. Opening a popup preserves valid parent-page refs.

Observation URL fields are display values: recognized token, credential,
password, authorization, session, signature and API-key parameters are redacted
in queries and key/value fragments; URL userinfo is removed. Matching values
echoed in titles are redacted too. The same filtering applies to navigation
errors, retained operation/download errors and browser setup logs, including
preview `ticket` credentials. Ordinary navigation parameters and hash
anchors remain visible. Use stable tab IDs, frame indexes and read document IDs
for targeting; a redacted URL is not a reusable authenticated link. Page text and
screenshots remain application content, so this metadata filtering does not
promise a secret-free page capture.

`browser_history` dispatches Back, Forward or Reload once and waits up to five
seconds for navigation to commit, then at most one second for `DOMContentLoaded`.
It returns the observed URL/title, `navigation.status` (`committed` or
`not_observed`), `navigation.waitTimedOut`, and a separate `loading` record with
`waitStatus` and the observed document `readyState`. An observed interactive or
complete document satisfies the loading check even when its protocol event is
missing; Qubicl skips that wait when readiness is already visible. A document
still loading, or unavailable to inspection, can report `waitStatus: timed_out`.
Same-document history entries can commit without an HTTP response. An absent
Back/Forward entry still returns `browser_no_history`.

The current Chromium/Playwright combination keeps the back-forward cache
disabled. Its restored child frames otherwise disappear from fresh tool
inventories, and cached console events can acquire the next page's attribution.
Ordinary history restores the tested edited form field and discoverable iframe;
this does not promise preservation of arbitrary JavaScript heap state. See the
[decision and review condition](decisions/0006-browser-history-and-preview-origins.md).

The final document observation also has a one-second budget. If it cannot be
read, `observationComplete` is false, title is empty, and `readyState` is
`unavailable`; the browser's current URL is still reported. An expired wait does
not establish that navigation failed or was cancelled. Inspect the page before
issuing another history action; the tool never retries that action itself.

The session runner checks current interactive ownership with the controller
before each input, including individual batch actions and compound-action steps.
Human takeover stops remaining input; cleanup releases modifiers and mouse
buttons already pressed by that operation. A failed ownership check stops input
instead of relying on a cached lease. An input already dispatched can still have
taken effect, so an interrupted operation must be observed before continuing.

Passive snapshots reuse refs for the same DOM nodes and do not invalidate the
controller's previous snapshot. References remain bounded to 6,400 distinct
elements, evicting the least recently observed when genuinely new elements fill
that capacity. Snapshot metadata reports this retention policy. Navigation,
frame replacement, tab changes and disconnected nodes still invalidate affected
refs; refresh the snapshot after `stale_browser_ref`.

JavaScript alert, confirm and prompt dialogs return a successful tool response
with `status: "awaiting_dialog"`, `dialogId`, `operationId`, dispatch information
and the dialog's tab. This is a waiting state, not proof that the action finished.
`dispatch: "not-started"` means a pending dialog prevented the requested
operation from starting; resolving it does not launch that operation later.
`browser_dialogs` and authorized `browser_respond_dialog` bypass the blocked
action queue. They do not accept or dismiss dialogs automatically.

Semantic clicks complete bounded actionability and hit testing before dispatching
one input event, so waiting for a prompt no longer consumes a locator-click
timeout. Keyboard input likewise avoids a locator navigation wait. Sequential
dialogs update the same operation with the currently pending dialog ID. The
isolated runner preserves these IDs and dispatch details in its responses.

The response to a dialog includes its originating operation receipt when known.
It waits up to one second for that operation to settle; otherwise it reports the
current state. `browser_dialogs.operations` retains the latest 32 dialog-related
receipts so clients can reconcile `operationId` as `running`, `awaiting_dialog`,
`completed`, `interrupted` or `failed`. Completion describes tool execution, not
the application's intended outcome. Clients should track waiting dialogs
separately from failed calls and update the same operation after resolution.
Older Qubicl runtimes return the legacy `browser_waiting_for_dialog` error.
After resolving a dialog, observe the page. A dialog interrupts remaining batched
computer actions; issue only actions still needed. Fill/select failures never
cause input to be repeated through a different mechanism.

Snapshot refs for contenteditable editors (including empty and plaintext-only
attributes), inputs and textareas include a current `value`, `valueLength` and
`valueTruncated`, separately from their accessible name. Values preserve
whitespace and line breaks, are bounded to 1,500 UTF-16 code units without splitting
a surrogate pair, and can be shortened further to respect the response budget.
Use targeted `browser_read` with `mode: "value"` for the exact current value,
including leading/trailing spaces and newlines, or its normal text mode for
document prose. Password values remain omitted.

Snapshots, refs and point inspection share the same control-name resolver:
`aria-labelledby`, `aria-label`, native labels, then native/content alternatives.
Names are bounded to 160 UTF-16 units; values are separate. Snapshot text combines
those names and validation messages with visible document prose, rather than the
browser library's raw accessibility serialization. Open shadow roots and assigned
slots are traversed; closed shadow roots are not DOM-readable. Closed disclosures
omit their concealed content but expose the summary ref and `expanded` state.

Control metadata includes `readOnly`, `disabled`, `inert`, `blockedByModal` and
`actionable`; native form `validation`; numeric `constraints` (`min`, `max`,
`step`); checkbox state; and select `options` with distinct labels and values.
File controls include `accept`, `multiple`, and selected files' name, size, MIME
type and last-modified time, without a local path or file contents. Option/file
inventories are bounded (at most 20 items and the shared response budget), with
totals and truncation flags. Target `browser_read` with `mode: "control"` for a
paginated JSON capture of full inventories and values. This is structured DOM
state, not a guarantee that a control is unobscured or that an app will accept an
action. Native modal dialogs, visible ARIA modal dialogs and inert ancestors mark
background controls as blocked, including controls in child frames; semantic
actions reject blocked targets before input.
Text controls also report `editable`. A `contenteditable="false"` ARIA textbox
inside an editable ancestor reports read-only; it may still be focusable/clickable.

Custom controls expose `pressed` and `checked` as booleans or `mixed` when the
ARIA state is valid; absence is distinct from false. Numeric ARIA controls expose
finite `valueNow` and their `valueText`, separately from field text. Password
controls omit both value fields. Switches and explicit `tabindex` targets receive
refs, including programmatically focusable `tabindex=-1` elements. `tabIndex`
reports keyboard focus metadata rather than promising tab-order navigation.
`relationships` carries ID references for labels, descriptions, controlled/owned
elements, active descendants, details, errors and flow targets. Snapshot lists
are bounded and report `relationshipsTruncated`; a targeted control read retains
the full lists through its existing pagination. These are document IDs, not
Qubicl element refs. Immediate focus observations expose the same widget states.

Snapshots include `focus` and `selection`; focused refs also carry these states.
Input/textarea selections expose UTF-16 offsets and direction, with up to 256
units of selected text. Document/editor selections expose text and anchor/focus
offsets relative to their nodes. Password selections return only `redacted`.

Scrollable regions receive refs and `scroll` metadata with position, client and
content dimensions, and scrollable axes. Use `browser_scroll` with `ref`,
`direction: "up" | "down" | "left" | "right"`, and `amount` to scroll that region
directly and receive its resulting position. Omitting `ref` retains page-wheel
scrolling. `browser_click` with `checked: true` or `false` sets a checkbox's state;
repeating the same request does not toggle it again. Omit `checked` for an ordinary
click. Read-only fields can still receive focus, but text entry is rejected.

Semantic click/type/select/press/scroll and visual input tools accept optional
`observe: true`. The result includes immediate text and focus from the acted-on
frame before tab/pointer settling, plus up to eight brief DOM/live-region feedback
strings (256 units each) recorded during the action. This can retain a toast
removed before the next call. Observation is bounded and best-effort, not a
transaction or proof of application success; navigation or closure may make it
unavailable, and lost feedback capture reports `feedbackComplete: false`.
Input is never repeated to obtain an observation. Existing calls remain valid and
do not collect this extra observation unless requested.

`browser_select.value` accepts a string or an array of labels/values. With the
default `by: "auto"`, labels retain precedence when both could match. Use
`by: "value"` for exact underlying values or `by: "label"` for labels. An array selects all requested options together
and replaces the previous selection; `[]` clears it. Multiple values on a
single-select are rejected before changing its selection.

`browser_diagnostics` includes event time, stable `tabId`, redacted `pageUrl`,
source URL and console line/column when available. Filter with `tabId`, `type`,
`since` and `until` (inclusive ISO timestamps), plus `limit` up to 200. Only the
latest 200 events are retained; output also respects the text budget and reports
`truncated` when matching retained events are omitted. It remains readable during
dialogs. URL credentials, query strings and fragments are removed from metadata
and absolute HTTP(S) URLs in messages; arbitrary secrets printed as ordinary
console text cannot be inferred or automatically redacted.

Browser snapshots never use password values as element names and do not consume
the browser library's raw accessibility text, which can contain passwords.
Normal `browser_read` reads visible prose without extracting form values;
explicit value/control modes still omit passwords and raw file-input paths.
Viewport resizing advances geometry when dimensions change; old coordinate
observations must be refreshed.

`browser_permissions` keeps grants for other origins when `clear: true` revokes
the named origin. `scope: "context"` explicitly clears all tool-managed grants.
The receipt states the scope and the named origin's remaining permissions.
The browser's own site settings are separate from these automation overrides.

Downloads use separate per-download directories, preserving simultaneous
same-name files. Failed cancellation stays observable as an error rather than
becoming a false cancelled receipt. Active transfers remain tracked; the bounded
history retains the latest 200 completed transfers. History eviction does not
delete downloaded files. Tab reset reports `resetComplete` and `failedToClose`
when a previous tab could not be closed.

Action receipts include `operationId` and `downloadStartedIds` observed during
that operation's result window. A timer or delayed page event can begin a later
download; these are correlation receipts, not proof of causal ownership. Never
repeat a click solely because its download has not appeared. `browser_downloads`
filters by `downloadId`, `tabId`, or `operationId`. Optional `waitMs` (up to 10
seconds) waits once for a specified ID to finish, or for a matching download to
start when no match exists. It reports `waitTimedOut`, does not hold the input
queue, and does not impose a polling loop. Results honor `limit` and the shared
byte budget with `truncated`; an ID filter retrieves a particular retained entry.

Download records retain tab/action provenance and source/page URLs with
credentials, query parameters and fragments removed. Available MIME and transfer
counts come from browser responses/events. `receivedBytes`, `totalBytes` and
`lastProgressAt` are null when unavailable; no transfer rate is invented. Event
progress may lag the transfer. Completed artifacts include `sizeBytes` and
`sha256` measured from the saved file. Explicit successful cancellation stays
`cancelled` even when the save operation rejects concurrently; genuine failures
stay `failed`, and cancelling a completed download is a no-op.
Cancellation retains the highest observed `receivedBytes` rather than replacing
partial progress with a terminal browser event's zero counter. It does not imply
that cancelled bytes were published as a usable file.
