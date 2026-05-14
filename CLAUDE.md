# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Fork & Rebrand Context

This project is forked from OpenCode and rebranded as **DDM**. Upstream OpenCode changes will continue to be merged. When adding DDM-specific features:
- Prefer new modules, wrappers, adapters, and isolated integration points over editing upstream files
- Keep patches to upstream files small, scoped, and easy to reapply
- Avoid broad refactors, formatting churn, or renames in upstream code

Default branch is `dev`. Local `main` may not exist; use `dev` or `origin/dev` for diffs.

## Commands

```bash
# Install dependencies (repo root)
bun install

# Run OpenCode in dev mode (runs in packages/opencode directory)
bun dev

# Run against a specific directory
bun dev <directory>

# Run against repo root itself
bun dev .

# Build standalone executable
./packages/opencode/script/build.ts --single
# Output: ./packages/opencode/dist/opencode-<platform>/bin/opencode

# Lint (repo root)
bun run lint          # runs oxlint

# Type check (run from package dir, e.g. packages/opencode)
bun typecheck         # uses tsgo --noEmit, NOT tsc directly

# Tests — MUST run from package directory, not repo root
cd packages/opencode && bun test --timeout 30000
cd packages/opencode && bun test --timeout 30000 <test-file>

# Rebuild JS SDK
./packages/sdk/js/script/build.ts

# Database migrations
cd packages/opencode && bun run db
```

## Architecture

This is a **Bun monorepo** managed with Turborepo. Key packages:

| Package | Purpose |
|---|---|
| `packages/opencode` | Core business logic, HTTP server, agent/session/tool engine |
| `packages/opencode/src/cli/cmd/tui/` | TUI frontend written in SolidJS + [opentui](https://github.com/sst/opentui) |
| `packages/app` | Shared web UI components (SolidJS) |
| `packages/desktop` | Electron desktop app wrapping `packages/app` |
| `packages/plugin` | Source for `@opencode-ai/plugin` |
| `packages/sdk/js` | JavaScript SDK |

### `packages/opencode/src` modules

- `agent/` — Agent definitions (build, plan, general subagent); Tab-switchable
- `session/` — Conversation/session lifecycle
- `tool/` — LLM tools (file edit, bash, etc.)
- `server/` — HTTP API server; platform-conditional via `#httpapi-server` import
- `config/` — Configuration; modules self-export via `export * as ConfigX from "./x"` pattern
- `provider/` — LLM provider integrations (Anthropic, OpenAI, Google, local)
- `mcp/` — MCP protocol support
- `lsp/` — LSP integration
- `storage/` — SQLite via Drizzle ORM; platform-conditional via `#db` import
- `pty/` — Pseudo-terminal; platform-conditional via `#pty` import
- `bus/` — Internal event bus
- `permission/` — Tool permission system
- `skill/` — Built-in skills

### Client/Server Architecture

OpenCode runs as a local server with multiple possible frontends (TUI, web, mobile). The TUI is just one client. This enables remote control scenarios.

### Platform-Conditional Imports

Uses package.json `imports` field for Bun vs Node conditionals:
- `#db` → `db.bun.ts` or `db.node.ts`
- `#pty` → `pty.bun.ts` or `pty.node.ts`
- `#httpapi-server` → `httpapi-server.node.ts`

## Style Guide

- **No destructuring** unless value is reused; use dot notation to preserve context
- **No `else`** — prefer early returns
- **No `try/catch`** where avoidable; prefer `.catch()`
- **No `any`** types
- **Inline single-use variables** — don't extract unless reused or hides genuine complexity
- **`const` over `let`**; use ternaries instead of reassignment
- **Functional array methods** (`flatMap`, `filter`, `map`) over `for` loops
- **Bun APIs** preferred: `Bun.file()`, etc.
- **Drizzle schema**: snake_case field names (column names don't need string overrides)
- **`config/` modules**: follow self-export pattern at top of file

## Testing Notes

- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`)
- Run from package dirs: `cd packages/opencode && bun test`
- Avoid mocks; test actual implementation
