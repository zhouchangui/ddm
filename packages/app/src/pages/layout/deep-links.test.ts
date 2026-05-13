import { describe, expect, test } from "bun:test"
import { parseAgentImportDeepLink, parseDeepLink, parseNewSessionDeepLink } from "./deep-links"

describe("agent import deep links", () => {
  test("parses homepage market import-agent links", () => {
    expect(
      parseAgentImportDeepLink(
        "ddm://import-agent?url=https%3A%2F%2Fexample.test%2Ffunctions%2Fv1%2Fdownload-agent-release%3FreleaseId%3Dr1%26source%3Dmarket&name=%E5%8F%91%E5%B8%83%E5%8A%A9%E6%89%8B&source=homepage-market",
      ),
    ).toEqual({
      packageUrl: "https://example.test/functions/v1/download-agent-release?releaseId=r1&source=market",
      name: "发布助手",
      source: "homepage-market",
    })
  })

  test("parses cli import links", () => {
    expect(parseAgentImportDeepLink("ddm://import?pkg=https%3A%2F%2Fexample.test%2Fagent.zip")).toEqual({
      packageUrl: "https://example.test/agent.zip",
      name: undefined,
      source: undefined,
    })
  })
})

// Regression: ISSUE-001 — ddm:// URLs incorrectly parsed as opencode:// deep links
// Found by /qa on 2026-05-13
// Report: .gstack/qa-reports/qa-report-ddm-import-2026-05-13.md
describe("scheme isolation: ddm:// must not trigger opencode:// actions", () => {
  test("ddm://open-project does NOT open a project directory", () => {
    expect(parseDeepLink("ddm://open-project?directory=/etc/passwd")).toBeUndefined()
    expect(parseDeepLink("ddm://open-project?directory=/tmp/malicious")).toBeUndefined()
  })

  test("ddm://new-session does NOT create a new session", () => {
    expect(parseNewSessionDeepLink("ddm://new-session?directory=/tmp&prompt=hello")).toBeUndefined()
  })

  test("opencode:// links still work normally", () => {
    expect(parseDeepLink("opencode://open-project?directory=/tmp/demo")).toBe("/tmp/demo")
    expect(parseNewSessionDeepLink("opencode://new-session?directory=/tmp&prompt=hello")).toEqual({
      directory: "/tmp",
      prompt: "hello",
    })
  })
})
