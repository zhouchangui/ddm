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
- [ ] `agents: []` 空数组 → 返回错误
- [ ] `parseManifest` 传入非 JSON 字符串 → 抛出 `ManifestValidationError`

---

## V4 - ddm pack 干跑验证

用一个最小 agent 目录测试打包流程。

- [ ] 创建临时目录 `/tmp/test-agent/agent/hello.md`（带合法 frontmatter）
- [ ] 运行 `ddm pack /tmp/test-agent`（无 manifest.json）→ 应自动生成 `manifest.json` 草稿并退出（不打包）
- [ ] 补充 manifest.json 必填字段后再次运行 → 应输出 `hello-0.1.0.zip`
- [ ] 解压 zip，确认包含 `manifest.json` 和 `agent/hello.md`，不含其他文件
- [ ] `manifest.json` 内 `agents` 字段与实际文件路径一致

---

## V5 - ddm unpack 干跑验证

用 V4 生成的 zip 测试还原流程。

- [ ] 运行 `ddm unpack /tmp/hello-0.1.0.zip --target /tmp/unpack-test --yes`
- [ ] 确认 `/tmp/unpack-test/.opencode/agent/hello.md` 已创建
- [ ] 如果 manifest 有 `dependencies.mcp`：确认 `/tmp/unpack-test/.opencode/opencode.jsonc` 中 mcp 块已合并
- [ ] 如果 manifest 有 `dependencies.envVars`：确认 `.opencode/.env` 已追加对应 key

---

## V6 - manifest schema 完整样例验证

验证文档中给出的完整样例（含 skills / docker / mcp / envVars）能通过 schema 验证。

- [ ] 把完整样例 JSON（含 docker / skills / mcp / envVars 字段）喂给 `parseManifest` → 无报错
- [ ] `dependencies.skills[].installCommand` 字段存在且为字符串
- [ ] `dependencies.docker[].startCommand` 字段存在且为字符串

---

## V7 - SKILL.md 内容审查

人工检查两个重写后的 SKILL.md，确认无龙虾架构残留。

- [ ] `ddm-agent-create/SKILL.md`：不含 `SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`HEARTBEAT.md`、`USER.md`、`openclaw` 等词
- [ ] `ddm-agent-create/SKILL.md`：输出路径引用 `agent/<name>.md` 格式
- [ ] `ddm-agent-publish/SKILL.md`：不含上述旧架构词
- [ ] `ddm-agent-publish/SKILL.md`：skills 依赖用 `installCommand` 格式，不用 `repo`/`ref` 格式
- [ ] `ddm-agent-publish/SKILL.md`：发布流程引用 `ddm pack` 命令

---

## V8 - monorepo 注册

确认新包已纳入 workspace。

- [ ] 根目录 `package.json` 的 `workspaces` 已包含 `packages/ddm-cli`（或通过 `packages/*` 通配符覆盖）
- [ ] 根目录运行 `bun install` 后 `node_modules/@ddm/cli` 可被解析（或 workspace 链接正常）
