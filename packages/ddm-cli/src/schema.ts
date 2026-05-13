/**
 * DDM Agent 包 manifest.json Schema
 *
 * 这个文件是 agent zip 包内的唯一元数据文件，
 * 同时指导 ddm unpack 如何还原 agent 到 OpenCode 执行环境。
 */

export const SCHEMA_VERSION = "1" as const

// ─── 依赖声明 ───────────────────────────────────────────────

/** Skill 依赖：通过 npx skills add 安装 */
export interface SkillDep {
  /** skill 的唯一标识，用于日志和去重检查 */
  name: string
  /** 完整的安装命令，unpack 时原样执行 */
  installCommand: string
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
  key: string
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

  // 快速命令（3-6 条）
  quickCommands: QuickCommand[]

  // 包内文件（相对于 zip 根目录的路径）
  /** agent 定义文件列表，如 ["agent/visual-designer.md"] */
  agents: string[]

  // 依赖声明（unpack 时按此安装/配置）
  dependencies: Dependencies

  // 版本信息
  /** 本版本的变更摘要，用于审核和用户了解更新内容 */
  changeSummary: string
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

  if (!Array.isArray(m.agents) || m.agents.length < 1) {
    errors.push(new ManifestValidationError("agents 至少需要 1 个文件路径", "agents"))
  }

  if (!m.dependencies || typeof m.dependencies !== "object") {
    errors.push(new ManifestValidationError("dependencies 是必填对象", "dependencies"))
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
