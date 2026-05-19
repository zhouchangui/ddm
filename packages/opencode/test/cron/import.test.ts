import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { cmdUnpack } from "../../../ddm-cli/src/cmd/pack"
import { parseManifest } from "../../../ddm-cli/src/schema"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"

const cronRegistryPath = path.join(process.env.XDG_CONFIG_HOME!, "ddm", "cron", "registry.json")

test("manifest schedules remain validated metadata and unpack does not create cron registry state", async () => {
  if (process.platform === "win32") return

  const manifest = {
    schemaVersion: "1",
    packageId: "ddm.cron-test",
    agentId: "cron-test",
    version: "1.0.0",
    name: "Cron Test",
    summary: "用于验证导入时的 schedule 行为",
    description: "导入应继续校验 schedules，但不能创建任何本地 cron registry 任务。",
    tags: ["cron"],
    media: {
      avatar: { path: "media/avatar.png", alt: "avatar" },
      cover: { path: "media/cover.png", alt: "cover" },
      gallery: [{ path: "media/gallery.png", alt: "gallery", kind: "image" }],
      theme: { accent: "#111111", background: "#ffffff" },
    },
    quickCommands: [{ id: "start", label: "开始", prompt: "开始执行" }],
    opencode: {
      agent: "cron-test.md",
      skills: [],
    },
    dependencies: {},
    schedules: [
      {
        id: "daily",
        label: "Daily",
        prompt: "run daily",
        timezone: "UTC",
        cron: "0 9 * * *",
        enabledDefault: true,
      },
    ],
    changeSummary: "initial",
  }

  expect(parseManifest(JSON.stringify(manifest)).schedules).toHaveLength(1)
  await fs.rm(cronRegistryPath, { force: true }).catch(() => undefined)

  await using source = await tmpdir()
  await using archive = await tmpdir()
  await using target = await tmpdir()
  const zipPath = path.join(archive.path, "cron-test.zip")
  await Filesystem.write(path.join(source.path, "manifest.json"), JSON.stringify(manifest, null, 2))
  await Filesystem.write(path.join(source.path, "cron-test.md"), "# cron test")
  await Filesystem.write(path.join(source.path, "media", "avatar.png"), "")
  await Filesystem.write(path.join(source.path, "media", "cover.png"), "")
  await Filesystem.write(path.join(source.path, "media", "gallery.png"), "")
  await Process.run(["zip", "-r", zipPath, "."], { cwd: source.path })

  await cmdUnpack({
    zipPath,
    target: target.path,
    yes: true,
    skipDeps: true,
  })

  expect(await Bun.file(path.join(target.path, ".opencode", "agent", "cron-test.md")).text()).toContain("# cron test")
  expect(await Filesystem.exists(cronRegistryPath)).toBe(false)
})
