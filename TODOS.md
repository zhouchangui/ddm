# TODO

## DDM agent scheduled tasks architecture

Status: Phase 1 implemented in `packages/opencode`.

Implemented:
- `specs/ddm-agent-scheduled-tasks.md` now reflects the OpenCode-internal cron
  direction.
- Built-in `cron` tool supports `list`, `create`, `update`, `enable`,
  `disable`, `delete`, and `run`.
- `opencode cron run`, `tick`, `install-runner`, and `uninstall-runner` are in
  place.
- Registry and run artifacts are stored under `~/.config/ddm/cron`.
- `opencode run --strict-agent` is available and used by cron execution.
- Import continues validating `manifest.schedules[]` but does not create cron
  registry tasks or install OS schedulers.
- Automated verification lives under `packages/opencode/test/cron`.

Follow-up work:
- Build Phase 2 UI on top of the existing OpenCode cron service instead of
  introducing a parallel DDM-only scheduler path.
- Decide whether Phase 2 should expose an administrative `list all` view beyond
  the current conversation/workdir default.
- Decide whether repeated skipped/failed runs should surface warnings only or
  eventually auto-disable tasks.
- Decide whether manifest schedule templates should later become conversation
  suggestions without becoming import-time active tasks.
