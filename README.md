# pi-jobs

Session-scoped background jobs for [Pi](https://github.com/earendil-works/pi) with an interactive TUI and OS-managed process lifetime.

`pi-jobs` is designed for commands that must keep running while Pi extensions reload. On macOS each job is owned by `launchd`; on Linux it uses a transient user `systemd` unit when available. Reloading Pi disconnects and reconnects the extension without restarting the command.

## One primitive: `run`

A job executes one Bash command exactly once:

```json
{
  "action": "run",
  "label": "warehouse query",
  "command": "query-cli run report.sql",
  "readiness": "process",
  "timeout_seconds": 14400
}
```

A failed, interrupted, or timed-out job is never automatically restarted. Each job creates an atomic execution claim before launching its command, so accidentally starting the same OS service again cannot submit the command twice. `retry` is the only operation that deliberately creates another execution under a new job ID.

Polling and retry policy belong in the command itself. A quiet watchdog can stay out of the model context while healthy and exit only when attention is required:

```json
{
  "action": "run",
  "label": "remote-control watchdog",
  "command": "remote-control-is-healthy || exit 1; touch \"$PI_JOB_READY\"; while remote-control-is-healthy; do sleep 30; done; echo 'remote control disconnected' >&2; exit 1",
  "readiness": "signal",
  "ready_timeout_seconds": 10,
  "timeout_seconds": 86400
}
```

This keeps pi-jobs small: it supervises one process; the process defines its own behavior.

## Readiness and wake reliability

Every `run` explicitly chooses its readiness contract. Use `"process"` when seeing both the external runner and command PID is sufficient before ending the current Pi turn. A service-manager acceptance alone is never treated as successful startup.

For commands that can spawn successfully but fail silently before doing useful work, request an explicit readiness signal:

```json
{
  "action": "run",
  "label": "warehouse query",
  "command": "query-cli submit report.sql && touch \"$PI_JOB_READY\" && query-cli wait report.sql",
  "readiness": "signal",
  "ready_timeout_seconds": 30
}
```

The command receives `PI_JOB_READY`, a private per-job path. It should create that file only after the external service accepted the work, or after a watchdog completed its first successful health check. If readiness is not proven before the deadline, pi-jobs stops the job and returns an error without ending the turn. A command that finishes successfully during readiness verification is reported immediately; failure before signaling readiness is an error.

Terminal events use a durable at-least-once wake path. The event remains pending until its triggered agent run produces an assistant response and settles. A crash, reload, or provider failure before that confirmation causes redelivery; in the narrow ambiguous case this may create a duplicate reminder, which is intentionally preferred over silently losing the wake.

## Lifecycle guarantees

- `/reload`: active OS services and command PIDs remain untouched; the new extension runtime reconnects by Pi session ID.
- `/quit`, `/new`, `/resume`, or `/fork`: active jobs from the old session receive `SIGTERM`; the runner escalates to `SIGKILL` after a short grace period.
- Unexpected Pi process death: each runner watches the owning Pi PID and stops its command when that process disappears.
- Explicit stop: stops the OS service, runner, and command process group.
- Startup: the tool returns only after process readiness, or optional business-level signal readiness, has been confirmed.
- Completion: terminal success, failure, timeout, or stop wakes Pi through a durable at-least-once outbox.
- Output: stdout/stderr are stored per job and exposed as bounded tails to Pi.
- State directories and files use modes `0700` and `0600`; the inherited command environment is passed through a private one-shot file that the runner deletes before launching the command.

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

Job state lives under `~/.pi/agent/pi-jobs/sessions/<session-id>-<hash>/jobs/<job-id>/`. It contains configuration, state, output, and OS service metadata. The readiness marker path is provided only through the command environment; the inherited environment is deleted from disk before the command starts. Finished history remains available until removed from `/jobs` or through the `remove` action.

## License

MIT
