import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, type JSXElement } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@opencode-ai/ui/context/dialog"

type SkillDep = {
  name?: string
  installCommand?: string
  description?: string
  required?: boolean
}

type McpDep = {
  name?: string
  type?: string
  command?: string[]
  url?: string
  headers?: Record<string, string>
  description?: string
  required?: boolean
}

type DockerDep = {
  service?: string
  image?: string
  ports?: string[]
  description?: string
  required?: boolean
  startCommand?: string
  healthCheck?: string
}

type AppDep = {
  name?: string
  platform?: string[]
  description?: string
  required?: boolean
  installUrl?: string
}

type EnvVarDep = {
  name?: string
  description?: string
  required?: boolean
  example?: string
}

type OpencodeManifest = {
  agent?: string
  skills?: string[]
}

type AgentManifest = {
  schemaVersion?: string
  packageId?: string
  agentId?: string
  version?: string
  name?: string
  summary?: string
  description?: string
  tags?: string[]
  opencode?: OpencodeManifest
  dependencies?: {
    skills?: SkillDep[]
    mcp?: McpDep[]
    docker?: DockerDep[]
    apps?: AppDep[]
    envVars?: EnvVarDep[]
  }
  changeSummary?: string
}

type DependencyState = {
  skills?: Record<string, { installed?: boolean; location?: string }>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : "未声明")
const hasText = (value: unknown) => typeof value === "string" && value.trim().length > 0
const list = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
const records = <T extends Record<string, unknown>>(value: unknown) =>
  Array.isArray(value) ? (value.filter(isRecord) as T[]) : []
const manifestAgentFiles = (manifest: AgentManifest) => (hasText(manifest.opencode?.agent) ? [manifest.opencode!.agent!] : [])

function RequiredBadge(props: { required?: boolean }) {
  return (
    <span
      classList={{
        "text-11-medium px-1.5 py-0.5 rounded-sm shrink-0": true,
        "bg-surface-critical-weak text-text-on-critical-strong": !!props.required,
        "bg-surface-base text-text-weak shadow-xs-border-base": !props.required,
      }}
    >
      {props.required ? "必需" : "可选"}
    </span>
  )
}

function StatusBadge(props: { tone: "success" | "base"; children: JSXElement }) {
  return (
    <span
      classList={{
        "text-11-medium px-1.5 py-0.5 rounded-sm shrink-0": true,
        "bg-surface-success-weak text-text-on-success-strong": props.tone === "success",
        "bg-surface-base text-text-weak shadow-xs-border-base": props.tone === "base",
      }}
    >
      {props.children}
    </span>
  )
}

function Section(props: { title: string; count?: number; children: JSXElement }) {
  return (
    <section class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <h3 class="text-13-medium text-text-strong">{props.title}</h3>
        <Show when={props.count !== undefined}>
          <span class="text-11-regular text-text-weak">{props.count} 项</span>
        </Show>
      </div>
      {props.children}
    </section>
  )
}

function InfoRow(props: { label: string; value: JSXElement }) {
  return (
    <div class="min-w-0">
      <div class="text-11-medium text-text-weak">{props.label}</div>
      <div class="mt-0.5 text-13-regular text-text-base break-words">{props.value}</div>
    </div>
  )
}

function DependencyCard(props: { title: string; required?: boolean; status?: JSXElement; children: JSXElement }) {
  return (
    <div class="rounded-md bg-surface-base p-3 shadow-xs-border-base">
      <div class="flex items-start justify-between gap-3">
        <div class="text-13-medium text-text-strong break-words">{props.title}</div>
        <div class="flex shrink-0 items-center gap-1.5">
          <Show when={props.status}>{props.status}</Show>
          <RequiredBadge required={props.required} />
        </div>
      </div>
      <div class="mt-2 grid gap-1.5 text-12-regular text-text-base">{props.children}</div>
    </div>
  )
}

function FieldLine(props: { label: string; value: JSXElement }) {
  return (
    <div class="grid grid-cols-[96px_minmax(0,1fr)] gap-2">
      <div class="text-text-weak">{props.label}</div>
      <div class="min-w-0 break-words">{props.value}</div>
    </div>
  )
}

export function DialogDdmImportAgent(props: { pkgUrl: string }) {
  const dialog = useDialog()
  const [env, setEnv] = createStore<Record<string, string>>({})
  const [importing, setImporting] = createSignal(false)
  const [progress, setProgress] = createSignal<string[]>([])
  const [error, setError] = createSignal<string>()
  const [preview] = createResource(
    () => props.pkgUrl,
    async (pkgUrl) => {
      const result = await window.api?.previewDdmImport?.(pkgUrl)
      if (!result) return { success: false as const, error: "当前运行环境不支持 DDM 导入预览" }
      return result
    },
  )
  const manifest = createMemo((): AgentManifest => {
    const result = preview()
    if (result?.success && isRecord(result.manifest)) return result.manifest as AgentManifest
    return {}
  })
  const dependencies = createMemo(() => manifest().dependencies ?? {})
  const dependencyState = createMemo((): DependencyState => {
    const result = preview()
    if (result?.success) return result.dependencyState ?? {}
    return {}
  })
  const envVars = createMemo(() => records<EnvVarDep>(dependencies().envVars).filter((item) => hasText(item.name)))
  const skillDeps = createMemo(() =>
    records<SkillDep>(dependencies().skills).filter(
      (item) => hasText(item.name) || hasText(item.installCommand) || hasText(item.description),
    ),
  )
  const mcpDeps = createMemo(() =>
    records<McpDep>(dependencies().mcp).filter(
      (item) =>
        hasText(item.name) ||
        hasText(item.type) ||
        hasText(item.url) ||
        hasText(item.description) ||
        !!item.command?.length,
    ),
  )
  const dockerDeps = createMemo(() =>
    records<DockerDep>(dependencies().docker).filter(
      (item) => hasText(item.service) || hasText(item.image) || hasText(item.description) || hasText(item.startCommand),
    ),
  )
  const appDeps = createMemo(() =>
    records<AppDep>(dependencies().apps).filter(
      (item) => hasText(item.name) || hasText(item.description) || hasText(item.installUrl),
    ),
  )
  const localEnv = createMemo(() => {
    const result = preview()
    if (result?.success) return result.env ?? {}
    return {}
  })
  const [prefilledFor, setPrefilledFor] = createSignal<string>()
  const previewError = createMemo(() => {
    const result = preview()
    if (result && !result.success) return result.error ?? "未知错误"
    return "未知错误"
  })
  const missingRequired = createMemo(() =>
    envVars()
      .filter((item) => item.required && item.name)
      .filter((item) => !env[item.name!]?.trim()),
  )
  const importEnv = () =>
    Object.fromEntries(
      envVars()
        .map((item) => {
          const key = item.name
          return key && env[key]?.trim() ? [key, env[key].trim()] : undefined
        })
        .filter((item): item is [string, string] => !!item),
    )
  const sourceUrl = createMemo(() => {
    const raw = preview()?.downloadUrl ?? props.pkgUrl
    try {
      return new URL(raw).hostname
    } catch {
      return raw
    }
  })
  const appendProgress = (message: string) =>
    setProgress((current) => [...current.filter((line) => line !== message), message].slice(-8))

  createEffect(() => {
    const result = preview()
    if (!result?.success || prefilledFor() === props.pkgUrl) return
    Object.entries(result.env ?? {})
      .filter(([key, value]) => envVars().some((item) => item.name === key) && value.trim())
      .forEach(([key, value]) => setEnv(key, value))
    setPrefilledFor(props.pkgUrl)
  })

  createEffect(() => {
    if (!importing()) return
    const unsubscribe = window.api?.onDdmImportProgress?.((item) => appendProgress(item.message))
    if (unsubscribe) onCleanup(unsubscribe)
  })

  async function confirmImport() {
    if (missingRequired().length > 0) {
      setError(
        `请填写必需环境变量：${missingRequired()
          .map((item) => item.name)
          .join(", ")}`,
      )
      return
    }
    setError(undefined)
    setProgress(["开始导入..."])
    setImporting(true)
    const result = await window.api?.runDdmImport?.(props.pkgUrl, { env: importEnv() })
    setImporting(false)
    if (result?.success) {
      showToast({ title: "Agent 已导入", description: "重启 DDM 后即可使用新 agent。" })
      dialog.close()
      return
    }
    setError(result?.error ?? "导入失败")
  }

  return (
    <Dialog
      size="x-large"
      title={preview.loading ? "读取 agent manifest" : `导入「${text(manifest().name)}」`}
      description={preview.loading ? "正在下载发布包并解析 manifest.json。" : text(manifest().summary)}
      class="h-full [&_[data-slot=dialog-body]]:overflow-hidden"
    >
      <Show
        when={!preview.loading}
        fallback={
          <div class="flex flex-1 items-center justify-center gap-3 text-13-regular text-text-weak">
            <Spinner class="size-4" />
            <span>正在读取 manifest.json</span>
          </div>
        }
      >
        <Show
          when={preview()?.success}
          fallback={
            <div class="flex flex-1 flex-col justify-between gap-4 p-5">
              <div class="rounded-md bg-surface-base p-4 shadow-xs-border-base">
                <div class="text-14-medium text-text-strong">无法预览 agent 包</div>
                <div class="mt-2 text-13-regular text-text-base break-words">{previewError()}</div>
              </div>
              <div class="flex justify-end gap-2">
                <Button variant="ghost" size="large" onClick={() => dialog.close()}>
                  关闭
                </Button>
              </div>
            </div>
          }
        >
          <div class="flex min-h-0 flex-1 flex-col">
            <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
              <div class="flex flex-col gap-5">
                <div class="grid grid-cols-2 gap-3 rounded-md bg-surface-base p-4 shadow-xs-border-base max-sm:grid-cols-1">
                  <InfoRow label="包 ID" value={text(manifest().packageId)} />
                  <InfoRow label="版本" value={text(manifest().version)} />
                  <InfoRow label="Schema" value={text(manifest().schemaVersion)} />
                  <InfoRow label="摘要" value={text(manifest().summary)} />
                  <InfoRow label="来源" value={sourceUrl()} />
                  <InfoRow
                    label="Agent 文件"
                    value={manifestAgentFiles(manifest()).length ? manifestAgentFiles(manifest()).join(", ") : "未声明"}
                  />
                  <InfoRow
                    label="内置 Skills"
                    value={
                      list(manifest().opencode?.skills).length ? list(manifest().opencode?.skills).join(", ") : "无"
                    }
                  />
                  <InfoRow
                    label="标签"
                    value={
                      list(manifest().tags).length ? (
                        <div class="flex flex-wrap gap-1">
                          <For each={list(manifest().tags)}>
                            {(tag) => (
                              <span class="rounded-sm bg-surface-raised-base px-1.5 py-0.5 text-11-medium">{tag}</span>
                            )}
                          </For>
                        </div>
                      ) : (
                        "未声明"
                      )
                    }
                  />
                </div>

                <Section title="描述">
                  <div class="rounded-md bg-surface-base p-4 shadow-xs-border-base">
                    <p class="text-13-regular text-text-base break-words">{text(manifest().description)}</p>
                    <Show when={manifest().changeSummary}>
                      <div class="mt-3 border-t border-border-base pt-3">
                        <div class="text-11-medium text-text-weak">版本变更</div>
                        <div class="mt-1 text-13-regular text-text-base break-words">{manifest().changeSummary}</div>
                      </div>
                    </Show>
                  </div>
                </Section>

                <Show when={envVars().length}>
                  <Section title="环境变量" count={envVars().length}>
                    <div class="grid gap-3">
                      <For each={envVars()}>
                        {(item) => {
                          const key = createMemo(() => item.name)
                          return (
                            <div class="rounded-md bg-surface-base p-3 shadow-xs-border-base">
                              <div class="mb-2 flex items-start justify-between gap-3">
                                <div>
                                  <div class="text-13-medium text-text-strong">{text(key())}</div>
                                  <div class="mt-1 text-12-regular text-text-weak break-words">
                                    {text(item.description)}
                                  </div>
                                </div>
                                <div class="flex shrink-0 items-center gap-2">
                                  <Show when={key() && localEnv()[key()!] && env[key()!]?.trim()}>
                                    <span class="rounded-sm bg-surface-success-weak px-1.5 py-0.5 text-text-on-success-strong">
                                      <Checkbox checked readOnly>
                                        <span class="text-11-medium">本地已填入</span>
                                      </Checkbox>
                                    </span>
                                  </Show>
                                  <RequiredBadge required={item.required} />
                                </div>
                              </div>
                              <Show when={key()}>
                                <TextField
                                  type="password"
                                  label={`${key()} 值`}
                                  hideLabel
                                  placeholder={item.example ?? "输入后会写入 .opencode/.env"}
                                  value={env[key()!] ?? ""}
                                  disabled={importing()}
                                  validationState={item.required && !env[key()!]?.trim() ? "invalid" : "valid"}
                                  error={item.required && !env[key()!]?.trim() ? "必填" : undefined}
                                  onChange={(value) => setEnv(key()!, value)}
                                />
                              </Show>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </Section>
                </Show>

                <Show when={skillDeps().length}>
                  <Section title="Skill 依赖" count={skillDeps().length}>
                    <div class="grid gap-2">
                      <For each={skillDeps()}>
                        {(item) => {
                          const state = createMemo(() =>
                            item.name ? dependencyState().skills?.[item.name] : undefined,
                          )
                          return (
                            <DependencyCard
                              title={text(item.name)}
                              required={item.required}
                              status={
                                state()?.installed ? (
                                  <StatusBadge tone="success">本地已安装</StatusBadge>
                                ) : (
                                  <StatusBadge tone="base">待安装</StatusBadge>
                                )
                              }
                            >
                              <FieldLine label="用途" value={text(item.description)} />
                              <FieldLine
                                label="安装命令"
                                value={<code class="font-mono text-11-regular">{text(item.installCommand)}</code>}
                              />
                              <Show when={state()?.location}>
                                <FieldLine
                                  label="本地位置"
                                  value={<code class="font-mono text-11-regular">{state()!.location}</code>}
                                />
                              </Show>
                            </DependencyCard>
                          )
                        }}
                      </For>
                    </div>
                  </Section>
                </Show>

                <Show when={mcpDeps().length}>
                  <Section title="MCP 服务" count={mcpDeps().length}>
                    <div class="grid gap-2">
                      <For each={mcpDeps()}>
                        {(item) => (
                          <DependencyCard title={text(item.name)} required={item.required}>
                            <FieldLine label="类型" value={text(item.type)} />
                            <FieldLine label="用途" value={text(item.description)} />
                            <Show when={item.command?.length}>
                              <FieldLine
                                label="命令"
                                value={<code class="font-mono text-11-regular">{item.command!.join(" ")}</code>}
                              />
                            </Show>
                            <Show when={item.url}>
                              <FieldLine label="地址" value={item.url} />
                            </Show>
                            <Show when={item.headers && Object.keys(item.headers).length > 0}>
                              <FieldLine
                                label="Headers"
                                value={<code class="font-mono text-11-regular">{JSON.stringify(item.headers)}</code>}
                              />
                            </Show>
                          </DependencyCard>
                        )}
                      </For>
                    </div>
                  </Section>
                </Show>

                <Show when={dockerDeps().length}>
                  <Section title="Docker 服务" count={dockerDeps().length}>
                    <div class="grid gap-2">
                      <For each={dockerDeps()}>
                        {(item) => (
                          <DependencyCard title={text(item.service)} required={item.required}>
                            <FieldLine label="镜像" value={text(item.image)} />
                            <FieldLine
                              label="端口"
                              value={list(item.ports).length ? list(item.ports).join(", ") : "未声明"}
                            />
                            <FieldLine label="用途" value={text(item.description)} />
                            <FieldLine
                              label="启动命令"
                              value={<code class="font-mono text-11-regular">{text(item.startCommand)}</code>}
                            />
                            <Show when={item.healthCheck}>
                              <FieldLine label="健康检查" value={item.healthCheck} />
                            </Show>
                          </DependencyCard>
                        )}
                      </For>
                    </div>
                  </Section>
                </Show>

                <Show when={appDeps().length}>
                  <Section title="应用依赖" count={appDeps().length}>
                    <div class="grid gap-2">
                      <For each={appDeps()}>
                        {(item) => (
                          <DependencyCard title={text(item.name)} required={item.required}>
                            <FieldLine
                              label="平台"
                              value={list(item.platform).length ? list(item.platform).join(", ") : "未声明"}
                            />
                            <FieldLine label="用途" value={text(item.description)} />
                            <FieldLine label="安装地址" value={text(item.installUrl)} />
                          </DependencyCard>
                        )}
                      </For>
                    </div>
                  </Section>
                </Show>
              </div>
            </div>

            <div class="border-t border-border-base px-5 py-4">
              <Show when={error()}>
                <div class="mb-3 rounded-md bg-surface-critical-weak px-3 py-2 text-12-regular text-text-on-critical-strong">
                  {error()}
                </div>
              </Show>
              <Show when={progress().length > 0}>
                <div class="mb-3 rounded-md bg-surface-base px-3 py-2 shadow-xs-border-base">
                  <div class="mb-1 flex items-center gap-2 text-12-medium text-text-strong">
                    <Show when={importing()}>
                      <Spinner class="size-3" />
                    </Show>
                    <span>{importing() ? "导入进度" : "导入输出"}</span>
                  </div>
                  <div class="grid gap-1 text-11-regular text-text-weak">
                    <For each={progress()}>{(line) => <div class="break-words font-mono">{line}</div>}</For>
                  </div>
                </div>
              </Show>
              <div class="flex items-center justify-between gap-3">
                <div class="flex min-w-0 items-center gap-2 text-12-regular text-text-weak">
                  <Icon name="shield" size="small" class="shrink-0" />
                  <span class="truncate">依赖会按 manifest 配置安装或写入，本地密钥只写入 .opencode/.env。</span>
                </div>
                <div class="flex shrink-0 gap-2">
                  <Button variant="ghost" size="large" disabled={importing()} onClick={() => dialog.close()}>
                    取消
                  </Button>
                  <Button
                    variant="primary"
                    size="large"
                    icon="download"
                    disabled={importing() || missingRequired().length > 0}
                    onClick={confirmImport}
                  >
                    {importing() ? "导入中" : "确认导入"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </Show>
      </Show>
    </Dialog>
  )
}
