import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event, MessageBoxOptions } from "electron"
import { app, BrowserWindow, dialog } from "electron"

import contextMenu from "electron-context-menu"

import type { InitStep, ServerReadyData, SqliteMigrationProgress, WslConfig } from "../preload/types"
import { checkAppExists, resolveAppPath, wslPath } from "./apps"
import { CHANNEL, UPDATER_ENABLED } from "./constants"
import { isDdmImportDeepLink, previewDdmImport, runDdmImport, type DdmImportManifest } from "./ddm-import"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, sendSqliteMigrationProgress } from "./ipc"
import { initLogging } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import { ensureDdmLogin } from "./ddm-login"
import {
  getDefaultServerUrl,
  getWslConfig,
  preferAppEnv,
  setDefaultServerUrl,
  setWslConfig,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import {
  createLoadingWindow,
  createMainWindow,
  registerRendererProtocol,
  setBackgroundColor,
  setDockIcon,
} from "./windows"
import { migrate } from "./migrate"
import { checkUpdate, checkForUpdates, installUpdate, setupAutoUpdater } from "./updater"
import { Deferred, Effect, Fiber } from "effect"

const APP_NAMES: Record<string, string> = {
  dev: "百搭智能开发版",
  beta: "百搭智能测试版",
  prod: "百搭智能",
}
const APP_IDS: Record<string, string> = {
  dev: "run.bothub.desktop.dev",
  beta: "run.bothub.desktop.beta",
  prod: "run.bothub.desktop",
}
const TEST_ONBOARDING = process.env.OPENCODE_TEST_ONBOARDING === "1"

let logger: ReturnType<typeof initLogging>
let mainWindow: BrowserWindow | null = null
let server: SidecarListener | null = null

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  const imports = urls.filter(isDdmImportDeepLink)
  for (const input of imports) {
    void confirmAndRunDdmImport(input)
  }
  pendingDeepLinks.push(...urls)
  if (mainWindow && !mainWindow.isDestroyed()) sendDeepLinks(mainWindow, urls)
}

function formatDdmImportPreview(manifest: DdmImportManifest) {
  const deps = manifest.dependencies ?? {}
  const depSummary = [
    deps.skills?.length ? `Skills: ${deps.skills.map((item) => item.name).join(", ")}` : "",
    deps.mcp?.length ? `MCP: ${deps.mcp.map((item) => item.name).join(", ")}` : "",
    deps.docker?.length ? `Docker: ${deps.docker.map((item) => item.service).join(", ")}` : "",
    deps.apps?.length ? `Apps: ${deps.apps.map((item) => item.name).join(", ")}` : "",
    deps.envVars?.length ? `Env: ${deps.envVars.map((item) => item.key).join(", ")}` : "",
  ].filter(Boolean)

  return [
    `${manifest.name} v${manifest.version}`,
    manifest.summary,
    "",
    manifest.description,
    "",
    `Package: ${manifest.packageId}`,
    `Agents: ${manifest.agents.join(", ")}`,
    manifest.quickCommands.length ? `Quick commands: ${manifest.quickCommands.map((item) => item.label).join(", ")}` : "",
    depSummary.length ? `Dependencies: ${depSummary.join("; ")}` : "Dependencies: none",
    "",
    `Change: ${manifest.changeSummary}`,
  ]
    .filter((line) => line !== "")
    .join("\n")
}

async function confirmAndRunDdmImport(input: string) {
  try {
    const manifest = await previewDdmImport(input)
    const confirmOptions: MessageBoxOptions = {
      type: "question",
      buttons: ["导入", "取消"],
      defaultId: 0,
      cancelId: 1,
      title: "导入 DDM Agent",
      message: "确认导入这个 OpenCode Agent？",
      detail: formatDdmImportPreview(manifest),
    }
    const result = mainWindow
      ? await dialog.showMessageBox(mainWindow, confirmOptions)
      : await dialog.showMessageBox(confirmOptions)
    if (result.response !== 0) return
    await runDdmImport(input)
    const doneOptions: MessageBoxOptions = {
      type: "info",
      buttons: ["知道了"],
      title: "导入完成",
      message: `${manifest.name} 已导入`,
      detail: `重启或刷新后可使用 ${manifest.agents.join(", ")}。`,
    }
    if (mainWindow) await dialog.showMessageBox(mainWindow, doneOptions)
    else await dialog.showMessageBox(doneOptions)
  } catch (error) {
    logger.error("ddm import failed", { error: error instanceof Error ? error.message : String(error) })
    const errorOptions: MessageBoxOptions = {
      type: "error",
      buttons: ["知道了"],
      title: "导入失败",
      message: "DDM Agent 导入失败",
      detail: error instanceof Error ? error.message : String(error),
    }
    if (mainWindow) await dialog.showMessageBox(mainWindow, errorOptions)
    else await dialog.showMessageBox(errorOptions)
  }
}

function setInitStep(step: InitStep) {
  initStep = step
  logger.log("init step", { step })
  initEmitter.emit("step", step)
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "run.bothub.desktop.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.OPENCODE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "百搭智能开发版")
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  logger = initLogging()

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv(app.getPath("userData"))

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("opencode://") || arg.startsWith("ddm://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { count: urls.length })
      emitDeepLinks(urls)
    }
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { scheme: url.split(":", 1)[0] })
    emitDeepLinks([url])
  })

  // macOS: 关闭所有窗口时不退出（登录窗口关闭后 app 应继续运行）
  app.on("window-all-closed", () => {})

  app.on("before-quit", () => {
    void killSidecar()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void killSidecar().finally(() => app.exit(0))
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData>()
  const loadingComplete = Deferred.makeUnsafe<void>()

  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    awaitInitialization: Effect.fnUntraced(
      function* (sendStep) {
        sendStep(initStep)
        const listener = (step: InitStep) => sendStep(step)
        initEmitter.on("step", listener)
        try {
          logger.log("awaiting server ready")
          const res = yield* Deferred.await(serverReady)
          logger.log("server ready", { url: res.url })
          return res
        } finally {
          initEmitter.off("step", listener)
        }
      },
      (e) => Effect.runPromise(e),
    ),
    getWindowConfig: () => ({ updaterEnabled: UPDATER_ENABLED }),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    getWslConfig: () => Promise.resolve(getWslConfig()),
    setWslConfig: (config: WslConfig) => setWslConfig(config),
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    parseMarkdown: async (markdown) => parseMarkdown(markdown),
    checkAppExists: (appName) => checkAppExists(appName),
    wslPath: async (path, mode) => wslPath(path, mode),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    loadingWindowComplete: () => Deferred.doneUnsafe(loadingComplete, Effect.void),
    runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail, killSidecar),
    checkUpdate: async () => checkUpdate(),
    installUpdate: async () => installUpdate(killSidecar),
    setBackgroundColor: (color) => setBackgroundColor(color),
  })

  yield* Effect.promise(() => app.whenReady())

  // DDM 登录检查：app ready 后才能创建 BrowserWindow
  yield* Effect.promise(() => ensureDdmLogin())

  if (!TEST_ONBOARDING) migrate()
  app.setAsDefaultProtocolClient("opencode")
  app.setAsDefaultProtocolClient("ddm")
  registerRendererProtocol()
  setDockIcon()
  setupAutoUpdater()

  const needsMigration = ((): boolean => {
    if (process.env.OPENCODE_DB === ":memory:") return false

    const xdg = process.env.XDG_DATA_HOME
    const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
    return !existsSync(join(base, "opencode", "opencode.db"))
  })()
  let overlay: BrowserWindow | null = null

  const port = yield* Effect.gen(function* () {
    const fromEnv = process.env.OPENCODE_PORT
    if (fromEnv) {
      const parsed = Number.parseInt(fromEnv, 10)
      if (!Number.isNaN(parsed)) return parsed
    }

    const res = yield* Deferred.make<number, unknown>()
    const server = createServer()
    server.on("error", (e) => Deferred.failSync(res, () => e))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        Deferred.failSync(res, () => new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => Effect.runSync(Deferred.succeed(res, port)))
    })

    return yield* Deferred.await(res)
  })
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { url })

    initEmitter.on("sqlite", (progress: SqliteMigrationProgress) => {
      setInitStep({ phase: "sqlite_waiting" })
      if (overlay) sendSqliteMigrationProgress(overlay, progress)
      if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress)
    })

    ensureLoopbackNoProxy()
    useEnvProxy()

    logger.log("spawning sidecar", { url })
    const { listener, health } = yield* Effect.promise(() =>
      spawnLocalServer(hostname, port, password, {
        needsMigration,
        userDataPath: app.getPath("userData"),
        onSqliteProgress: (progress) => initEmitter.emit("sqlite", progress),
        onStdout: (message) => logger.log("sidecar stdout", { message }),
        onStderr: (message) => logger.warn("sidecar stderr", { message }),
        onExit: (code) => logger.warn("sidecar exited", { code }),
      }),
    )
    server = listener
    yield* Deferred.succeed(serverReady, {
      url,
      username: "opencode",
      password,
    })

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
    )

    logger.log("loading task finished")
  }).pipe(Effect.forkChild)

  if (needsMigration) {
    const show = yield* loadingTask.pipe(
      Fiber.await,
      Effect.timeout("1 second"),
      Effect.as(false),
      Effect.catch(() => Effect.succeed(true)),
    )
    if (show) {
      overlay = createLoadingWindow()
      yield* Effect.sleep("1 second")
    }
  }

  yield* Fiber.await(loadingTask)
  setInitStep({ phase: "done" })

  if (overlay) yield* Deferred.await(loadingComplete)

  mainWindow = createMainWindow()
  if (mainWindow) {
    // 窗口关闭后清空引用，防止往已销毁 webContents 发消息
    mainWindow.on("closed", () => {
      mainWindow = null
    })

    // flush 冷启动期间积压的 deep links（renderer 可能在 did-finish-load 前已
    // 通过 consumeInitialDeepLinks 取走，splice 保证不重复投递）
    mainWindow.webContents.once("did-finish-load", () => {
      if (mainWindow && !mainWindow.isDestroyed() && pendingDeepLinks.length > 0) {
        sendDeepLinks(mainWindow, pendingDeepLinks.splice(0))
      }
    })

    createMenu({
      trigger: (id) => mainWindow && sendMenuCommand(mainWindow, id),
      checkForUpdates: () => {
        void checkForUpdates(true, killSidecar)
      },
      reload: () => mainWindow?.reload(),
      relaunch: () => {
        void killSidecar().finally(() => {
          app.relaunch()
          app.exit(0)
        })
      },
    })
  }

  overlay?.close()
})

Effect.runFork(main)
