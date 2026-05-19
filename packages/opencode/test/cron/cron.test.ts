import { afterEach, describe, expect, test } from "bun:test"
import { Agent } from "@/agent/agent"
import { Cron, ExecutorService, buildRunCommand } from "@/cron/cron"
import {
  CRON_BLOCK_END,
  CRON_BLOCK_START,
  cronFallbackPlan,
  launchAgentPlan,
  systemdUserPlan,
  windowsTaskPlan,
} from "@/cron/platform"
import { InstanceLayer } from "@/project/instance-layer"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { CronTool } from "@/tool/cron"
import { Truncate } from "@/tool/truncate"
import { Filesystem } from "@/util/filesystem"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const runs: Array<{ scheduleId: string; command: string[] }> = []

const executorLayer = Layer.succeed(
  ExecutorService,
  ExecutorService.of({
    execute: (input) =>
      Effect.sync(() => {
        const command = buildRunCommand(input.schedule)
        runs.push({ scheduleId: input.schedule.id, command })
        return {
          code: input.schedule.label.includes("fail") ? 1 : 0,
          stdout: JSON.stringify({ type: "mock.run", scheduleId: input.schedule.id, runId: input.runId }) + "\n",
          stderr: input.schedule.label.includes("fail") ? "mock failure" : "",
          command,
        }
      }),
  }),
)

const cronLayer = Cron.layer.pipe(
  Layer.provide(executorLayer),
  Layer.provide(Agent.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provideMerge(InstanceLayer.layer),
)

const it = testEffect(Layer.mergeAll(cronLayer, Agent.defaultLayer, Session.defaultLayer, Truncate.defaultLayer))

const registryPath = path.join(process.env.XDG_CONFIG_HOME!, "ddm", "cron", "registry.json")

async function registry() {
  return (await Bun.file(registryPath).json()) as { schedules: Array<Record<string, unknown>> }
}

async function patchSchedule(scheduleId: string, patch: Record<string, unknown>) {
  const current = await registry()
  const schedule = current.schedules.find((item) => item.id === scheduleId)
  if (!schedule) throw new Error(`missing schedule ${scheduleId}`)
  Object.assign(schedule, patch)
  await Bun.write(registryPath, JSON.stringify(current, null, 2) + "\n")
}

const seed = Effect.fn("CronTest.seed")(function* (title = "cron seed") {
  const session = yield* Session.Service
  return yield* session.create({ title, agent: "build" })
})

function ctx(sessionID: SessionID) {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

afterEach(async () => {
  runs.length = 0
  await disposeAllInstances()
})

describe("cron service", () => {
  it.instance("creates schedules in the ddm cron registry and computes nextRunAt", () =>
    Effect.gen(function* () {
      const cron = yield* Cron.Service
      const test = yield* TestInstance
      const session = yield* seed()

      const created = yield* cron.create({
        label: "daily digest",
        prompt: "write the daily digest",
        agentId: "build",
        sessionId: session.id,
        workdir: test.directory,
        every: "1 day",
        timezone: "UTC",
      })

      expect(created.workdir).toBe(test.directory)
      expect(created.nextRunAt).toBeGreaterThan(created.createdAt)

      const stored = yield* Effect.promise(() => registry())
      expect(stored.schedules).toHaveLength(1)
      expect(stored.schedules[0]?.id).toBe(created.id)
    }),
  )

  it.instance("rejects binding changes during update", () =>
    Effect.gen(function* () {
      const cron = yield* Cron.Service
      const test = yield* TestInstance
      const session = yield* seed()
      const created = yield* cron.create({
        label: "daily digest",
        prompt: "write the daily digest",
        agentId: "build",
        sessionId: session.id,
        workdir: test.directory,
        every: "1 day",
        timezone: "UTC",
      })

      const exit = yield* cron.update({ scheduleId: created.id, agentId: "plan" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect((Cause.squash(exit.cause) as Error).message).toContain("Delete and recreate")
    }),
  )

  it.instance("switches recurrence type during update", () =>
    Effect.gen(function* () {
      const cron = yield* Cron.Service
      const test = yield* TestInstance
      const session = yield* seed()
      const created = yield* cron.create({
        label: "daily digest",
        prompt: "write the daily digest",
        agentId: "build",
        sessionId: session.id,
        workdir: test.directory,
        every: "1 day",
        timezone: "UTC",
      })

      const updated = yield* cron.update({ scheduleId: created.id, cron: "0 9 * * *" })
      expect(updated.cron).toBe("0 9 * * *")
      expect(updated.every).toBeUndefined()
    }),
  )

  it.instance("writes run artifacts and uses strict-agent execution", () =>
    Effect.gen(function* () {
      const cron = yield* Cron.Service
      const test = yield* TestInstance
      const session = yield* seed()
      const created = yield* cron.create({
        label: "daily digest",
        prompt: "write the daily digest",
        agentId: "build",
        sessionId: session.id,
        workdir: test.directory,
        every: "1 day",
        timezone: "UTC",
      })

      const result = yield* cron.run(created.id)
      expect(result.status).toBe("success")
      expect(runs[0]?.command).toContain("--strict-agent")
      expect(yield* Effect.promise(() => Filesystem.exists(result.jsonlPath))).toBe(true)
      expect(yield* Effect.promise(() => Filesystem.exists(result.logPath))).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(result.jsonlPath).text())).toContain('"type":"mock.run"')
      expect(yield* Effect.promise(() => Bun.file(result.logPath).text())).toContain("status=success")
    }),
  )

  it.instance("tick runs overdue schedules once and continues after failures", () =>
    Effect.gen(function* () {
      const cron = yield* Cron.Service
      const test = yield* TestInstance
      const session = yield* seed()
      const ok = yield* cron.create({
        label: "ok task",
        prompt: "run the ok task",
        agentId: "build",
        sessionId: session.id,
        workdir: test.directory,
        every: "1 day",
        timezone: "UTC",
      })
      const fail = yield* cron.create({
        label: "fail task",
        prompt: "run the fail task",
        agentId: "build",
        sessionId: session.id,
        workdir: test.directory,
        every: "1 day",
        timezone: "UTC",
      })

      yield* Effect.promise(() => patchSchedule(ok.id, { nextRunAt: Date.now() - 60_000 }))
      yield* Effect.promise(() => patchSchedule(fail.id, { nextRunAt: Date.now() - 60_000 }))

      const result = yield* cron.tick()
      expect(result.due).toBe(2)
      expect(result.runs).toHaveLength(2)
      expect(result.runs.map((item) => item.status).sort()).toEqual(["failed", "success"])
      expect(runs).toHaveLength(2)

      const stored = yield* Effect.promise(() => registry())
      const next = stored.schedules
        .map((item) => Number(item.nextRunAt))
        .every((value) => Number.isFinite(value) && value > Date.now() - 1_000)
      expect(next).toBe(true)
    }),
  )

  it.instance("skips missing workdirs and keeps the task enabled", () =>
    Effect.gen(function* () {
      const cron = yield* Cron.Service
      const test = yield* TestInstance
      const session = yield* seed()
      const created = yield* cron.create({
        label: "missing workdir",
        prompt: "run me",
        agentId: "build",
        sessionId: session.id,
        workdir: test.directory,
        every: "1 day",
        timezone: "UTC",
      })

      yield* Effect.promise(() =>
        patchSchedule(created.id, {
          workdir: path.join(test.directory, "missing-dir"),
          nextRunAt: Date.now() - 60_000,
        }),
      )

      const result = yield* cron.run(created.id, "tick")
      expect(result.status).toBe("skipped")
      expect(result.reason).toContain("Workdir not found")

      const stored = yield* Effect.promise(() => registry())
      const schedule = stored.schedules.find((item) => item.id === created.id)
      expect(schedule?.enabled).toBe(true)
    }),
  )

  it.instance("fails missing sessions and missing agents", () =>
    Effect.gen(function* () {
      const cron = yield* Cron.Service
      const test = yield* TestInstance
      const session = yield* seed()
      const missingSession = yield* cron.create({
        label: "missing session",
        prompt: "run me",
        agentId: "build",
        sessionId: session.id,
        workdir: test.directory,
        every: "1 day",
        timezone: "UTC",
      })
      const missingAgent = yield* cron.create({
        label: "missing agent",
        prompt: "run me",
        agentId: "build",
        sessionId: session.id,
        workdir: test.directory,
        every: "1 day",
        timezone: "UTC",
      })

      yield* Effect.promise(() => patchSchedule(missingSession.id, { sessionId: "ses_missing", nextRunAt: Date.now() - 60_000 }))
      yield* Effect.promise(() => patchSchedule(missingAgent.id, { agentId: "ghost", nextRunAt: Date.now() - 60_000 }))

      const sessionResult = yield* cron.run(missingSession.id, "tick")
      const agentResult = yield* cron.run(missingAgent.id, "tick")
      expect(sessionResult.status).toBe("failed")
      expect(sessionResult.reason).toContain("Session ses_missing was not found")
      expect(agentResult.status).toBe("failed")
      expect(agentResult.reason).toContain("Agent ghost was not found")
    }),
  )
})

describe("cron tool", () => {
  it.instance("defaults create bindings from the current conversation and lists the current scope", () =>
    Effect.gen(function* () {
      const cron = yield* Cron.Service
      const test = yield* TestInstance
      const session1 = yield* seed("session one")
      const session2 = yield* seed("session two")
      const toolInfo = yield* CronTool
      const tool = yield* toolInfo.init()

      const created = yield* tool.execute(
        {
          action: "create",
          label: "session one task",
          prompt: "run the first task",
          every: "1 day",
          timezone: "UTC",
        },
        ctx(session1.id),
      )
      yield* cron.create({
        label: "session two task",
        prompt: "run the second task",
        agentId: "build",
        sessionId: session2.id,
        workdir: test.directory,
        every: "1 day",
        timezone: "UTC",
      })

      const listed = yield* tool.execute({ action: "list" }, ctx(session1.id))
      const metadata = created.metadata as unknown as {
        schedule: { agentId: string; sessionId: string; workdir: string }
      }
      expect(String(metadata.schedule.agentId)).toBe("build")
      expect(String(metadata.schedule.sessionId)).toBe(session1.id)
      expect(String(metadata.schedule.workdir)).toBe(test.directory)
      expect(listed.output).toContain("label=session one task")
      expect(listed.output).not.toContain("label=session two task")
    }),
  )

  it.instance("rejects access to schedules outside the current conversation scope", () =>
    Effect.gen(function* () {
      const cron = yield* Cron.Service
      const test = yield* TestInstance
      const session1 = yield* seed("session one")
      const session2 = yield* seed("session two")
      const toolInfo = yield* CronTool
      const tool = yield* toolInfo.init()
      const other = yield* cron.create({
        label: "session two task",
        prompt: "run the second task",
        agentId: "build",
        sessionId: session2.id,
        workdir: test.directory,
        every: "1 day",
        timezone: "UTC",
      })

      const exit = yield* tool.execute({ action: "disable", schedule_id: other.id }, ctx(session1.id)).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect((Cause.squash(exit.cause) as Error).message).toContain("not visible")

      const all = yield* tool.execute({ action: "list" }, ctx(session1.id))
      expect(all.output).not.toContain("session two task")
    }),
  )
})

describe("cron platform plans", () => {
  test("launchagent generation is deterministic", () => {
    const plan = launchAgentPlan({
      home: "/Users/test",
      configRoot: "/Users/test/.config/ddm/cron",
      command: ["/opt/opencode", "cron", "tick"],
    })
    expect(plan.writes[0]?.path).toBe("/Users/test/Library/LaunchAgents/ai.ddm.opencode.cron.plist")
    expect(plan.writes[0]?.content).toContain("<integer>60</integer>")
    expect(plan.writes[0]?.content).toContain("<string>/opt/opencode</string>")
  })

  test("windows task generation is deterministic", () => {
    const plan = windowsTaskPlan({
      command: ["C:\\opencode.exe", "cron", "tick"],
    })
    expect(plan.commands[0]).toEqual([
      "schtasks",
      "/Create",
      "/SC",
      "MINUTE",
      "/MO",
      "1",
      "/TN",
      "ai.ddm.opencode.cron",
      "/TR",
      "C:\\opencode.exe cron tick",
      "/F",
    ])
  })

  test("systemd user generation is deterministic", () => {
    const plan = systemdUserPlan({
      home: "/home/test",
      configRoot: "/home/test/.config/ddm/cron",
      command: ["/opt/opencode", "cron", "tick"],
    })
    expect(plan.writes[0]?.content).toContain("ExecStart=/bin/sh -lc '/opt/opencode cron tick'")
    expect(plan.writes[1]?.content).toContain("OnCalendar=*-*-* *:*:00")
  })

  test("cron fallback generation is deterministic", () => {
    const plan = cronFallbackPlan({
      configRoot: "/home/test/.config/ddm/cron",
      command: ["/opt/opencode", "cron", "tick"],
    })
    expect(plan.writes[0]?.content).toContain(CRON_BLOCK_START)
    expect(plan.writes[0]?.content).toContain(CRON_BLOCK_END)
    expect(plan.writes[0]?.content).toContain("* * * * * /opt/opencode cron tick")
  })
})
