import { Agent } from "@/agent/agent"
import { InstanceLayer } from "@/project/instance-layer"
import { InstanceStore } from "@/project/instance-store"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { Context, Effect, Layer, Schema } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ulid } from "ulid"
import { RUNNER_LABEL, type RunnerKind, type RunnerPlan, cronFallbackPlan, launchAgentPlan, mergeManagedCrontab, removeManagedCrontab, systemdUserPlan, windowsTaskPlan } from "./platform"

export type Schedule = {
  id: string
  source: "conversation"
  label: string
  prompt: string
  agentId: string
  workdir: string
  sessionId: SessionID
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

type RegistryShape = {
  version: 1
  schedules: Schedule[]
}

export type RunResult = {
  schedule: Schedule
  runId: string
  status: "success" | "failed" | "skipped"
  reason?: string
  exitCode?: number
  jsonlPath: string
  logPath: string
}

export type TickResult = {
  due: number
  runs: RunResult[]
}

type CreateInput = {
  label: string
  prompt: string
  agentId: string
  sessionId: string
  workdir: string
  cron?: string
  every?: string
  timezone?: string
  enabled?: boolean
}

type UpdateInput = {
  scheduleId: string
  label?: string
  prompt?: string
  cron?: string
  every?: string
  timezone?: string
  enabled?: boolean
  agentId?: string
  sessionId?: string
  workdir?: string
}

type ListInput = {
  sessionId?: string
  workdir?: string
  all?: boolean
}

type InstallRunnerInput = {
  runner?: RunnerKind | "auto"
  dryRun?: boolean
}

type RunnerResult = RunnerPlan & {
  applied: boolean
}

type Validation =
  | { ok: true }
  | { ok: false; status: "failed" | "skipped"; reason: string }

type ExecuteInput = {
  schedule: Schedule
  runId: string
}

type ExecuteResult = {
  code: number
  stdout: string
  stderr: string
  command: string[]
}

const decodeSessionID = Schema.decodeUnknownSync(SessionID)
const weekday = new Map([
  ["Sun", 0],
  ["Mon", 1],
  ["Tue", 2],
  ["Wed", 3],
  ["Thu", 4],
  ["Fri", 5],
  ["Sat", 6],
])
const zoned = new Map<string, Intl.DateTimeFormat>()

function root() {
  return process.env.OPENCODE_CRON_CONFIG_DIR
    ? path.resolve(process.env.OPENCODE_CRON_CONFIG_DIR)
    : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "ddm", "cron")
}

function registryPath(dir = root()) {
  return path.join(dir, "registry.json")
}

function runDir(dir: string, scheduleId: string) {
  return path.join(dir, "runs", scheduleId)
}

function lockPath(dir: string, scheduleId: string) {
  return path.join(dir, "locks", `${scheduleId}.json`)
}

function selfCommand() {
  const script = process.argv[1]
  if (!script) return [process.execPath, ...process.execArgv]
  if (!path.isAbsolute(script) && !script.startsWith(".") && !script.includes(path.sep) && !/\.[cm]?[jt]s$/u.test(script)) {
    return [process.execPath, ...process.execArgv]
  }
  return [process.execPath, ...process.execArgv, script]
}

function tickCommand() {
  return [...selfCommand(), "cron", "tick"]
}

export function buildRunCommand(schedule: Schedule) {
  return [
    ...selfCommand(),
    "run",
    "--strict-agent",
    "--agent",
    schedule.agentId,
    "--dir",
    schedule.workdir,
    "--session",
    schedule.sessionId,
    "--format",
    "json",
    "--title",
    schedule.label,
    schedule.prompt,
  ]
}

function formatter(timezone: string) {
  const existing = zoned.get(timezone)
  if (existing) return existing
  const next = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  })
  zoned.set(timezone, next)
  return next
}

function validateTimezone(timezone: string) {
  try {
    formatter(timezone).format(Date.now())
    return timezone
  } catch {
    throw new Error(`Invalid timezone "${timezone}"`)
  }
}

function normalizeRecurrence(input?: string) {
  const text = input?.trim()
  return text ? text : undefined
}

function duration(value: string) {
  const short = value.trim().match(/^(\d+)\s*(ms|s|m|h|d)$/i)
  if (short) {
    const amount = Number(short[1])
    const unit = short[2].toLowerCase()
    const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
    return amount * multiplier
  }

  const long = value.trim().match(/^(\d+)\s*(millis?|milliseconds?|seconds?|minutes?|hours?|days?)$/i)
  if (long) {
    const amount = Number(long[1])
    const unit = long[2].toLowerCase()
    const multiplier = unit.startsWith("mill") ? 1 : unit.startsWith("second") ? 1000 : unit.startsWith("minute") ? 60_000 : unit.startsWith("hour") ? 3_600_000 : 86_400_000
    return amount * multiplier
  }

  throw new Error(`Invalid every interval "${value}"`)
}

function values(token: string, min: number, max: number, weekdayField = false) {
  if (token === "*") return undefined
  const result = new Set<number>()
  for (const part of token.split(",")) {
    const [base, stepPart] = part.split("/")
    const step = stepPart ? Number(stepPart) : 1
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid cron step "${part}"`)
    if (base === "*") {
      for (let value = min; value <= max; value += step) result.add(weekdayField && value === 7 ? 0 : value)
      continue
    }
    const range = base.split("-")
    const start = Number(range[0])
    const end = Number(range[1] ?? range[0])
    if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error(`Invalid cron range "${part}"`)
    if (start < min || end > max || end < start) throw new Error(`Cron value "${part}" is out of range`)
    for (let value = start; value <= end; value += step) result.add(weekdayField && value === 7 ? 0 : value)
  }
  return result
}

function parsedCron(input: string) {
  const parts = input.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`Invalid cron expression "${input}"`)
  return {
    minute: values(parts[0], 0, 59),
    hour: values(parts[1], 0, 23),
    day: values(parts[2], 1, 31),
    month: values(parts[3], 1, 12),
    weekday: values(parts[4], 0, 7, true),
  }
}

function zonedParts(timestamp: number, timezone: string) {
  const parts = formatter(timezone).formatToParts(new Date(timestamp))
  const value = Object.fromEntries(parts.map((item) => [item.type, item.value]))
  const day = weekday.get(value.weekday)
  if (day === undefined) throw new Error(`Unsupported weekday for timezone ${timezone}`)
  return {
    minute: Number(value.minute),
    hour: Number(value.hour),
    day: Number(value.day),
    month: Number(value.month),
    weekday: day,
  }
}

function matches(value: number, set?: Set<number>) {
  return !set || set.has(value)
}

function nextCronAt(input: string, timezone: string, after: number) {
  const cron = parsedCron(input)
  const start = Math.floor(after / 60_000) * 60_000 + 60_000
  const limit = start + 366 * 24 * 60 * 60_000
  for (let candidate = start; candidate <= limit; candidate += 60_000) {
    const parts = zonedParts(candidate, timezone)
    const dayMatch =
      !cron.day && !cron.weekday
        ? true
        : !cron.day
          ? matches(parts.weekday, cron.weekday)
          : !cron.weekday
            ? matches(parts.day, cron.day)
            : matches(parts.day, cron.day) || matches(parts.weekday, cron.weekday)
    if (!matches(parts.minute, cron.minute)) continue
    if (!matches(parts.hour, cron.hour)) continue
    if (!matches(parts.month, cron.month)) continue
    if (dayMatch) return candidate
  }
  throw new Error(`Could not compute next run for cron "${input}"`)
}

function nextRunAt(schedule: Pick<Schedule, "cron" | "every" | "timezone">, after: number) {
  if (schedule.cron) return nextCronAt(schedule.cron, schedule.timezone, after)
  if (schedule.every) return after + duration(schedule.every)
  throw new Error("Schedule must define cron or every")
}

function validateRecurrence(input: { cron?: string; every?: string; timezone: string }) {
  const cron = normalizeRecurrence(input.cron)
  const every = normalizeRecurrence(input.every)
  if (!!cron === !!every) throw new Error("Specify exactly one of cron or every")
  validateTimezone(input.timezone)
  if (cron) parsedCron(cron)
  if (every) {
    const ms = duration(every)
    if (ms < 60_000) throw new Error("every must be at least 1 minute")
  }
  return { cron, every }
}

function nowTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

function note(input: {
  schedule: Schedule
  runId: string
  status: RunResult["status"]
  reason?: string
  exitCode?: number
  command?: string[]
}) {
  return [
    `scheduleId=${input.schedule.id}`,
    `runId=${input.runId}`,
    `status=${input.status}`,
    input.reason ? `reason=${input.reason}` : "",
    input.exitCode !== undefined ? `exitCode=${input.exitCode}` : "",
    input.command?.length ? `command=${input.command.join(" ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

async function loadRegistry(dir = root()): Promise<RegistryShape> {
  const file = registryPath(dir)
  if (!(await Filesystem.exists(file))) return { version: 1, schedules: [] }
  const raw = (await Bun.file(file).json()) as Partial<RegistryShape>
  const schedules = Array.isArray(raw.schedules)
    ? raw.schedules.map((item) => ({
        ...item,
        sessionId: decodeSessionID(item.sessionId),
      }))
    : []
  return { version: 1, schedules }
}

async function saveRegistry(dir: string, registry: RegistryShape) {
  const file = registryPath(dir)
  const temp = path.join(dir, `registry.${process.pid}.${ulid()}.tmp`)
  await Filesystem.write(temp, JSON.stringify(registry, null, 2) + "\n")
  await fs.rename(temp, file)
}

async function append(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, text)
}

async function jsonl(file: string, value: unknown) {
  await append(file, JSON.stringify(value) + "\n")
}

async function pidAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "EPERM") return true
    return false
  }
}

async function acquire(dir: string, scheduleId: string, runId: string) {
  const file = lockPath(dir, scheduleId)
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ pid: process.pid, runId, createdAt: Date.now() }), { flag: "wx" })
    return { release: () => fs.rm(file, { force: true }) }
  } catch (error) {
    if (!(typeof error === "object" && error && "code" in error && error.code === "EEXIST")) throw error
  }
  const existing = (await Bun.file(file).json().catch(() => undefined)) as { pid?: number } | undefined
  if (existing?.pid && (await pidAlive(existing.pid))) return
  await fs.rm(file, { force: true })
  return acquire(dir, scheduleId, runId)
}

async function acquireBlocking(dir: string, lockId: string, runId: string) {
  const deadline = Date.now() + 30_000
  for (;;) {
    const lock = await acquire(dir, lockId, runId)
    if (lock) return lock
    if (Date.now() > deadline) throw new Error(`Timed out waiting for cron lock "${lockId}"`)
    await Bun.sleep(50)
  }
}

async function mutate<T>(fn: (registry: RegistryShape) => T | Promise<T>) {
  const dir = root()
  const lock = await acquireBlocking(dir, "registry", `mut_${ulid()}`)
  try {
    const registry = await loadRegistry(dir)
    const result = await fn(registry)
    await saveRegistry(dir, registry)
    return result
  } finally {
    await lock.release()
  }
}

function dueNextRun(schedule: Schedule, after: number, source: "manual" | "tick") {
  if (source === "tick") return nextRunAt(schedule, after)
  if ((schedule.nextRunAt ?? 0) <= after) return nextRunAt(schedule, after)
  return schedule.nextRunAt
}

export interface ExecutorInterface {
  readonly execute: (input: ExecuteInput) => Effect.Effect<ExecuteResult>
}

export class ExecutorService extends Context.Service<ExecutorService, ExecutorInterface>()("@opencode/CronExecutor") {}

const executorLayer = Layer.succeed(
  ExecutorService,
  ExecutorService.of({
    execute: Effect.fn("CronExecutor.execute")(
      function* (input: ExecuteInput) {
        const command = buildRunCommand(input.schedule)
        const result = yield* Effect.promise(() =>
          Process.run(command, {
            cwd: input.schedule.workdir,
            nothrow: true,
          }),
        )
        return {
          code: result.code,
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
          command,
        }
      },
      Effect.orDie,
    ),
  }),
)

export interface Interface {
  readonly root: () => Effect.Effect<string>
  readonly list: (input?: ListInput) => Effect.Effect<Schedule[]>
  readonly create: (input: CreateInput) => Effect.Effect<Schedule>
  readonly update: (input: UpdateInput) => Effect.Effect<Schedule>
  readonly enable: (scheduleId: string) => Effect.Effect<Schedule>
  readonly disable: (scheduleId: string) => Effect.Effect<Schedule>
  readonly remove: (scheduleId: string) => Effect.Effect<void>
  readonly run: (scheduleId: string, source?: "manual" | "tick") => Effect.Effect<RunResult>
  readonly tick: () => Effect.Effect<TickResult>
  readonly installRunner: (input?: InstallRunnerInput) => Effect.Effect<RunnerResult>
  readonly uninstallRunner: (input?: InstallRunnerInput) => Effect.Effect<RunnerResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Cron") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const store = yield* InstanceStore.Service
    const executor = yield* ExecutorService

    const validateBinding = Effect.fn("Cron.validateBinding")(
      function* (schedule: Schedule) {
        if (!(yield* Effect.promise(() => Filesystem.exists(schedule.workdir)))) {
          return { ok: false, status: "skipped", reason: `Workdir not found: ${schedule.workdir}` } satisfies Validation
        }

        return yield* store.provide(
          { directory: schedule.workdir },
          Effect.gen(function* () {
            const sessionExit = yield* sessions.get(schedule.sessionId).pipe(Effect.exit)
            if (sessionExit._tag === "Failure") {
              return { ok: false, status: "failed", reason: `Session ${schedule.sessionId} was not found` } satisfies Validation
            }
            if (sessionExit.value.directory !== schedule.workdir) {
              return { ok: false, status: "failed", reason: `Session ${schedule.sessionId} is not bound to ${schedule.workdir}` } satisfies Validation
            }

            const agentExit = yield* agents.get(schedule.agentId).pipe(Effect.exit)
            if (agentExit._tag === "Failure" || !agentExit.value) {
              return { ok: false, status: "failed", reason: `Agent ${schedule.agentId} was not found` } satisfies Validation
            }
            if (agentExit.value.mode !== "primary" || agentExit.value.hidden === true) {
              return { ok: false, status: "failed", reason: `Agent ${schedule.agentId} is not a primary agent` } satisfies Validation
            }

            return { ok: true } satisfies Validation
          }),
        )
      },
      Effect.orDie,
    )

    const list: Interface["list"] = Effect.fn("Cron.list")(
      function* (input) {
        const schedules = (yield* Effect.promise(() => loadRegistry())).schedules
        const workdir = input?.workdir ? Filesystem.resolve(input.workdir) : undefined
        return schedules
          .filter((item) => {
            if (input?.all) return true
            if (input?.sessionId && item.sessionId !== input.sessionId) return false
            if (workdir && item.workdir !== workdir) return false
            return true
          })
          .toSorted((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER))
      },
      Effect.orDie,
    )

    const create: Interface["create"] = Effect.fn("Cron.create")(
      function* (input) {
        const timezone = validateTimezone(input.timezone ?? nowTimezone())
        const recurrence = validateRecurrence({ cron: input.cron, every: input.every, timezone })
        const createdAt = Date.now()
        const schedule: Schedule = {
          id: `sch_${ulid()}`,
          source: "conversation",
          label: input.label.trim(),
          prompt: input.prompt.trim(),
          agentId: input.agentId.trim(),
          workdir: Filesystem.resolve(input.workdir),
          sessionId: decodeSessionID(input.sessionId.trim()),
          cron: recurrence.cron,
          every: recurrence.every,
          timezone,
          enabled: input.enabled ?? true,
          createdAt,
          updatedAt: createdAt,
          nextRunAt: nextRunAt({ cron: recurrence.cron, every: recurrence.every, timezone }, createdAt),
        }
        if (!schedule.label) throw new Error("label is required")
        if (!schedule.prompt) throw new Error("prompt is required")
        const binding = yield* validateBinding(schedule)
        if (!binding.ok) throw new Error(binding.reason)
        return yield* Effect.promise(() =>
          mutate((registry) => {
            registry.schedules.push(schedule)
            return schedule
          }),
        )
      },
      Effect.orDie,
    )

    const update: Interface["update"] = Effect.fn("Cron.update")(
      function* (input) {
        return yield* Effect.promise(() =>
          mutate((registry) => {
            const schedule = registry.schedules.find((item) => item.id === input.scheduleId)
            if (!schedule) throw new Error(`Schedule "${input.scheduleId}" not found`)
            if (
              (input.agentId !== undefined && input.agentId.trim() !== schedule.agentId) ||
              (input.sessionId !== undefined && input.sessionId.trim() !== schedule.sessionId) ||
              (input.workdir !== undefined && Filesystem.resolve(input.workdir) !== schedule.workdir)
            ) {
              throw new Error("agentId, workdir, and sessionId are immutable in v1. Delete and recreate the schedule.")
            }

            const timezone = validateTimezone(input.timezone ?? schedule.timezone)
            const recurrence = validateRecurrence({
              cron:
                input.cron !== undefined
                  ? normalizeRecurrence(input.cron)
                  : input.every !== undefined
                    ? undefined
                    : schedule.cron,
              every:
                input.every !== undefined
                  ? normalizeRecurrence(input.every)
                  : input.cron !== undefined
                    ? undefined
                    : schedule.every,
              timezone,
            })

            schedule.label = input.label?.trim() || schedule.label
            schedule.prompt = input.prompt?.trim() || schedule.prompt
            schedule.cron = recurrence.cron
            schedule.every = recurrence.every
            schedule.timezone = timezone
            schedule.enabled = input.enabled ?? schedule.enabled
            schedule.updatedAt = Date.now()
            const current = schedule.nextRunAt ?? nextRunAt(schedule, schedule.createdAt)
            schedule.nextRunAt = current > Date.now() ? current : nextRunAt(schedule, Date.now())
            return schedule
          }),
        )
      },
      Effect.orDie,
    )

    const setEnabled = Effect.fn("Cron.setEnabled")(
      function* (scheduleId: string, enabled: boolean) {
        return yield* Effect.promise(() =>
          mutate((registry) => {
            const schedule = registry.schedules.find((item) => item.id === scheduleId)
            if (!schedule) throw new Error(`Schedule "${scheduleId}" not found`)
            schedule.enabled = enabled
            schedule.updatedAt = Date.now()
            if (enabled && (!schedule.nextRunAt || schedule.nextRunAt <= Date.now())) {
              schedule.nextRunAt = nextRunAt(schedule, Date.now())
            }
            return schedule
          }),
        )
      },
      Effect.orDie,
    )

    const run: Interface["run"] = Effect.fn("Cron.run")(
      function* (scheduleId: string, source = "manual") {
        const dir = root()
        const registry = yield* Effect.promise(() => loadRegistry(dir))
        const schedule = registry.schedules.find((item) => item.id === scheduleId)
        if (!schedule) throw new Error(`Schedule "${scheduleId}" not found`)

        const runId = `run_${ulid()}`
        const jsonlPath = path.join(runDir(dir, schedule.id), `${runId}.jsonl`)
        const logPath = path.join(runDir(dir, schedule.id), `${runId}.log`)
        const startedAt = Date.now()

        yield* Effect.promise(() =>
          jsonl(jsonlPath, {
            type: "cron.run.started",
            scheduleId: schedule.id,
            runId,
            source,
            timestamp: startedAt,
          }),
        )

        if (!schedule.enabled) {
          const result: RunResult = {
            schedule,
            runId,
            status: "skipped",
            reason: "Schedule is disabled",
            jsonlPath,
            logPath,
          }
          yield* Effect.promise(() =>
            jsonl(jsonlPath, {
              type: "cron.run.finished",
              scheduleId: schedule.id,
              runId,
              status: result.status,
              reason: result.reason,
              timestamp: Date.now(),
            }),
          )
          yield* Effect.promise(() => append(logPath, note(result) + "\n"))
          return result
        }

        const lock = yield* Effect.promise(() => acquire(dir, schedule.id, runId))
        if (!lock) {
          const result: RunResult = {
            schedule,
            runId,
            status: "skipped",
            reason: "Schedule is already running",
            jsonlPath,
            logPath,
          }
          yield* Effect.promise(() =>
            jsonl(jsonlPath, {
              type: "cron.run.finished",
              scheduleId: schedule.id,
              runId,
              status: result.status,
              reason: result.reason,
              timestamp: Date.now(),
            }),
          )
          yield* Effect.promise(() => append(logPath, note(result) + "\n"))
          return result
        }

        return yield* Effect.acquireUseRelease(
          Effect.succeed(lock),
          () =>
            Effect.gen(function* () {
              const binding = yield* validateBinding(schedule)
              if (!binding.ok) {
                const finishedAt = Date.now()
                const next = dueNextRun(schedule, finishedAt, source)
                yield* Effect.promise(() =>
                  mutate((current) => {
                    const match = current.schedules.find((item) => item.id === schedule.id)
                    if (!match) return
                    match.lastRunAt = startedAt
                    match.lastStatus = binding.status
                    match.updatedAt = finishedAt
                    match.nextRunAt = next
                  }),
                )
                const result: RunResult = {
                  schedule: { ...schedule, lastRunAt: startedAt, lastStatus: binding.status, nextRunAt: next },
                  runId,
                  status: binding.status,
                  reason: binding.reason,
                  jsonlPath,
                  logPath,
                }
                yield* Effect.promise(() =>
                  jsonl(jsonlPath, {
                    type: "cron.run.finished",
                    scheduleId: schedule.id,
                    runId,
                    status: result.status,
                    reason: result.reason,
                    timestamp: finishedAt,
                  }),
                )
                yield* Effect.promise(() => append(logPath, note(result) + "\n"))
                return result
              }

              const executed = yield* executor.execute({ schedule, runId })
              if (executed.stdout.trim()) yield* Effect.promise(() => append(jsonlPath, executed.stdout.trimEnd() + "\n"))
              const status = executed.code === 0 ? "success" : "failed"
              const finishedAt = Date.now()
              const next = dueNextRun(schedule, finishedAt, source)
              yield* Effect.promise(() =>
                mutate((current) => {
                  const match = current.schedules.find((item) => item.id === schedule.id)
                  if (!match) return
                  match.lastRunAt = startedAt
                  match.lastStatus = status
                  match.updatedAt = finishedAt
                  match.nextRunAt = next
                }),
              )
              const reason = executed.code === 0 ? undefined : `Command exited with code ${executed.code}`
              const result: RunResult = {
                schedule: { ...schedule, lastRunAt: startedAt, lastStatus: status, nextRunAt: next },
                runId,
                status,
                reason,
                exitCode: executed.code,
                jsonlPath,
                logPath,
              }
              yield* Effect.promise(() =>
                jsonl(jsonlPath, {
                  type: "cron.run.finished",
                  scheduleId: schedule.id,
                  runId,
                  status,
                  exitCode: executed.code,
                  reason,
                  timestamp: finishedAt,
                }),
              )
              yield* Effect.promise(() =>
                append(
                  logPath,
                  [
                    note({ ...result, command: executed.command }),
                    executed.stderr.trim() ? `stderr:\n${executed.stderr.trim()}` : "",
                  ]
                    .filter(Boolean)
                    .join("\n\n") + "\n",
                ),
              )
              return result
            }),
          (handle) => Effect.promise(() => handle.release()),
        )
      },
      Effect.orDie,
    )

    const tick: Interface["tick"] = Effect.fn("Cron.tick")(
      function* () {
        const registry = yield* Effect.promise(() => loadRegistry())
        const due = registry.schedules.filter((item) => item.enabled && (item.nextRunAt ?? nextRunAt(item, item.createdAt)) <= Date.now())
        const runs: RunResult[] = []
        for (const schedule of due) runs.push(yield* run(schedule.id, "tick"))
        return { due: due.length, runs }
      },
      Effect.orDie,
    )

    const chooseRunner = (requested?: RunnerKind | "auto") =>
      Effect.gen(function* () {
        if (requested && requested !== "auto") return requested
        if (process.platform === "darwin") return "launchagent" as const
        if (process.platform === "win32") return "windows-task" as const
        const systemd = yield* Effect.promise(() =>
          Process.run(["systemctl", "--user", "show-environment"], {
            nothrow: true,
          }),
        )
        return systemd.code === 0 ? ("systemd-user" as const) : ("cron" as const)
      }).pipe(Effect.orDie)

    const installPlan = (runner: RunnerKind) =>
      Effect.gen(function* () {
        const input = {
          home: os.homedir(),
          configRoot: root(),
          command: tickCommand(),
        }
        if (runner === "launchagent") return launchAgentPlan(input)
        if (runner === "windows-task") return windowsTaskPlan(input)
        if (runner === "systemd-user") return systemdUserPlan(input)
        return cronFallbackPlan(input)
      }).pipe(Effect.orDie)

    const installRunner: Interface["installRunner"] = Effect.fn("Cron.installRunner")(
      function* (input) {
        const runner = yield* chooseRunner(input?.runner)
        const plan = yield* installPlan(runner)
        if (input?.dryRun) return { ...plan, applied: false }
        yield* Effect.promise(() => fs.mkdir(root(), { recursive: true }))
        for (const file of plan.writes) yield* Effect.promise(() => Filesystem.write(file.path, file.content))
        if (runner === "cron") {
          const existing = yield* Effect.promise(() => Process.text(["crontab", "-l"], { nothrow: true }))
          const merged = mergeManagedCrontab(existing.code === 0 ? existing.text : "", plan.writes[0]?.content ?? "")
          yield* Effect.promise(() => Filesystem.write(plan.writes[0]!.path, merged))
        }
        for (const command of plan.commands) {
          const result = yield* Effect.promise(() => Process.run(command, { nothrow: true }))
          if (result.code === 0 || command.includes("unload")) continue
          throw new Error(result.stderr.toString() || `Failed to run ${command.join(" ")}`)
        }
        return { ...plan, applied: true }
      },
      Effect.orDie,
    )

    const uninstallRunner: Interface["uninstallRunner"] = Effect.fn("Cron.uninstallRunner")(
      function* (input) {
        const runner = yield* chooseRunner(input?.runner)
        const plan = yield* installPlan(runner)
        if (input?.dryRun) return { ...plan, applied: false }
        if (runner === "launchagent") {
          yield* Effect.promise(() => Process.run(["launchctl", "unload", plan.writes[0]!.path], { nothrow: true }))
          yield* Effect.promise(() => fs.rm(plan.writes[0]!.path, { force: true }))
          return { ...plan, applied: true }
        }
        if (runner === "windows-task") {
          yield* Effect.promise(() => Process.run(["schtasks", "/Delete", "/TN", RUNNER_LABEL, "/F"], { nothrow: true }))
          return { ...plan, applied: true }
        }
        if (runner === "systemd-user") {
          yield* Effect.promise(() =>
            Process.run(["systemctl", "--user", "disable", "--now", `${RUNNER_LABEL}.timer`], { nothrow: true }),
          )
          for (const file of plan.writes) yield* Effect.promise(() => fs.rm(file.path, { force: true }))
          yield* Effect.promise(() => Process.run(["systemctl", "--user", "daemon-reload"], { nothrow: true }))
          return { ...plan, applied: true }
        }
        const existing = yield* Effect.promise(() => Process.text(["crontab", "-l"], { nothrow: true }))
        const cleaned = removeManagedCrontab(existing.code === 0 ? existing.text : "")
        const managed = path.join(root(), "managed.crontab")
        yield* Effect.promise(() => Filesystem.write(managed, cleaned))
        yield* Effect.promise(() => Process.run(["crontab", managed], { nothrow: true }))
        return { ...plan, applied: true }
      },
      Effect.orDie,
    )

    return Service.of({
      root: () => Effect.succeed(root()),
      list,
      create,
      update,
      enable: (scheduleId) => setEnabled(scheduleId, true),
      disable: (scheduleId) => setEnabled(scheduleId, false),
      remove: Effect.fn("Cron.remove")(
        function* (scheduleId: string) {
          yield* Effect.promise(() =>
            mutate((registry) => {
              const index = registry.schedules.findIndex((item) => item.id === scheduleId)
              if (index < 0) throw new Error(`Schedule "${scheduleId}" not found`)
              registry.schedules.splice(index, 1)
            }),
          )
        },
        Effect.orDie,
      ),
      run,
      tick,
      installRunner,
      uninstallRunner,
    })
  }),
)

export const defaultLayer: Layer.Layer<Service, never, never> = layer.pipe(
  Layer.provide(executorLayer),
  Layer.provide(Agent.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provideMerge(InstanceLayer.layer),
) as Layer.Layer<Service, never, never>

export * as Cron from "./cron"
