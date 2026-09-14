import { describe, expect, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

// walks up from the extension directory to the repository root, the first
// directory holding cli/go.mod
function repoRoot(): string | undefined {
  let dir = resolve(import.meta.dir, "..")
  for (;;) {
    if (existsSync(join(dir, "cli", "go.mod"))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return undefined
    }
    dir = parent
  }
}

const root = repoRoot()

describe("repository tooling", () => {
  test("root Makefile delegates the extension targets to bun", async () => {
    if (root === undefined) {
      console.log("skipping: repository root not found")
      return
    }
    const makefile = await Bun.file(join(root, "Makefile")).text()
    for (const target of ["ext-build", "ext-test", "ext-check"]) {
      expect(makefile).toContain(`${target}:`)
    }
    expect(makefile).toMatch(/bun (run )?build/)
    expect(makefile).toMatch(/bun test/)
    expect(makefile).toMatch(/bun run check/)
  })

  test("CI runs check, test and build for the extension", async () => {
    if (root === undefined) {
      console.log("skipping: repository root not found")
      return
    }
    const ci = await Bun.file(join(root, ".github", "workflows", "ci.yaml")).text()
    expect(ci).toContain("extension:")
    expect(ci).toContain("oven-sh/setup-bun")
    expect(ci).toContain("bun install --frozen-lockfile")
    expect(ci).toContain("bun run check")
    expect(ci).toContain("bun test")
    expect(ci).toContain("bun run build")
  })
})

const extensionDir = resolve(import.meta.dir, "..")

function biomeCheck(file: string): { code: number; output: string } {
  const result = Bun.spawnSync(["bunx", "biome", "check", file], { cwd: extensionDir })
  return {
    code: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  }
}

// the probe files only exist while the test runs; biome resolves the override
// from the path, so the same source is legal outside src/content
async function withProbe(file: string, source: string, run: () => void): Promise<void> {
  const path = join(extensionDir, file)
  await Bun.write(path, source)
  try {
    run()
  } finally {
    rmSync(path, { force: true })
  }
}

const rawGlobal = "export function title(): string {\n  return document.title\n}\n"

describe("content script globals", () => {
  test("biome rejects a raw global inside src/content", async () => {
    await withProbe("src/content/probe.tmp.ts", rawGlobal, () => {
      const { code, output } = biomeCheck("src/content/probe.tmp.ts")
      expect(code).not.toBe(0)
      expect(output).toContain("noRestrictedGlobals")
      expect(output).toContain("use page.document")
    })
  })

  test("biome allows the same source outside src/content", async () => {
    await withProbe("src/probe.tmp.ts", rawGlobal, () => {
      expect(biomeCheck("src/probe.tmp.ts").code).toBe(0)
    })
  })

  test("the Page binding is the one file allowed to read globals", () => {
    expect(biomeCheck("src/content/page.ts").code).toBe(0)
  })

  test("every restricted global has a Page replacement", async () => {
    const config = await Bun.file(join(extensionDir, "biome.json")).json()
    const override = config.overrides?.[0]
    expect(override?.includes).toEqual(["src/content/**", "!src/content/page.ts"])
    const denied = override?.linter?.rules?.style?.noRestrictedGlobals?.options?.deniedGlobals
    for (const name of [
      "document",
      "window",
      "CSS",
      "InputEvent",
      "KeyboardEvent",
      "Event",
      "requestAnimationFrame",
      "setTimeout",
    ]) {
      expect(Object.keys(denied ?? {})).toContain(name)
    }
  })
})
