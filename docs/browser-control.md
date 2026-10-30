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

JavaScript alert, confirm and prompt dialogs return `browser_waiting_for_dialog`
with a dialog ID. `browser_dialogs` and authorized `browser_respond_dialog` bypass
the blocked action queue. They do not accept or dismiss dialogs automatically.
After resolving a dialog, observe the page. A dialog interrupts remaining batched
computer actions; issue only actions that are still needed. Fill/select failures
are reported without repeating input through a different mechanism.

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
