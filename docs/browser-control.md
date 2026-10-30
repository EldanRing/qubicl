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

`browser_history` dispatches Back, Forward or Reload once and waits up to five
seconds for navigation to commit, then at most one second for `DOMContentLoaded`.
It returns the observed URL/title, `navigation.status` (`committed` or
`not_observed`), `navigation.waitTimedOut`, and a separate `loading` record with
`waitStatus` and the observed document `readyState`. A missing loading event can
produce `waitStatus: "timed_out"` even when the document is already complete.
Same-document history entries can commit without an HTTP response. An absent
Back/Forward entry still returns `browser_no_history`.

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
Use `browser_read` for longer document prose. Password values remain omitted.

`browser_select.value` accepts a string or an array of labels/values. Labels retain
precedence when both could match. An array selects all requested options together
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

Browser snapshots never use password values as element names. The pinned browser
library also includes password values in its raw accessibility text, so that text
is omitted when password fields are present. Safe element refs remain available;
`browser_read` reads page prose without extracting input values. This fallback
should be revisited when the browser library provides a verified safe snapshot.
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
