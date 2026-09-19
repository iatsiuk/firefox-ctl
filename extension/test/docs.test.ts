import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
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

async function readRootDoc(name: string): Promise<string> {
  if (root === undefined) {
    return ""
  }
  return Bun.file(join(root, name)).text()
}

describe("extension README", () => {
  const readme = Bun.file(join(import.meta.dir, "..", "README.md"))

  test("exists", async () => {
    expect(await readme.exists()).toBe(true)
  })

  test("documents the bun workflow", async () => {
    const text = await readme.text()
    for (const command of ["bun install", "bun run build", "bun test", "bun run check"]) {
      expect(text).toContain(command)
    }
  })

  test("documents loading the add-on and the first end-to-end command", async () => {
    const text = await readme.text()
    expect(text).toContain("about:debugging")
    expect(text).toContain("addons.mozilla.org")
    expect(text).toContain("firefox-ctl install")
    expect(text).toContain("firefox-ctl ping")
  })

  test("names the extension id and the native host", async () => {
    const text = await readme.text()
    expect(text).toContain("firefox-ctl@firefox-ctl.dev")
    expect(text).toContain("manifest.json")
  })
})

describe("repository documentation", () => {
  test.skipIf(root === undefined)("CLAUDE.md lists the root extension make targets", async () => {
    const text = await readRootDoc("CLAUDE.md")
    for (const target of ["make ext-build", "make ext-test", "make ext-check"]) {
      expect(text).toContain(target)
    }
  })

  test.skipIf(root === undefined)(
    "architecture describes the reconnect policy and the dispatcher contract",
    async () => {
      const text = await readRootDoc(join("docs", "architecture.md"))
      expect(text).toContain("UNKNOWN_COMMAND")
      // reconnect numbers the port module actually implements
      expect(text).toContain("10 attempts")
      expect(text).toContain("30000")
    },
  )
})

describe("licensing", () => {
  test.skipIf(root === undefined)("the repository carries the MIT license text", async () => {
    const text = await readRootDoc("LICENSE")
    expect(text).toContain("MIT License")
    expect(text).toContain("Copyright (c) 2026 Aleksei Iatsiuk")
    expect(text).toContain("WITHOUT WARRANTY OF ANY KIND")
  })

  test.skipIf(root === undefined)("the root README links to the license", async () => {
    const text = await readRootDoc("README.md")
    expect(text).toContain("## License")
    expect(text).toContain("[LICENSE](LICENSE)")
    expect(text).toContain("MIT")
  })

  test("the extension README states the license in one line", async () => {
    const text = await Bun.file(join(import.meta.dir, "..", "README.md")).text()
    expect(text).toContain("MIT")
    expect(text).toContain("../LICENSE")
  })
})

describe("native host installation", () => {
  const linuxPath = "~/.mozilla/native-messaging-hosts/firefoxctl.json"
  const macPath = "~/Library/Application Support/Mozilla/NativeMessagingHosts/firefoxctl.json"

  test.skipIf(root === undefined)("the root README lists both manifest paths", async () => {
    const text = await readRootDoc("README.md")
    expect(text).toContain(macPath)
    expect(text).toContain(linuxPath)
  })

  test.skipIf(root === undefined)("architecture.md lists both manifest paths", async () => {
    const text = await readRootDoc(join("docs", "architecture.md"))
    expect(text).toContain(macPath)
    expect(text).toContain(linuxPath)
  })

  test.skipIf(root === undefined)(
    "the CLI README lists both manifest paths and the --dir fallback",
    async () => {
      const text = await readRootDoc(join("cli", "README.md"))
      expect(text).toContain(macPath)
      expect(text).toContain(linuxPath)
      expect(text).toContain("--dir")
    },
  )

  test("the extension README lists both manifest paths", async () => {
    const text = await Bun.file(join(import.meta.dir, "..", "README.md")).text()
    expect(text).toContain(macPath)
    expect(text).toContain(linuxPath)
  })
})

describe("screenshot and DevTools documentation", () => {
  test.skipIf(root === undefined)("commands.md lists the purpose presets", async () => {
    const text = await readRootDoc(join("docs", "commands.md"))
    for (const purpose of ["quick-glance", "read-text", "inspect-ui", "full-detail"]) {
      expect(text).toContain(purpose)
    }
  })

  test.skipIf(root === undefined)(
    "commands.md documents the frame limit and the downgrade ladder",
    async () => {
      const text = await readRootDoc(join("docs", "commands.md"))
      for (const phrase of ["10 MiB", "SCREENSHOT_TOO_LARGE", "reduced {from, to, steps}"]) {
        expect(text).toContain(phrase)
      }
    },
  )

  test.skipIf(root === undefined)("commands.md states the console capture scope", async () => {
    const text = await readRootDoc(join("docs", "commands.md"))
    for (const phrase of ['scope: "content-world"', "unhandled rejections", "ring of 500"]) {
      expect(text).toContain(phrase)
    }
  })

  test.skipIf(root === undefined)("commands.md documents the network buffer", async () => {
    const text = await readRootDoc(join("docs", "commands.md"))
    for (const phrase of ["200 entries", "[REDACTED]", "credential", "Set-Cookie"]) {
      expect(text).toContain(phrase)
    }
  })

  test.skipIf(root === undefined)(
    "commands.md states that headers are redacted by default and how to opt out",
    async () => {
      const text = await readRootDoc(join("docs", "commands.md"))
      for (const phrase of [
        "`[redacted]`",
        "That is the default",
        "untick",
        "add-on preferences",
        "`www-authenticate`",
      ]) {
        expect(text).toContain(phrase)
      }
    },
  )

  test.skipIf(root === undefined)(
    "architecture.md states that private-session state is never persisted",
    async () => {
      const text = await readRootDoc(join("docs", "architecture.md"))
      for (const phrase of ["never reaches `storage.local`", "only persistence is skipped"]) {
        expect(text).toContain(phrase)
      }
    },
  )

  test.skipIf(root === undefined)(
    "commands.md states the private exception for the session and attachments",
    async () => {
      const text = await readRootDoc(join("docs", "commands.md"))
      for (const phrase of [
        "A private window and an attached private tab are the exception",
        "do not survive a restart",
      ]) {
        expect(text).toContain(phrase)
      }
    },
  )

  test.skipIf(root === undefined)(
    "commands.md states the evaluate opt-in, its default and its error",
    async () => {
      const text = await readRootDoc(join("docs", "commands.md"))
      for (const phrase of [
        "EVALUATE_DISABLED",
        "off until the user ticks",
        '"Allow the `evaluate` command"',
        "no message reaches the tab",
      ]) {
        expect(text).toContain(phrase)
      }
    },
  )

  test.skipIf(root === undefined)(
    "architecture.md and the root README state that evaluate is off by default",
    async () => {
      const architecture = await readRootDoc(join("docs", "architecture.md"))
      expect(architecture).toContain("EVALUATE_DISABLED")
      expect(architecture).toContain("src/options.ts")

      const readme = await readRootDoc("README.md")
      expect(readme).toContain("EVALUATE_DISABLED")
      expect(readme).toContain("off by default")
    },
  )

  test.skipIf(root === undefined)(
    "architecture.md declares the data categories and the destination of the data",
    async () => {
      const text = await readRootDoc(join("docs", "architecture.md"))
      for (const phrase of [
        "## Data leaving the browser",
        "`browsingActivity`",
        "`websiteContent`",
        "`websiteActivity`",
        "`authenticationInfo`",
        "`technicalAndInteraction`",
        "the local native host over stdio",
      ]) {
        expect(text).toContain(phrase)
      }
    },
  )

  test.skipIf(root === undefined)(
    "commands.md states that version carries no user agent",
    async () => {
      const text = await readRootDoc(join("docs", "commands.md"))
      expect(text).toContain("no user agent")
    },
  )

  test("extension README states how to enable evaluate", async () => {
    const text = await Bun.file(join(import.meta.dir, "..", "README.md")).text()
    expect(text).toContain('"Allow the `evaluate` command"')
    expect(text).toContain("EVALUATE_DISABLED")
  })

  test("extension README states that private state is not restored", async () => {
    const text = await Bun.file(join(import.meta.dir, "..", "README.md")).text()
    expect(text).toContain("A private session is never written there")
  })

  test("extension README states the header redaction default and the opt-out", async () => {
    const text = await Bun.file(join(import.meta.dir, "..", "README.md")).text()
    expect(text).toContain("`[redacted]` by default")
    expect(text).toContain("add-on preferences returns them raw")
  })

  test.skipIf(root === undefined)("commands.md names the four consent passes", async () => {
    const text = await readRootDoc(join("docs", "commands.md"))
    for (const method of ["cmp-selector", "text-match", "shadow-dom", "aria-dialog"]) {
      expect(text).toContain(method)
    }
  })

  test.skipIf(root === undefined)("commands.md explains the waitFor load wait", async () => {
    const text = await readRootDoc(join("docs", "commands.md"))
    expect(text).toContain("status: complete")
    expect(text).toContain("`text` first, then `url`, then `selector`")
  })

  test.skipIf(root === undefined)(
    "architecture.md describes the tracker, the readiness pipeline and the annotation host",
    async () => {
      const text = await readRootDoc(join("docs", "architecture.md"))
      for (const phrase of [
        "webRequest",
        "waitForPageReady",
        "captureTab",
        "__firefox_ctl_annotations__",
        "render_check_failed",
      ]) {
        expect(text).toContain(phrase)
      }
    },
  )

  test.skipIf(root === undefined)("roadmap.md marks all five plans delivered", async () => {
    const text = await readRootDoc(join("docs", "roadmap.md"))
    for (const heading of [
      "## Plan 1: Go binary (delivered)",
      "## Plan 2: Extension skeleton (delivered)",
      "## Plan 3: Sessions and windows (delivered)",
      "## Plan 4: DOM actions (delivered)",
      "## Plan 5: Screenshots, DevTools, consent (delivered)",
    ]) {
      expect(text).toContain(heading)
    }
    expect(text).toContain("not tracked in git")
  })

  test("extension README walks through screenshots and DevTools", async () => {
    const text = await Bun.file(join(import.meta.dir, "..", "README.md")).text()
    for (const step of [
      "firefox-ctl screenshot --purpose read-text",
      "firefox-ctl getConsoleLogs",
      "firefox-ctl getNetworkRequests",
      "firefox-ctl handleConsent",
    ]) {
      expect(text).toContain(step)
    }
    expect(text).toContain("src/network.ts")
    expect(text).toContain("src/readiness.ts")
  })
})

describe("selector documentation", () => {
  test.skipIf(root === undefined)(
    "commands.md states the selector guarantee for page state, misses and labels",
    async () => {
      const text = await readRootDoc(join("docs", "commands.md"))
      for (const phrase of [
        "unique in the current DOM at the time of the call",
        "not stable across re-renders",
        "`selector`",
        "`null` when no verified selector exists",
        "Suggested alternatives:",
        "CSS-escaped",
      ]) {
        expect(text).toContain(phrase)
      }
      expect(text).not.toContain("without suggestions")
    },
  )

  test.skipIf(root === undefined)(
    "architecture.md lists the shared selector generator",
    async () => {
      const text = await readRootDoc(join("docs", "architecture.md"))
      expect(text).toContain("unique-selector.ts")
    },
  )
})

describe("text targeting documentation", () => {
  test.skipIf(root === undefined)(
    "commands.md states the text contract, its limit and its errors",
    async () => {
      const text = await readRootDoc(join("docs", "commands.md"))
      for (const phrase of [
        "mutually exclusive",
        "matchedBy",
        "Scope not found",
        'text "',
        "500 characters",
        "AMBIGUOUS_TEXT",
      ]) {
        expect(text).toContain(phrase)
      }
    },
  )

  test.skipIf(root === undefined)(
    "commands.md keeps the text meaning of type and waitFor",
    async () => {
      const text = await readRootDoc(join("docs", "commands.md"))
      expect(text).toContain("`type --text` is the text to type")
      expect(text).toContain("`waitFor --text` is an unnormalised substring")
    },
  )

  test.skipIf(root === undefined)("architecture.md lists the text resolver", async () => {
    const text = await readRootDoc(join("docs", "architecture.md"))
    expect(text).toContain("text-target.ts")
  })
})

describe("session documentation", () => {
  test.skipIf(root === undefined)(
    "commands.md describes the session model without agent ids",
    async () => {
      const text = await readRootDoc(join("docs", "commands.md"))
      for (const phrase of [
        "12 tabs",
        "closedOldestTab",
        "privateFallback",
        "MODE_MISMATCH",
        "adopt",
        "ownerId",
        "POOL_FULL",
      ]) {
        expect(text).toContain(phrase)
      }
    },
  )

  test.skipIf(root === undefined)("commands.md states the explicit tabId policy", async () => {
    const text = await readRootDoc(join("docs", "commands.md"))
    expect(text).toContain("no session is required")
    expect(text).toContain("TAB_CLOSED")
    expect(text).toContain("Tab session lost")
  })

  test.skipIf(root === undefined)("commands.md documents the close result shapes", async () => {
    const text = await readRootDoc(join("docs", "commands.md"))
    expect(text).toContain("tabsClosed")
    expect(text).toContain("attached: true")
    expect(text).toContain("adopted: true")
  })

  test.skipIf(root === undefined)(
    "architecture.md documents the storage keys and adopt-and-sweep",
    async () => {
      const text = await readRootDoc(join("docs", "architecture.md"))
      expect(text).toContain("firefoxCtlWindowState")
      expect(text).toContain("firefoxCtlAttachedTabs")
      expect(text).toContain("sweepDuplicateWindows")
      expect(text).toContain("tabGroups")
    },
  )

  test("extension README walks through a session", async () => {
    const text = await Bun.file(join(import.meta.dir, "..", "README.md")).text()
    for (const step of [
      "firefox-ctl createWindow",
      "firefox-ctl getTabs",
      "firefox-ctl navigate",
      "firefox-ctl attachTab",
      "firefox-ctl closeWindow",
    ]) {
      expect(text).toContain(step)
    }
    expect(text).toContain("src/session.ts")
    expect(text).toContain("src/attached.ts")
  })
})

describe("source archive and reviewer material", () => {
  const build = Bun.file(join(import.meta.dir, "..", "BUILD.md"))

  test("BUILD.md pins the bun version, the frozen install and the three bundles", async () => {
    expect(await build.exists()).toBe(true)
    const text = await build.text()
    expect(text).toContain("bun 1.4.2")
    expect(text).toContain("bun install --frozen-lockfile")
    expect(text).toContain("bun run build")
    for (const bundle of ["dist/background.js", "dist/content.js", "dist/options.js"]) {
      expect(text).toContain(bundle)
    }
  })

  test("BUILD.md stands alone: no link leaves the extension directory", async () => {
    const text = await build.text()
    expect(text).not.toMatch(/]\(\.\.\//)
  })

  test("the extension README pins the same bun version and the frozen install", async () => {
    const text = await Bun.file(join(import.meta.dir, "..", "README.md")).text()
    expect(text).toContain("bun 1.4.2")
    expect(text).toContain("bun install --frozen-lockfile")
    expect(text).toContain("BUILD.md")
  })

  test.skipIf(root === undefined)(
    "the root Makefile packs the source archive and reproduces the bundles",
    async () => {
      const text = await readRootDoc("Makefile")
      expect(text).toContain("ext-source:")
      expect(text).toContain("ext-reproduce:")
      expect(text).toContain("--frozen-lockfile")
      // the archive must not carry build output or the AMO upload id
      for (const excluded of ["node_modules", "dist", "web-ext-artifacts", ".amo-upload-uuid"]) {
        expect(text).toContain(excluded)
      }
    },
  )

  test.skipIf(root === undefined)("reviewer notes cover the AMO form fields", async () => {
    const text = await readRootDoc(join("docs", "reviewer-notes.md"))
    for (const phrase of [
      "https://github.com/iatsiuk/firefox-ctl",
      "nativeMessaging",
      "tabGroups",
      "webRequest",
      "`browsingActivity`",
      "`authenticationInfo`",
      "the local native host over stdio",
      "firefox-ctl install",
      "~/.mozilla/native-messaging-hosts/firefoxctl.json",
      "~/Library/Application Support/Mozilla/NativeMessagingHosts/firefoxctl.json",
      "firefox-ctl ping",
      "firefox-ctl createWindow",
      "firefox-ctl getContent",
      "firefox-ctl screenshot",
      "EVALUATE_DISABLED",
      "[redacted]",
      "DANGEROUS_EVAL",
    ]) {
      expect(text).toContain(phrase)
    }
  })

  test.skipIf(root === undefined)(
    "CLAUDE.md documents the listed-channel submission steps",
    async () => {
      const text = await readRootDoc("CLAUDE.md")
      for (const phrase of [
        "make ext-source",
        "make ext-reproduce",
        "docs/reviewer-notes.md",
        "listed",
      ]) {
        expect(text).toContain(phrase)
      }
    },
  )
})
