import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { intro, log, outro, spinner, text, confirm } from "@clack/prompts"
import JSZip from "jszip"
import matter from "gray-matter"
import {
  type AgentManifest,
  envVarKey,
  isSafeRelativePath,
  manifestAgentCommandName,
  manifestAgentPaths,
  manifestMediaPaths,
  manifestOpencodeSkillEntries,
  manifestOpencodeSkillPaths,
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

function walkFiles(dir: string): string[] {
  const results: string[] = []
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) results.push(...walkFiles(full))
    else if (entry.isFile()) results.push(full)
  }
  return results
}

function toZipPath(value: string): string {
  return value.replace(/\\/g, "/")
}

function assertSafeRelativePath(rel: string, label: string): boolean {
  if (isSafeRelativePath(rel)) return true
  log.error(`${label} 不是安全相对路径: ${rel}`)
  process.exitCode = 1
  return false
}

function safeResolve(root: string, rel: string): string | undefined {
  if (!isSafeRelativePath(rel)) return
  const resolved = path.resolve(root, rel)
  const base = path.resolve(root)
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return
  return resolved
}

function resolveOpencodeConfig(baseDir = process.cwd()): string {
  // 查找最近的 .opencode/opencode.jsonc
  let cur = baseDir
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

function skillRoots(target?: string): string[] {
  const home = os.homedir()
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config")
  const opencodeDir = target ? path.join(path.resolve(target), ".opencode") : path.join(xdgConfig, "opencode")
  const projectDirs = [process.cwd(), target ? path.resolve(target) : ""]
    .filter((dir): dir is string => dir.length > 0)
    .flatMap((dir) => {
      const dirs: string[] = []
      for (let current = path.resolve(dir); ; current = path.dirname(current)) {
        dirs.push(current)
        if (path.dirname(current) === current) return dirs
      }
    })

  return Array.from(
    new Set([
      path.join(home, ".agents", "skills"),
      path.join(home, ".claude", "skills"),
      path.join(opencodeDir, "skill"),
      path.join(opencodeDir, "skills"),
      ...projectDirs.flatMap((dir) => [
        path.join(dir, ".agents", "skills"),
        path.join(dir, ".claude", "skills"),
        path.join(dir, ".opencode", "skill"),
        path.join(dir, ".opencode", "skills"),
      ]),
    ]),
  )
}

function skillFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root).flatMap((entry) => {
    const full = path.join(root, entry)
    let stat: fs.Stats
    try {
      stat = fs.statSync(full)
    } catch {
      return []
    }
    if (!stat.isDirectory()) return entry === "SKILL.md" ? [full] : []
    return [path.join(full, "SKILL.md"), ...skillFiles(full)].filter((file) => fs.existsSync(file))
  })
}

function installedSkillLocation(name: string, target?: string): string | undefined {
  return skillRoots(target)
    .flatMap((root) => {
      const direct = path.join(root, name, "SKILL.md")
      return fs.existsSync(direct) ? [direct, ...skillFiles(root)] : skillFiles(root)
    })
    .find((file) => {
      try {
        const parsed = matter(fs.readFileSync(file, "utf8"))
        return parsed.data.name === name
      } catch {
        return false
      }
    })
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

/**
 * 通过 npm 安装指定包并将技能目录复制到 opencodeDir/skills/<skillId>。
 * 1. 在临时目录运行 `npm install <npmPackage>`
 * 2. 从 node_modules 内找到 SKILL.md 并将整个包目录复制到 skillsDir/<skillId>
 */
async function installSkillFromNpm(
  npmPackage: string,
  skillId: string,
  skillsDir: string,
): Promise<{ ok: boolean; message: string }> {
  const { spawnSync } = await import("node:child_process")
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ddm-skill-"))
  try {
    // 写最小 package.json，防止 npm install 报"no package.json"
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "ddm-skill-install-tmp", version: "0.0.0", private: true }), "utf8")

    const result = spawnSync("npm", ["install", npmPackage], {
      cwd: tmpDir,
      stdio: "pipe",
      encoding: "utf8",
    })

    if (result.status !== 0) {
      const stderr = result.stderr ?? ""
      return { ok: false, message: `npm install 失败: ${stderr.slice(0, 200)}` }
    }

    // 推断包在 node_modules 中的路径（@scope/name → node_modules/@scope/name）
    const pkgDir = path.join(tmpDir, "node_modules", ...npmPackage.split("/"))
    if (!fs.existsSync(pkgDir)) {
      return { ok: false, message: `安装后未找到包目录: ${pkgDir}` }
    }

    // 技能内容在包内的 <skillId>/ 子目录（publish-skill.mjs 约定的包结构）
    const skillContentDir = path.join(pkgDir, skillId)
    if (!fs.existsSync(path.join(skillContentDir, "SKILL.md"))) {
      return { ok: false, message: `SKILL.md not found in ${npmPackage}: expected at ${skillContentDir}/SKILL.md` }
    }

    // 将技能内容复制到 skillsDir/<skillId>（不包含 package.json 等包元数据）
    const destDir = path.join(skillsDir, skillId)
    fs.mkdirSync(destDir, { recursive: true })
    fs.cpSync(skillContentDir, destDir, { recursive: true })
    return { ok: true, message: `已从 npm 安装 ${npmPackage} 到 ${destDir}` }
  } finally {
    // 清理临时目录
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

function manifestPackageFiles(agentDir: string, manifest: AgentManifest): string[] | undefined {
  const files = new Set<string>(["manifest.json"])
  const readme = path.join(agentDir, "README.md")
  if (fs.existsSync(readme)) files.add("README.md")

  for (const agentPath of manifestAgentPaths(manifest)) {
    if (!assertSafeRelativePath(agentPath, "agent 文件路径")) return
    const full = safeResolve(agentDir, agentPath)
    if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      log.error(`manifest 声明的 agent 文件不存在: ${agentPath}`)
      process.exitCode = 1
      return
    }
    files.add(toZipPath(agentPath))
  }

  for (const skillPath of manifestOpencodeSkillPaths(manifest)) {
    if (!assertSafeRelativePath(skillPath, "opencode skill 路径")) return
    const full = safeResolve(agentDir, skillPath)
    if (!full || !fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
      log.error(`manifest 声明的专属 skill 目录不存在: ${skillPath}`)
      process.exitCode = 1
      return
    }
    if (!fs.existsSync(path.join(full, "SKILL.md"))) {
      log.error(`专属 skill 目录缺少 SKILL.md: ${skillPath}`)
      process.exitCode = 1
      return
    }
    for (const file of walkFiles(full)) {
      files.add(toZipPath(path.relative(agentDir, file)))
    }
  }

  for (const mediaPath of manifestMediaPaths(manifest)) {
    if (!assertSafeRelativePath(mediaPath, "media 文件路径")) return
    if (!mediaPath.startsWith("media/")) {
      log.error(`manifest.media.path 必须位于 media/ 目录下: ${mediaPath}`)
      process.exitCode = 1
      return
    }
    const full = safeResolve(agentDir, mediaPath)
    if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      log.error(`manifest 声明的 media 文件不存在: ${mediaPath}`)
      process.exitCode = 1
      return
    }
    files.add(toZipPath(mediaPath))
  }

  return Array.from(files).sort()
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
 *   manifest.json              → 包契约
 *   manifest.opencode.agent    → 当前格式主 agent 定义
 *   manifest.opencode.skills[] → 当前格式专属技能目录
 */
export async function cmdPack(opts: PackOptions): Promise<void> {
  intro("DDM Pack")

  const agentDir = path.resolve(opts.agentDir)
  if (!fs.existsSync(agentDir)) {
    log.error(`目录不存在: ${agentDir}`)
    process.exitCode = 1
    return
  }

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
  } else {
    log.error("未找到 manifest.json")
    log.info("当前格式必须先在 agent 成品目录维护 manifest.json，再执行 ddm pack")
    process.exitCode = 1
    return
  }

  const packageFiles = manifestPackageFiles(agentDir, manifest)
  if (!packageFiles) return

  // 打包
  const s2 = spinner()
  s2.start("打包 zip...")

  const zip = new JSZip()
  for (const rel of packageFiles) {
    const full = safeResolve(agentDir, rel)
    if (!full) {
      s2.stop("打包失败", 1)
      log.error(`非法包内路径: ${rel}`)
      process.exitCode = 1
      return
    }
    const content = rel === "manifest.json" ? JSON.stringify(manifest, null, 2) : fs.readFileSync(full)
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
  log.info(`🤖 Agent : ${manifestAgentPaths(manifest).join(", ")}`)
  const bundledSkills = manifestOpencodeSkillPaths(manifest)
  if (bundledSkills.length) {
    log.info(`🧩 内置 Skills: ${bundledSkills.join(", ")}`)
  }
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

// ─── UNPACK ───────────────────────────────────────────────────

interface UnpackOptions {
  zipPath: string
  target?: string
  yes?: boolean
  skipDeps?: boolean
  env?: Record<string, string>
}

const cleanEnvValue = (value: string) => value.replaceAll("\n", "").replaceAll("\r", "")

function zipContainsPrefix(zip: JSZip, prefix: string): boolean {
  const normalized = toZipPath(prefix).replace(/\/+$/, "")
  return Object.values(zip.files).some((file) => !file.dir && (file.name === normalized || file.name.startsWith(`${normalized}/`)))
}

async function copyZipFile(zip: JSZip, rel: string, dest: string): Promise<boolean> {
  const file = zip.file(rel)
  if (!file) return false
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, await file.async("nodebuffer"))
  return true
}

async function copyZipPrefix(zip: JSZip, prefix: string, destRoot: string): Promise<number> {
  const normalized = toZipPath(prefix).replace(/\/+$/, "")
  const root = path.resolve(destRoot)
  let copied = 0
  for (const file of Object.values(zip.files)) {
    if (file.dir || (file.name !== normalized && !file.name.startsWith(`${normalized}/`))) continue
    const relInside = file.name === normalized ? path.basename(file.name) : file.name.slice(normalized.length + 1)
    if (!relInside || relInside.split("/").some((part) => part === ".." || part === "")) continue
    const dest = path.resolve(root, relInside)
    if (!dest.startsWith(root + path.sep) && dest !== root) continue
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, await file.async("nodebuffer"))
    copied++
  }
  return copied
}

function agentInstallPath(opencodeDir: string, manifest: AgentManifest, agentPath: string): string {
  if (manifest.opencode?.agent) return path.join(opencodeDir, "agent", path.basename(agentPath))
  return path.resolve(opencodeDir, agentPath)
}

/**
 * ddm unpack <file.zip>
 *
 * 从 zip 还原 agent 到 OpenCode 执行环境：
 * 1. 解压 manifest.json 读取依赖
 * 2. 复制 manifest.opencode.agent → .opencode/agent/
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

  const s = spinner()
  s.start("读取 zip 包...")
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath))
  const manifestFile = zip.file("manifest.json")
  let manifest: AgentManifest
  try {
    if (!manifestFile) throw new Error("zip 包中缺少 manifest.json")
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
    if (deps.skills?.length) {
      const skills = deps.skills
        .filter((skill) => skill.name)
        .map((skill) => ({ skill, existing: installedSkillLocation(skill.name, opts.target) }))
      const toInstall = skills.filter((item) => !item.existing).map((item) => item.skill.name)
      const installed = skills.filter((item) => item.existing).map((item) => item.skill.name)
      if (toInstall.length) log.info(`🔧 将安装 Skills: ${toInstall.join(", ")}`)
      if (installed.length) log.info(`✅ 已存在并跳过 Skills: ${installed.join(", ")}`)
    }
    if (deps.mcp?.length) log.info(`🔌 将配置 MCP: ${deps.mcp.map((m) => m.name).join(", ")}`)
    if (deps.docker?.length) log.info(`🐳 将启动 Docker: ${deps.docker.map((d) => d.service).join(", ")}`)
    if (deps.envVars?.filter((e) => e.required).length) {
      log.info(
        `🔑 需要填写环境变量: ${deps.envVars
          .filter((e) => e.required)
          .map((e) => envVarKey(e))
          .filter((key): key is string => !!key)
          .join(", ")}`,
      )
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
  for (const agentPath of manifestAgentPaths(manifest)) {
    if (!isSafeRelativePath(agentPath)) {
      log.warn(`跳过非法 agent 路径: ${agentPath}`)
      continue
    }
    const dest = agentInstallPath(opencodeDir, manifest, agentPath)
    const opencodeRoot = path.resolve(opencodeDir)
    if (!dest.startsWith(opencodeRoot + path.sep) && dest !== opencodeRoot) {
      log.warn(`跳过非法路径（路径遍历）: ${agentPath}`)
      continue
    }
    const ok = await copyZipFile(zip, agentPath, dest)
    if (!ok) {
      log.warn(`manifest 中声明的文件不在 zip 内: ${agentPath}`)
      continue
    }
    copied++
  }
  s1.stop(`已复制 ${copied} 个 agent 文件到 ${opencodeDir}/agent/`)

  const bundledSkillEntries = manifestOpencodeSkillEntries(manifest)
  if (bundledSkillEntries.length > 0) {
    const sSkills = spinner()
    sSkills.start("复制包内专属 skills...")
    let skillFilesCopied = 0
    const skillsDir = path.join(opencodeDir, "skills")
    for (const { path: skillPath, npmPackage } of bundledSkillEntries) {
      if (!isSafeRelativePath(skillPath)) {
        log.warn(`跳过非法 skill 路径: ${skillPath}`)
        continue
      }
      const skillId = path.basename(skillPath)
      const inZip = zipContainsPrefix(zip, skillPath) && !!zip.file(`${skillPath.replace(/\/+$/, "")}/SKILL.md`)

      if (inZip) {
        // zip 内有完整 skill：直接解压（优先）
        skillFilesCopied += await copyZipPrefix(zip, skillPath, path.join(skillsDir, skillId))
      } else if (npmPackage) {
        // zip 中无 skill 但有 npmPackage：从 npm 安装
        sSkills.stop("切换到 npm 安装模式")
        const ns = spinner()
        ns.start(`从 npm 安装捆绑 skill: ${npmPackage}...`)
        const r = await installSkillFromNpm(npmPackage, skillId, skillsDir)
        if (r.ok) {
          ns.stop(`✓ ${skillId} (npm: ${npmPackage})`)
          skillFilesCopied++
        } else {
          ns.stop(`✗ ${skillId} 安装失败: ${r.message}`, 1)
        }
        sSkills.start("继续复制其他 skills...")
      } else {
        log.warn(`manifest 中声明的 skill 目录不完整: ${skillPath}`)
      }
    }
    sSkills.stop(`已处理 ${skillFilesCopied} 个 skill 到 ${skillsDir}/`)
  }

  const deps = manifest.dependencies

  if (opts.skipDeps) {
    log.warn("已跳过 dependencies 安装和配置")
    log.success(`${manifest.name} 导入完成！`)
    log.info(`重启 OpenCode 后即可使用 @${manifestAgentCommandName(manifest)} 调用此 agent`)
    outro("Unpack 完成")
    return
  }

  // 2. 安装 Skills（deps.skills：优先 npmPackage，其次 installCommand）
  if (deps.skills && deps.skills.length > 0) {
    const skillsDir = path.join(opencodeDir, "skills")
    for (const skill of deps.skills) {
      if (!skill.name) continue
      const existing = installedSkillLocation(skill.name, opts.target)
      if (existing) {
        log.info(`skill 已存在，跳过安装: ${skill.name} (${existing})`)
        continue
      }

      if (skill.npmPackage) {
        // 优先走 npm 安装路径，将 skill 安装到 opencodeDir/skills/<name>
        const s2 = spinner()
        s2.start(`从 npm 安装 skill: ${skill.npmPackage}...`)
        const r = await installSkillFromNpm(skill.npmPackage, skill.name, skillsDir)
        if (r.ok) {
          s2.stop(`✓ ${skill.name} (npm: ${skill.npmPackage})`)
        } else {
          s2.stop(`✗ ${skill.name} npm 安装失败，尝试 installCommand...`, 1)
          // npm 失败 → fallback 到 installCommand
          if (skill.installCommand) {
            const s3 = spinner()
            s3.start(`fallback: ${skill.installCommand}`)
            const r2 = await runCommand(skill.installCommand)
            if (r2.ok) {
              s3.stop(`✓ ${skill.name} (fallback)`)
            } else {
              s3.stop(`✗ ${skill.name} 安装失败`, 1)
              if (!skill.required) log.warn("（此 skill 非必须，可跳过）")
            }
          } else if (skill.required) {
            log.warn(`必需 skill 安装失败且无 fallback: ${skill.name}`)
          }
        }
      } else if (skill.installCommand) {
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
      } else {
        log.warn(`skill 未安装且未声明 npmPackage 或 installCommand: ${skill.name}`)
        if (skill.required) log.warn("此 skill 标记为必需，请先按发布说明手动安装")
      }
    }
  }

  // 3. 合并 MCP 配置到 opencode.jsonc
  if (deps.mcp && deps.mcp.length > 0) {
    const s3 = spinner()
    s3.start("合并 MCP 配置...")
    const configPath = opts.target ? path.join(opencodeDir, "opencode.jsonc") : resolveOpencodeConfig()
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
    const relevantApps = deps.apps.filter((a) => a.platform?.includes(platformKey))
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
      const key = envVarKey(ev)
      if (!key) continue
      const supplied = opts.env?.[key]
      if (supplied) {
        envLines.push(`${key}=${cleanEnvValue(supplied)}`)
        continue
      }
      if (opts.yes) {
        log.warn(`  ${ev.required ? "[必须]" : "[可选]"} ${key}`)
        log.info(`         ${ev.description}`)
        if (ev.example) log.info(`         示例: ${ev.example}`)
        envLines.push(`${key}=`)
      } else {
        log.info(`  ${ev.required ? "【必填】" : "【可选】"} ${key}`)
        log.info(`         ${ev.description}`)
        if (ev.example) log.info(`         示例: ${ev.example}`)

        if (ev.required) {
          const val = await text({
            message: `请输入 ${key}`,
            placeholder: ev.example ?? "",
          })
          if (val && typeof val === "string") {
            envLines.push(`${key}=${val}`)
          }
        } else {
          envLines.push(`# ${key}=  # ${ev.description}`)
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
  log.info(`重启 OpenCode 后即可使用 @${manifestAgentCommandName(manifest)} 调用此 agent`)

  outro("Unpack 完成")
}

export async function readManifestFromZip(zipPath: string): Promise<AgentManifest> {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.resolve(zipPath)))
  const manifestFile = zip.file("manifest.json")
  if (!manifestFile) throw new Error("zip 包中缺少 manifest.json")
  return parseManifest(await manifestFile.async("string"))
}

interface VerifyOptions {
  zipPath: string
}

export async function cmdVerify(opts: VerifyOptions): Promise<void> {
  intro("DDM Verify")

  const zipPath = path.resolve(opts.zipPath)
  if (!fs.existsSync(zipPath)) {
    log.error(`文件不存在: ${zipPath}`)
    process.exitCode = 1
    return
  }

  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath))
  const manifestFile = zip.file("manifest.json")
  let manifest: AgentManifest
  try {
    if (!manifestFile) throw new Error("zip 包中缺少 manifest.json")
    manifest = parseManifest(await manifestFile.async("string"))
  } catch (e) {
    log.error(String(e))
    process.exitCode = 1
    return
  }

  const errors: string[] = []
  for (const agentPath of manifestAgentPaths(manifest)) {
    if (!zip.file(agentPath)) errors.push(`缺少 agent 文件: ${agentPath}`)
  }
  for (const skillPath of manifestOpencodeSkillPaths(manifest)) {
    const normalized = skillPath.replace(/\/+$/, "")
    if (!zipContainsPrefix(zip, normalized)) errors.push(`缺少专属 skill 目录: ${skillPath}`)
    if (!zip.file(`${normalized}/SKILL.md`)) errors.push(`专属 skill 缺少 SKILL.md: ${skillPath}`)
  }

  if (errors.length > 0) {
    for (const error of errors) log.error(error)
    process.exitCode = 1
    return
  }

  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "ddm-verify-"))
  try {
    await cmdUnpack({
      zipPath,
      target: tmpProject,
      yes: true,
      skipDeps: true,
    })

    const opencodeDir = path.join(tmpProject, ".opencode")
    for (const agentPath of manifestAgentPaths(manifest)) {
      const installed = agentInstallPath(opencodeDir, manifest, agentPath)
      if (!fs.existsSync(installed)) errors.push(`本地导入后未找到 agent 文件: ${installed}`)
    }
    for (const skillPath of manifestOpencodeSkillPaths(manifest)) {
      const installed = path.join(opencodeDir, "skills", path.basename(skillPath), "SKILL.md")
      if (!fs.existsSync(installed)) errors.push(`本地导入后未找到 skill 文件: ${installed}`)
    }
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true })
  }

  if (errors.length > 0) {
    for (const error of errors) log.error(error)
    process.exitCode = 1
    return
  }

  log.success(`${manifest.packageId} v${manifest.version} 本地 zip 验证通过`)
  log.info(`已验证 manifest、包内文件，以及离线导入到临时 OpenCode 目录`)
  outro("Verify 完成")
}
