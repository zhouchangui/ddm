import { describe, expect, test } from "bun:test"
import { parseAgentImportDeepLink } from "./deep-links"

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
