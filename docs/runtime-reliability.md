# Reliable files, task output and services

These additions are implemented for the unreleased 0.8 development contract.

## Whole-file saves

`read_file` returns `sha256` for the complete source bytes, even when its text
response is paginated. Pass that value as `write_file.expectedSha256` to reject a
stale save. A `file_conflict` returns the current hash and size, or reports that the
file no longer exists. Read again and merge before retrying. The bounded filesystem
also checks the read identity during its atomic replacement transaction. Optimistic
saves use the same bounded source-size limit as `read_file`; oversized files are
rejected before comparing hashes.

`write_file.createOnly: true` creates a new file without replacing an existing
file, directory or symlink, including one created concurrently. Both guards are
optional; existing unconditional writes remain supported. Successful writes
return their new `sha256`.

`edit_file` returns a replayable unified diff of full source lines, preserving BOM,
CRLF and the absence of a final newline. When `diffTruncated` is true, the returned
preview is incomplete and must not be treated as a complete patch.

## UTF-8 output and retained outcomes

Terminal and process-output cursors remain byte offsets. UTF-8 pages end at complete
code points. A limit smaller than one code point can return up to three extra bytes
so continuation makes progress. An arbitrary offset inside a character rounds back
to its start and reports the adjusted `offset`. Incomplete live trailing characters
remain pending at `nextOffset` until more bytes arrive. Base64 pages preserve exact
byte boundaries, including non-UTF-8 output. A terminal's truncated retained prefix
starts at the next available complete character.

Retained task summaries and records preserve `exitCode` and `signal` when known.
Older records that never stored these fields still have an unknown outcome; an
`exited` status alone does not establish success.

Commands, interactive terminals and devcontainer lifecycle hooks use the same
sanitized workload environment, including configured variables and network proxy
settings. Controller credentials remain excluded. Environment values cannot
contain NUL because operating systems cannot pass those values to a process.
Generated Compose files escape literal dollar signs, so guest hook variables
expand in the guest shell and configured values or paths are not substituted
from the host environment.

The configured managed-task concurrency limit includes pending terminal starts
and services in crash-restart backoff, so opening terminals cannot bypass it. Completed
records do not consume running slots. Task lifetimes and completed-output retention
support the full configured 30-day range without overflowing platform timers.
Paged log reads validate against the configured per-log writer limit and allocate
only the requested page. Whole-buffer export retains its separate explicit tool
limit; increasing retention does not require loading a whole log into memory.

## Service readiness and bounded restarts

An `exec_command` with `lifecycle: "service"` can include:

```json
{
  "service": {
    "readiness": {
      "type": "http",
      "port": 3000,
      "path": "/health",
      "expectedStatus": 200,
      "timeoutMs": 30000,
      "intervalMs": 1000,
      "probeTimeoutMs": 1000
    },
    "restart": { "maxAttempts": 3, "backoffMs": 1000 }
  }
}
```

Readiness supports TCP connections or an exact HTTP status on guest loopback
(`127.0.0.1`, optionally `::1`). HTTP redirects are not followed. A successful TCP
connection establishes reachability, not application correctness; choose a health
endpoint when that distinction matters. The command can return when the first probe
succeeds, within `yieldTimeMs`; otherwise inspect the retained process handle later.

The response and task listing include `service.state`: `queued`, `starting`, `ready`,
`unhealthy`, or `exited`, with check time and the last probe error when available.
Without a probe the running state is explicitly `unverified`. Probes continue after
readiness and detect a later failure or recovery. A startup timeout marks the
service unhealthy without silently killing it.

Crash restarts are disabled unless `restart` is supplied. A nonzero exit or signal
can trigger at most `maxAttempts` retries (0–10) per computer session. Backoff doubles
from `backoffMs` (default 1000 ms), capped at 30 seconds. Attempts, the previous exit
code and the next restart time are reported. Successful exits and explicit stops
never trigger a crash retry; stopping also cancels a pending backoff. Health probe
failure alone does not restart a process. The service handle and output journal
remain stable across retries. Existing restart-on-computer-start declarations
persist these settings; an explicit stop removes that declaration.

At runtime startup, saved services beyond the concurrent-task limit remain
visible as `queued` and start as slots become available. Their empty `write_stdin`
poll returns `running: false` and `terminalState: "queued"`; they have no current
output until started. A saved service that cannot launch remains visible with
its error. Stop it explicitly or correct the cause before the next runtime start.
Polling a completed service preserves its management record and restart
declaration; polling never disables or hides a service.

On 0.8 runtimes, `qubicl tasks stop-all NAME --yes` blocks new admissions while it
disables all saved service declarations and stops managed work, including queued
and completed services. Completed ordinary task and terminal records remain
available. It does not start queued services while stopping others.
Executor/runtime shutdown stops work while preserving service declarations for the next
start. When connected to an older runtime without atomic stop-all, the CLI uses
its existing per-process stop interface; that compatibility path cannot exclude
concurrent new admissions.

## Failed custom skill updates

A replacement is staged and inspected before the existing skill is renamed to a
private backup. Failed promotion restores the original. If restoration itself
fails, `skill_recovery_required` identifies the retained backup for recovery; the
original bytes are not deleted by cleanup. Concurrent mutations through one manager
serialize. A failed update is an error, not a success receipt.
