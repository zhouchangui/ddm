# ddm-cli 验证计划

## V1 - 包结构完整性

检查所有必要文件存在且格式正确。

- [ ] `package.json` 存在，`name` 为 `@ddm/cli`，`bin.ddm` 指向 `./bin/ddm`
- [ ] `bin/ddm` 存在且有执行权限（`chmod +x`）
- [ ] `src/index.ts` 存在
- [ ] `src/schema.ts` 存在
- [ ] `src/cmd/pack.ts` 存在
- [ ] `src/cmd/auth.ts` 存在
- [ ] `tsconfig.json` 存在

---

## V2 - TypeScript 类型检查

确认代码无类型错误。

- [ ] 在 `packages/ddm-cli` 目录下安装依赖：`bun install`
- [ ] 运行类型检查：`bun run typecheck`（或 `tsc --noEmit`）无报错

---

## V3 - schema.ts 逻辑验证

用内联脚本验证 `validateManifest` 和 `parseManifest` 行为正确。

- [ ] 合法的完整 manifest → `validateManifest` 返回空数组
- [ ] 缺少 `packageId` 的 manifest → 返回包含对应错误的数组
- [ ] `schemaVersion` 不是 `"1"` → 返回错误
- [ ] 缺少 `opencode.agent` → 返回错误
- [ ] 出现废弃字段 `agents` → 返回错误
- [ ] 当前格式 `opencode.skills` 不是数组 → 返回错误
- [ ] `parseManifest` 传入非 JSON 字符串 → 抛出 `ManifestValidationError`

---

## V4 - 当前格式 ddm pack 干跑验证

用一个最小当前格式 agent 目录测试打包流程。

- [ ] 创建临时目录 `/tmp/test-agent/hello.md`（带合法 frontmatter）
- [ ] 补充 manifest.json，包含 `agentId: "hello"` 和 `opencode.agent: "hello.md"`
- [ ] 运行 `ddm pack /tmp/test-agent --out /tmp/ddm-hello-0.1.0.zip`
- [ ] 解压 zip，确认包含 `manifest.json`、`hello.md`，以及声明的 `skills/<skillId>/`
- [ ] `manifest.json` 内 `opencode` 字段保持当前格式
- [ ] zip 不包含废弃 `agent/` 目录和 `agents` 字段

---

## V5 - ddm unpack 干跑验证

用 V4 生成的 zip 测试还原流程。

- [ ] 运行 `ddm unpack /tmp/hello-0.1.0.zip --target /tmp/unpack-test --yes`
- [ ] 确认 `/tmp/unpack-test/.opencode/agent/hello.md` 已创建
- [ ] 如果 manifest 有 `opencode.skills`：确认 `/tmp/unpack-test/.opencode/skills/<skillId>/SKILL.md` 已创建
- [ ] 如果 manifest 有 `dependencies.mcp`：确认 `/tmp/unpack-test/.opencode/opencode.jsonc` 中 mcp 块已合并
- [ ] 如果 manifest 有 `dependencies.envVars`：确认 `.opencode/.env` 已追加对应 `key` 或 `name`

---

## V6 - ddm verify 发布前验证

用 V4 生成的 zip 测试发布前本地验证。

- [ ] 运行 `ddm verify /tmp/hello-0.1.0.zip`
- [ ] 确认 verify 会解析 manifest、检查包内文件、导入到临时 `.opencode` 目录
- [ ] 缺少 `opencode.agent` 文件的 zip → verify 失败
- [ ] 缺少 `skills/<skillId>/SKILL.md` 的 zip → verify 失败

---

## V7 - manifest schema 完整样例验证

验证文档中给出的完整样例（含 skills / docker / mcp / envVars）能通过 schema 验证。

- [ ] 把完整样例 JSON（含 docker / skills / mcp / envVars 字段）喂给 `parseManifest` → 无报错
- [ ] `dependencies.skills[].installCommand` 可选；缺失时导入器只做本地存在性提示
- [ ] `dependencies.docker[].startCommand` 字段存在且为字符串

---

## V8 - SKILL.md 内容审查

人工检查两个重写后的 SKILL.md，确认无龙虾架构残留。

- [ ] `ddm-agent-create/SKILL.md`：不含 `SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`HEARTBEAT.md`、`USER.md`、`openclaw` 等词
- [ ] `ddm-agent-create/SKILL.md`：输出路径引用当前根目录 `<agentId>.md` 格式
- [ ] `ddm-agent-publish/SKILL.md`：不含上述旧架构词
- [ ] `ddm-agent-publish/SKILL.md`：发布流程引用 `ddm pack` 和 `ddm verify`

---

## V9 - monorepo 注册

确认新包已纳入 workspace。

- [ ] 根目录 `package.json` 的 `workspaces` 已包含 `packages/ddm-cli`（或通过 `packages/*` 通配符覆盖）
- [ ] 根目录运行 `bun install` 后 `node_modules/@ddm/cli` 可被解析（或 workspace 链接正常）
