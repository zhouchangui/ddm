import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as http from "node:http"
import * as crypto from "node:crypto"
import { intro, log, outro, spinner } from "@clack/prompts"

// ─── 平台常量（从 dingding-platform .env.prod 同步） ───────────
// 如需切换环境，可通过环境变量覆盖

const PLATFORM_WEB_BASE_URL = process.env.PLATFORM_WEB_BASE_URL ?? "https://www.bothub.run"

const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://kemfhphqsaxooafdmivq.supabase.co"

const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "sb_publishable_bMXQDnIXXnLZ_qqqKup3Ug_SwHbbu1F"

const SUPABASE_FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`

// ─── 本地 OAuth 回调 ───────────────────────────────────────────

const OAUTH_CALLBACK_PORT = 19877
const OAUTH_CALLBACK_PATH = "/api/platform-auth/callback"

// ─── 存储路径 ─────────────────────────────────────────────────

const DDM_AUTH_FILE = path.join(os.homedir(), ".config", "ddm", "auth.json")

// ─── 类型 ─────────────────────────────────────────────────────

interface StoredSession {
  platformWebBaseUrl: string
  platformApiBaseUrl: string
  user: { id: string; email: string; name: string }
  accessToken: string
  refreshToken: string
  savedAt: string
  // 登录后补充的服务信息
  serviceToken?: string
  llmBaseUrl?: string | null
  imageApiUrl?: string | null
  fileApiUrl?: string | null
}

interface PlatformServiceEndpoint {
  serviceId: string
  protocol: string
  baseUrl: string
  priority: number
  weight?: number
}

// ─── PKCE 工具函数 ────────────────────────────────────────────

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "")
}

function createCodeChallenge(verifier: string): string {
  return base64UrlEncode(crypto.createHash("sha256").update(verifier).digest())
}

function createRandomToken(byteLength = 32): string {
  return base64UrlEncode(crypto.randomBytes(byteLength))
}

// ─── 存储工具 ─────────────────────────────────────────────────

function readSession(): StoredSession | null {
  try {
    return JSON.parse(fs.readFileSync(DDM_AUTH_FILE, "utf8")) as StoredSession
  } catch {
    return null
  }
}

function writeSession(session: StoredSession): void {
  fs.mkdirSync(path.dirname(DDM_AUTH_FILE), { recursive: true, mode: 0o700 })
  fs.writeFileSync(DDM_AUTH_FILE, JSON.stringify(session, null, 2), { encoding: "utf8", mode: 0o600 })
}

// ─── OpenCode 配置工具 ─────────────────────────────────────────

function resolveGlobalOpencodeConfig(): string {
  // 全局配置：~/.config/opencode/opencode.json（OpenCode XDG 路径）
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
  return path.join(xdgConfig, "opencode", "opencode.json")
}

function resolveGlobalEnvFile(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
  return path.join(xdgConfig, "opencode", ".env")
}

function mergeJson(filePath: string, patch: (obj: Record<string, unknown>) => void): void {
  let raw = "{}"
  try {
    raw = fs.readFileSync(filePath, "utf8")
    // 去掉 JSONC 单行注释
    raw = raw.replace(/\/\/[^\n]*/g, "")
  } catch {
    /* 文件不存在，用空对象 */
  }
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw)
  } catch {
    obj = {}
  }
  patch(obj)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8")
}

// ─── 平台 API 工具 ────────────────────────────────────────────

async function supabaseFetch<T>(path: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  const url = `${SUPABASE_FUNCTIONS_URL}${path}`
  const resp = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${accessToken}`,
      ...(init.headers ?? {}),
    },
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`${resp.status} ${resp.statusText}: ${text}`)
  }
  if (resp.status === 204) return undefined as T
  return resp.json() as Promise<T>
}

async function supabasePublicFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${SUPABASE_FUNCTIONS_URL}${path}`
  const resp = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      ...(init.headers ?? {}),
    },
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`${resp.status} ${resp.statusText}: ${text}`)
  }
  return resp.json() as Promise<T>
}

// ─── LOGIN ────────────────────────────────────────────────────

/**
 * ddm login
 *
 * 完整的 PKCE 桌面端登录流程，与 dingding-platform desktop-auth 一致：
 *
 * 1. 生成 state + PKCE code_verifier / code_challenge
 * 2. 启动本地 HTTP server 监听回调（port 19877）
 * 3. 打开浏览器 → bothub.run/desktop-auth?auth_flow_id=...&state=...&redirect_uri=...&code_challenge=...
 * 4. 用户登录后平台回调带 code+state
 * 5. 用 code+code_verifier 换 Supabase session（exchange-desktop-auth Edge Function）
 * 6. 发起 issue-platform-service-token 获取平台服务 token
 * 7. 用服务 token 调 get-platform-service-endpoints 拿服务地址
 * 8. LLM endpoint → ~/.config/opencode/opencode.json provider
 * 9. 图像/其他 endpoint → ~/.config/opencode/.env
 * 10. session → ~/.config/ddm/auth.json
 */
export async function cmdLogin(): Promise<void> {
  intro("DDM Login")

  const existing = readSession()
  if (existing) {
    log.info(`已登录: ${existing.user.email}`)
    const { confirm } = await import("@clack/prompts")
    const relogin = await confirm({ message: "重新登录？" })
    if (!relogin) {
      outro("保持当前登录状态")
      return
    }
  }

  // 1. 生成 PKCE 参数
  const state = createRandomToken(24)
  const codeVerifier = createRandomToken(32)
  const codeChallenge = createCodeChallenge(codeVerifier)
  const authFlowId = `auth-${createRandomToken(12)}`
  const redirectUri = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`

  // 构建登录 URL（与 platform-auth.ts buildDesktopAuthUrl 一致）
  const loginUrl = `${PLATFORM_WEB_BASE_URL}/desktop-auth?${new URLSearchParams({
    auth_flow_id: authFlowId,
    state,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
  }).toString()}`

  const s = spinner()
  s.start("等待浏览器授权...")

  // 2. 启动本地回调 server
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith(OAUTH_CALLBACK_PATH)) return

      const url = new URL(req.url, `http://127.0.0.1:${OAUTH_CALLBACK_PORT}`)
      const returnedState = url.searchParams.get("state")
      const returnedCode = url.searchParams.get("code")

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })

      if (returnedState !== state) {
        res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>❌ 登录失败</h2><p>state 校验失败，请重试。</p></body></html>`)
        server.close()
        reject(new Error("OAuth state 不匹配"))
        return
      }

      if (!returnedCode) {
        res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>❌ 登录失败</h2><p>缺少授权码，请重试。</p></body></html>`)
        server.close()
        reject(new Error("缺少 code 参数"))
        return
      }

      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>✅ 登录成功</h2>
        <p>可以关闭这个窗口，回到终端继续操作。</p>
      </body></html>`)
      server.close()
      resolve(returnedCode)
    })

    server.listen(OAUTH_CALLBACK_PORT, "127.0.0.1", () => {
      import("open")
        .then(({ default: open }) => open(loginUrl))
        .catch(() => {
          log.warn(`请手动打开浏览器访问: ${loginUrl}`)
        })
    })

    server.on("error", reject)

    setTimeout(() => {
      server.close()
      reject(new Error("登录超时（3分钟），请重试"))
    }, 180_000)
  }).catch((e) => {
    s.stop("登录失败", 1)
    throw e
  })

  s.stop("已收到授权码")

  // 5. 用 code + code_verifier 换 Supabase session
  const s2 = spinner()
  s2.start("换取平台 session...")

  const exchangeResult = await supabasePublicFetch<{
    user: { id: string; email: string; name: string }
    auth_otp: { email: string; token: string }
  }>("/exchange-desktop-auth", {
    method: "POST",
    body: JSON.stringify({
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  }).catch((e) => {
    s2.stop("换取 session 失败", 1)
    throw e
  })

  // 用 OTP 兑换真正的 Supabase access_token / refresh_token
  const otpResp = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      email: exchangeResult.auth_otp.email,
      token: exchangeResult.auth_otp.token,
      type: "email",
    }),
  })

  if (!otpResp.ok) {
    s2.stop("OTP 验证失败", 1)
    log.error(await otpResp.text())
    process.exitCode = 1
    return
  }

  const otpData = (await otpResp.json()) as {
    access_token: string
    refresh_token: string
  }

  const session: StoredSession = {
    platformWebBaseUrl: PLATFORM_WEB_BASE_URL,
    platformApiBaseUrl: `${new URL(PLATFORM_WEB_BASE_URL).origin}/api`,
    user: exchangeResult.user,
    accessToken: otpData.access_token,
    refreshToken: otpData.refresh_token,
    savedAt: new Date().toISOString(),
  }

  writeSession(session)
  s2.stop(`已登录: ${session.user.email}`)

  // 6. 查询用户名下的 service instances，取第一个获取服务 token
  const s3 = spinner()
  s3.start("获取平台服务凭证...")

  // 6a. 查 REST 拿 instance_id
  const instancesResp = await fetch(`${SUPABASE_URL}/rest/v1/openclaw_service_instances?select=id,name&limit=5`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${session.accessToken}`,
    },
  })
  if (!instancesResp.ok) {
    s3.stop("查询服务实例失败", 1)
    log.error(`HTTP ${instancesResp.status}: ${await instancesResp.text()}`)
    process.exitCode = 1
    return
  }
  const instances = (await instancesResp.json()) as Array<{ id: string; name: string }>
  if (instances.length === 0) {
    s3.stop("未找到服务实例", 1)
    log.error("你的账号下没有服务实例，请先在 bothub.run 上创建一个实例后再登录")
    process.exitCode = 1
    return
  }
  const instanceId = instances[0].id
  log.info(`使用实例: ${instances[0].name} (${instanceId})`)

  // 6b. issue-platform-service-token
  const serviceTokenResp = await supabaseFetch<{
    token: string
    credential_id: string
    instance_id: string
    scopes: string[]
  }>("/issue-platform-service-token", session.accessToken, {
    method: "POST",
    body: JSON.stringify({
      instance_id: instanceId,
      name: "DDM CLI",
      scopes: ["llm:*", "service:*"],
    }),
  }).catch((e) => {
    s3.stop("获取服务凭证失败", 1)
    throw e
  })
  const serviceToken = serviceTokenResp.token

  // 7. get-platform-service-endpoints
  const endpointsResp = await supabasePublicFetch<{
    version: string
    endpoints: Array<{
      service_id: string
      protocol: string
      base_url: string
      priority?: number
      weight?: number
    }>
  }>("/get-platform-service-endpoints", {
    method: "POST",
    headers: { authorization: `Bearer ${serviceToken}` },
    body: JSON.stringify({ environment: "prod" }),
  }).catch((e) => {
    s3.stop("获取服务地址失败", 1)
    throw e
  })

  const endpoints: PlatformServiceEndpoint[] = endpointsResp.endpoints.map((row) => ({
    serviceId: row.service_id,
    protocol: row.protocol,
    baseUrl: row.base_url.replace(/\/+$/, ""),
    priority: row.priority ?? 100,
    weight: row.weight ?? 100,
  }))

  // 选出每个 serviceId 优先级最高的端点
  const bestEndpoint = (serviceId: string) =>
    endpoints
      .filter((e) => e.serviceId === serviceId)
      .sort((a, b) => b.priority - a.priority || (b.weight ?? 100) - (a.weight ?? 100))[0]

  const llmEndpoint = bestEndpoint("llm.openai-compatible.default")
  const imageEndpoint = bestEndpoint("image.openai-compatible.default")
  const fileEndpoint =
    bestEndpoint("file.r2.default")
    ?? bestEndpoint("file.object-storage.default")
    ?? bestEndpoint("file.default")

  s3.stop("服务地址获取成功")

  // 8. 写入 opencode.jsonc — LLM provider（立即生效）
  const s4 = spinner()
  s4.start("写入 OpenCode provider 配置...")

  const opencodeConfig = resolveGlobalOpencodeConfig()
  mergeJson(opencodeConfig, (obj) => {
    const providers = (obj.provider ?? {}) as Record<string, unknown>
    if (llmEndpoint) {
      // OpenCode custom provider 格式：
      // - npm: SDK 包名（OpenAI provider 默认走 Responses API）
      // - options.apiKey / options.baseURL：凭证和地址
      // - models：至少要有一个条目，否则 autoload=false，不显示
      providers["ddm"] = {
        name: "DDM",
        npm: "@ai-sdk/openai",
        options: {
          apiKey: serviceToken,
          baseURL: llmEndpoint.baseUrl,
        },
        models: {
          "ddm-auto": {
            name: "DDM Auto",
            attachment: true,
            tool_call: true,
          },
        },
      }
    }
    obj.provider = providers

    // 设置 DDM Auto 为默认模型
    if (llmEndpoint) {
      obj.model = "ddm/ddm-auto"
    }

    // 同步更新已配置的 ddm-image MCP server 中的 token
    const mcp = (obj.mcp ?? {}) as Record<string, unknown>
    if (mcp["ddm-image"] && typeof mcp["ddm-image"] === "object") {
      const mcpEntry = mcp["ddm-image"] as Record<string, unknown>
      mcpEntry.environment = {
        ...((mcpEntry.environment as Record<string, string>) ?? {}),
        DDM_TOKEN: serviceToken,
        ...(imageEndpoint ? { DDM_IMAGE_API_URL: `${imageEndpoint.baseUrl}/images` } : {}),
      }
    }
    obj.mcp = mcp
  })

  s4.stop(`已更新 ${opencodeConfig}`)

  // 9. 把服务地址写入 auth.json（desktop 启动时从这里读取注入 process.env）
  // 不写入 ~/.zshrc，避免 token 明文暴露在 shell 历史和配置文件中
  writeSession({
    ...session,
    serviceToken,
    llmBaseUrl: llmEndpoint?.baseUrl ?? null,
    imageApiUrl: imageEndpoint ? `${imageEndpoint.baseUrl}/images` : null,
    fileApiUrl: fileEndpoint?.baseUrl ?? null,
  } as StoredSession)

  // 打印结果
  log.info("")
  log.success("登录完成！")
  log.info(`用户    : ${session.user.email}`)
  if (llmEndpoint) log.info(`LLM     : ${llmEndpoint.baseUrl}`)
  if (imageEndpoint) log.info(`图像    : ${imageEndpoint.baseUrl}/images`)
  if (fileEndpoint) log.info(`文件    : ${fileEndpoint.baseUrl}`)
  log.info(`配置    : ${opencodeConfig}`)
  log.info(`凭证    : ${DDM_AUTH_FILE}`)

  outro("Done")
}

// ─── AUTH CHECK ──────────────────────────────────────────────

/**
 * 检查是否已登录，返回 auth 信息。供 desktop 主进程直接 import 调用。
 * - 有 serviceToken → 已登录，返回服务信息
 * - 没有 → 返回 null，调用方应触发 ddm login
 */
export function checkAuth(): {
  serviceToken: string
  llmBaseUrl: string | null
  imageApiUrl: string | null
  fileApiUrl: string | null
  user: { id: string; email: string; name: string }
} | null {
  const session = readSession()
  if (!session?.serviceToken) return null
  return {
    serviceToken: session.serviceToken,
    llmBaseUrl: session.llmBaseUrl ?? null,
    imageApiUrl: session.imageApiUrl ?? null,
    fileApiUrl: session.fileApiUrl ?? null,
    user: session.user,
  }
}

/**
 * ddm auth check
 *
 * CLI 用途：检查登录状态，未登录时 exit 1，供脚本判断。
 */
export async function cmdAuthCheck(): Promise<void> {
  const auth = checkAuth()
  if (auth) {
    log.success(`已登录: ${auth.user.email}`)
    if (auth.llmBaseUrl) log.info(`LLM: ${auth.llmBaseUrl}`)
    if (auth.fileApiUrl) log.info(`文件: ${auth.fileApiUrl}`)
  } else {
    log.warn("未登录，请运行 ddm login")
    process.exitCode = 1
  }
}

/**
 * ddm setup
 *
 * 注册 ddm:// 协议 handler，使网站点击"导入"按钮时能自动拉起 ddm import
 */
export async function cmdSetup(opts: { protocolOnly?: boolean; silent?: boolean } = {}): Promise<void> {
  if (!opts.silent) intro("DDM Setup")

  const platform = os.platform()
  const ddmBin = process.execPath.endsWith("ddm") ? process.execPath : await findDdmBin()

  if (platform === "darwin") {
    await setupMacOS(ddmBin, opts.silent ?? false)
  } else if (platform === "linux") {
    await setupLinux(ddmBin, opts.silent ?? false)
  } else if (platform === "win32") {
    await setupWindows(ddmBin, opts.silent ?? false)
  } else {
    log.warn(`不支持的平台: ${platform}，请手动注册 ddm:// 协议`)
  }

  if (!opts.silent) outro("Setup 完成")
}

async function findDdmBin(): Promise<string> {
  const { execSync } = await import("node:child_process")
  try {
    return execSync("which ddm", { encoding: "utf8" }).trim()
  } catch {
    return "ddm"
  }
}

async function setupMacOS(ddmBin: string, silent: boolean): Promise<void> {
  const handlerScript = path.join(os.homedir(), ".local", "bin", "ddm-protocol-handler.sh")
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "ai.ddm.protocol-handler.plist")

  fs.mkdirSync(path.dirname(handlerScript), { recursive: true })
  fs.writeFileSync(handlerScript, `#!/bin/bash\n# DDM protocol handler: ddm://<path>\n"${ddmBin}" import "$1"\n`, {
    mode: 0o755,
  })

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.ddm.protocol-handler</string>
  <key>ProgramArguments</key>
  <array>
    <string>${handlerScript}</string>
  </array>
  <key>StandardOutPath</key>
  <string>${os.homedir()}/.config/ddm/protocol-handler.log</string>
  <key>StandardErrorPath</key>
  <string>${os.homedir()}/.config/ddm/protocol-handler.log</string>
</dict>
</plist>`

  fs.mkdirSync(path.dirname(plistPath), { recursive: true })
  fs.writeFileSync(plistPath, plist, "utf8")

  if (!silent) {
    log.success(`已写入 protocol handler: ${handlerScript}`)
    log.info(`LaunchAgent: ${plistPath}`)
    log.warn("macOS 的 URI scheme 注册需要一个 .app bundle，建议使用 DDM Desktop 应用获得完整的协议支持。")
    log.info("当前已配置 shell handler，在 Terminal 中执行 ddm import ddm://... 可正常工作。")
  }
}

async function setupLinux(ddmBin: string, silent: boolean): Promise<void> {
  const desktopFile = path.join(os.homedir(), ".local", "share", "applications", "ddm-protocol-handler.desktop")

  const content = `[Desktop Entry]
Name=DDM Protocol Handler
Exec=${ddmBin} import %u
Type=Application
NoDisplay=true
MimeType=x-scheme-handler/ddm;
`

  fs.mkdirSync(path.dirname(desktopFile), { recursive: true })
  fs.writeFileSync(desktopFile, content, "utf8")

  const { execSync } = await import("node:child_process")
  try {
    execSync(`xdg-mime default ddm-protocol-handler.desktop x-scheme-handler/ddm`, { stdio: "pipe" })
    execSync(`update-desktop-database ${path.dirname(desktopFile)}`, { stdio: "pipe" })
    if (!silent) log.success(`已注册 ddm:// 协议 (${desktopFile})`)
  } catch {
    if (!silent) {
      log.warn(`已写入 ${desktopFile}`)
      log.warn("请手动运行: xdg-mime default ddm-protocol-handler.desktop x-scheme-handler/ddm")
    }
  }
}

async function setupWindows(ddmBin: string, silent: boolean): Promise<void> {
  const { execSync } = await import("node:child_process")
  const regScript = `
Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\\Software\\Classes\\ddm]
@="URL:DDM Protocol"
"URL Protocol"=""

[HKEY_CURRENT_USER\\Software\\Classes\\ddm\\shell]

[HKEY_CURRENT_USER\\Software\\Classes\\ddm\\shell\\open]

[HKEY_CURRENT_USER\\Software\\Classes\\ddm\\shell\\open\\command]
@="\\"${ddmBin.replace(/\\/g, "\\\\")}\" import \\"%1\\""
`

  const regFile = path.join(os.tmpdir(), "ddm-protocol.reg")
  fs.writeFileSync(regFile, regScript, "utf16le")

  try {
    execSync(`regedit /s "${regFile}"`, { stdio: "pipe" })
    if (!silent) log.success("已注册 ddm:// 协议到 Windows 注册表")
  } catch (e) {
    if (!silent) {
      log.warn(`写入注册表失败: ${String(e)}`)
      log.info(`请手动导入: ${regFile}`)
    }
  }
}

// ─── IMPORT ───────────────────────────────────────────────────

/**
 * ddm import <ddm://import?pkg=<url>>、<ddm://import-agent?url=<url>> 或 <path/to/file.zip>
 */
async function resolveMarketAgentUrl(input: string): Promise<string | undefined> {
  if (!URL.canParse(input)) return

  const parsed = new URL(input)
  const market = new URL(PLATFORM_WEB_BASE_URL)
  if (parsed.protocol !== "https:" || parsed.hostname !== market.hostname) return

  const [, kind, agentId] = parsed.pathname.split("/")
  if (kind !== "agent" || !agentId) return

  const query = new URL(`${SUPABASE_URL}/rest/v1/agents`)
  query.searchParams.set("select", "id,latest_release_id,name")
  query.searchParams.set("id", `eq.${agentId}`)
  query.searchParams.set("status", "eq.published")
  query.searchParams.set("show_in_market", "eq.true")

  const resp = await fetch(query, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      accept: "application/json",
    },
  })
  if (!resp.ok) throw new Error(`读取市场 agent 失败: HTTP ${resp.status}`)

  const rows = (await resp.json()) as unknown
  const agent = Array.isArray(rows) && rows[0] && typeof rows[0] === "object" ? rows[0] : undefined
  const releaseId =
    agent && "latest_release_id" in agent ? (agent as { latest_release_id?: unknown }).latest_release_id : undefined
  if (typeof releaseId !== "string" || releaseId.length === 0) {
    throw new Error("该市场 agent 暂无可导入版本")
  }

  const download = new URL(`${SUPABASE_FUNCTIONS_URL}/download-agent-release`)
  download.searchParams.set("releaseId", releaseId)
  download.searchParams.set("source", "market")
  return download.toString()
}

async function resolveImportZip(input: string, quiet = false): Promise<{ zipPath: string; cleanup: () => void }> {
  const pkgUrl = await (async () => {
    if (input.startsWith("ddm://")) {
      const parsed = new URL(input)
      const value = parsed.searchParams.get("pkg") ?? parsed.searchParams.get("url") ?? ""
      if (!value) throw new Error("无效的 ddm:// URL: 缺少 pkg/url 参数")
      return value
    }
    if (URL.canParse(input)) {
      const parsed = new URL(input)
      if (parsed.protocol === "https:") return (await resolveMarketAgentUrl(input)) ?? input
      throw new Error(`只允许 https:// 协议，拒绝: ${parsed.protocol}`)
    }
    return
  })()

  if (!pkgUrl) {
    return { zipPath: input, cleanup: () => {} }
  }

  // 只允许 https:// 防止 SSRF（file://、http://、内网地址等）
  const parsedUrl = new URL(pkgUrl)
  if (parsedUrl.protocol !== "https:") throw new Error(`只允许 https:// 协议，拒绝: ${parsedUrl.protocol}`)

  const s = quiet ? null : spinner()
  s?.start(`下载 agent 包: ${pkgUrl}`)
  const resp = await fetch(pkgUrl)
  if (!resp.ok) {
    s?.stop(`下载失败: HTTP ${resp.status}`, 1)
    throw new Error(`下载失败: HTTP ${resp.status}`)
  }

  const tmpFile = path.join(os.tmpdir(), `ddm-import-${Date.now()}.zip`)
  fs.writeFileSync(tmpFile, Buffer.from(await resp.arrayBuffer()))
  s?.stop(`已下载到临时文件: ${tmpFile}`)
  return {
    zipPath: tmpFile,
    cleanup: () => {
      try {
        fs.unlinkSync(tmpFile)
      } catch {}
    },
  }
}

export async function cmdPreview(input: string): Promise<void> {
  try {
    const { readManifestFromZip } = await import("./pack.js")
    const resolved = await resolveImportZip(input, true)
    try {
      process.stdout.write(`${JSON.stringify(await readManifestFromZip(resolved.zipPath), null, 2)}\n`)
    } finally {
      resolved.cleanup()
    }
  } catch (e) {
    log.error(String(e))
    process.exitCode = 1
  }
}

export async function cmdImport(
  input: string,
  opts: { target?: string; yes?: boolean; skipDeps?: boolean; env?: Record<string, string> } = {},
): Promise<void> {
  const { cmdUnpack } = await import("./pack.js")

  if (input.startsWith("ddm://") || URL.canParse(input)) {
    intro("DDM Import")
    try {
      const resolved = await resolveImportZip(input)
      try {
        outro("下载完成，开始导入...")
        await cmdUnpack({
          zipPath: resolved.zipPath,
          target: opts.target,
          yes: opts.yes,
          skipDeps: opts.skipDeps,
          env: opts.env,
        })
      } finally {
        resolved.cleanup()
      }
    } catch (e) {
      log.error(String(e))
      process.exitCode = 1
    }
    return
  }

  await cmdUnpack({ zipPath: input, target: opts.target, yes: opts.yes, skipDeps: opts.skipDeps, env: opts.env })
}
