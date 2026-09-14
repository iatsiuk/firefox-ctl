import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"

import { buildExtension } from "../build"

const root = join(import.meta.dir, "..")
const dist = join(root, "dist")

type Manifest = {
  manifest_version: number
  name: string
  version: string
  background?: { scripts?: string[] }
  options_ui?: { page?: string }
  content_scripts?: Array<{ js?: string[]; css?: string[] }>
  icons?: Record<string, string>
  web_accessible_resources?: string[]
}

async function readManifest(): Promise<Manifest> {
  return JSON.parse(await Bun.file(join(root, "manifest.json")).text()) as Manifest
}

// every path the browser resolves relative to the extension root when it loads
// the add-on; web-ext lint fails the package when one of them is missing
function referencedFiles(manifest: Manifest): string[] {
  const paths = [
    ...(manifest.background?.scripts ?? []),
    ...(manifest.options_ui?.page === undefined ? [] : [manifest.options_ui.page]),
    ...(manifest.content_scripts ?? []).flatMap((entry) => [
      ...(entry.js ?? []),
      ...(entry.css ?? []),
    ]),
    ...Object.values(manifest.icons ?? {}),
    ...(manifest.web_accessible_resources ?? []),
  ]
  return [...new Set(paths)]
}

describe("packaged extension", () => {
  beforeAll(async () => {
    rmSync(dist, { recursive: true, force: true })
    const result = await buildExtension(dist)
    expect(result.success).toBe(true)
  })

  test("collects every path the manifest references", async () => {
    expect(referencedFiles(await readManifest()).sort()).toEqual([
      "dist/background.js",
      "dist/content.js",
      "icons/firefox-ctl.svg",
      "options.html",
    ])
  })

  test("the preferences page loads a built bundle", async () => {
    const manifest = await readManifest()
    const page = manifest.options_ui?.page as string
    const html = await Bun.file(join(root, page)).text()
    const sources = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((match) => match[1])

    expect(sources).toEqual(["dist/options.js"])
    for (const source of sources) {
      expect(await Bun.file(join(root, source as string)).exists()).toBe(true)
    }
  })

  test("ships every referenced file after a build", async () => {
    const manifest = await readManifest()
    const missing: string[] = []
    for (const path of referencedFiles(manifest)) {
      if (!(await Bun.file(join(root, path)).exists())) {
        missing.push(path)
      }
    }
    expect(missing).toEqual([])
  })

  test("reports a referenced file that the build does not produce", async () => {
    const missing = referencedFiles({
      manifest_version: 2,
      name: "firefox-ctl",
      version: "0.1.0",
      background: { scripts: ["dist/nope.js"] },
    })
    expect(missing).toEqual(["dist/nope.js"])
    expect(await Bun.file(join(root, "dist", "nope.js")).exists()).toBe(false)
  })

  test("passes the web-ext lint basics", async () => {
    const manifest = await readManifest()
    expect(manifest.manifest_version).toBe(2)
    expect(manifest.name.length).toBeGreaterThan(0)
    expect(manifest.version).toMatch(/^\d+(\.\d+)*$/)

    const csp = (manifest as unknown as Record<string, unknown>).content_security_policy as string
    expect(csp).not.toContain("unsafe-eval")
    expect(csp).not.toContain("http:")
    // remote scripts are rejected by the add-on linter
    for (const path of referencedFiles(manifest)) {
      expect(path).not.toMatch(/^(https?:)?\/\//)
    }
  })
})

describe("the xpi make ext-xpi writes", () => {
  let artifact = ""

  beforeAll(async () => {
    const manifest = await readManifest()
    artifact = join(root, "web-ext-artifacts", `firefox-ctl-${manifest.version}.zip`)
    const packed = Bun.spawnSync(["make", "ext-xpi"], { cwd: join(root, "..") })
    expect(packed.exitCode).toBe(0)
  })

  afterAll(() => {
    rmSync(artifact, { force: true })
  })

  test("holds exactly the files the browser loads", () => {
    const listed = Bun.spawnSync(["unzip", "-Z1", artifact])
    expect(listed.exitCode).toBe(0)

    const entries = listed.stdout
      .toString()
      .split("\n")
      .filter((name) => name !== "" && !name.endsWith("/"))
    expect(entries.sort()).toEqual([
      "dist/background.js",
      "dist/content.js",
      "dist/options.js",
      "icons/firefox-ctl.svg",
      "manifest.json",
      "options.html",
    ])
  })
})
