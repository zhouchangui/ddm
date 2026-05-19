# DDM/OpenCode scheduled tasks

## Direction

Phase 1 uses an internal OpenCode cron subsystem.

- Scheduled tasks are created and managed from conversation through a built-in
  OpenCode tool named `cron`.
- Import continues validating `manifest.schedules[]`, but import does not create
  registry tasks and does not install OS schedulers.
- There is no Phase 1 task list or task editor UI.
- OS schedulers call `opencode cron tick`, not `ddm schedule ...` and not
  `opencode run` directly.

This keeps one implementation surface for conversation flows, background
execution, and later UI work.

## Product rules

### Creation and ownership

- A task is created only from conversation or direct tool usage.
- Every task binds exactly one `agentId`, one `workdir`, and one `sessionId`.
- Tool defaults come from the current conversation context:
  - `agentId`: current tool context agent
  - `sessionId`: current session
  - `workdir`: current OpenCode instance directory
- If the user needs the same workflow in multiple directories, create one task
  per directory.

### Management surface

Phase 1 task management happens through conversation and the built-in `cron`
tool only.

Required tool actions:

- `list`
- `create`
- `update`
- `enable`
- `disable`
- `delete`
- `run`

`cron list` defaults to the current `sessionId` and current `workdir`.

### V1 binding rules

V1 does not support mutating task bindings.

- Updating `agentId`, `workdir`, or `sessionId` must be rejected.
- The user must delete and recreate the task if any binding changes.

## Storage

Phase 1 stores durable cron state in JSON under the DDM config root:

```text
~/.config/ddm/cron/registry.json
~/.config/ddm/cron/runs/<scheduleId>/<runId>.jsonl
~/.config/ddm/cron/runs/<scheduleId>/<runId>.log
```

Notes:

- `registry.json` is the authoritative schedule registry.
- `runs/...jsonl` stores the structured event stream for one run.
- `runs/...log` stores plain-text logs for one run.
- A test override may be used if needed, but production defaults must resolve to
  the DDM config root above.

## Schedule model

Suggested Phase 1 shape:

```ts
type CronSource = "conversation"

type CronSchedule = {
  id: string
  source: CronSource
  label: string
  prompt: string
  agentId: string
  workdir: string
  sessionId: string
  cron?: string
  every?: string
  timezone: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  nextRunAt?: number
  lastStatus?: "success" | "failed" | "skipped"
}
```

Registry format can include additional internal metadata, but the binding fields
above are the contract.

## Execution

### Runner command

Scheduled runs execute through OpenCode non-interactive run mode:

```bash
opencode run \
  --strict-agent \
  --agent <agentId> \
  --dir <workdir> \
  --session <sessionId> \
  --format json \
  --title "<schedule label>" \
  "<prompt>"
```

Strict behavior is mandatory:

- Missing agent must fail.
- Non-primary agent must fail.
- The runner must never fall back to the default agent.

If needed, `opencode run --strict-agent` should be added specifically so cron
execution cannot silently fall back.

### CLI commands

Phase 1 must add:

```bash
opencode cron run <scheduleId>
opencode cron tick
opencode cron install-runner
opencode cron uninstall-runner
```

Expected behavior:

- `opencode cron run <scheduleId>` executes one registered schedule once.
- `opencode cron tick` loads enabled schedules and executes due tasks.
- `opencode cron install-runner` installs the platform scheduler hook.
- `opencode cron uninstall-runner` removes the platform scheduler hook.

### Tick semantics

`opencode cron tick` must:

- Run overdue tasks once.
- Avoid overlapping runs for the same schedule.
- Continue processing other due tasks if one task fails.
- Skip backfill loops. If a task missed many intervals, one run happens on the
  next tick and the following `nextRunAt` advances from current time.

### Validation before each run

Before execution:

- The task must still be enabled.
- `workdir` must exist.
- `sessionId` must exist and be compatible with `workdir`.
- `agentId` must exist and must be a primary agent.

Failure rules:

- Missing `workdir`: mark the run `skipped` and keep the task enabled.
- Missing `sessionId`: mark the run `failed`.
- Missing `agentId`: mark the run `failed`.

## OS scheduler integration

The OS scheduler is a wakeup mechanism only. It must call:

```bash
opencode cron tick
```

Supported Phase 1 targets:

- macOS LaunchAgent
- Windows Task Scheduler
- Linux `systemd --user` timer
- Linux cron fallback when user systemd timers are unavailable

Generation and install logic must be dry-run and snapshot-test friendly.

## Import behavior

Import behavior does not change for Phase 1 except that schedules remain
metadata only.

- `manifest.schedules[]` continues to be validated.
- Import does not create cron registry entries.
- Import does not install OS schedulers.
- Import may surface schedule metadata in product copy later, but not as active
  tasks in Phase 1.

## Phase boundary

Phase 1 explicitly excludes:

- Schedule list UI
- Schedule detail UI
- Editing bindings in place
- Import-created schedule instances
- A parallel DDM-only scheduler implementation

Later UI work must reuse the same OpenCode cron service used by the tool and the
CLI runner.

## Verification matrix

### Tool

- `cron create` defaults `agentId`, `workdir`, and `sessionId` from the current
  tool context and instance.
- `cron list` defaults to current session and current workdir.
- `cron update` can change mutable fields such as label, prompt, recurrence,
  timezone, and enabled state.
- `cron update` rejects `agentId`, `workdir`, and `sessionId` changes with a
  delete-and-recreate message.
- `cron enable`, `cron disable`, `cron delete`, and `cron run` operate on a
  task created earlier.

### Registry and schedule math

- Registry is written to JSON under `~/.config/ddm/cron`.
- New schedules compute and persist `nextRunAt`.
- `tick` advances `nextRunAt` from current time and does not backfill multiple
  missed runs.

### Run artifacts

- Each run writes `runs/<scheduleId>/<runId>.jsonl`.
- Each run writes `runs/<scheduleId>/<runId>.log`.
- Success, failed, and skipped runs all leave artifacts.

### Runner behavior

- `opencode cron run <scheduleId>` invokes OpenCode run mode with
  `--strict-agent`.
- Missing or non-primary agent fails and never falls back to the default agent.
- Missing workdir marks skipped and keeps the task enabled.
- Missing session marks failed.

### Tick behavior

- `tick` runs all due tasks once.
- One failing due task does not block other due tasks.
- Overlapping runs for the same schedule are prevented.

### OS scheduler generation

- macOS LaunchAgent generation is deterministic and snapshot-testable.
- Windows Task Scheduler generation is deterministic and snapshot-testable.
- Linux systemd user timer generation is deterministic and snapshot-testable.
- Linux cron fallback generation is deterministic and snapshot-testable.

### Import behavior

- Manifest validation still accepts and validates `manifest.schedules[]`.
- Import does not create registry tasks.
- Import does not install OS schedulers.

### Phase boundary

- No Phase 1 UI is introduced.
- Implementation stays mostly within `packages/opencode` plus docs updates.
