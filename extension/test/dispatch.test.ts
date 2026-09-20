import { describe, expect, test } from "bun:test"
import { ATTACHED_TABS_KEY, AttachedTabs } from "../src/attached"
import { CaptureLocks } from "../src/capture-locks"
import type { Services } from "../src/dispatch"
import { createDispatcher, Dispatcher, describeTabError } from "../src/dispatch"
import { FrameRegistry } from "../src/frames"
import { NetworkTracker } from "../src/network"
import type { CommandName, HostCommand, JsonObject } from "../src/protocol"
import { ExtensionError } from "../src/protocol"
import { waitForPageReady } from "../src/readiness"
import { Session, WINDOW_STATE_KEY } from "../src/session"
import { FakeBrowser, FakeEnvironment } from "./fakes"
import errors from "./fixtures/errors.json"

function hostCommand(command: string, params: JsonObject = {}): HostCommand {
  return { id: "frame-1", type: "command", command, params }
}

function setup(options: { manifestVersion?: string; now?: number } = {}) {
  const browser = new FakeBrowser({ manifestVersion: options.manifestVersion })
  const env = new FakeEnvironment({ now: options.now })
  return { browser, env }
}

function deps(browser: FakeBrowser, env: FakeEnvironment): Services {
  return {
    browser,
    env,
    session: new Session(browser, env),
    attached: new AttachedTabs(browser, env),
    network: new NetworkTracker(env),
    captureLocks: new CaptureLocks(),
    frames: new FrameRegistry(env),
    readiness: waitForPageReady,
  }
}

describe("Dispatcher core commands", () => {
  test("ping answers with pong and the clock", async () => {
    const { browser, env } = setup({ now: 1234 })
    const response = await createDispatcher(browser, env).handle(hostCommand("ping"))

    expect(response).toEqual({
      id: "frame-1",
      success: true,
      result: { pong: true, timestamp: 1234 },
    })
  })

  test("version reports the manifest version and features, never the user agent", async () => {
    const { browser, env } = setup({ manifestVersion: "0.4.2" })
    const response = await createDispatcher(browser, env).handle(hostCommand("version"))

    expect(response).toEqual({
      id: "frame-1",
      success: true,
      result: {
        extension: "0.4.2",
        features: ["sessions", "dom", "devtools", "frames"],
      },
    })
    const result = (response as { result: Record<string, unknown> }).result
    expect(Object.keys(result)).not.toContain("browser")
  })
})

describe("Dispatcher.handle", () => {
  test("rejects a name that is not in the command table", async () => {
    const { browser, env } = setup()
    const response = await createDispatcher(browser, env).handle(hostCommand("teleport"))

    expect(response).toEqual({ id: "frame-1", success: false, error: "UNKNOWN_COMMAND: teleport" })
  })

  test("rejects a known name with no handler registered", async () => {
    const { browser, env } = setup()
    const response = await new Dispatcher(deps(browser, env)).handle(hostCommand("screenshot"))

    expect(response).toEqual({
      id: "frame-1",
      success: false,
      error: "UNKNOWN_COMMAND: screenshot",
    })
  })

  test("passes params and dependencies to the handler", async () => {
    const { browser, env } = setup({ now: 7 })
    const dispatcher = new Dispatcher(deps(browser, env))
    dispatcher.register("navigate", (params, deps) => ({
      url: params.url ?? null,
      at: deps.env.now(),
      version: deps.browser.runtime.getManifest().version,
    }))

    const response = await dispatcher.handle(
      hostCommand("navigate", { url: "https://example.com" }),
    )

    expect(response).toEqual({
      id: "frame-1",
      success: true,
      result: { url: "https://example.com", at: 7, version: "0.1.0" },
    })
  })

  test("awaits an async handler", async () => {
    const { browser, env } = setup()
    const dispatcher = new Dispatcher(deps(browser, env))
    dispatcher.register("getTabs", async () => ["a", "b"])

    expect(await dispatcher.handle(hostCommand("getTabs"))).toEqual({
      id: "frame-1",
      success: true,
      result: ["a", "b"],
    })
  })

  test("reports an ExtensionError with its prefix", async () => {
    const { browser, env } = setup()
    const dispatcher = new Dispatcher(deps(browser, env))
    dispatcher.register("closeTab", () => {
      throw new ExtensionError("TAB_CLOSED", "Tab 7 no longer exists.")
    })

    expect(await dispatcher.handle(hostCommand("closeTab"))).toEqual({
      id: "frame-1",
      success: false,
      error: "TAB_CLOSED: Tab 7 no longer exists.",
    })
  })

  test("reports a plain Error by its message", async () => {
    const { browser, env } = setup()
    const dispatcher = new Dispatcher(deps(browser, env))
    dispatcher.register("scroll", () => {
      throw new Error("url is required")
    })

    expect(await dispatcher.handle(hostCommand("scroll"))).toEqual({
      id: "frame-1",
      success: false,
      error: "url is required",
    })
  })

  test("stringifies a throw that is not an Error", async () => {
    const { browser, env } = setup()
    const dispatcher = new Dispatcher(deps(browser, env))
    dispatcher.register("evaluate", () => {
      throw "boom"
    })

    expect(await dispatcher.handle(hostCommand("evaluate"))).toEqual({
      id: "frame-1",
      success: false,
      error: "boom",
    })
  })

  test("reports a rejected promise", async () => {
    const { browser, env } = setup()
    const dispatcher = new Dispatcher(deps(browser, env))
    dispatcher.register("screenshot", () => Promise.reject(new Error("capture failed")))

    expect(await dispatcher.handle(hostCommand("screenshot"))).toEqual({
      id: "frame-1",
      success: false,
      error: "capture failed",
    })
  })

  test("serializes concurrent state commands so the next waits for the previous", async () => {
    const { browser, env } = setup()
    const dispatcher = new Dispatcher(deps(browser, env))
    const order: string[] = []
    let releaseFirst: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    dispatcher.register("createWindow", async (params) => {
      order.push(`start:${params.tag}`)
      if (params.tag === "first") {
        await gate
      }
      order.push(`end:${params.tag}`)
      return null
    })

    const first = dispatcher.handle(hostCommand("createWindow", { tag: "first" }))
    const second = dispatcher.handle(hostCommand("createWindow", { tag: "second" }))

    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(order).toEqual(["start:first"])

    releaseFirst()
    await Promise.all([first, second])

    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"])
  })

  test("runs commands that touch no session state concurrently", async () => {
    const { browser, env } = setup()
    const dispatcher = new Dispatcher(deps(browser, env))
    const order: string[] = []
    let releaseFirst: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    dispatcher.register("navigate", async (params) => {
      order.push(`start:${params.tag}`)
      if (params.tag === "first") {
        await gate
      }
      order.push(`end:${params.tag}`)
      return null
    })

    const first = dispatcher.handle(hostCommand("navigate", { tag: "first" }))
    const second = await dispatcher.handle(hostCommand("navigate", { tag: "second" }))

    expect(second).toMatchObject({ success: true })
    expect(order).toEqual(["start:first", "start:second", "end:second"])

    releaseFirst()
    await first
    expect(order).toEqual(["start:first", "start:second", "end:second", "end:first"])
  })

  test("has() reports registered handlers only", () => {
    const { browser, env } = setup()
    const dispatcher = createDispatcher(browser, env)

    expect(dispatcher.has("ping")).toBe(true)
    expect(dispatcher.has("screenshot")).toBe(true)
    expect(dispatcher.has("teleport")).toBe(false)
  })
})

const SESSION_COMMANDS: CommandName[] = [
  "createWindow",
  "navigate",
  "canNavigate",
  "getWindowMode",
  "getActiveTab",
  "getTabs",
  "listAllTabs",
  "attachTab",
  "detachTab",
  "closeTab",
  "closeWindow",
  "getWindows",
  "resizeWindow",
  "setViewport",
]

describe("createDispatcher registration", () => {
  test("registers every session, window and tab command", () => {
    const { browser, env } = setup()
    const dispatcher = createDispatcher(browser, env)

    expect(SESSION_COMMANDS.filter((command) => !dispatcher.has(command))).toEqual([])
  })

  test("registers the page commands", () => {
    const { browser, env } = setup()
    const dispatcher = createDispatcher(browser, env)

    expect(dispatcher.has("click")).toBe(true)
    expect(dispatcher.has("getPageState")).toBe(true)
    expect(dispatcher.has("handleConsent")).toBe(true)
  })

  test("registers the commands of plan 5", () => {
    const { browser, env } = setup()
    const dispatcher = createDispatcher(browser, env)

    expect(dispatcher.has("screenshot")).toBe(true)
    expect(dispatcher.has("getNetworkRequests")).toBe(true)
    expect(dispatcher.has("getConsoleLogs")).toBe(true)
  })
})

describe("command preamble", () => {
  test("restores the stored session before the handler runs", async () => {
    const { browser, env } = setup()
    browser.addWindow({ id: 1 })
    browser.addTab({ id: 10, windowId: 1, url: "https://example.com" })
    await browser.storage.local.set({
      [WINDOW_STATE_KEY]: {
        windowId: 1,
        tabs: [10],
        createdAt: 5,
        groupId: null,
        isPrivate: false,
        adopted: false,
      },
    })

    const response = await createDispatcher(browser, env).handle(hostCommand("getTabs"))

    expect(response).toMatchObject({ success: true, result: { windowId: 1, tabCount: 1 } })
  })

  test("drops an attachment the pool has taken over", async () => {
    const { browser, env } = setup()
    browser.addWindow({ id: 1 })
    browser.addTab({ id: 10, windowId: 1 })
    await browser.storage.local.set({
      [WINDOW_STATE_KEY]: {
        windowId: 1,
        tabs: [10],
        createdAt: 5,
        groupId: null,
        isPrivate: false,
        adopted: true,
      },
      [ATTACHED_TABS_KEY]: [[10, { attachedAt: 1 }]],
    })
    const dispatcher = createDispatcher(browser, env)

    // ping bypasses the preamble, so the check rides a command that needs it
    await dispatcher.handle(hostCommand("getTabs"))

    expect(dispatcher.deps.attached.has(10)).toBe(false)
    expect((await browser.storage.local.get(ATTACHED_TABS_KEY))[ATTACHED_TABS_KEY]).toEqual([])
  })

  test("reports a failing restore, keeps the stored state and retries", async () => {
    const { browser, env } = setup()
    browser.addWindow({ id: 1 })
    browser.addTab({ id: 10, windowId: 1 })
    const saved = {
      windowId: 1,
      tabs: [10],
      createdAt: 5,
      groupId: null,
      isPrivate: false,
      adopted: false,
    }
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: saved })
    let failures = 0
    const real = browser.storage.local.get.bind(browser.storage.local)
    browser.storage.local.get = (keys) => {
      if (failures === 0) {
        failures++
        return Promise.reject(new Error("storage unavailable"))
      }
      return real(keys)
    }
    const dispatcher = createDispatcher(browser, env)

    expect(await dispatcher.handle(hostCommand("getTabs"))).toMatchObject({
      success: false,
      error: "storage unavailable",
    })
    // a transient storage failure must not wipe the session
    expect((await browser.storage.local.get(WINDOW_STATE_KEY))[WINDOW_STATE_KEY]).toEqual(saved)
    expect(await dispatcher.handle(hostCommand("getTabs"))).toMatchObject({ success: true })
    expect(dispatcher.deps.session.state).toMatchObject({ windowId: 1, tabs: [10] })
  })

  test("persists session state even when the handler throws", async () => {
    const { browser, env } = setup({ now: 7 })
    const dispatcher = new Dispatcher(deps(browser, env))
    dispatcher.register("closeTab", (_params, { session }) => {
      session.state = {
        windowId: 3,
        tabs: [30],
        createdAt: 7,
        groupId: null,
        isPrivate: false,
        adopted: false,
      }
      throw new Error("boom")
    })

    expect(await dispatcher.handle(hostCommand("closeTab"))).toMatchObject({
      success: false,
      error: "boom",
    })
    expect((await browser.storage.local.get(WINDOW_STATE_KEY))[WINDOW_STATE_KEY]).toMatchObject({
      windowId: 3,
      tabs: [30],
    })
  })
})

const RECEIVING_END = new Error("Could not establish connection. Receiving end does not exist.")

describe("describeTabError", () => {
  test("passes an unrelated error through unchanged", async () => {
    const browser = new FakeBrowser()
    const original = new Error("Permission denied")

    expect(await describeTabError(browser, 1, original)).toBe(original)
  })

  test("wraps an unrelated non-Error value in a new Error", async () => {
    const browser = new FakeBrowser()

    const error = await describeTabError(browser, 1, "boom")

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe("boom")
  })

  test("maps a missing tab to TAB_CLOSED", async () => {
    const browser = new FakeBrowser()
    const error = await describeTabError(browser, 42, RECEIVING_END)

    expect(error).toBeInstanceOf(ExtensionError)
    expect(error.message).toStartWith("TAB_CLOSED: ")
    expect(error.message).toContain("42")
  })

  test("maps a failed page load to PAGE_LOAD_FAILED", async () => {
    const browser = new FakeBrowser({
      tabs: [{ id: 1, url: "http://localhost:9/", title: "Problem loading page" }],
    })

    expect((await describeTabError(browser, 1, RECEIVING_END)).message).toStartWith(
      "PAGE_LOAD_FAILED: ",
    )
  })

  test("maps a missing server page to PAGE_LOAD_FAILED", async () => {
    const browser = new FakeBrowser({
      tabs: [{ id: 1, url: "http://nope.invalid/", title: "Server Not Found" }],
    })

    expect((await describeTabError(browser, 1, RECEIVING_END)).message).toStartWith(
      "PAGE_LOAD_FAILED: ",
    )
  })

  test.each([
    ["about:config", "about:config"],
    ["moz-extension://abc/page.html", "extension page"],
    ["chrome://browser/content/browser.xhtml", "chrome page"],
  ])("maps %s to RESTRICTED_PAGE", async (url, title) => {
    const browser = new FakeBrowser({ tabs: [{ id: 1, url, title }] })

    expect((await describeTabError(browser, 1, RECEIVING_END)).message).toStartWith(
      "RESTRICTED_PAGE: ",
    )
  })

  test("maps a non-HTML file extension to CONTENT_SCRIPT_ERROR", async () => {
    const browser = new FakeBrowser({
      tabs: [{ id: 1, url: "https://example.com/data.json?x=1", title: "data.json" }],
    })

    expect((await describeTabError(browser, 1, RECEIVING_END)).message).toStartWith(
      "CONTENT_SCRIPT_ERROR: ",
    )
  })

  test("maps a JSON viewer title equal to host plus path to CONTENT_SCRIPT_ERROR", async () => {
    const browser = new FakeBrowser({
      tabs: [{ id: 1, url: "https://httpbin.org/get", title: "httpbin.org/get" }],
    })

    expect((await describeTabError(browser, 1, RECEIVING_END)).message).toStartWith(
      "CONTENT_SCRIPT_ERROR: ",
    )
  })

  test("falls back to CONTENT_SCRIPT_UNAVAILABLE for an ordinary page", async () => {
    const browser = new FakeBrowser({
      tabs: [{ id: 1, url: "https://example.com/", title: "Example Domain" }],
    })
    const error = await describeTabError(browser, 1, RECEIVING_END)

    expect(error.message).toStartWith("CONTENT_SCRIPT_UNAVAILABLE: ")
    expect(error.message).toContain("https://example.com/")
    expect(error.message).toContain("Example Domain")
  })

  test("tolerates a tab with no url", async () => {
    const browser = new FakeBrowser({ tabs: [{ id: 1 }] })

    expect((await describeTabError(browser, 1, RECEIVING_END)).message).toStartWith(
      "CONTENT_SCRIPT_UNAVAILABLE: ",
    )
  })

  test("tolerates a tab with an unparseable url", async () => {
    const browser = new FakeBrowser({ tabs: [{ id: 1, url: "not a url", title: "not a url" }] })

    expect((await describeTabError(browser, 1, RECEIVING_END)).message).toStartWith(
      "CONTENT_SCRIPT_UNAVAILABLE: ",
    )
  })

  test("maps a loading tab titled with host plus path to CONTENT_SCRIPT_UNAVAILABLE", async () => {
    const browser = new FakeBrowser({
      tabs: [
        { id: 7, url: "https://httpbin.org/get", title: "httpbin.org/get", status: "loading" },
      ],
    })

    expect((await describeTabError(browser, 7, RECEIVING_END)).message).toBe(
      errors.tabLoading.replace("<id>", "7").replace("<url>", "https://httpbin.org/get"),
    )
  })

  test("keeps CONTENT_SCRIPT_ERROR for a complete tab titled with host plus path", async () => {
    const browser = new FakeBrowser({
      tabs: [
        { id: 7, url: "https://httpbin.org/get", title: "httpbin.org/get", status: "complete" },
      ],
    })

    expect((await describeTabError(browser, 7, RECEIVING_END)).message).toStartWith(
      "CONTENT_SCRIPT_ERROR: ",
    )
  })

  test("maps a loading about:blank to CONTENT_SCRIPT_UNAVAILABLE", async () => {
    const browser = new FakeBrowser({
      tabs: [{ id: 3, url: "about:blank", title: "New Tab", status: "loading" }],
    })

    expect((await describeTabError(browser, 3, RECEIVING_END)).message).toBe(
      errors.tabLoading.replace("<id>", "3").replace("<url>", "about:blank"),
    )
  })

  test("keeps RESTRICTED_PAGE for a complete about:blank", async () => {
    const browser = new FakeBrowser({
      tabs: [{ id: 3, url: "about:blank", title: "New Tab", status: "complete" }],
    })

    expect((await describeTabError(browser, 3, RECEIVING_END)).message).toStartWith(
      "RESTRICTED_PAGE: ",
    )
  })

  test("keeps PAGE_LOAD_FAILED for a loading error page", async () => {
    const browser = new FakeBrowser({
      tabs: [
        { id: 4, url: "http://localhost:9/", title: "Problem loading page", status: "loading" },
      ],
    })

    expect((await describeTabError(browser, 4, RECEIVING_END)).message).toStartWith(
      "PAGE_LOAD_FAILED: ",
    )
  })

  test("names the loading tab even when its url is unknown", async () => {
    const browser = new FakeBrowser({ tabs: [{ id: 5, status: "loading" }] })

    expect((await describeTabError(browser, 5, RECEIVING_END)).message).toBe(
      errors.tabLoading.replace("<id>", "5").replace("<url>", "(none)"),
    )
  })

  test("maps a thrown string to CONTENT_SCRIPT_UNAVAILABLE only when it mentions the receiving end", async () => {
    const browser = new FakeBrowser({ tabs: [{ id: 1, url: "https://example.com/" }] })
    const error = await describeTabError(browser, 1, "Receiving end does not exist.")

    expect(error.message).toStartWith("CONTENT_SCRIPT_UNAVAILABLE: ")
  })
})
