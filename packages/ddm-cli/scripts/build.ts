import { chmod, readFile, writeFile } from "node:fs/promises"

await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "bin",
  naming: "ddm",
  target: "node",
})

const output = "bin/ddm"
const text = await readFile(output, "utf8")
if (!text.startsWith("#!")) {
  await writeFile(output, `#!/usr/bin/env node\n${text}`, "utf8")
}
await chmod(output, 0o755)
