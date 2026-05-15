/**
 * DDM Agent 包 manifest.json Schema
 *
 * 这个文件是 agent zip 包内的唯一元数据文件，
 * 同时指导 ddm unpack 如何还原 agent 到 OpenCode 执行环境。
 */

export const SCHEMA_VERSION = "1" as const

// ─── 依赖声明 ───────────────────────────────────────────────

/** Skill 依赖：通过 installCommand 安装；没有 installCommand 时仅做本地存在性提示 */
export interface SkillDep {
  /** skill 的唯一标识，用于日志和去重检查 */
  name: string
  /** 完整的安装命令，unpack 时原样执行 */
  installCommand?: string
  /** 这个 skill 的用途说明（人读） */
  description: string
  /** 是否必须安装才能正常使用 agent */
  required: boolean
}

/** MCP Server 依赖：写入 opencode.jsonc 的 mcp 块 */
export interface McpDep {
  /** opencode.jsonc 中的 key，也是 MCP server 标识 */
  name: string
  type: "local" | "remote"
  /** type=local 时的启动命令，支持 ${ENV_VAR} 引用 */
  command?: string[]
  /** type=remote 时的服务地址 */
  url?: string
  /** HTTP headers，type=remote 时使用 */
  headers?: Record<string, string>
  /** 这个 MCP server 的用途说明（人读） */
  description: string
  /** 是否必须配置才能正常使用 agent */
  required: boolean
}

/** Docker 服务依赖：unpack 时检查并启动 */
export interface DockerDep {
  /** 服务名，用于 docker ps 检查和日志 */
  service: string
  /** Docker 镜像地址 */
  image: string
  /** 端口映射，格式同 docker run -p */
  ports: string[]
  /** 服务用途说明（人读） */
  description: string
  /** 是否必须运行才能正常使用 agent */
  required: boolean
  /** unpack 时执行的完整启动命令 */
  startCommand: string
  /** 健康检查地址，unpack 后用于确认服务已就绪 */
  healthCheck?: string
}

/** 需要用户手动安装的应用（GUI 应用、系统工具等） */
export interface AppDep {
  /** 应用名称 */
  name: string
  /** 适用平台 */
  platform: Array<"macos" | "windows" | "linux">
  /** 为什么需要这个应用（人读） */
  description: string
  /** 是否必须安装才能正常使用 agent */
  required: boolean
  /** 下载/安装页面地址 */
  installUrl: string
}

/** 环境变量依赖：unpack 时提示用户填写 */
export interface EnvVarDep {
  /** 环境变量名，如 FIGMA_API_KEY */
  name: string
  /** 用途和获取方式说明（人读） */
  description: string
  /** 是否必须设置才能正常使用 agent */
  required: boolean
  /** 示例值，帮助用户理解格式 */
  example?: string
}

/** 全部依赖声明 */
export interface Dependencies {
  /** Skill 依赖列表 */
  skills?: SkillDep[]
  /** MCP Server 依赖列表 */
  mcp?: McpDep[]
  /** Docker 服务依赖列表 */
  docker?: DockerDep[]
  /** 需要手动安装的应用 */
  apps?: AppDep[]
  /** 环境变量依赖列表 */
  envVars?: EnvVarDep[]
}

/** OpenCode 运行时文件入口 */
export interface OpencodeManifest {
  /** agent 定义文件路径，例如 "visual-designer.md" */
  agent: string
  /** 包内专属技能目录，例如 ["skills/visual-research"] */
  skills: string[]
}

/** 定时任务声明，由导入器或平台调度系统安装 */
export interface ScheduleManifest {
  id: string
  label: string
  prompt: string
  timezone: string
  cron?: string
  every?: string
  enabledDefault: boolean
}

// ─── 展示媒体 ───────────────────────────────────────────────

export interface MediaAsset {
  path: string
  alt: string
  caption?: string
}

export interface GalleryMediaAsset extends MediaAsset {
  kind: string
}

export interface AgentMedia {
  avatar: MediaAsset
  cover: MediaAsset
  gallery: GalleryMediaAsset[]
  theme: {
    accent: string
    background: string
  }
}

// ─── 快速命令 ───────────────────────────────────────────────

/** 快速启动命令，展示在 DDM 平台 agent 详情页 */
export interface QuickCommand {
  /** 唯一 ID，kebab-case */
  id: string
  /** 按钮文字，4-10 字，动宾结构 */
  label: string
  /** 点击后发送给 agent 的完整任务指令 */
  prompt: string
}

// ─── Manifest 主体 ──────────────────────────────────────────

/** DDM Agent 包 manifest.json 完整 Schema */
export interface AgentManifest {
  /** manifest 格式版本，当前固定为 "1" */
  schemaVersion: typeof SCHEMA_VERSION

  // 包标识
  /** 全局唯一包 ID，格式建议 "域名.名称"，如 "ddm.visual-designer" */
  packageId: string
  /** 成品仓 agent 目录名，当前格式要求与 packageId 的后缀一致 */
  agentId?: string
  /** semver 版本号 */
  version: string

  // 展示信息（展示在 DDM 平台市场页）
  /** 中文名称，6-14 字，表达角色或任务入口 */
  name: string
  /** 20-40 字，一句话说明为谁解决什么问题 */
  summary: string
  /** 80-160 字，适用场景、核心能力、主要产出和必要边界 */
  description: string
  /** 3-5 个面向用户的领域词，不使用内部技术词 */
  tags: string[]

  /** homepage 和市场页使用的包内展示媒体 */
  media: AgentMedia

  // 快速命令（3-6 条）
  quickCommands: QuickCommand[]

  // OpenCode 入口（当前格式）
  opencode?: OpencodeManifest

  // 依赖声明（unpack 时按此安装/配置）
  dependencies: Dependencies

  /** 定时任务契约；没有时为空数组 */
  schedules?: ScheduleManifest[]

  // 版本信息
  /** 本版本的变更摘要，用于审核和用户了解更新内容 */
  changeSummary: string
}

export function isSafeRelativePath(value: string): boolean {
  if (!value || pathIsAbsolute(value)) return false
  const normalized = value.replace(/\\/g, "/")
  if (normalized.startsWith("/") || normalized.includes("\0")) return false
  return !normalized.split("/").some((part) => part === "" || part === "." || part === "..")
}

function pathIsAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)
}

export function manifestAgentPaths(manifest: AgentManifest): string[] {
  return manifest.opencode?.agent ? [manifest.opencode.agent] : []
}

export function manifestOpencodeSkillPaths(manifest: AgentManifest): string[] {
  return manifest.opencode?.skills ?? []
}

export function manifestMediaPaths(manifest: AgentManifest): string[] {
  return [
    manifest.media.avatar.path,
    manifest.media.cover.path,
    ...manifest.media.gallery.map((item) => item.path),
  ]
}

export function manifestAgentCommandName(manifest: AgentManifest): string {
  const first = manifestAgentPaths(manifest)[0] ?? manifest.agentId ?? manifest.packageId
  return first.split("/").pop()?.replace(/\.md$/i, "") ?? first
}

export function envVarKey(envVar: EnvVarDep): string | undefined {
  return envVar.name
}

// ─── 验证 ────────────────────────────────────────────────────

export class ManifestValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message)
    this.name = "ManifestValidationError"
  }
}

/** 验证 manifest 格式是否合法，返回错误列表（空数组表示合法） */
export function validateManifest(data: unknown): ManifestValidationError[] {
  const errors: ManifestValidationError[] = []
  const m = data as Record<string, unknown>

  if (!m || typeof m !== "object") {
    errors.push(new ManifestValidationError("manifest 必须是 JSON 对象", "root"))
    return errors
  }

  if (m.schemaVersion !== SCHEMA_VERSION) {
    errors.push(
      new ManifestValidationError(
        `schemaVersion 必须是 "${SCHEMA_VERSION}"，当前值: ${m.schemaVersion}`,
        "schemaVersion",
      ),
    )
  }

  for (const field of ["packageId", "version", "name", "summary", "description", "changeSummary"] as const) {
    if (!m[field] || typeof m[field] !== "string") {
      errors.push(new ManifestValidationError(`${field} 是必填字符串`, field))
    }
  }

  if (!Array.isArray(m.tags) || m.tags.length < 1) {
    errors.push(new ManifestValidationError("tags 至少需要 1 个", "tags"))
  }

  if (!Array.isArray(m.quickCommands) || m.quickCommands.length < 1) {
    errors.push(new ManifestValidationError("quickCommands 至少需要 1 条", "quickCommands"))
  } else {
    for (const [i, qc] of (m.quickCommands as unknown[]).entries()) {
      const q = qc as Record<string, unknown>
      for (const f of ["id", "label", "prompt"] as const) {
        if (!q[f] || typeof q[f] !== "string") {
          errors.push(new ManifestValidationError(`quickCommands[${i}].${f} 是必填字符串`, `quickCommands.${i}.${f}`))
        }
      }
    }
  }

  const media = m.media as Record<string, unknown> | undefined
  if (!media || typeof media !== "object" || Array.isArray(media)) {
    errors.push(new ManifestValidationError("media 是必填对象", "media"))
  } else {
    const validateMediaAsset = (value: unknown, field: string, requireKind = false) => {
      const asset = value as Record<string, unknown> | undefined
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
        errors.push(new ManifestValidationError(`${field} 是必填对象`, field))
        return
      }
      if (typeof asset.path !== "string" || !isSafeRelativePath(asset.path) || !asset.path.startsWith("media/")) {
        errors.push(new ManifestValidationError(`${field}.path 必须是 media/ 下的安全相对路径`, `${field}.path`))
      }
      if (typeof asset.alt !== "string" || !asset.alt.trim()) {
        errors.push(new ManifestValidationError(`${field}.alt 是必填字符串`, `${field}.alt`))
      }
      if (asset.caption !== undefined && (typeof asset.caption !== "string" || !asset.caption.trim())) {
        errors.push(new ManifestValidationError(`${field}.caption 必须是非空字符串`, `${field}.caption`))
      }
      if (requireKind && (typeof asset.kind !== "string" || !asset.kind.trim())) {
        errors.push(new ManifestValidationError(`${field}.kind 是必填字符串`, `${field}.kind`))
      }
    }

    validateMediaAsset(media.avatar, "media.avatar")
    validateMediaAsset(media.cover, "media.cover")
    if (!Array.isArray(media.gallery) || media.gallery.length < 1) {
      errors.push(new ManifestValidationError("media.gallery 至少需要 1 张图片", "media.gallery"))
    } else {
      for (const [index, item] of media.gallery.entries()) {
        validateMediaAsset(item, `media.gallery.${index}`, true)
      }
    }
    const theme = media.theme as Record<string, unknown> | undefined
    if (!theme || typeof theme !== "object" || Array.isArray(theme)) {
      errors.push(new ManifestValidationError("media.theme 是必填对象", "media.theme"))
    } else {
      for (const field of ["accent", "background"] as const) {
        const value = theme[field]
        if (typeof value !== "string" || !value.trim()) {
          errors.push(new ManifestValidationError(`media.theme.${field} 是必填字符串`, `media.theme.${field}`))
        }
      }
    }
  }

  const opencode = m.opencode as Record<string, unknown> | undefined
  const hasOpencode = !!opencode && typeof opencode === "object" && !Array.isArray(opencode)

  if ("agents" in m) {
    errors.push(new ManifestValidationError("agents 已废弃，请使用 opencode.agent", "agents"))
  }

  if (!hasOpencode) {
    errors.push(new ManifestValidationError("opencode 是必填对象", "opencode"))
  } else {
    if (!m.agentId || typeof m.agentId !== "string") {
      errors.push(new ManifestValidationError("当前格式必须声明 agentId", "agentId"))
    }
    if (!opencode.agent || typeof opencode.agent !== "string") {
      errors.push(new ManifestValidationError("opencode.agent 是必填字符串", "opencode.agent"))
    } else if (!isSafeRelativePath(opencode.agent)) {
      errors.push(new ManifestValidationError("opencode.agent 必须是安全相对路径", "opencode.agent"))
    }
    if (!Array.isArray(opencode.skills)) {
      errors.push(new ManifestValidationError("opencode.skills 必须是数组", "opencode.skills"))
    } else {
      for (const [i, skillPath] of opencode.skills.entries()) {
        if (typeof skillPath !== "string" || !isSafeRelativePath(skillPath)) {
          errors.push(new ManifestValidationError(`opencode.skills[${i}] 必须是安全相对路径`, `opencode.skills.${i}`))
        }
      }
    }
  }

  if (!m.dependencies || typeof m.dependencies !== "object") {
    errors.push(new ManifestValidationError("dependencies 是必填对象", "dependencies"))
  } else {
    const deps = m.dependencies as Record<string, unknown>
    for (const field of ["skills", "mcp", "docker", "apps", "envVars"] as const) {
      if (deps[field] !== undefined && !Array.isArray(deps[field])) {
        errors.push(new ManifestValidationError(`dependencies.${field} 必须是数组`, `dependencies.${field}`))
      }
    }
  }

  if (m.schedules !== undefined) {
    if (!Array.isArray(m.schedules)) {
      errors.push(new ManifestValidationError("schedules 必须是数组", "schedules"))
    } else {
      for (const [i, schedule] of (m.schedules as unknown[]).entries()) {
        const item = schedule as Record<string, unknown>
        for (const f of ["id", "label", "prompt", "timezone"] as const) {
          if (!item[f] || typeof item[f] !== "string") {
            errors.push(new ManifestValidationError(`schedules[${i}].${f} 是必填字符串`, `schedules.${i}.${f}`))
          }
        }
        if (typeof item.enabledDefault !== "boolean") {
          errors.push(
            new ManifestValidationError(`schedules[${i}].enabledDefault 是必填布尔值`, `schedules.${i}.enabledDefault`),
          )
        }
        if (!item.cron && !item.every) {
          errors.push(new ManifestValidationError(`schedules[${i}] 必须声明 cron 或 every`, `schedules.${i}`))
        }
      }
    }
  }

  return errors
}

/** 解析并验证 manifest JSON 字符串，验证失败时抛出 */
export function parseManifest(json: string): AgentManifest {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch (e) {
    throw new ManifestValidationError(`manifest.json 解析失败: ${(e as Error).message}`, "root")
  }

  const errors = validateManifest(data)
  if (errors.length > 0) {
    throw new ManifestValidationError(
      `manifest.json 验证失败:\n${errors.map((e) => `  - [${e.field}] ${e.message}`).join("\n")}`,
      "root",
    )
  }

  return data as AgentManifest
}
