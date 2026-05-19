import path from "path"

export type RunnerKind = "launchagent" | "windows-task" | "systemd-user" | "cron"

export const RUNNER_LABEL = "ai.ddm.opencode.cron"
export const CRON_BLOCK_START = "# >>> opencode cron runner >>>"
export const CRON_BLOCK_END = "# <<< opencode cron runner <<<"

type FileWrite = {
  path: string
  content: string
}

export type RunnerPlan = {
  runner: RunnerKind
  commands: string[][]
  writes: FileWrite[]
}

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function posixQuote(value: string) {
  if (!value.length) return "''"
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

function windowsQuote(value: string) {
  if (!value.length) return '""'
  if (!/[\s"]/u.test(value)) return value
  return `"${value.replace(/(\\*)"/g, "$1$1\\\\\"").replace(/(\\+)$/g, "$1$1")}"`
}

function posixCommand(args: string[]) {
  return args.map(posixQuote).join(" ")
}

function windowsCommand(args: string[]) {
  return args.map(windowsQuote).join(" ")
}

export function mergeManagedCrontab(existing: string, block: string) {
  const trimmed = existing.trimEnd()
  const withoutManaged = trimmed.includes(CRON_BLOCK_START)
    ? trimmed
        .replace(new RegExp(`${CRON_BLOCK_START}[\\s\\S]*?${CRON_BLOCK_END}\\n?`, "g"), "")
        .trimEnd()
    : trimmed
  return [withoutManaged, block].filter(Boolean).join(withoutManaged ? "\n\n" : "\n").trim() + "\n"
}

export function removeManagedCrontab(existing: string) {
  if (!existing.includes(CRON_BLOCK_START)) return existing.trim() ? existing.trimEnd() + "\n" : ""
  return existing
    .replace(new RegExp(`${CRON_BLOCK_START}[\\s\\S]*?${CRON_BLOCK_END}\\n?`, "g"), "")
    .trim()
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
    .concat(existing.trim() ? "\n" : "")
}

export function cronBlock(input: { command: string[]; logPath: string }) {
  const cmd = `${posixCommand(input.command)} >> ${posixQuote(input.logPath)} 2>&1`
  return [CRON_BLOCK_START, `* * * * * ${cmd}`, CRON_BLOCK_END].join("\n")
}

export function launchAgentPlan(input: {
  home: string
  configRoot: string
  command: string[]
}) {
  const plistPath = path.join(input.home, "Library", "LaunchAgents", `${RUNNER_LABEL}.plist`)
  const stdoutPath = path.join(input.configRoot, "runner.stdout.log")
  const stderrPath = path.join(input.configRoot, "runner.stderr.log")
  const content = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${xml(RUNNER_LABEL)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...input.command.map((item) => `    <string>${xml(item)}</string>`),
    `  </array>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>StartInterval</key>`,
    `  <integer>60</integer>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xml(stdoutPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xml(stderrPath)}</string>`,
    `</dict>`,
    `</plist>`,
  ].join("\n")
  return {
    runner: "launchagent" as const,
    writes: [{ path: plistPath, content }],
    commands: [
      ["launchctl", "unload", plistPath],
      ["launchctl", "load", plistPath],
    ],
  } satisfies RunnerPlan
}

export function windowsTaskPlan(input: { command: string[] }) {
  const taskCommand = windowsCommand(input.command)
  return {
    runner: "windows-task" as const,
    writes: [],
    commands: [
      [
        "schtasks",
        "/Create",
        "/SC",
        "MINUTE",
        "/MO",
        "1",
        "/TN",
        RUNNER_LABEL,
        "/TR",
        taskCommand,
        "/F",
      ],
    ],
  } satisfies RunnerPlan
}

export function systemdUserPlan(input: { home: string; configRoot: string; command: string[] }) {
  const unitDir = path.join(input.home, ".config", "systemd", "user")
  const servicePath = path.join(unitDir, `${RUNNER_LABEL}.service`)
  const timerPath = path.join(unitDir, `${RUNNER_LABEL}.timer`)
  const stdoutPath = path.join(input.configRoot, "runner.stdout.log")
  const stderrPath = path.join(input.configRoot, "runner.stderr.log")
  const service = [
    `[Unit]`,
    `Description=OpenCode cron tick runner`,
    ``,
    `[Service]`,
    `Type=oneshot`,
    `ExecStart=/bin/sh -lc ${posixQuote(posixCommand(input.command))}`,
    `StandardOutput=append:${stdoutPath}`,
    `StandardError=append:${stderrPath}`,
    ``,
  ].join("\n")
  const timer = [
    `[Unit]`,
    `Description=OpenCode cron tick runner`,
    ``,
    `[Timer]`,
    `OnCalendar=*-*-* *:*:00`,
    `Persistent=true`,
    ``,
    `[Install]`,
    `WantedBy=timers.target`,
    ``,
  ].join("\n")
  return {
    runner: "systemd-user" as const,
    writes: [
      { path: servicePath, content: service },
      { path: timerPath, content: timer },
    ],
    commands: [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", `${RUNNER_LABEL}.timer`],
    ],
  } satisfies RunnerPlan
}

export function cronFallbackPlan(input: { configRoot: string; command: string[] }) {
  return {
    runner: "cron" as const,
    writes: [
      {
        path: path.join(input.configRoot, "managed.crontab"),
        content: cronBlock({
          command: input.command,
          logPath: path.join(input.configRoot, "runner.stdout.log"),
        }),
      },
    ],
    commands: [["crontab", path.join(input.configRoot, "managed.crontab")]],
  } satisfies RunnerPlan
}

export * as CronPlatform from "./platform"
