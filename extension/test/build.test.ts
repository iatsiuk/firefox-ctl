import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildExtension } from "../build"

const outdir = mkdtempSync(join(tmpdir(), "firefox-ctl-build-"))

afterAll(() => {
  rmSync(outdir, { recursive: true, force: true })
})

describe("buildExtension", () => {
  test("emits classic IIFE scripts for every entry point", async () => {
    const result = await buildExtension(outdir)
    expect(result.success).toBe(true)

    for (const name of ["background.js", "content.js", "options.js"]) {
      const file = Bun.file(join(outdir, name))
      expect(await file.exists()).toBe(true)

      const code = (await file.text()).trim()
      expect(code).not.toMatch(/^\s*import\s/m)
      expect(code).not.toMatch(/^\s*export\s/m)
      // classic script: the whole bundle is a function expression called at top level
      expect(code).toMatch(/^\(\s*(?:function|\(\s*\)\s*=>)/)
      expect(code).toMatch(/\)\s*\(\s*\)\s*;?$/)
    }
  })
})

describe("bun run build", () => {
  test("writes every bundle into the gitignored dist directory", async () => {
    const dist = join(import.meta.dir, "..", "dist")
    rmSync(dist, { recursive: true, force: true })

    const build = Bun.spawnSync(["bun", "run", "build"], {
      cwd: join(import.meta.dir, ".."),
    })
    expect(build.exitCode).toBe(0)

    for (const name of ["background.js", "content.js", "options.js"]) {
      expect(await Bun.file(join(dist, name)).exists()).toBe(true)
    }

    // dist is a build artefact: git must never see it
    const ignored = Bun.spawnSync(["git", "check-ignore", "--quiet", join(dist, "background.js")], {
      cwd: join(import.meta.dir, ".."),
    })
    expect(ignored.exitCode).toBe(0)
  })
})
