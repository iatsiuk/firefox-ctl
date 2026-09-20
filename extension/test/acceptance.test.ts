// Acceptance checks for the sessions-and-windows and DOM-actions plans: every
// command of each plan travels a real host frame with the flags the CLI
// declares, the page commands are answered by a live content script over
// happy-dom, the error texts reach the reply verbatim, and the docs name the
// same texts and result fields.

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { start } from "../src/app"
import commandTable from "../src/commands.json"
import { resetConsoleCapture } from "../src/content/console"
import { realPage } from "../src/content/page"
import { PAGE_COMMANDS } from "../src/handlers/dom"
import { startPage } from "../src/page"
import type { ExtensionResponse, HostCommand, JsonObject } from "../src/protocol"
import { ERROR_CODES } from "../src/protocol"
import { writeEvaluateEnabled } from "../src/settings"
import { stubRect, stubTop } from "./dom"
import { FakeBrowser, FakeEnvironment, type FakePort } from "./fakes"
import errors from "./fixtures/errors.json"

/** The commands this plan delivers, as listed in its Overview. */
const PLAN_COMMANDS = [
  "createWindow",
  "navigate",
  "getActiveTab",
  "getTabs",
  "closeTab",
  "closeWindow",
  "getWindows",
  "resizeWindow",
  "setViewport",
  "canNavigate",
  "getWindowMode",
  "listAllTabs",
  "attachTab",
  "detachTab",
] as const

function flagsOf(command: string): Set<string> {
  const spec = commandTable.find((entry) => entry.name === command)
  if (!spec) {
    throw new Error(`${command} is missing from commands.json`)
  }
  return new Set(spec.flags.map((flag) => flag.name))
}

function hostCommand(id: string, command: string, params: JsonObject): HostCommand {
  return { id, type: "command", command, params }
}

/** A browser holding one focused user window with one user tab. */
function userBrowser(): FakeBrowser {
  const browser = new FakeBrowser()
  browser.addWindow({ id: 1, focused: true, type: "normal", incognito: false })
  browser.addTab({ id: 1, windowId: 1, url: "https://user.example", title: "User", active: true })
  browser.currentWindowId = 1
  browser.focusWindow(1)
  return browser
}

function livePort(browser: FakeBrowser): FakePort {
  const port = browser.lastPort()
  if (!port) {
    throw new Error("no port was created")
  }
  return port
}

function session(browser: FakeBrowser) {
  const handle = start(browser, new FakeEnvironment({ now: 1000 }))
  return { handle, port: livePort(browser) }
}

/** Sends one host frame, checking its params against the CLI flag table first. */
async function run(
  port: FakePort,
  command: string,
  params: JsonObject = {},
): Promise<ExtensionResponse> {
  const flags = flagsOf(command)
  for (const name of Object.keys(params)) {
    expect(`${command} --${name}`).toBe(flags.has(name) ? `${command} --${name}` : "undeclared")
  }
  port.emitMessage(hostCommand(command, command, params))
  // page commands wait on animation frames and poll intervals, so the reply
  // needs real time rather than a fixed number of turns of the event loop
  const deadline = Date.now() + 5000
  while (port.posted.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  const reply = port.posted.shift() as ExtensionResponse | undefined
  if (!reply) {
    throw new Error(`no reply for ${command}`)
  }
  return reply
}

function result(reply: ExtensionResponse): JsonObject {
  if (!reply.success) {
    throw new Error(reply.error)
  }
  return reply.result as JsonObject
}

async function failure(port: FakePort, command: string, params: JsonObject = {}): Promise<string> {
  const reply = await run(port, command, params)
  if (reply.success) {
    throw new Error(`${command} unexpectedly succeeded: ${JSON.stringify(reply.result)}`)
  }
  return reply.error
}

function number(object: JsonObject, key: string): number {
  const value = object[key]
  if (typeof value !== "number") {
    throw new Error(`${key} is ${String(value)}, not a number`)
  }
  return value
}

describe("plan commands", () => {
  test("every command of the plan is in the CLI table and registered", () => {
    const { handle } = session(userBrowser())
    for (const command of PLAN_COMMANDS) {
      expect(commandTable.some((entry) => entry.name === command)).toBe(true)
      expect(handle.dispatcher.has(command)).toBe(true)
    }
  })

  test("every command answers a host frame carrying its declared flags", async () => {
    const browser = userBrowser()
    const { port } = session(browser)
    const seen = new Set<string>()

    const created = result(
      await run(port, "createWindow", { url: "https://example.com", private: false }),
    )
    seen.add("createWindow")
    const windowId = number(created, "windowId")
    const tabId = number(created, "tabId")

    const frames: [string, JsonObject][] = [
      ["canNavigate", {}],
      ["getWindowMode", {}],
      ["getWindows", {}],
      ["getActiveTab", {}],
      ["getTabs", {}],
      ["navigate", { url: "https://mozilla.org", tabId, windowId }],
      ["resizeWindow", { windowId, width: 1024, height: 768, left: 10, top: 20 }],
      ["setViewport", { windowId, device: "iphone-14" }],
      ["setViewport", { windowId, width: 900, height: 600 }],
      ["listAllTabs", {}],
      ["attachTab", { tabId: 1 }],
      ["detachTab", { tabId: 1 }],
      ["closeTab", { tabId }],
      ["closeWindow", {}],
    ]
    for (const [command, params] of frames) {
      const reply = await run(port, command, params)
      expect(`${command}: ${reply.success ? "ok" : reply.error}`).toBe(`${command}: ok`)
      seen.add(command)
    }

    expect([...seen].sort()).toEqual([...PLAN_COMMANDS].sort())
  })

  test("an adopted session keeps the user window and its tab", async () => {
    const browser = userBrowser()
    const { port } = session(browser)
    const created = result(await run(port, "createWindow", { private: false }))
    expect(number(created, "windowId")).toBe(1)

    const closed = result(await run(port, "closeWindow"))

    expect(closed.adopted).toBe(true)
    const windows = await run(port, "getWindows")
    expect(windows.success && windows.result).toBeArrayOfSize(1)
  })
})

describe("shipped error texts", () => {
  test("a command without a session reports the session loss", async () => {
    const { port } = session(userBrowser())
    expect(await failure(port, "navigate", { url: "https://example.com" })).toBe(errors.sessionLost)
    expect(await failure(port, "closeWindow")).toBe(errors.closeWindowNoSession)
    expect(await failure(port, "closeTab", { tabId: 1 })).toBe(errors.closeTabNoSession)
  })

  test("an expired window, an empty pool and a vanished active tab", async () => {
    const browser = userBrowser()
    const { handle, port } = session(browser)
    result(await run(port, "createWindow", { private: false }))
    const state = handle.dispatcher.deps.session.state
    if (!state) {
      throw new Error("createWindow left no session")
    }
    const poolTabId = state.tabs[0] as number

    state.tabs = []
    expect(await failure(port, "navigate", { url: "https://example.com" })).toBe(errors.noTabs)

    state.tabs = [9999]
    handle.dispatcher.deps.session.activeTabId = 9999
    expect(await failure(port, "navigate", { url: "https://example.com" })).toBe(
      errors.tabUnavailable,
    )

    state.tabs = [poolTabId]
    state.windowId = 4242
    expect(await failure(port, "navigate", { url: "https://example.com" })).toBe(
      errors.windowExpired,
    )
  })

  test("both mode mismatches", async () => {
    const { port } = session(userBrowser())
    result(await run(port, "createWindow", {}))
    expect(await failure(port, "createWindow", { private: false })).toBe(
      errors.modeMismatchNonPrivate,
    )

    const other = session(userBrowser())
    result(await run(other.port, "createWindow", { private: false }))
    expect(await failure(other.port, "createWindow", { private: true })).toBe(
      errors.modeMismatchPrivate,
    )
  })

  test("tab targeting and tab bookkeeping", async () => {
    const browser = userBrowser()
    const { port } = session(browser)
    const created = result(await run(port, "createWindow", { private: false }))
    const tabId = number(created, "tabId")

    expect(await failure(port, "navigate", { tabId })).toBe(errors.navigateMissingUrl)
    expect(await failure(port, "navigate", { url: "https://x.test", tabId: 9999 })).toBe(
      errors.tabClosed.replace("<id>", "9999"),
    )
    expect(await failure(port, "attachTab", { tabId: 0 })).toBe(errors.attachInvalidTabId)
    expect(await failure(port, "attachTab", { tabId })).toBe(
      errors.attachPoolTab.replace("<id>", String(tabId)),
    )
    expect(await failure(port, "attachTab", { tabId: 9999 })).toBe(
      errors.attachNotFound.replace("<id>", "9999"),
    )
    expect(await failure(port, "detachTab", {})).toBe(errors.detachMissingTabId)
    expect(await failure(port, "closeTab", { tabId: 1 })).toBe(
      errors.closeTabUnknown.replace("<id>", "1").replace("<ids>", String(tabId)),
    )
  })

  test("window geometry and viewport parameters", async () => {
    const { port } = session(userBrowser())
    expect(await failure(port, "resizeWindow", { windowId: -1 })).toBe(errors.invalidWindowId)
    expect(await failure(port, "setViewport", {})).toBe(errors.viewportMissingParams)
  })
})

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

describe("documented error texts", () => {
  const root = repoRoot()

  async function commandsDoc(): Promise<string> {
    if (root === undefined) {
      return ""
    }
    return Bun.file(join(root, "docs", "commands.md")).text()
  }

  test("every prefix used in the fixtures is a declared error code and documented", async () => {
    const doc = await commandsDoc()
    if (doc === "") {
      console.log("skipping: repository root not found")
      return
    }
    for (const text of Object.values(errors)) {
      const match = /^([A-Z_]+): /.exec(text)
      if (!match) {
        continue
      }
      const code = match[1] as (typeof ERROR_CODES)[number]
      expect(ERROR_CODES).toContain(code)
      expect(doc).toContain(code)
    }
  })

  test("commands.md quotes the session errors verbatim", async () => {
    const doc = await commandsDoc()
    if (doc === "") {
      console.log("skipping: repository root not found")
      return
    }
    for (const text of [errors.sessionLost, errors.windowExpired, errors.tabClosed]) {
      expect(doc).toContain(text)
    }
    const template = "MODE_MISMATCH: Requested <a> mode, but existing window is <b>."
    expect(doc).toContain(template)
    expect(template.replace("<a>", "private").replace("<b>", "non-private")).toBe(
      errors.modeMismatchPrivate,
    )
    expect(template.replace("<a>", "non-private").replace("<b>", "private")).toBe(
      errors.modeMismatchNonPrivate,
    )
  })
})

/** The page commands the DOM-actions plan delivers, as listed in its Overview. */
const PLAN_PAGE_COMMANDS = [
  "getContent",
  "click",
  "type",
  "pressKey",
  "scroll",
  "waitFor",
  "getElementInfo",
  "getPageState",
  "getAccessibilitySnapshot",
  "evaluate",
] as const

const FIXTURE_HTML = `
  <main>
    <h1 id="title">Hello world</h1>
    <p>Fixture page for the acceptance run.</p>
    <a href="https://example.com/docs">Docs</a>
    <button id="go" type="button">Go</button>
    <button id="twice-a" type="button">Go twice</button>
    <button id="twice-b" type="button">Go twice</button>
    <label for="q">Query</label>
    <input id="q" name="q" type="text" placeholder="Search">
    <img src="/logo.png" alt="Logo" width="40" height="40">
  </main>
`

// the shared happy-dom window carries the top document of every scenario, and
// `startPage` installs itself once per document: the content side is therefore
// a single browser reused across the runs, as a real tab reuses its script
let contentBrowser: FakeBrowser | undefined

/**
 * Puts a real content script on the other end of `tabs.sendMessage`: the
 * background page's frame travels the registry over happy-dom, so a page
 * command is answered by the action it names, not by a scripted reply.
 */
function contentTab(browser: FakeBrowser): void {
  document.title = "Fixture page"
  document.body.innerHTML = FIXTURE_HTML
  // happy-dom has no layout and the text resolver walks from the root, so
  // `html`, `body` and every fixture element need a box to count as visible
  for (const target of document.querySelectorAll("*")) {
    stubRect(target, { width: 100, height: 20 })
  }
  stubTop(window, true)
  contentBrowser ??= new FakeBrowser()
  const content = contentBrowser
  startPage(content, realPage())
  // every background send names its frame, so a stray broadcast fails the run
  browser.sendMessageHandler = (_tabId, message, options) => {
    if (options === undefined) {
      return Promise.reject(new Error("tabs.sendMessage was called without a frame target"))
    }
    return content.emitRuntimeMessage(message)
  }
}

/** The row of `docs/commands.md` describing one command. */
function docRow(doc: string, command: string): string {
  const row = doc.split("\n").find((line) => line.startsWith(`| ${command} |`))
  if (row === undefined) {
    throw new Error(`${command} has no row in commands.md`)
  }
  return row
}

describe("page commands", () => {
  test("every page command is in the CLI table and registered", () => {
    const { handle } = session(userBrowser())
    for (const command of PLAN_PAGE_COMMANDS) {
      expect(`${command} in commands.json`).toBe(
        commandTable.some((entry) => entry.name === command)
          ? `${command} in commands.json`
          : `${command} missing`,
      )
      expect(`${command} dispatched`).toBe(
        handle.dispatcher.has(command) ? `${command} dispatched` : `${command} unregistered`,
      )
      expect(flagsOf(command).has("tabId")).toBe(true)
      expect(flagsOf(command).has("windowId")).toBe(true)
    }
  })

  test("every page command answers a host frame through a live content script", async () => {
    const browser = userBrowser()
    const { port } = session(browser)
    contentTab(browser)
    await writeEvaluateEnabled(browser, true)
    const created = result(await run(port, "createWindow", { private: false }))
    const tabId = number(created, "tabId")
    const windowId = number(created, "windowId")

    const frames: [string, JsonObject][] = [
      ["getContent", { selector: "h1", includeHtml: true, maxLength: 1000, tabId, windowId }],
      ["getElementInfo", { selector: "#title" }],
      ["getPageState", { maxHeadings: 5, maxLinks: 5, maxButtons: 5, maxInputs: 5, maxImages: 5 }],
      ["getAccessibilitySnapshot", { selector: "body", maxDepth: 3, maxNodes: 50 }],
      ["click", { selector: "#go", autoWait: true, waitTimeout: 500 }],
      [
        "type",
        { selector: "#q", text: "firefox-ctl", clear: true, autoWait: true, waitTimeout: 500 },
      ],
      [
        "pressKey",
        {
          key: "Enter",
          selector: "#q",
          ctrlKey: false,
          shiftKey: true,
          altKey: false,
          metaKey: false,
        },
      ],
      ["scroll", { x: 0, y: 100, behavior: "auto" }],
      ["waitFor", { text: "Hello world", timeout: 500, interval: 10 }],
      ["evaluate", { expression: "document.title" }],
    ]

    const seen = new Set<string>()
    for (const [command, params] of frames) {
      const reply = await run(port, command, params)
      expect(`${command}: ${reply.success ? "ok" : reply.error}`).toBe(`${command}: ok`)
      expect(number(result(reply), "tabId")).toBe(tabId)
      seen.add(command)
    }
    expect([...seen].sort()).toEqual([...PLAN_PAGE_COMMANDS].sort())
  })

  test("evaluate is refused end to end until the preferences opt-in is stored", async () => {
    const browser = userBrowser()
    const { port } = session(browser)
    contentTab(browser)
    result(await run(port, "createWindow", { private: false }))

    expect(await failure(port, "evaluate", { expression: "1 + 1" })).toBe(
      "EVALUATE_DISABLED: evaluate is disabled; enable it in the add-on preferences " +
        "(about:addons > Terminal Control for Firefox > Preferences)",
    )

    await writeEvaluateEnabled(browser, true)
    expect(result(await run(port, "evaluate", { expression: "1 + 1" }))).toMatchObject({
      result: 2,
    })
  })

  test("the live content script reports what the commands did", async () => {
    const browser = userBrowser()
    const { port } = session(browser)
    contentTab(browser)
    await writeEvaluateEnabled(browser, true)
    result(await run(port, "createWindow", { private: false }))

    expect(result(await run(port, "getContent", { selector: "h1" }))).toMatchObject({
      selector: "h1",
      text: "Hello world",
      tagName: "h1",
      truncated: false,
    })

    let clicks = 0
    ;(document.querySelector("#go") as HTMLElement).addEventListener("click", () => {
      clicks++
    })
    expect(result(await run(port, "click", { selector: "#go" }))).toMatchObject({
      selector: "#go",
      clicked: true,
      tagName: "button",
      text: "Go",
      id: "go",
    })
    expect(clicks).toBe(1)

    expect(result(await run(port, "type", { selector: "#q", text: "firefox-ctl" }))).toMatchObject({
      selector: "#q",
      typed: "firefox-ctl",
      currentValue: "firefox-ctl",
    })
    expect((document.querySelector("#q") as HTMLInputElement).value).toBe("firefox-ctl")

    expect(result(await run(port, "evaluate", { expression: "1 + 1" }))).toMatchObject({
      expression: "1 + 1",
      result: 2,
      type: "number",
    })
    expect(result(await run(port, "evaluate", { expression: "missing.field" }))).toMatchObject({
      type: "error",
    })
  })

  test("getContent answers the tail of an element through the port", async () => {
    const browser = userBrowser()
    const { port } = session(browser)
    contentTab(browser)
    result(await run(port, "createWindow", { private: false }))

    const main = document.querySelector("main") as HTMLElement
    const tailed = result(await run(port, "getContent", { selector: "main", tail: 5 }))
    expect(tailed).toMatchObject({ truncated: true, tailLength: 5 })
    expect(String(tailed.text)).toEndWith(main.innerText.trim().slice(-5))

    expect(await failure(port, "getContent", { selector: "main", tail: 5, maxLength: 10 })).toBe(
      errors.tailExclusive,
    )
  })

  test("click by text refuses an ambiguous label and presses a unique one", async () => {
    const browser = userBrowser()
    const { port } = session(browser)
    contentTab(browser)
    result(await run(port, "createWindow", { private: false }))

    let twice = 0
    for (const id of ["#twice-a", "#twice-b"]) {
      ;(document.querySelector(id) as HTMLElement).addEventListener("click", () => {
        twice++
      })
    }
    const ambiguous = await failure(port, "click", { text: "Go twice" })
    expect(ambiguous.slice(0, 45)).toBe('AMBIGUOUS_TEXT: "Go twice" matches 2 elements')
    expect(twice).toBe(0)

    let clicks = 0
    ;(document.querySelector("#go") as HTMLElement).addEventListener("click", () => {
      clicks++
    })
    expect(result(await run(port, "click", { text: "Go" }))).toMatchObject({
      selector: "#go",
      clicked: true,
      tagName: "button",
      text: "Go",
      id: "go",
      matchedBy: "text",
    })
    expect(clicks).toBe(1)
  })

  test("getElementInfo by text answers the heading", async () => {
    const browser = userBrowser()
    const { port } = session(browser)
    contentTab(browser)
    result(await run(port, "createWindow", { private: false }))

    expect(result(await run(port, "getElementInfo", { text: "Hello world" }))).toMatchObject({
      selector: "#title",
      tagName: "h1",
      text: "Hello world",
      matchedBy: "text",
    })
  })

  test("a refused action keeps the content script's message and diagnostics", async () => {
    const browser = userBrowser()
    const { port } = session(browser)
    contentTab(browser)
    result(await run(port, "createWindow", { private: false }))

    const notFound = await failure(port, "click", { selector: "#titl", autoWait: false })
    expect(notFound).toContain(errors.elementNotFound.replace("<selector>", "#titl"))
    expect(notFound).toContain(errors.notFoundSuggestions)
    expect(notFound).toContain("#title")
    expect(notFound).toContain(errors.notFoundContext)
    expect(notFound).toContain(errors.notFoundHint)

    expect(await failure(port, "type", { selector: "h1", text: "nope", autoWait: false })).toBe(
      errors.elementNotEditable.replace("<selector>", "h1"),
    )
    const infoMiss = await failure(port, "getElementInfo", { selector: "#missing" })
    expect(infoMiss).toContain(errors.elementNotFound.replace("<selector>", "#missing"))
    expect(infoMiss).toContain(errors.notFoundContext)
    expect(await failure(port, "getContent", { selector: "#missing" })).toBe(
      errors.elementNotFound.replace("<selector>", "#missing"),
    )
    expect(await failure(port, "waitFor", { timeout: 50, interval: 10 })).toBe(
      errors.selectorRequired,
    )
    expect(
      await failure(port, "waitFor", { selector: "#nothing", timeout: 50, interval: 10 }),
    ).toBe(errors.timeoutElement.replace("<selector>", "#nothing"))
    expect(await failure(port, "waitFor", { text: "nowhere", timeout: 50, interval: 10 })).toBe(
      errors.timeoutText.replace("<text>", "nowhere"),
    )
  })

  test("an unreachable content script becomes a coded error", async () => {
    const browser = userBrowser()
    const { port } = session(browser)
    browser.sendMessageHandler = () =>
      Promise.reject(new Error("Could not establish connection. Receiving end does not exist."))
    const created = result(await run(port, "createWindow", { private: false }))
    await browser.tabs.update(number(created, "tabId"), { url: "about:config" })

    expect(await failure(port, "getContent", {})).toStartWith("RESTRICTED_PAGE: ")
  })

  test("a page command on a still-loading tab answers with the loading hint", async () => {
    const browser = userBrowser()
    const { port } = session(browser)
    browser.sendMessageHandler = () =>
      Promise.reject(new Error("Could not establish connection. Receiving end does not exist."))
    const created = result(await run(port, "createWindow", { private: false }))
    const tabId = number(created, "tabId")
    browser.emitTabUpdated(tabId, { status: "loading", url: "https://example.com/" })

    expect(await failure(port, "getContent", {})).toBe(
      errors.tabLoading.replace("<id>", String(tabId)).replace("<url>", "https://example.com/"),
    )
  })
})

describe("documented page results", () => {
  const root = repoRoot()

  test.skipIf(root === undefined)(
    "commands.md names every field the page commands return",
    async () => {
      const doc = await Bun.file(join(root as string, "docs", "commands.md")).text()
      const browser = userBrowser()
      const { port } = session(browser)
      contentTab(browser)
      await writeEvaluateEnabled(browser, true)
      result(await run(port, "createWindow", { private: false }))

      const calls: [string, JsonObject][] = [
        ["getContent", { selector: "h1", includeHtml: true }],
        ["getElementInfo", { selector: "#title" }],
        ["getPageState", {}],
        ["getAccessibilitySnapshot", {}],
        ["click", { selector: "#go" }],
        ["type", { selector: "#q", text: "hi" }],
        ["pressKey", { key: "Enter" }],
        ["scroll", { y: 10 }],
        ["waitFor", { text: "Hello world" }],
        ["evaluate", { expression: "1" }],
      ]
      for (const [command, params] of calls) {
        const row = docRow(doc, command)
        for (const field of Object.keys(result(await run(port, command, params)))) {
          if (field === "tabId") {
            continue
          }
          expect(`${command}.${field}`).toBe(
            row.includes(field) ? `${command}.${field}` : "undocumented",
          )
        }
      }
    },
  )

  test.skipIf(root === undefined)("commands.md quotes the page error texts verbatim", async () => {
    const doc = await Bun.file(join(root as string, "docs", "commands.md")).text()
    for (const text of [
      errors.selectorRequired,
      errors.selectorEmpty,
      errors.selectorTooLong,
      errors.elementNotFound.replace("<selector>", "#missing"),
      errors.notFoundSuggestions,
      errors.notFoundContext,
      errors.notFoundHint,
      errors.elementNotEditable,
      errors.timeoutText.replace('"<text>"', '"<t>"'),
      errors.timeoutUrl.replace('"<url>"', '"<u>"'),
      errors.timeoutElement.replace("<selector>", "<s>"),
    ]) {
      expect(doc).toContain(text)
    }
    expect(doc).toContain("Invalid CSS selector:")
  })

  test.skipIf(root === undefined)(
    "commands.md ties getPageState errors to the console capture buffer",
    async () => {
      const doc = await Bun.file(join(root as string, "docs", "commands.md")).text()
      const row = docRow(doc, "getPageState")
      expect(row).toContain("last 10 captured `error` entries")
      expect(row).toContain("first `getConsoleLogs`")
    },
  )
})

describe("command deadline", () => {
  const root = repoRoot()

  // the deadline runs on the injected clock, so the frame is emitted by hand
  // and the fake clock is moved past the budget the host's `_timeout` buys
  async function drain(port: FakePort): Promise<ExtensionResponse> {
    const deadline = Date.now() + 5000
    while (port.posted.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    const reply = port.posted.shift() as ExtensionResponse | undefined
    if (!reply) {
      throw new Error("no reply")
    }
    return reply
  }

  test("a page that never replies answers COMMAND_TIMEOUT and leaves ping alive", async () => {
    const browser = userBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    start(browser, env)
    const port = livePort(browser)
    const created = result(await run(port, "createWindow", { private: false }))
    const tabId = number(created, "tabId")

    browser.sendMessageHandler = () => new Promise<never>(() => undefined)
    port.emitMessage(hostCommand("hung", "getContent", { tabId, _timeout: 5000 }))
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    env.advance(4000)

    const reply = await drain(port)
    expect(reply.success).toBe(false)
    expect(reply.success ? "" : reply.error).toBe(
      errors.commandTimeout.replace("<command>", "getContent").replace("<ms>", "4000"),
    )
    expect(await run(port, "ping")).toMatchObject({ success: true })
    expect(await run(port, "getTabs")).toMatchObject({ success: true })
  })

  test.skipIf(root === undefined)(
    "commands.md quotes the timeout and loading texts verbatim",
    async () => {
      const doc = (await Bun.file(join(root as string, "docs", "commands.md")).text()).replace(
        /\s+/g,
        " ",
      )
      expect(doc).toContain(errors.commandTimeout)
      expect(doc).toContain(errors.tabLoading.slice("CONTENT_SCRIPT_UNAVAILABLE: ".length))
    },
  )
})

/** The commands the screenshots, DevTools and consent plan delivers. */
const PLAN_DEVTOOLS_COMMANDS = [
  "screenshot",
  "getConsoleLogs",
  "getNetworkRequests",
  "handleConsent",
] as const

describe("the whole command table", () => {
  afterEach(() => {
    resetConsoleCapture()
  })

  test("every command of the last plan is in the CLI table and registered", () => {
    const { handle } = session(userBrowser())
    for (const command of PLAN_DEVTOOLS_COMMANDS) {
      expect(commandTable.some((entry) => entry.name === command)).toBe(true)
      expect(`${command} dispatched`).toBe(
        handle.dispatcher.has(command) ? `${command} dispatched` : `${command} unregistered`,
      )
    }
  })

  test("every command in commands.json is registered", () => {
    const { handle } = session(userBrowser())
    for (const entry of commandTable) {
      expect(`${entry.name} dispatched`).toBe(
        handle.dispatcher.has(entry.name)
          ? `${entry.name} dispatched`
          : `${entry.name} unregistered`,
      )
    }
  })

  test("all 33 commands answer a host frame with their declared flags", async () => {
    const browser = userBrowser()
    const { port } = session(browser)
    contentTab(browser)
    await writeEvaluateEnabled(browser, true)
    const seen = new Set<string>(["createWindow"])
    const created = result(
      await run(port, "createWindow", { url: "https://example.com", private: false }),
    )
    const tabId = number(created, "tabId")
    const windowId = number(created, "windowId")
    browser.emitRequestStarted({
      requestId: "a1",
      url: "https://example.com/app.js?token=hunter2",
      method: "GET",
      type: "script",
      tabId,
    })
    browser.emitRequestCompleted({
      requestId: "a1",
      url: "https://example.com/app.js?token=hunter2",
      method: "GET",
      type: "script",
      tabId,
      statusCode: 200,
    })

    const frames: [string, JsonObject][] = [
      ["ping", {}],
      ["version", {}],
      ["canNavigate", {}],
      ["getWindowMode", {}],
      ["getWindows", {}],
      ["getActiveTab", {}],
      ["getTabs", {}],
      ["listAllTabs", {}],
      ["attachTab", { tabId: 1 }],
      ["detachTab", { tabId: 1 }],
      ["navigate", { url: "https://mozilla.org", tabId, windowId }],
      ["resizeWindow", { windowId, width: 1024, height: 768, left: 10, top: 20 }],
      ["setViewport", { windowId, width: 900, height: 600 }],
      ["setViewport", { windowId, device: "iphone-14" }],
      ["getContent", { selector: "h1", includeHtml: true, maxLength: 1000, tabId, windowId }],
      ["getElementInfo", { selector: "#title", tabId, windowId }],
      ["getPageState", { maxHeadings: 5, maxLinks: 5, maxButtons: 5, maxInputs: 5, maxImages: 5 }],
      ["getAccessibilitySnapshot", { selector: "body", maxDepth: 3, maxNodes: 50 }],
      ["click", { selector: "#go", autoWait: true, waitTimeout: 500 }],
      [
        "type",
        { selector: "#q", text: "firefox-ctl", clear: true, autoWait: true, waitTimeout: 500 },
      ],
      ["pressKey", { key: "Enter", selector: "#q", ctrlKey: false, shiftKey: false }],
      ["scroll", { x: 0, y: 100, behavior: "auto" }],
      ["waitFor", { text: "Hello world", timeout: 500, interval: 10 }],
      ["evaluate", { expression: "document.title", tabId, windowId }],
      ["getConsoleLogs", { level: "error", clear: false, limit: 10, tabId, windowId }],
      [
        "getNetworkRequests",
        { type: "script", status: "completed", clear: false, limit: 5, includeHeaders: true },
      ],
      ["handleConsent", { scanTimeout: 200, tabId, windowId }],
      [
        "screenshot",
        {
          format: "jpeg",
          quality: 70,
          scale: 1,
          purpose: "read-text",
          annotate: true,
          maxWait: 1000,
          waitForImages: false,
          skipReadiness: false,
          tabId,
          windowId,
        },
      ],
      ["watchFrames", { match: "*secured-fields*", tabId }],
      ["listFrames", { match: "*secured-fields*", timeout: 0, tabId }],
      ["unwatchFrames", { tabId }],
      ["closeTab", { tabId }],
      ["closeWindow", {}],
    ]
    for (const [command, params] of frames) {
      const reply = await run(port, command, params)
      expect(`${command}: ${reply.success ? "ok" : reply.error}`).toBe(`${command}: ok`)
      seen.add(command)
    }

    expect([...seen].sort()).toEqual(commandTable.map((entry) => entry.name).sort())
  })

  test("the page rows keep their targeting flags and only they take a frame", () => {
    for (const command of PAGE_COMMANDS) {
      const flags = flagsOf(command)
      expect(`${command}: ${[...flags].filter((name) => name.endsWith("Id")).join(",")}`).toBe(
        `${command}: tabId,windowId,frameId`,
      )
    }
    // tab-wide or background commands that take a tab but never a child frame
    for (const command of ["navigate", "screenshot", "getNetworkRequests"]) {
      expect(flagsOf(command).has("tabId")).toBe(true)
      expect(flagsOf(command).has("windowId")).toBe(true)
      expect(`${command} frameId: ${flagsOf(command).has("frameId")}`).toBe(
        `${command} frameId: false`,
      )
    }
    for (const command of ["watchFrames", "unwatchFrames", "listFrames"]) {
      expect(flagsOf(command).has("tabId")).toBe(true)
      expect(`${command} frameId: ${flagsOf(command).has("frameId")}`).toBe(
        `${command} frameId: false`,
      )
    }
  })
})
