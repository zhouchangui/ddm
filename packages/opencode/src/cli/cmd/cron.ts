import { Cron } from "@/cron/cron"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"
import { UI } from "../ui"

const runnerChoices = ["auto", "launchagent", "windows-task", "systemd-user", "cron"] as const

type RunnerArg = {
  runner: (typeof runnerChoices)[number]
  "dry-run": boolean
}

export const CronCommand = cmd({
  command: "cron",
  describe: "manage scheduled cron tasks",
  builder: (yargs) =>
    yargs
      .command(CronRunCommand)
      .command(CronTickCommand)
      .command(CronInstallRunnerCommand)
      .command(CronUninstallRunnerCommand)
      .demandCommand(),
  async handler() {},
})

export const CronRunCommand = effectCmd({
  command: "run <scheduleId>",
  describe: "run one schedule immediately",
  instance: false,
  builder: (yargs) =>
    yargs.positional("scheduleId", {
      type: "string",
      describe: "schedule id",
      demandOption: true,
    }),
  handler: (args) =>
    Cron.Service.use((cron) =>
      Effect.gen(function* () {
        const result = yield* cron.run(args.scheduleId)
        UI.println(`schedule=${result.schedule.id} run=${result.runId} status=${result.status}`)
        if (result.reason) UI.println(`reason=${result.reason}`)
        UI.println(`jsonl=${result.jsonlPath}`)
        UI.println(`log=${result.logPath}`)
      }),
    ).pipe(Effect.provide(Cron.defaultLayer), Effect.orDie),
})

export const CronTickCommand = effectCmd({
  command: "tick",
  describe: "run all due schedules once",
  instance: false,
  handler: () =>
    Cron.Service.use((cron) =>
      Effect.gen(function* () {
        const result = yield* cron.tick()
        UI.println(`due=${String(result.due)} ran=${String(result.runs.length)}`)
        for (const run of result.runs) UI.println(`${run.schedule.id} ${run.status}${run.reason ? ` ${run.reason}` : ""}`)
      }),
    ).pipe(Effect.provide(Cron.defaultLayer), Effect.orDie),
})

export const CronInstallRunnerCommand = effectCmd({
  command: "install-runner",
  describe: "install the OS scheduler wakeup runner",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("runner", {
        type: "string",
        choices: runnerChoices,
        default: "auto",
        describe: "runner backend to install",
      })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "print the generated plan without applying it",
      }),
  handler: (args) =>
    Cron.Service.use((cron) =>
      Effect.gen(function* () {
        const result = yield* cron.installRunner({
          runner: args.runner as RunnerArg["runner"],
          dryRun: args["dry-run"],
        })
        UI.println(JSON.stringify(result, null, 2))
      }),
    ).pipe(Effect.provide(Cron.defaultLayer), Effect.orDie),
})

export const CronUninstallRunnerCommand = effectCmd({
  command: "uninstall-runner",
  describe: "remove the OS scheduler wakeup runner",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("runner", {
        type: "string",
        choices: runnerChoices,
        default: "auto",
        describe: "runner backend to remove",
      })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "print the generated plan without applying it",
      }),
  handler: (args) =>
    Cron.Service.use((cron) =>
      Effect.gen(function* () {
        const result = yield* cron.uninstallRunner({
          runner: args.runner as RunnerArg["runner"],
          dryRun: args["dry-run"],
        })
        UI.println(JSON.stringify(result, null, 2))
      }),
    ).pipe(Effect.provide(Cron.defaultLayer), Effect.orDie),
})
