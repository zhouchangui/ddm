import { Cron } from "@/cron/cron"
import { Session } from "@/session/session"
import { Effect, Schema } from "effect"
import DESCRIPTION from "./cron.txt"
import * as Tool from "./tool"

type Metadata = {
  schedules?: unknown[]
  schedule?: unknown
  scheduleId?: string
  result?: unknown
}

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "create", "update", "enable", "disable", "delete", "run"]),
  schedule_id: Schema.optional(Schema.String).annotate({ description: "Existing schedule id for update, enable, disable, delete, or run" }),
  label: Schema.optional(Schema.String).annotate({ description: "Human-readable schedule label" }),
  prompt: Schema.optional(Schema.String).annotate({ description: "Recurring prompt to run" }),
  cron: Schema.optional(Schema.String).annotate({ description: "Cron expression in minute-level 5-field format" }),
  every: Schema.optional(Schema.String).annotate({ description: "Recurring interval such as 1h, 24h, or 1 day" }),
  timezone: Schema.optional(Schema.String).annotate({ description: "IANA timezone such as Asia/Shanghai or America/Los_Angeles" }),
  agent_id: Schema.optional(Schema.String).annotate({ description: "Primary agent id. Defaults to the current conversation agent." }),
  session_id: Schema.optional(Schema.String).annotate({ description: "Session id. Defaults to the current conversation session." }),
  workdir: Schema.optional(Schema.String).annotate({ description: "Working directory. Defaults to the current OpenCode instance directory." }),
  enabled: Schema.optional(Schema.Boolean).annotate({ description: "Optional enabled state when creating or updating a schedule" }),
})

function format(schedule: {
  id: string
  label: string
  agentId: string
  sessionId: string
  workdir: string
  cron?: string
  every?: string
  timezone: string
  enabled: boolean
  nextRunAt?: number
  lastStatus?: string
}) {
  return [
    `id=${schedule.id}`,
    `label=${schedule.label}`,
    `agentId=${schedule.agentId}`,
    `sessionId=${schedule.sessionId}`,
    `workdir=${schedule.workdir}`,
    `recurrence=${schedule.cron ?? schedule.every ?? "unknown"}`,
    `timezone=${schedule.timezone}`,
    `enabled=${String(schedule.enabled)}`,
    schedule.nextRunAt ? `nextRunAt=${new Date(schedule.nextRunAt).toISOString()}` : "",
    schedule.lastStatus ? `lastStatus=${schedule.lastStatus}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export const CronTool = Tool.define<typeof Parameters, Metadata, Cron.Service | Session.Service>(
  "cron",
  Effect.gen(function* () {
    const cron = yield* Cron.Service
    const session = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const current = yield* session.get(ctx.sessionID)
          const scoped = Effect.fn("CronTool.scoped")(function* (scheduleId: string) {
            const schedules = yield* cron.list({
              sessionId: ctx.sessionID,
              workdir: current.directory,
            })
            const schedule = schedules.find((item) => item.id === scheduleId)
            if (!schedule) throw new Error(`Schedule "${scheduleId}" is not visible from the current session and workdir`)
            return schedule
          })

          if (params.action === "list") {
            const schedules = yield* cron.list({
              sessionId: params.session_id ?? ctx.sessionID,
              workdir: params.workdir ?? current.directory,
            })
            return {
              title: `Listed ${schedules.length} schedule${schedules.length === 1 ? "" : "s"}`,
              output: schedules.length
                ? schedules.map((item) => format(item)).join("\n\n")
                : "No schedules found for the current scope.",
              metadata: { schedules },
            }
          }

          if (params.action === "create") {
            const created = yield* cron.create({
              label: params.label ?? "",
              prompt: params.prompt ?? "",
              cron: params.cron,
              every: params.every,
              timezone: params.timezone,
              enabled: params.enabled,
              agentId: params.agent_id ?? ctx.agent,
              sessionId: params.session_id ?? ctx.sessionID,
              workdir: params.workdir ?? current.directory,
            })
            return {
              title: `Created schedule ${created.id}`,
              output: format(created),
              metadata: { schedule: created },
            }
          }

          if (!params.schedule_id) throw new Error("schedule_id is required for this cron action")
          yield* scoped(params.schedule_id)

          if (params.action === "update") {
            const updated = yield* cron.update({
              scheduleId: params.schedule_id,
              label: params.label,
              prompt: params.prompt,
              cron: params.cron,
              every: params.every,
              timezone: params.timezone,
              enabled: params.enabled,
              agentId: params.agent_id,
              sessionId: params.session_id,
              workdir: params.workdir,
            })
            return {
              title: `Updated schedule ${updated.id}`,
              output: format(updated),
              metadata: { schedule: updated },
            }
          }

          if (params.action === "enable") {
            const enabled = yield* cron.enable(params.schedule_id)
            return {
              title: `Enabled schedule ${enabled.id}`,
              output: format(enabled),
              metadata: { schedule: enabled },
            }
          }

          if (params.action === "disable") {
            const disabled = yield* cron.disable(params.schedule_id)
            return {
              title: `Disabled schedule ${disabled.id}`,
              output: format(disabled),
              metadata: { schedule: disabled },
            }
          }

          if (params.action === "delete") {
            yield* cron.remove(params.schedule_id)
            return {
              title: `Deleted schedule ${params.schedule_id}`,
              output: `Deleted schedule ${params.schedule_id}.`,
              metadata: { scheduleId: params.schedule_id },
            }
          }

          const result = yield* cron.run(params.schedule_id)
          return {
            title: `Ran schedule ${result.schedule.id}`,
            output: [
              format(result.schedule),
              `runId=${result.runId}`,
              `status=${result.status}`,
              result.reason ? `reason=${result.reason}` : "",
              result.exitCode !== undefined ? `exitCode=${String(result.exitCode)}` : "",
              `jsonlPath=${result.jsonlPath}`,
              `logPath=${result.logPath}`,
            ]
              .filter(Boolean)
              .join("\n"),
            metadata: { result },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
