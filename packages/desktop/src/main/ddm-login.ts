/**
 * DDM 登录检查模块（Electron 窗口版）
 *
 * desktop 启动时调用 ensureDdmLogin()：
 * 1. 读取 ~/.config/ddm/auth.json 检查是否已登录
 * 2. 未登录 → 弹一个原生 Electron 登录窗口（品牌页 + 登录按钮）
 *    - 点击登录 → 打开系统浏览器完成 OAuth
 *    - 回调成功 → 窗口关闭，继续启动
 * 3. 登录成功 → 把 serviceToken / llmBaseUrl / imageApiUrl / fileApiUrl 注入 process.env
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "node:http"
import { randomBytes, createHash } from "node:crypto"
import { BrowserWindow, shell } from "electron"
import { getLogger } from "./logging"

// ─── 平台常量 ──────────────────────────────────────────────────
const PLATFORM_WEB_BASE_URL =
  process.env.PLATFORM_WEB_BASE_URL ?? "https://www.bothub.run"
const SUPABASE_URL =
  process.env.SUPABASE_URL ?? "https://kemfhphqsaxooafdmivq.supabase.co"
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? "sb_publishable_bMXQDnIXXnLZ_qqqKup3Ug_SwHbbu1F"
const SUPABASE_FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`
const OAUTH_PORT = 19877
const OAUTH_PATH = "/api/platform-auth/callback"
const DDM_AUTH_FILE = join(homedir(), ".config", "ddm", "auth.json")

// ─── 类型 ──────────────────────────────────────────────────────
interface StoredSession {
  platformWebBaseUrl: string
  platformApiBaseUrl: string
  user: { id: string; email: string; name: string }
  accessToken: string
  refreshToken: string
  savedAt: string
  serviceToken?: string
  llmBaseUrl?: string | null
  imageApiUrl?: string | null
  fileApiUrl?: string | null
}

// ─── 工具 ──────────────────────────────────────────────────────
function base64url(buf: Buffer) {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}
function randomToken(n = 32) { return base64url(randomBytes(n)) }
function codeChallenge(v: string) {
  return base64url(createHash("sha256").update(v).digest())
}

async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

function readAuth(): StoredSession | null {
  try {
    if (!existsSync(DDM_AUTH_FILE)) return null
    return JSON.parse(readFileSync(DDM_AUTH_FILE, "utf8")) as StoredSession
  } catch { return null }
}

function writeAuth(s: StoredSession) {
  mkdirSync(dirname(DDM_AUTH_FILE), { recursive: true })
  writeFileSync(DDM_AUTH_FILE, JSON.stringify(s, null, 2), "utf8")
}

function injectEnv(auth: StoredSession) {
  const logger = getLogger()
  if (auth.serviceToken) {
    process.env.DDM_TOKEN = auth.serviceToken
    process.env.DDM_SERVICE_LLM_TOKEN = auth.serviceToken
    process.env.DDM_IMAGE_API_KEY = auth.serviceToken
    process.env.DDM_FILE_API_KEY = auth.serviceToken
    logger.log("[ddm-login] DDM_TOKEN injected")
  }
  if (auth.llmBaseUrl) process.env.DDM_SERVICE_LLM_BASE_URL = auth.llmBaseUrl
  if (auth.imageApiUrl) process.env.DDM_IMAGE_API_URL = auth.imageApiUrl
  if (auth.fileApiUrl) process.env.DDM_FILE_API_URL = auth.fileApiUrl
}

// ─── 写入 opencode.json ────────────────────────────────────────
function updateOpencodeConfig(serviceToken: string, llmBaseUrl: string | null) {
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  const configPath = join(xdg, "opencode", "opencode.json")
  let cfg: Record<string, unknown> = {}
  try { cfg = JSON.parse(readFileSync(configPath, "utf8")) } catch { /* 新文件 */ }

  if (llmBaseUrl) {
    const providers = (cfg.provider ?? {}) as Record<string, unknown>
    providers["ddm"] = {
      name: "DDM",
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: serviceToken, baseURL: llmBaseUrl },
      models: {
        "ddm-auto": { name: "DDM Auto", attachment: true, tool_call: true },
      },
    }
    cfg.provider = providers
    cfg.model = "ddm/ddm-auto"
  }
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8")
}

// ─── OAuth 登录流程 ────────────────────────────────────────────
async function runLoginFlow(): Promise<StoredSession | null> {
  const logger = getLogger()
  const state = randomToken(24)
  const verifier = randomToken(32)
  const challenge = codeChallenge(verifier)
  const authFlowId = `auth-${randomToken(12)}`
  const redirectUri = `http://127.0.0.1:${OAUTH_PORT}${OAUTH_PATH}`

  const loginUrl = `${PLATFORM_WEB_BASE_URL}/desktop-auth?${new URLSearchParams({
    auth_flow_id: authFlowId,
    state,
    redirect_uri: redirectUri,
    code_challenge: challenge,
  })}`

  // 1. 启动本地回调 server
  const code = await new Promise<string | null>((resolve) => {
    const server = createServer((req, res) => {
      if (!req.url?.startsWith(OAUTH_PATH)) return
      const url = new URL(req.url, `http://127.0.0.1:${OAUTH_PORT}`)
      const returnedState = url.searchParams.get("state")
      const returnedCode = url.searchParams.get("code")

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      if (returnedState !== state || !returnedCode) {
        res.end("<html><body><h2>❌ 授权失败，请重试</h2></body></html>")
        server.close()
        resolve(null)
        return
      }
      res.end("<html><body style='font-family:sans-serif;text-align:center;padding:60px'><h2>✅ 登录成功，可关闭此窗口</h2></body></html>")
      server.close()
      resolve(returnedCode)
    })
    server.listen(OAUTH_PORT, "127.0.0.1", () => {
      shell.openExternal(loginUrl)
    })
    server.on("error", () => resolve(null))
    setTimeout(() => { server.close(); resolve(null) }, 5 * 60 * 1000)
  })

  if (!code) { logger.warn("[ddm-login] OAuth cancelled or timed out"); return null }

  // 2. exchange-desktop-auth
  const exchanged = await apiFetch<{
    user: { id: string; email: string; name: string }
    auth_otp: { email: string; token: string }
  }>(`${SUPABASE_FUNCTIONS_URL}/exchange-desktop-auth`, {
    method: "POST",
    body: JSON.stringify({ code, redirect_uri: redirectUri, code_verifier: verifier }),
  })

  // 3. OTP → Supabase session
  const otpRes = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email: exchanged.auth_otp.email, token: exchanged.auth_otp.token, type: "email" }),
  })
  if (!otpRes.ok) throw new Error(`OTP verify failed: ${await otpRes.text()}`)
  const otp = await otpRes.json() as { access_token: string; refresh_token: string }

  const session: StoredSession = {
    platformWebBaseUrl: PLATFORM_WEB_BASE_URL,
    platformApiBaseUrl: `${new URL(PLATFORM_WEB_BASE_URL).origin}/api`,
    user: exchanged.user,
    accessToken: otp.access_token,
    refreshToken: otp.refresh_token,
    savedAt: new Date().toISOString(),
  }

  // 4. 查 instance → issue service token → get endpoints
  const instancesRes = await fetch(`${SUPABASE_URL}/rest/v1/openclaw_service_instances?select=id,name&limit=5`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${otp.access_token}` },
  })
  const instances = instancesRes.ok ? await instancesRes.json() as { id: string; name: string }[] : []

  if (instances.length > 0) {
    const instanceId = instances[0].id
    const svcToken = await apiFetch<{ token: string }>(`${SUPABASE_FUNCTIONS_URL}/issue-platform-service-token`, {
      method: "POST",
      headers: { authorization: `Bearer ${otp.access_token}` },
      body: JSON.stringify({ instance_id: instanceId, name: "DDM Desktop", scopes: ["llm:*", "service:*"] }),
    })
    const endpoints = await apiFetch<{ endpoints: Array<{ service_id: string; base_url: string; priority: number }> }>(
      `${SUPABASE_FUNCTIONS_URL}/get-platform-service-endpoints`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${svcToken.token}` },
        body: JSON.stringify({ environment: "prod" }),
      },
    )
    const best = (id: string) =>
      endpoints.endpoints.filter(e => e.service_id === id).sort((a, b) => b.priority - a.priority)[0]
    const bestFile =
      best("file.r2.default")
      ?? best("file.object-storage.default")
      ?? best("file.default")

    session.serviceToken = svcToken.token
    session.llmBaseUrl = best("llm.openai-compatible.default")?.base_url ?? null
    session.imageApiUrl = best("image.openai-compatible.default")
      ? `${best("image.openai-compatible.default")!.base_url}/images`
      : null
    session.fileApiUrl = bestFile?.base_url ?? null
  }

  writeAuth(session)
  if (session.serviceToken) {
    updateOpencodeConfig(session.serviceToken, session.llmBaseUrl ?? null)
  }
  return session
}

// ─── 登录窗口 ─────────────────────────────────────────────────
function showLoginWindow(): Promise<boolean> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      resizable: true,
      center: true,
      title: "百搭智能",
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    })

    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>百搭智能</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      color-scheme: light dark;
      /* light */
      --bg:         #f8f8f8;
      --card-bg:    #fcfcfc;
      --text-strong: rgba(0,0,0,0.88);
      --text-weak:   rgba(0,0,0,0.45);
      --text-weaker: rgba(0,0,0,0.3);
      --btn-bg:      #171717;
      --btn-color:   #f8f8f8;
      --btn-hover:   #2e2e2e;
      --btn-active:  #3e3e3e;
      --btn-border:  #282828;
      --btn-dis-bg:  #e2e2e2;
      --btn-dis-col: rgba(0,0,0,0.3);
      --mark-inner:  rgba(0,0,0,0.18);
      --mark-path:   #111111;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg:         #131010;
        --card-bg:    #131010;
        --text-strong: rgba(255,255,255,0.936);
        --text-weak:   rgba(255,255,255,0.422);
        --text-weaker: rgba(255,255,255,0.284);
        --btn-bg:      #ededed;
        --btn-color:   #161616;
        --btn-hover:   #e0e0e0;
        --btn-active:  #d4d4d4;
        --btn-border:  #282828;
        --btn-dis-bg:  #3e3e3e;
        --btn-dis-col: rgba(255,255,255,0.3);
        --mark-inner:  rgba(255,255,255,0.35);
        --mark-path:   #f0f0f0;
      }
    }

    body {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text-strong);
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      -webkit-app-region: drag;
    }

    .card {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 280px;
    }

    .logo-mark {
      width: 108px;
      height: auto;
      margin-bottom: 24px;
    }

    h1 {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-strong);
      text-align: center;
      margin-bottom: 6px;
      letter-spacing: -0.16px;
      line-height: 1.3;
    }

    .slogan {
      font-size: 13px;
      color: var(--text-weak);
      text-align: center;
      margin-bottom: 4px;
      line-height: 1.5;
    }

    .desc {
      font-size: 13px;
      color: var(--text-weaker);
      text-align: center;
      margin-bottom: 32px;
      line-height: 1.5;
    }

    .btn {
      -webkit-app-region: no-drag;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--btn-bg);
      color: var(--btn-color);
      border: 1px solid var(--btn-border);
      border-radius: 6px;
      padding: 7px 12px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background .1s ease;
      font-family: inherit;
      line-height: 1.3;
    }
    .btn:hover:not(:disabled) { background: var(--btn-hover); }
    .btn:active:not(:disabled) { background: var(--btn-active); }
    .btn:disabled { background: var(--btn-dis-bg); color: var(--btn-dis-col); cursor: not-allowed; }

    #status {
      margin-top: 10px;
      font-size: 12px;
      color: var(--text-weaker);
      min-height: 16px;
      text-align: center;
      line-height: 1.5;
    }
    #status.err { color: #e5484d; }
    #status.ok  { color: #30a46c; }
  </style>
</head>
<body>
  <div class="card">
    <!-- DDM Logo -->
    <svg class="logo-mark" viewBox="0 0 144 42" fill="none" xmlns="http://www.w3.org/2000/svg">
      <!-- D -->
      <path d="M18 30H6V18H18V30Z" fill="var(--mark-inner)"/>
      <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" fill="var(--mark-path)"/>
      <!-- D -->
      <path d="M66 30H54V18H66V30Z" fill="var(--mark-inner)"/>
      <path d="M66 12H54V30H66V12ZM72 36H48V6H72V36Z" fill="var(--mark-path)"/>
      <!-- M -->
      <path d="M96 18H84V30H96V18Z" fill="var(--mark-inner)"/>
      <path d="M120 18H108V30H120V18Z" fill="var(--mark-inner)"/>
      <path d="M84 6H78V36H84V6ZM96 6H84V18H96V6ZM108 6H96V18H108V6ZM120 6H108V18H120V6ZM126 6H120V36H126V6ZM132 36H78V6H132V36Z" fill="var(--mark-path)"/>
    </svg>

    <h1>百搭智能</h1>
    <p class="slogan">你的 7×24 小时智能搭子</p>
    <p class="desc">用顶尖模型，复用最佳实践，交付可用结果</p>

    <button class="btn" id="btn" onclick="login()">
      使用浏览器登录
    </button>

    <div id="status"></div>
  </div>

  <script>
    function login() {
      var btn = document.getElementById('btn');
      var status = document.getElementById('status');
      btn.disabled = true;
      btn.textContent = '正在打开浏览器...';
      status.className = 'ok';
      status.textContent = '请在浏览器中完成授权';
      window.location.href = 'ddm-login://start';
    }
    window.__loginFailed = function() {
      var btn = document.getElementById('btn');
      var status = document.getElementById('status');
      btn.disabled = false;
      btn.textContent = '使用浏览器登录';
      status.className = 'err';
      status.textContent = '登录失败，请重试';
    };
  </script>
</body>
</html>
    `))

    // 拦截 ddm-login://start 触发登录
    win.webContents.on("will-navigate", (event, url) => {
      if (url.startsWith("ddm-login://start")) {
        event.preventDefault()
        runLoginFlow()
          .then((session) => {
            if (session) {
              win.close()
              resolve(true)
            } else {
              win.webContents.executeJavaScript(`window.__loginFailed && window.__loginFailed()`)
            }
          })
          .catch((e) => {
            getLogger().error("[ddm-login] login error", e)
            win.webContents.executeJavaScript(`window.__loginFailed && window.__loginFailed()`)
          })
      }
    })

    win.on("closed", () => resolve(false))
  })
}

// ─── 主入口 ───────────────────────────────────────────────────
export async function ensureDdmLogin(): Promise<void> {
  const logger = getLogger()
  const auth = readAuth()

  if (auth?.serviceToken) {
    logger.log("[ddm-login] already logged in", { email: auth.user?.email })
    injectEnv(auth)
    return
  }

  logger.log("[ddm-login] not logged in, showing login window")
  const success = await showLoginWindow()

  if (success) {
    const newAuth = readAuth()
    if (newAuth?.serviceToken) {
      logger.log("[ddm-login] login succeeded", { email: newAuth.user?.email })
      injectEnv(newAuth)
    }
  } else {
    logger.warn("[ddm-login] login skipped or failed, continuing without DDM provider")
  }
}
