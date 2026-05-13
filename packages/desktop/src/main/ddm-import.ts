import { execFile } from "node:child_process"

export type DdmImportManifest = {
  schemaVersion: string
  packageId: string
  version: string
  name: string
  summary: string
  description: string
  tags: string[]
  quickCommands: Array<{ id: string; label: string; prompt: string }>
  agents: string[]
  dependencies?: {
    skills?: Array<{ name: string; required?: boolean }>
    mcp?: Array<{ name: string; required?: boolean }>
    docker?: Array<{ service: string; required?: boolean }>
    apps?: Array<{ name: string; required?: boolean }>
    envVars?: Array<{ key: string; required?: boolean }>
  }
  changeSummary: string
}

export function isDdmImportDeepLink(input: string) {
  const url = parseDdmImportDeepLink(input)
  return Boolean(url)
}

export function parseDdmImportDeepLink(input: string) {
  if (!input.startsWith("ddm://")) return
  try {
    const url = new URL(input)
    if (url.hostname !== "import" && url.hostname !== "import-agent") return
    const packageUrl = url.searchParams.get("pkg") ?? url.searchParams.get("url")
    if (!packageUrl) return
    return input
  } catch {
    return
  }
}

export function previewDdmImport(input: string, ddmBin = process.env.DDM_CLI_PATH ?? "ddm") {
  return new Promise<DdmImportManifest>((resolve, reject) => {
    execFile(ddmBin, ["preview", input], { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message))
        return
      }

      try {
        resolve(JSON.parse(stdout) as DdmImportManifest)
      } catch (parseError) {
        reject(parseError)
      }
    })
  })
}

export function runDdmImport(input: string, ddmBin = process.env.DDM_CLI_PATH ?? "ddm") {
  return new Promise<void>((resolve, reject) => {
    execFile(ddmBin, ["import", input, "--yes"], (error, _stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(),
    )
  })
}
