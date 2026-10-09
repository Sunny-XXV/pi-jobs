# pi-jobs

Session-scoped background jobs for [Pi](https://github.com/earendil-works/pi) with an interactive TUI and OS-managed process lifetime.

`pi-jobs` is designed for commands that must keep running while Pi extensions reload. On macOS each job is owned by `launchd`; on Linux it uses a transient user `systemd` unit when available. Reloading Pi disconnects and reconnects the extension without restarting the command.

## Why jobs, not workers?

A *worker* can mean a thread, subprocess, or subagent. This package manages durable background **jobs**: commands with explicit ownership, status, output, cancellation, and retry semantics.

## Execution modes

### `run`

Executes a command exactly once. Use this for long-running SQL queries, builds, exports, and other commands that must not be submitted again automatically.

```json
{
  "action": "run",
  "label": "warehouse query",
  "command": "query-cli run report.sql",
  "timeout_seconds": 14400
}
```

A failed or interrupted `run` job is not automatically restarted. `retry` is the only operation that deliberately creates another execution.

### `watch`

Repeatedly evaluates a read-only, idempotent Bash predicate. Exit status 0 completes the job; nonzero retries after the configured interval.

```json
{
  "action": "watch",
  "label": "wait for report",
  "command": "test -f /tmp/report.done",
  "interval_seconds": 15,
  "timeout_seconds": 3600
}
```

Do not use `watch` to submit SQL, deployments, builds, or any command with side effects.

## Lifecycle guarantees

- `/reload`: active OS services and command PIDs remain untouched; the new extension runtime reconnects by Pi session ID.
- `/quit`, `/new`, `/resume`, or `/fork`: active jobs from the old session receive `SIGTERM`; the runner escalates to `SIGKILL` after a short grace period.
- Unexpected Pi process death: each runner watches the owning Pi PID and stops its command when that process disappears.
- Explicit stop: stops the OS service, runner, and command process group.
- Output: stdout/stderr are stored per attempt and exposed as bounded tails to Pi.
- State directories and files use modes `0700` and `0600`.

The current implementation targets macOS and Linux. macOS uses `launchctl bootstrap/bootout`; Linux uses `systemd-run --user` when available and otherwise falls back to a detached runner.

## TUI

Run `/jobs` to open the live dashboard.

- `↑`/`↓` or `j`/`k`: select a job
- `Tab`: switch between all, active, and finished jobs
- `PageUp`/`PageDown`: scroll output
- `f`: toggle following the newest output
- `r`: explicitly retry a finished job
- `x`: stop an active job
- `d`: remove a finished job from history
- `q`/`Esc`: close

The dashboard uses a two-pane layout on wide terminals and a stacked layout on narrow terminals. Destructive actions require confirmation.

Scriptable slash commands remain available:

```text
/jobs list
/jobs show <id>
/jobs stop <id|all>
/jobs retry <id>
/jobs remove <id|finished>
```

The model-facing tool is named `jobs` and exposes the same lifecycle operations.

## Install

```bash
pi install git:github.com/Sunny-XXV/pi-jobs
```

For development:

```bash
npm test
pi --extension ./index.ts
```

## Storage

Job state lives under `~/.pi/agent/pi-jobs/sessions/<session-id>-<hash>/jobs/<job-id>/`. It contains configuration, state, output, and OS service metadata. Finished history remains available until removed from `/jobs` or through the `remove` action.

## License

MIT
