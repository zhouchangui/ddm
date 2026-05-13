import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { intro, log, outro, spinner, text, confirm } from "@clack/prompts"
import JSZip from "jszip"
import matter from "gray-matter"
import {
  type AgentManifest,
  type Dependencies,
  type QuickCommand,
  SCHEMA_VERSION,
  validateManifest,
  parseManifest,
} from "../schema.js"

// ─── 工具函数 ─────────────────────────────────────────────────

function readFileSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8")
  } catch {
    return null
  }
}

function walkDir(dir: string, ext: string): string[] {
  const results: string[] = []
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...walkDir(full, ext))
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      results.push(full)
    }
  }
  return results
}

function resolveOpencodeConfig(): string {
  // 查找最近的 .opencode/opencode.jsonc
  let cur = process.cwd()
  for (;;) {
    const candidate = path.join(cur, ".opencode", "opencode.jsonc")
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  // 回退到 cwd 下新建
  const dir = path.join(process.cwd(), ".opencode")
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, "opencode.jsonc")
}

function mergeJsonc(filePath: string, patch: (obj: Record<string, unknown>) => void): void {
  let raw = readFileSafe(filePath) ?? "{}"
  // 去掉 JSONC 注释（简单处理：单行 //）
  raw = raw.replace(/\/\/[^\n]*/g, "")
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw)
  } catch {
    obj = {}
  }
  patch(obj)
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8")
}

async function runCommand(cmd: string): Promise<{ ok: boolean; stderr: string }> {
  const { spawnSync } = await import("node:child_process")
  const [bin, ...args] = cmd.split(" ")
  const result = spawnSync(bin, args, { stdio: "inherit" })
  if (result.error) return { ok: false, stderr: result.error.message }
  return { ok: result.status === 0, stderr: "" }
}

// ─── PACK ─────────────────────────────────────────────────────

interface PackOptions {
  agentDir: string
  out?: string
}

/**
 * ddm pack <agent-dir>
 *
 * 把 agent 目录打包成 zip：
 *   agent/<name>.md       → 主 agent 定义
 *   manifest.json         → 自动生成或使用目录中已有的
 */
export async function cmdPack(opts: PackOptions): Promise<void> {
  intro("DDM Pack")

  const agentDir = path.resolve(opts.agentDir)
  if (!fs.existsSync(agentDir)) {
    log.error(`目录不存在: ${agentDir}`)
    process.exitCode = 1
    return
  }

  const s = spinner()
  s.start("扫描 agent 文件...")

  // 找 agent/*.md
  const agentMdDir = path.join(agentDir, "agent")
  const agentFiles = walkDir(agentMdDir, ".md").map((f) => path.relative(agentDir, f).replace(/\\/g, "/"))

  if (agentFiles.length === 0) {
    s.stop("未找到 agent 定义文件", 1)
    log.error(`在 ${agentMdDir} 下没有找到任何 .md 文件`)
    log.info("agent 定义文件应放在 <agent-dir>/agent/<name>.md")
    process.exitCode = 1
    return
  }

  s.stop(`找到 ${agentFiles.length} 个 agent 文件`)

  // 读取或生成 manifest.json
  const manifestPath = path.join(agentDir, "manifest.json")
  let manifest: AgentManifest

  if (fs.existsSync(manifestPath)) {
    log.info("使用已有 manifest.json")
    try {
      manifest = parseManifest(fs.readFileSync(manifestPath, "utf8"))
    } catch (e) {
      log.error(String(e))
      process.exitCode = 1
      return
    }
    // 同步 agents 列表
    manifest.agents = agentFiles
  } else {
    log.info("未找到 manifest.json，根据 agent 文件自动生成草稿")
    manifest = await generateManifestDraft(agentDir, agentFiles)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8")
    log.warn(`已生成 manifest.json 草稿到 ${manifestPath}，请检查并补全后重新运行 ddm pack`)
    process.exitCode = 0
    return
  }

  // 打包
  const s2 = spinner()
  s2.start("打包 zip...")

  const zip = new JSZip()
  zip.file("manifest.json", JSON.stringify(manifest, null, 2))

  // 添加 agent 文件
  for (const rel of agentFiles) {
    const content = fs.readFileSync(path.join(agentDir, rel), "utf8")
    zip.file(rel, content)
  }

  const outName = opts.out ?? `${manifest.packageId.replace(/\./g, "-")}-${manifest.version}.zip`
  const outPath = path.resolve(outName)
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  fs.writeFileSync(outPath, buf)

  s2.stop(`已生成: ${outPath}`)

  // 打印摘要
  log.info(`📦 包 ID : ${manifest.packageId}`)
  log.info(`📌 版本  : ${manifest.version}`)
  log.info(`🤖 Agent : ${agentFiles.join(", ")}`)
  if (manifest.dependencies.skills?.length) {
    log.info(`🔧 Skills: ${manifest.dependencies.skills.map((s) => s.name).join(", ")}`)
  }
  if (manifest.dependencies.mcp?.length) {
    log.info(`🔌 MCP   : ${manifest.dependencies.mcp.map((m) => m.name).join(", ")}`)
  }
  if (manifest.dependencies.docker?.length) {
    log.info(`🐳 Docker: ${manifest.dependencies.docker.map((d) => d.service).join(", ")}`)
  }

  outro("Pack 完成")
}

async function generateManifestDraft(agentDir: string, agentFiles: string[]): Promise<AgentManifest> {
  // 从第一个 agent 文件读 frontmatter 提取基本信息
  const firstAgent = path.join(agentDir, agentFiles[0])
  const parsed = matter(fs.readFileSync(firstAgent, "utf8"))
  const agentName = path.basename(agentFiles[0], ".md")

  return {
    schemaVersion: SCHEMA_VERSION,
    packageId: `ddm.${agentName}`,
    version: "0.1.0",
    name: (parsed.data.description as string) ?? agentName,
    summary: "请填写 20-40 字的一句话说明",
    description: "请填写 80-160 字的适用场景、核心能力和主要产出说明",
    tags: ["请填写", "领域标签", "3-5个"],
    quickCommands: [
      {
        id: "start",
        label: "开始任务",
        prompt: "请填写用户点击后发送给 agent 的完整任务指令",
      },
    ] satisfies QuickCommand[],
    agents: agentFiles,
    dependencies: {} satisfies Dependencies,
    changeSummary: "初始版本",
  }
}

// ─── UNPACK ───────────────────────────────────────────────────

interface UnpackOptions {
  zipPath: string
  target?: string
  yes?: boolean
}

/**
 * ddm unpack <file.zip>
 *
 * 从 zip 还原 agent 到 OpenCode 执行环境：
 * 1. 解压 manifest.json 读取依赖
 * 2. 复制 agent/*.md → .opencode/agent/
 * 3. 执行 skills installCommand
 * 4. 合并 mcp 配置到 opencode.jsonc
 * 5. 启动 docker 服务
 * 6. 提示填写环境变量
 */
export async function cmdUnpack(opts: UnpackOptions): Promise<void> {
  intro("DDM Unpack")

  const zipPath = path.resolve(opts.zipPath)
  if (!fs.existsSync(zipPath)) {
    log.error(`文件不存在: ${zipPath}`)
    process.exitCode = 1
    return
  }

  // 解析 zip
  const s = spinner()
  s.start("读取 zip 包...")
  const buf = fs.readFileSync(zipPath)
  const zip = await JSZip.loadAsync(buf)

  const manifestFile = zip.file("manifest.json")
  if (!manifestFile) {
    s.stop("zip 包中缺少 manifest.json", 1)
    process.exitCode = 1
    return
  }

  let manifest: AgentManifest
  try {
    manifest = parseManifest(await manifestFile.async("string"))
  } catch (e) {
    s.stop("manifest.json 验证失败", 1)
    log.error(String(e))
    process.exitCode = 1
    return
  }
  s.stop(`已读取 ${manifest.name} v${manifest.version}`)

  // 确认
  if (!opts.yes) {
    log.info(`📦 包 ID : ${manifest.packageId}`)
    log.info(`📌 版本  : ${manifest.version}`)
    log.info(`📝 简介  : ${manifest.summary}`)

    const deps = manifest.dependencies
    if (deps.skills?.length) log.info(`🔧 将安装 Skills: ${deps.skills.map((s) => s.name).join(", ")}`)
    if (deps.mcp?.length) log.info(`🔌 将配置 MCP: ${deps.mcp.map((m) => m.name).join(", ")}`)
    if (deps.docker?.length) log.info(`🐳 将启动 Docker: ${deps.docker.map((d) => d.service).join(", ")}`)
    if (deps.envVars?.filter((e) => e.required).length) {
      log.info(`🔑 需要填写环境变量: ${deps.envVars.filter((e) => e.required).map((e) => e.key).join(", ")}`)
    }

    const ok = await confirm({ message: "确认导入这个 agent 吗？" })
    if (!ok) {
      log.info("已取消")
      return
    }
  }

  // 默认安装到 XDG config 目录（~/.config/opencode），与 OpenCode 全局 agent 路径一致
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
  const targetDir = opts.target ? path.resolve(opts.target) : path.join(xdgConfig, "opencode")
  const opencodeDir = opts.target ? path.join(targetDir, ".opencode") : targetDir
  fs.mkdirSync(opencodeDir, { recursive: true })

  // 1. 复制 agent 文件
  const s1 = spinner()
  s1.start("复制 agent 文件...")
  let copied = 0
  for (const agentPath of manifest.agents) {
    const file = zip.file(agentPath)
    if (!file) {
      log.warn(`manifest 中声明的文件不在 zip 内: ${agentPath}`)
      continue
    }
    const dest = path.join(opencodeDir, agentPath)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, await file.async("string"), "utf8")
    copied++
  }
  s1.stop(`已复制 ${copied} 个 agent 文件到 ${opencodeDir}/agent/`)

  const deps = manifest.dependencies

  // 2. 安装 Skills
  if (deps.skills && deps.skills.length > 0) {
    for (const skill of deps.skills) {
      const s2 = spinner()
      s2.start(`安装 skill: ${skill.name}...`)
      const r = await runCommand(skill.installCommand)
      if (r.ok) {
        s2.stop(`✓ ${skill.name}`)
      } else {
        s2.stop(`✗ ${skill.name} 安装失败`, 1)
        log.warn(`可手动运行: ${skill.installCommand}`)
        if (!skill.required) log.warn("（此 skill 非必须，可跳过）")
      }
    }
  }

  // 3. 合并 MCP 配置到 opencode.jsonc
  if (deps.mcp && deps.mcp.length > 0) {
    const s3 = spinner()
    s3.start("合并 MCP 配置...")
    const configPath = resolveOpencodeConfig()
    mergeJsonc(configPath, (obj) => {
      const mcp = (obj.mcp ?? {}) as Record<string, unknown>
      for (const m of deps.mcp!) {
        if (mcp[m.name]) {
          // 已存在，跳过（不覆盖用户配置）
          continue
        }
        if (m.type === "local") {
          mcp[m.name] = {
            type: "local",
            command: m.command,
            enabled: true,
          }
        } else {
          mcp[m.name] = {
            type: "remote",
            url: m.url,
            headers: m.headers ?? {},
            enabled: true,
          }
        }
      }
      obj.mcp = mcp
    })
    s3.stop(`已更新 ${configPath}`)
  }

  // 4. 启动 Docker 服务
  if (deps.docker && deps.docker.length > 0) {
    for (const docker of deps.docker) {
      const s4 = spinner()
      s4.start(`启动 Docker 服务: ${docker.service}...`)

      // 先检查是否已在运行
      const check = await runCommand(`docker ps -q -f name=${docker.service}`)
      if (check.ok) {
        // 如果已运行则跳过
        s4.stop(`${docker.service} 已在运行，跳过`)
        continue
      }

      const r = await runCommand(docker.startCommand)
      if (r.ok) {
        s4.stop(`✓ ${docker.service} 已启动`)
        if (docker.healthCheck) {
          log.info(`健康检查: ${docker.healthCheck}`)
        }
      } else {
        s4.stop(`✗ ${docker.service} 启动失败`, 1)
        log.warn(`可手动运行: ${docker.startCommand}`)
        if (!docker.required) log.warn("（此服务非必须，可跳过）")
        else log.error(`此服务是必须的，agent 可能无法正常工作`)
      }
    }
  }

  // 5. 提示 App 安装
  if (deps.apps && deps.apps.length > 0) {
    const platform = os.platform() as "darwin" | "win32" | "linux"
    const platformKey = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux"
    const relevantApps = deps.apps.filter((a) => a.platform.includes(platformKey))
    if (relevantApps.length > 0) {
      log.warn("以下应用需要手动安装：")
      for (const app of relevantApps) {
        log.warn(`  ${app.required ? "[必须]" : "[可选]"} ${app.name}: ${app.installUrl}`)
        log.warn(`         ${app.description}`)
      }
    }
  }

  // 6. 提示填写环境变量
  if (deps.envVars && deps.envVars.length > 0) {
    log.info("")
    log.info("以下环境变量需要配置：")

    const envLines: string[] = []
    for (const ev of deps.envVars) {
      if (opts.yes) {
        log.warn(`  ${ev.required ? "[必须]" : "[可选]"} ${ev.key}`)
        log.info(`         ${ev.description}`)
        if (ev.example) log.info(`         示例: ${ev.example}`)
        envLines.push(`${ev.key}=`)
      } else {
        log.info(`  ${ev.required ? "【必填】" : "【可选】"} ${ev.key}`)
        log.info(`         ${ev.description}`)
        if (ev.example) log.info(`         示例: ${ev.example}`)

        if (ev.required) {
          const val = await text({
            message: `请输入 ${ev.key}`,
            placeholder: ev.example ?? "",
          })
          if (val && typeof val === "string") {
            envLines.push(`${ev.key}=${val}`)
          }
        } else {
          envLines.push(`# ${ev.key}=  # ${ev.description}`)
        }
      }
    }

    // 写入 .opencode/.env（不覆盖已有值）
    if (envLines.length > 0) {
      const envPath = path.join(opencodeDir, ".env")
      const existing = readFileSafe(envPath) ?? ""
      const toAdd = envLines.filter((line) => {
        const key = line.split("=")[0].replace(/^#\s*/, "")
        return !existing.includes(key + "=")
      })
      if (toAdd.length > 0) {
        fs.appendFileSync(envPath, "\n" + toAdd.join("\n") + "\n", "utf8")
        log.info(`环境变量已追加到 ${envPath}`)
      }
    }
  }

  log.info("")
  log.success(`${manifest.name} 导入完成！`)
  log.info(`重启 OpenCode 后即可使用 @${path.basename(manifest.agents[0], ".md")} 调用此 agent`)

  outro("Unpack 完成")
}
