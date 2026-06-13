# DDM Codex-like main UI plan

## Goal

把 DDM 当前主界面改造成 Codex-like 桌面应用格局：

- 左侧为固定主导航和任务历史。
- 中间为新任务首页、会话详情页、技能页、定时任务页等主内容。
- 新任务入口以居中大输入框为核心。
- 会话页保持现有 agent/chat 能力，但视觉上更接近 Codex 的任务流界面。
- 尽量保留 OpenCode 上游结构，避免大面积重写 upstream-owned 文件。

## Current Findings

当前主 UI 主要位于 `packages/app`：

- `packages/app/src/app.tsx` 定义路由，目前只有 `/`、`/:dir`、`/:dir/session/:id?`。
- `packages/app/src/pages/layout.tsx` 是当前全局 shell，包含项目 rail、workspace、session list、预取、通知、拖拽和设置入口。
- `packages/app/src/pages/session.tsx` 是会话详情页。
- `packages/app/src/components/session/session-new-view.tsx` 是当前新会话空状态。
- `packages/app/src/components/prompt-input.tsx` 已经支持附件、agent、model、variant、shell mode、slash command、history 等 composer 能力。
- `packages/desktop` 是 Electron shell，主要通过 `window.api` 和 IPC 接入桌面能力。

现有基础很适合复用，但当前 `Layout` 过重，不建议直接在原文件里把所有逻辑改成新产品形态。

## Recommended Direction

新增 DDM 专属 app shell，并逐步把现有能力接入，而不是在现有 `layout.tsx` 中一次性大改。

建议新增：

- `packages/app/src/pages/ddm-shell.tsx`
- `packages/app/src/pages/ddm-home.tsx`
- `packages/app/src/pages/ddm-scheduled.tsx`
- `packages/app/src/pages/ddm-skills.tsx`
- `packages/app/src/pages/ddm-archive.tsx`
- `packages/app/src/pages/ddm-mobile-control.tsx`

首版可以保留旧路由兼容，避免通知点击、深链和已有会话跳转失效。

## MVP Scope

第一版建议只做能明显改变产品气质、且底层能力已经比较成熟的部分：

- Codex-like 左侧主侧栏。
- 新任务首页：居中欢迎语 + 大 composer。
- 会话详情页：居中消息流 + 底部 composer。
- 真实任务历史：复用 session list。
- Agents 列表：复用 `app.agents`。
- Skills 入口：复用 `app.skills`，首版可以只展示或插入 slash command。
- 定时任务页：先做页面和空状态。
- 手机操控页：先做入口和占位页，等产品定义明确再接能力。

不建议 MVP 首版就做完整定时任务编辑器和手机操控真实链路。

## Phase 1: Shell And Routing

目标：建立新主格局，不破坏旧 session 能力。

任务：

- 新增 DDM shell component，负责主侧栏、内容区域、移动端抽屉。
- 调整 `app.tsx` 路由，让新页面进入 DDM shell。
- 保留 `/:dir/session/:id?` 旧会话路由。
- 设计新路由：
  - `/` 新建任务首页
  - `/skills` 技能页
  - `/scheduled` 定时任务页
  - `/mobile` 手机操控页
  - `/archive` 归档页
  - `/:dir/session/:id?` 会话页兼容路径

验收：

- 启动 app 后默认进入新首页。
- 老会话链接仍然能打开。
- 旧的项目选择、server connection、settings dialog 不丢失。

## Phase 2: DDM Sidebar

目标：实现图片中的左侧主导航。

结构：

- 顶部固定入口：
  - 新建任务
  - 技能
  - 定时任务
  - 手机操控
- 中部信息分区：
  - 置顶
  - 定时任务
  - 任务历史
- Agents 分区：
  - Coder
  - Verifier
  - General
  - 后续支持用户自定义 agent
- 归档分区
- 底部用户信息

数据映射：

- 任务历史：优先复用当前项目 session list；后续升级为跨项目 global session list。
- Agents：接 `app.agents`。
- Skills：接 `app.skills`。
- 归档：查询 archived sessions。
- 定时任务：MVP 显示空状态；完整版本接 cron service。

验收：

- 当前会话在任务历史中高亮。
- 点击任务历史能打开对应会话。
- 新建任务、技能、定时任务、手机操控入口能进入对应页面。
- 窗口窄屏时侧栏可用。

## Phase 3: Home Composer

目标：把首页改造成图片中的居中大输入框体验。

实现建议：

- 复用 `PromptInput` 的核心能力，但通过 wrapper 解决首页没有 session context 的问题。
- 首页必须有 workspace/project selector。
- 没有选择 workspace 时，引导用户选择目录。
- 用户提交后：
  - 创建 session。
  - 发送 prompt。
  - 导航到新 session 页面。
- 底部保留常用控件：
  - attach
  - auth mode
  - model
  - workspace
  - agent/team

验收：

- 从首页输入 prompt 能创建新任务并跳转会话。
- model/agent/workspace 选择能影响实际请求。
- 附件、图片、slash command、`@` mention 不回归。

## Phase 4: Session Page Visual Redesign

目标：复刻图片中的 Codex-like 会话详情页。

保留：

- message timeline
- tool call rendering
- permission/question dock
- todo dock
- follow-up queue
- file/review/terminal panel
- model/agent controls

调整：

- 主消息流居中，设置稳定 max-width。
- Composer 固定在底部，宽度和消息流一致。
- 顶部显示任务标题和目录/项目信息。
- 降低页面边框和 panel 感，整体更像任务流。
- 对移动端保持原有 session/changes tab 逻辑。

验收：

- 旧会话内容正常渲染。
- 运行中的会话状态、stop、follow-up、permission request 正常。
- 文件 diff/review panel 可打开。
- 滚动、自动贴底、hash scroll 不回归。

## Phase 5: Skills And Agents

目标：让左侧和页面中的 Skills/Agents 真实可用。

Skills：

- 使用已有 `app.skills` API。
- 在 `global-sync` 或独立 query 中加载 skills。
- 技能页展示名称、描述、来源、安装状态。
- 点击技能可以插入 slash command 或进入详情。

Agents：

- 使用已有 `app.agents` API。
- 展示 primary/subagent/hidden 状态。
- 支持设置默认 agent。
- 后续支持 Agent Team 配置。

验收：

- Skills/Agents 数据来自真实 API。
- 切换 agent 后 composer 使用对应 agent。
- 技能入口不会和现有 slash command 冲突。

## Phase 6: Scheduled Tasks UI

目标：把已有 cron subsystem 做成图中的定时任务页。

当前状态：

- `packages/opencode/src/cron/cron.ts` 已有 schedule model、registry、runner、run/tick/install runner 能力。
- `specs/ddm-agent-scheduled-tasks.md` 已定义 Phase 1 方向。
- 目前 app 侧没有完整 UI 接入。

需要新增：

- HTTP API:
  - list
  - create
  - update
  - enable
  - disable
  - delete
  - run now
  - install/uninstall runner
- 重新生成 JavaScript SDK。
- App query/mutation。
- 定时任务列表页。
- 创建/编辑弹窗。
- 保持唤醒状态和开关。
- last run、next run、last status 展示。

验收：

- 可以创建绑定当前 session/workdir/agent 的定时任务。
- 可以启停、删除、立即运行。
- OS runner 安装状态可见。
- 空状态和错误状态完整。

## Phase 7: QA And Release

检查项：

- 首页新任务创建成功。
- 老会话可打开。
- 会话切换、归档、通知点击不失效。
- agent/model/workspace 选择正确进入 prompt。
- 文件附件、图片、slash command、`@` mention 不回归。
- 权限请求、问题请求、follow-up queue 正常。
- 桌面端 titlebar、窗口缩放、暗色主题正常。
- 移动端侧栏可用。
- `packages/app` typecheck 通过。
- `packages/desktop` typecheck 通过。
- 关键 unit/e2e 通过。

## Suggested Timeline

MVP: 5-7 个工作日。

- 1 天：Shell + 路由。
- 1-2 天：新侧栏。
- 1-2 天：首页 composer。
- 1 天：会话页视觉改造。
- 1 天：QA 和 polish。

完整版本：3-4 周。

- MVP：约 1 周。
- 定时任务真实化：约 1 周。
- Skills/Agents 完整页：3-5 天。
- 桌面/移动端 polish 和回归：3-5 天。

## Risks

- `layout.tsx` 当前承担太多职责，直接重写会增加回归风险和上游合并成本。
- `PromptInput` 依赖 directory/session context，首页全局 composer 需要先解耦或包一层适配。
- 定时任务不是纯 UI，需要 API、SDK、runner 状态和错误处理。
- 全局任务历史如果跨项目展示，需要处理 session list 性能和缓存策略。
- 手机操控入口的产品定义还不完整，不建议和 MVP 绑定。

## Decision

推荐先做 MVP：

1. 新 DDM shell。
2. 新首页 composer。
3. 新左侧任务历史。
4. 会话页 Codex-like 视觉改造。

定时任务、Skills/Agents 完整页、手机操控作为后续阶段推进。
