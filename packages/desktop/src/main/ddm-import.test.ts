import { describe, expect, test } from "bun:test"
import { isDdmImportDeepLink, parseDdmImportDeepLink } from "./ddm-import"

describe("ddm import deep links", () => {
  test("accepts homepage market import-agent links", () => {
    const input =
      "ddm://import-agent?url=https%3A%2F%2Fexample.test%2Ffunctions%2Fv1%2Fdownload-agent-release%3FreleaseId%3Dr1%26source%3Dmarket&name=test"

    expect(parseDdmImportDeepLink(input)).toBe(input)
    expect(isDdmImportDeepLink(input)).toBe(true)
  })

  test("accepts cli import links", () => {
    expect(isDdmImportDeepLink("ddm://import?pkg=https%3A%2F%2Fexample.test%2Fagent.zip")).toBe(true)
  })

  test("rejects missing package url and unrelated schemes", () => {
    expect(parseDdmImportDeepLink("ddm://import-agent?name=test")).toBeUndefined()
    expect(parseDdmImportDeepLink("opencode://open-project?directory=/tmp/demo")).toBeUndefined()
  })
})
