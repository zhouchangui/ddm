export const deepLinkEvent = "opencode:deep-link"

const parseUrl = (input: string) => {
  if (!input.startsWith("opencode://") && !input.startsWith("ddm://")) return
  if (typeof URL.canParse === "function" && !URL.canParse(input)) return
  try {
    return new URL(input)
  } catch {
    return
  }
}

const parseDdmUrl = (input: string) => {
  if (!input.startsWith("ddm://")) return
  if (typeof URL.canParse === "function" && !URL.canParse(input)) return
  try {
    return new URL(input)
  } catch {
    return
  }
}

export const parseDeepLink = (input: string) => {
  const url = parseUrl(input)
  if (url?.protocol !== "opencode:") return
  if (url.hostname !== "open-project") return
  const directory = url.searchParams.get("directory")
  if (!directory) return
  return directory
}

export const parseNewSessionDeepLink = (input: string) => {
  const url = parseUrl(input)
  if (url?.protocol !== "opencode:") return
  if (url.hostname !== "new-session") return
  const directory = url.searchParams.get("directory")
  if (!directory) return
  const prompt = url.searchParams.get("prompt") || undefined
  if (!prompt) return { directory }
  return { directory, prompt }
}

export const collectOpenProjectDeepLinks = (urls: string[]) =>
  urls.map(parseDeepLink).filter((directory): directory is string => !!directory)

export const collectNewSessionDeepLinks = (urls: string[]) =>
  urls.map(parseNewSessionDeepLink).filter((link): link is { directory: string; prompt?: string } => !!link)

export const parseAgentImportDeepLink = (input: string) => {
  const url = parseDdmUrl(input)
  if (!url) return
  if (url.hostname !== "import" && url.hostname !== "import-agent") return
  const packageUrl = url.searchParams.get("pkg") ?? url.searchParams.get("url")
  if (!packageUrl) return
  return {
    packageUrl,
    name: url.searchParams.get("name") || undefined,
    source: url.searchParams.get("source") || undefined,
  }
}

export const parseImportAgentDeepLink = (input: string) => {
  const link = parseAgentImportDeepLink(input)
  if (!link) return
  return { pkgUrl: link.packageUrl }
}

export const collectImportAgentDeepLinks = (urls: string[]) =>
  urls.map(parseImportAgentDeepLink).filter((link): link is { pkgUrl: string } => !!link)

type OpenCodeWindow = Window & {
  __OPENCODE__?: {
    deepLinks?: string[]
  }
}

export const drainPendingDeepLinks = (target: OpenCodeWindow) => {
  const pending = target.__OPENCODE__?.deepLinks ?? []
  if (pending.length === 0) return []
  if (target.__OPENCODE__) target.__OPENCODE__.deepLinks = []
  return pending
}
