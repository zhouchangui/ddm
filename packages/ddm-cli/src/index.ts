import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { cmdPack, cmdUnpack } from "./cmd/pack.js"
import { cmdLogin, cmdSetup, cmdImport } from "./cmd/auth.js"

yargs(hideBin(process.argv))
  .scriptName("ddm")
  .usage("$0 <command> [options]")

  // ─── pack ────────────────────────────────────────────────
  .command(
    "pack <agent-dir>",
    "将 agent 目录打包为 zip 发布包",
    (y) =>
      y
        .positional("agent-dir", {
          type: "string",
          describe: "包含 agent/*.md 和 manifest.json 的目录",
          demandOption: true,
        })
        .option("out", {
          alias: "o",
          type: "string",
          describe: "输出 zip 文件路径（默认按 packageId-version.zip 命名）",
        }),
    async (args) => {
      await cmdPack({
        agentDir: args["agent-dir"] as string,
        out: args.out,
      })
    },
  )

  // ─── unpack ──────────────────────────────────────────────
  .command(
    "unpack <zip>",
    "从 zip 包还原 agent 到 OpenCode 执行环境",
    (y) =>
      y
        .positional("zip", {
          type: "string",
          describe: "agent zip 文件路径",
          demandOption: true,
        })
        .option("target", {
          alias: "t",
          type: "string",
          describe: "目标目录（默认为当前目录，.opencode/ 会在此创建）",
        })
        .option("yes", {
          alias: "y",
          type: "boolean",
          default: false,
          describe: "跳过确认提示，直接导入",
        }),
    async (args) => {
      await cmdUnpack({
        zipPath: args.zip as string,
        target: args.target,
        yes: args.yes,
      })
    },
  )

  // ─── login ───────────────────────────────────────────────
  .command(
    "login",
    "登录 DDM 平台，获取 token 并写入 opencode.jsonc provider 配置",
    () => {},
    async () => {
      await cmdLogin()
    },
  )

  // ─── setup ───────────────────────────────────────────────
  .command(
    "setup",
    "注册 ddm:// 协议 handler（使网站导入按钮能拉起本工具）",
    (y) =>
      y
        .option("protocol-only", {
          type: "boolean",
          default: false,
          describe: "仅注册协议，跳过其他配置",
        })
        .option("silent", {
          type: "boolean",
          default: false,
          describe: "静默模式，不输出日志（postinstall 使用）",
        }),
    async (args) => {
      await cmdSetup({
        protocolOnly: args["protocol-only"],
        silent: args.silent,
      })
    },
  )

  // ─── import ──────────────────────────────────────────────
  .command(
    "import <input>",
    "从 ddm:// 协议 URL 或本地 zip 文件导入 agent",
    (y) =>
      y.positional("input", {
        type: "string",
        describe: "ddm://import?pkg=<url> 或 /path/to/file.zip",
        demandOption: true,
      }),
    async (args) => {
      await cmdImport(args.input as string)
    },
  )

  .demandCommand(1, "请指定一个命令")
  .help()
  .alias("h", "help")
  .version()
  .alias("v", "version")
  .strict()
  .parse()
