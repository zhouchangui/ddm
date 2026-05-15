import { execFile, spawn } from "node:child_process"
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import { stripVTControlCharacters } from "node:util"
import { BrowserWindow, Notification, app, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

import type {
  DdmImportDependencyState,
  InitStep,
  ServerReadyData,
  SqliteMigrationProgress,
  TitlebarTheme,
  WindowConfig,
  WslConfig,
} from "../preload/types"
import { getStore } from "./store"
import { setTitlebar, updateTitlebar } from "./windows"

type DdmImportEnv = Record<string, string>

const PLATFORM_WEB_BASE_URL = process.env.PLATFORM_WEB_BASE_URL ?? "https://www.bothub.run"
const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://kemfhphqsaxooafdmivq.supabase.co"
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "sb_publishable_bMXQDnIXXnLZ_qqqKup3Ug_SwHbbu1F"
const SUPABASE_FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

const resolveDdmImportDownloadUrl = (input: string) => {
  if (!input.startsWith("ddm:")) return input
  if (!URL.canParse(input)) return input
  const parsed = new URL(input)
  return parsed.searchParams.get("url") ?? parsed.searchParams.get("pkg") ?? input
}

const resolveDdmMarketAgentUrl = async (input: string) => {
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

  const res = await fetch(query, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      accept: "application/json",
    },
  })
  if (!res.ok) throw new Error(`读取市场 agent 失败: HTTP ${res.status}`)

  const rows = (await res.json()) as unknown
  const agent = Array.isArray(rows) && rows[0] && typeof rows[0] === "object" ? rows[0] : undefined
  const releaseId =
    agent && "latest_release_id" in agent ? (agent as { latest_release_id?: unknown }).latest_release_id : undefined
  if (typeof releaseId !== "string" || releaseId.length === 0) throw new Error("该市场 agent 暂无可导入版本")

  const download = new URL(`${SUPABASE_FUNCTIONS_URL}/download-agent-release`)
  download.searchParams.set("releaseId", releaseId)
  download.searchParams.set("source", "market")
  return download.toString()
}

const readEnvFile = (filePath: string) => {
  if (!existsSync(filePath)) return {}
  return Object.fromEntries(
    readFileSync(filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=")
        if (index === -1) return
        return [
          line.slice(0, index).trim(),
          line
            .slice(index + 1)
            .trim()
            .replace(/^['"]|['"]$/g, ""),
        ]
      })
      .filter((entry): entry is [string, string] => !!entry && !!entry[0]),
  )
}

const localDdmImportEnvPath = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", ".env")

const localDdmImportSkillRoots = () => {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  const projectDirs = [process.cwd()].flatMap((dir) => {
    const dirs: string[] = []
    for (let current = dir; ; current = dirname(current)) {
      dirs.push(current)
      if (dirname(current) === current) return dirs
    }
  })

  return Array.from(
    new Set([
      join(homedir(), ".agents", "skills"),
      join(homedir(), ".claude", "skills"),
      join(xdgConfig, "opencode", "skill"),
      join(xdgConfig, "opencode", "skills"),
      ...projectDirs.flatMap((dir) => [
        join(dir, ".agents", "skills"),
        join(dir, ".claude", "skills"),
        join(dir, ".opencode", "skill"),
        join(dir, ".opencode", "skills"),
      ]),
    ]),
  )
}

const localDdmImportSkillFiles = (root: string): string[] => {
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((entry) => {
    const full = join(root, entry)
    try {
      const stat = statSync(full)
      if (!stat.isDirectory()) return entry === "SKILL.md" ? [full] : []
      return [join(full, "SKILL.md"), ...localDdmImportSkillFiles(full)].filter((file) => existsSync(file))
    } catch {
      return []
    }
  })
}

const localDdmImportSkillName = (filePath: string) => {
  const frontmatter = readFileSync(filePath, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
  if (!frontmatter) return
  return frontmatter
    .split(/\r?\n/)
    .map((line) =>
      line
        .match(/^name:\s*(.+?)\s*$/)?.[1]
        ?.trim()
        .replace(/^['"]|['"]$/g, ""),
    )
    .find((name): name is string => !!name)
}

const localDdmImportInstalledSkill = (name: string) =>
  localDdmImportSkillRoots()
    .flatMap((root) => {
      const direct = join(root, name, "SKILL.md")
      return existsSync(direct) ? [direct, ...localDdmImportSkillFiles(root)] : localDdmImportSkillFiles(root)
    })
    .find((file) => {
      try {
        return localDdmImportSkillName(file) === name
      } catch {
        return false
      }
    })

const manifestEnvKeys = (manifest: unknown) => {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return []
  const dependencies = (manifest as { dependencies?: unknown }).dependencies
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) return []
  const envVars = (dependencies as { envVars?: unknown }).envVars
  if (!Array.isArray(envVars)) return []
  return envVars
    .map((item) => {
      if (!item || typeof item !== "object") return undefined
      if ("name" in item && typeof item.name === "string") return item.name
      return undefined
    })
    .filter((key): key is string => typeof key === "string" && key.length > 0)
}

const manifestSkillNames = (manifest: unknown) => {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return []
  const dependencies = (manifest as { dependencies?: unknown }).dependencies
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) return []
  const skills = (dependencies as { skills?: unknown }).skills
  if (!Array.isArray(skills)) return []
  return skills
    .map((item) => (item && typeof item === "object" && "name" in item ? item.name : undefined))
    .filter((name): name is string => typeof name === "string" && name.length > 0)
}

const localDdmImportDependencyState = (manifest: unknown): DdmImportDependencyState => {
  const skills = Object.fromEntries(
    manifestSkillNames(manifest).map((name) => {
      const location = localDdmImportInstalledSkill(name)
      return [name, location ? { installed: true, location } : { installed: false }]
    }),
  )
  if (Object.keys(skills).length === 0) return {}
  return { skills }
}

const localDdmImportEnv = (manifest: unknown) => {
  const envFile = readEnvFile(localDdmImportEnvPath())
  return Object.fromEntries(
    manifestEnvKeys(manifest)
      .map((key) => {
        const value = process.env[key] ?? envFile[key]
        if (!value) return
        return [key, value]
      })
      .filter((entry): entry is [string, string] => !!entry),
  )
}

const cleanDdmImportEnvValue = (value: string) => value.replaceAll("\n", "").replaceAll("\r", "")

const cleanDdmImportOutput = (value: string) => stripVTControlCharacters(value).trim()

const ddmImportProgressLines = (value: string) =>
  stripVTControlCharacters(value)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

const writeLocalDdmImportEnv = (env: DdmImportEnv) => {
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]) && entry[1].trim().length > 0,
  )
  if (entries.length === 0) return

  const envPath = localDdmImportEnvPath()
  const keys = new Set(entries.map((entry) => entry[0]))
  const replaced = new Set<string>()
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n") : []
  const next = current.map((line) => {
    const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]
    if (!key || !keys.has(key)) return line
    replaced.add(key)
    return `${key}=${cleanDdmImportEnvValue(env[key] ?? "")}`
  })

  next.push(
    ...entries.filter(([key]) => !replaced.has(key)).map(([key, value]) => `${key}=${cleanDdmImportEnvValue(value)}`),
  )
  mkdirSync(dirname(envPath), { recursive: true })
  writeFileSync(envPath, `${next.join("\n").replace(/\n+$/, "")}\n`, "utf8")
}

const ddmImportCliInput = (input: string) => {
  const downloadUrl = resolveDdmImportDownloadUrl(input)
  if (!URL.canParse(downloadUrl)) return input
  if (new URL(downloadUrl).protocol !== "https:") return input
  return `ddm://import?pkg=${encodeURIComponent(downloadUrl)}`
}

const ddmImportCliBin = () => {
  const bundled = app.isPackaged
    ? join(process.resourcesPath, "ddm-cli", "ddm")
    : join(dirname(fileURLToPath(import.meta.url)), "../../..", "ddm-cli", "bin", "ddm")
  return existsSync(bundled) ? bundled : "ddm"
}

const readDdmImportManifest = async (pkgUrl: string) => {
  const inputUrl = resolveDdmImportDownloadUrl(pkgUrl)
  const downloadUrl = (await resolveDdmMarketAgentUrl(inputUrl)) ?? inputUrl
  if (!URL.canParse(downloadUrl)) throw new Error("无效的 agent 包地址")
  if (new URL(downloadUrl).protocol !== "https:") throw new Error("只允许从 https:// 地址导入 agent 包")

  const tmpDir = join(tmpdir(), `ddm-preview-${Date.now()}`)
  await mkdir(tmpDir, { recursive: true })
  try {
    const zipPath = join(tmpDir, "pkg.zip")
    const res = await fetch(downloadUrl)
    if (!res.ok || !res.body) throw new Error(`下载失败: HTTP ${res.status}`)
    await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(zipPath))
    const manifest = await new Promise<string>((resolve, reject) => {
      execFile("unzip", ["-p", zipPath, "manifest.json"], (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      })
    })
    const parsed = JSON.parse(manifest) as unknown
    return {
      downloadUrl,
      manifest: parsed,
      env: localDdmImportEnv(parsed),
      dependencyState: localDdmImportDependencyState(parsed),
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

type Deps = {
  killSidecar: () => Promise<void> | void
  awaitInitialization: (sendStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getWindowConfig: () => Promise<WindowConfig> | WindowConfig
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  getWslConfig: () => Promise<WslConfig>
  setWslConfig: (config: WslConfig) => Promise<void> | void
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  wslPath: (path: string, mode: "windows" | "linux" | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void> | void
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>
  installUpdate: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
}

export function registerIpcHandlers(deps: Deps) {
  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("await-initialization", (event: IpcMainInvokeEvent) => {
    const send = (step: InitStep) => event.sender.send("init-step", step)
    return deps.awaitInitialization(send)
  })
  ipcMain.handle("get-window-config", () => deps.getWindowConfig())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("get-wsl-config", () => deps.getWslConfig())
  ipcMain.handle("set-wsl-config", (_event: IpcMainInvokeEvent, config: WslConfig) => deps.setWslConfig(config))
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("wsl-path", (_event: IpcMainInvokeEvent, path: string, mode: "windows" | "linux" | null) =>
    deps.wslPath(path, mode),
  )
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.on("loading-window-complete", () => deps.loadingWindowComplete())
  ipcMain.handle("run-updater", (_event: IpcMainInvokeEvent, alertOnFail: boolean) => deps.runUpdater(alertOnFail))
  ipcMain.handle("check-update", () => deps.checkUpdate())
  ipcMain.handle("install-update", () => deps.installUpdate())
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })

  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (
      _event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; accept?: string[]; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  ipcMain.on("open-link", (_event: IpcMainEvent, url: string) => {
    void shell.openExternal(url)
  })

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  ipcMain.handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })

  ipcMain.handle(
    "preview-ddm-import",
    async (
      _event: IpcMainInvokeEvent,
      pkgUrl: string,
    ): Promise<{
      success: boolean
      downloadUrl?: string
      manifest?: unknown
      env?: DdmImportEnv
      dependencyState?: DdmImportDependencyState
      error?: string
    }> => {
      try {
        return { success: true, ...(await readDdmImportManifest(pkgUrl)) }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  )

  ipcMain.handle(
    "run-ddm-import",
    async (
      event: IpcMainInvokeEvent,
      pkgUrl: string,
      opts?: { env?: DdmImportEnv },
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        writeLocalDdmImportEnv(opts?.env ?? {})
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
      return new Promise((resolve) => {
        let lastLine = ""
        const sendProgress = (message: string) => {
          if (message === lastLine) return
          lastLine = message
          if (event.sender.isDestroyed()) return
          event.sender.send("ddm-import-progress", { message })
        }
        sendProgress("准备执行 ddm import...")
        const child = spawn(ddmImportCliBin(), ["import", ddmImportCliInput(pkgUrl), "--yes"], {
          env: {
            ...process.env,
            CI: "true",
            NPM_CONFIG_YES: "true",
            npm_config_yes: "true",
            DDM_IMPORT_ENV_JSON: JSON.stringify(opts?.env ?? {}),
          },
        })
        let output = ""
        let settled = false
        const startedAt = Date.now()
        const heartbeat = setInterval(() => {
          sendProgress(`导入仍在执行（${Math.max(1, Math.round((Date.now() - startedAt) / 1000))}s）...`)
        }, 5000)
        const finish = (result: { success: boolean; error?: string }) => {
          if (settled) return
          settled = true
          clearInterval(heartbeat)
          resolve(result)
        }
        const append = (chunk: Buffer | string) => {
          const value = chunk.toString()
          output += value
          for (const line of ddmImportProgressLines(value)) {
            sendProgress(line)
          }
        }
        child.stdout.on("data", append)
        child.stderr.on("data", append)
        child.on("error", (err) => finish({ success: false, error: err.message }))
        child.on("close", (code) => {
          if (code === 0) {
            finish({ success: true })
            return
          }
          finish({ success: false, error: cleanDdmImportOutput(output) || `ddm import 退出码 ${code}` })
        })
      })
    },
  )
}

export function sendSqliteMigrationProgress(win: BrowserWindow, progress: SqliteMigrationProgress) {
  win.webContents.send("sqlite-migration-progress", progress)
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
