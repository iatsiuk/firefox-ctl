import { describe, expect, test } from "bun:test"

const manifestPath = `${import.meta.dir}/../manifest.json`
const packagePath = `${import.meta.dir}/../package.json`

async function readManifest(): Promise<Record<string, unknown>> {
  const text = await Bun.file(manifestPath).text()
  return JSON.parse(text) as Record<string, unknown>
}

async function readPackage(): Promise<Record<string, unknown>> {
  const text = await Bun.file(packagePath).text()
  return JSON.parse(text) as Record<string, unknown>
}

describe("manifest.json", () => {
  test("is valid MV2 JSON with the project name", async () => {
    const manifest = await readManifest()
    expect(manifest.manifest_version).toBe(2)
    expect(manifest.name).toBe("Terminal Control for Firefox")
  })

  test("carries the same version as package.json", async () => {
    const manifest = await readManifest()
    const pkg = await readPackage()
    expect(manifest.version).toBe(pkg.version)
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
    // child-frame observation is a new capability, so the minor version moves
    expect(manifest.version).toBe("1.0.2")
  })

  test("declares the gecko id and minimum Firefox version from docs/architecture.md", async () => {
    const manifest = await readManifest()
    const settings = manifest.browser_specific_settings as { gecko: Record<string, string> }
    expect(settings.gecko.id).toBe("firefox-ctl@firefox-ctl.dev")
    expect(settings.gecko.strict_min_version).toBe("155.0")
  })

  test("declares every data category that native messaging carries out of the browser", async () => {
    const manifest = await readManifest()
    const settings = manifest.browser_specific_settings as {
      gecko: { data_collection_permissions?: { required: string[]; optional?: string[] } }
    }
    const collection = settings.gecko.data_collection_permissions
    expect(collection).toBeDefined()
    expect([...(collection?.required ?? [])].sort()).toEqual(
      ["authenticationInfo", "browsingActivity", "websiteActivity", "websiteContent"].sort(),
    )
    // "none" cannot sit next to a category, and technicalAndInteraction may only be optional
    expect(collection?.required).not.toContain("none")
    expect(collection?.required).not.toContain("technicalAndInteraction")
    expect(collection?.optional).toBeUndefined()

    const architecture = await Bun.file(`${import.meta.dir}/../../docs/architecture.md`).text()
    expect(architecture).toContain("firefox-ctl@firefox-ctl.dev")
    expect(architecture).toContain("155.0")
  })

  test("requests exactly the permissions the transport needs", async () => {
    const manifest = await readManifest()
    const permissions = manifest.permissions as string[]
    expect([...permissions].sort()).toEqual(
      [
        "<all_urls>",
        "nativeMessaging",
        "storage",
        "tabGroups",
        "tabs",
        "webNavigation",
        "webRequest",
      ].sort(),
    )
  })

  test("points at the built background and content scripts", async () => {
    const manifest = await readManifest()
    const background = manifest.background as { scripts: string[]; persistent: boolean }
    expect(background.scripts).toEqual(["dist/background.js"])
    expect(background.persistent).toBe(true)

    const contentScripts = manifest.content_scripts as Array<{
      matches: string[]
      js: string[]
      run_at: string
      all_frames: boolean
    }>
    expect(contentScripts).toHaveLength(1)
    const [content] = contentScripts
    expect(content?.matches).toEqual(["<all_urls>"])
    expect(content?.js).toEqual(["dist/content.js"])
    expect(content?.run_at).toBe("document_idle")
    expect(content?.all_frames).toBe(false)
  })

  test("sets the strict content security policy", async () => {
    const manifest = await readManifest()
    expect(manifest.content_security_policy).toBe("script-src 'self'; object-src 'self'")
  })

  test("opens the preferences page in the add-ons manager", async () => {
    const manifest = await readManifest()
    expect(manifest.options_ui).toEqual({ page: "options.html", open_in_tab: false })
    expect(await Bun.file(`${import.meta.dir}/../options.html`).exists()).toBe(true)
  })

  test("carries the listing metadata the AMO form reuses", async () => {
    const manifest = await readManifest()
    expect(manifest.homepage_url).toBe("https://github.com/iatsiuk/firefox-ctl")
    expect(manifest.author).toBe("Aleksei Iatsiuk")
  })

  test("points both icon sizes at one packaged svg", async () => {
    const manifest = await readManifest()
    const icons = manifest.icons as Record<string, string>
    expect(Object.keys(icons).sort()).toEqual(["48", "96"])
    expect(icons["48"]).toBe("icons/firefox-ctl.svg")
    expect(icons["96"]).toBe(icons["48"] as string)
    expect(await Bun.file(`${import.meta.dir}/../${icons["48"]}`).exists()).toBe(true)
  })

  test("references entry points that exist in src", async () => {
    for (const entry of ["background", "content", "options"]) {
      expect(await Bun.file(`${import.meta.dir}/../src/${entry}.ts`).exists()).toBe(true)
    }
  })
})

describe("package.json", () => {
  test("carries the author, the license and the repository the listing needs", async () => {
    const pkg = await readPackage()
    expect(pkg.author).toBe("Aleksei Iatsiuk <a.v.iatsiuk@gmail.com>")
    expect(pkg.license).toBe("MIT")
    expect(pkg.homepage).toBe("https://github.com/iatsiuk/firefox-ctl")
    expect(pkg.repository).toEqual({
      type: "git",
      url: "https://github.com/iatsiuk/firefox-ctl.git",
    })
  })
})
