import { describe, expect, test } from "bun:test"

import { AttachedTabs } from "../src/attached"
import type { StorageArea } from "../src/browser"
import { CaptureLocks } from "../src/capture-locks"
import commandTable from "../src/commands.json"
import { INTERNAL_ACTIONS } from "../src/content/actions"
import type { HandlerDeps } from "../src/dispatch"
import { createDispatcher } from "../src/dispatch"
import { FrameRegistry } from "../src/frames"
import { executeInTab, PAGE_COMMANDS, pageHandlers } from "../src/handlers/dom"
import { NetworkTracker } from "../src/network"
import { pageActions } from "../src/page"
import type { JsonObject } from "../src/protocol"
import { commandContext } from "../src/protocol"
import { waitForPageReady } from "../src/readiness"
import { Session } from "../src/session"
import { writeEvaluateEnabled } from "../src/settings"
import { FakeBrowser, FakeEnvironment } from "./fakes"
import errors from "./fixtures/errors.json"

const RECEIVING_END = "Could not establish connection. Receiving end does not exist."

interface Sent {
  tabId: number
  action: string
  params: JsonObject
}

interface Harness {
  browser: FakeBrowser
  deps: HandlerDeps
  sent: Sent[]
  tabId: number
  run(command: string, params?: JsonObject): Promise<JsonObject>
}

/** A managed window with one tab, plus a recorder for every tab message. */
function harness(options: { url?: string; active?: boolean } = {}): Harness {
  const browser = new FakeBrowser()
  const env = new FakeEnvironment({ now: 1000 })
  const session = new Session(browser, env)
  const attached = new AttachedTabs(browser, env)
  const deps: HandlerDeps = {
    browser,
    env,
    session,
    attached,
    network: new NetworkTracker(env),
    captureLocks: new CaptureLocks(),
    frames: new FrameRegistry(env),
    readiness: waitForPageReady,
    ctx: commandContext({}, env),
  }
  const tabId = 1
  browser.addWindow({ id: 1, focused: true })
  browser.currentWindowId = 1
  browser.addTab({
    id: tabId,
    windowId: 1,
    index: 0,
    url: options.url ?? "https://example.com/",
    title: "Example Domain",
    active: options.active ?? true,
  })
  session.state = {
    windowId: 1,
    tabs: [tabId],
    createdAt: 1000,
    groupId: null,
    isPrivate: false,
    adopted: false,
  }
  session.activeTabId = tabId
  const sent: Sent[] = []
  const h: Harness = {
    browser,
    deps,
    sent,
    tabId,
    run: async (command, params = {}) => {
      const handler = pageHandlers[command as (typeof PAGE_COMMANDS)[number]]
      if (!handler) {
        throw new Error(`no handler for ${command}`)
      }
      return (await handler(params, deps)) as JsonObject
    },
  }
  browser.sendMessageHandler = (messageTabId, message) => {
    const frame = message as { action: string; params: JsonObject }
    sent.push({ tabId: messageTabId, action: frame.action, params: frame.params })
    return Promise.resolve({ success: true, result: { ok: true } })
  }
  return h
}

describe("executeInTab", () => {
  test("returns the result of a successful content reply", async () => {
    const h = harness()

    const result = await executeInTab(h.browser, h.tabId, "getContent", { maxLength: 10 })

    expect(result).toEqual({ ok: true })
    expect(h.sent).toEqual([{ tabId: h.tabId, action: "getContent", params: { maxLength: 10 } }])
  })

  test("turns a failed content reply into an error carrying its text", async () => {
    const h = harness()
    h.browser.sendMessageHandler = () =>
      Promise.resolve({ success: false, error: "Element not found: #missing" })

    await expect(executeInTab(h.browser, h.tabId, "click", {})).rejects.toThrow(
      "Element not found: #missing",
    )
  })

  test("maps an unreachable content script on a restricted page", async () => {
    const h = harness({ url: "about:config" })
    h.browser.sendMessageHandler = () => Promise.reject(new Error(RECEIVING_END))

    await expect(executeInTab(h.browser, h.tabId, "getContent", {})).rejects.toThrow(
      /^RESTRICTED_PAGE: /,
    )
  })

  test("maps an unreachable content script in a tab that is gone", async () => {
    const h = harness()
    h.browser.sendMessageHandler = () => Promise.reject(new Error(RECEIVING_END))
    await h.browser.tabs.remove(h.tabId)

    await expect(executeInTab(h.browser, h.tabId, "getContent", {})).rejects.toThrow(
      /^TAB_CLOSED: /,
    )
  })

  test("keeps an unrelated messaging failure", async () => {
    const h = harness()
    h.browser.sendMessageHandler = () => Promise.reject(new Error("boom"))

    await expect(executeInTab(h.browser, h.tabId, "getContent", {})).rejects.toThrow("boom")
  })

  test("reports a reply that is not an action response", async () => {
    const h = harness()
    h.browser.sendMessageHandler = () => Promise.resolve(undefined)

    await expect(executeInTab(h.browser, h.tabId, "getContent", {})).rejects.toThrow(
      /^CONTENT_SCRIPT_ERROR: /,
    )
  })

  test("reports a failed reply with no error text as not an action response", async () => {
    const h = harness()
    h.browser.sendMessageHandler = () => Promise.resolve({ success: false })

    await expect(executeInTab(h.browser, h.tabId, "getContent", {})).rejects.toThrow(
      /^CONTENT_SCRIPT_ERROR: /,
    )
  })

  test("reports a successful reply with no result as not an action response", async () => {
    const h = harness()
    h.browser.sendMessageHandler = () => Promise.resolve({ success: true })

    await expect(executeInTab(h.browser, h.tabId, "getContent", {})).rejects.toThrow(
      /^CONTENT_SCRIPT_ERROR: /,
    )
  })

  test("reports a successful reply with an undefined result as not an action response", async () => {
    const h = harness()
    h.browser.sendMessageHandler = () => Promise.resolve({ success: true, result: undefined })

    await expect(executeInTab(h.browser, h.tabId, "getContent", {})).rejects.toThrow(
      /^CONTENT_SCRIPT_ERROR: /,
    )
  })
})

describe("page command handlers", () => {
  test.each([...PAGE_COMMANDS])("%s forwards to the action of the same name", async (command) => {
    const h = harness()
    // evaluate is the one page command behind an opt-in
    await writeEvaluateEnabled(h.browser, true)

    const result = await h.run(command)

    expect(h.sent[0]?.action).toBe(command)
    expect(result).toMatchObject({ tabId: h.tabId, ok: true })
  })

  test.each([...PAGE_COMMANDS])("%s names the top frame explicitly", async (command) => {
    const h = harness()
    await writeEvaluateEnabled(h.browser, true)

    await h.run(command)

    expect(h.browser.sentMessages.map((sent) => sent.options)).toEqual(
      h.browser.sentMessages.map(() => ({ frameId: 0 })),
    )
    expect(h.browser.sentMessages).not.toHaveLength(0)
  })

  test("merges the tab id into the content result", async () => {
    const h = harness()
    h.browser.sendMessageHandler = () =>
      Promise.resolve({ success: true, result: { selector: "h1", text: "Example" } })

    expect(await h.run("getContent", { selector: "h1" })).toEqual({
      tabId: h.tabId,
      selector: "h1",
      text: "Example",
    })
  })

  test("strips the targeting params before forwarding", async () => {
    const h = harness()

    await h.run("click", { selector: "#go", tabId: h.tabId, windowId: 1 })

    expect(h.sent[0]?.params).toEqual({ selector: "#go" })
  })

  test("forwards the getPageState limits to the content script", async () => {
    const h = harness()

    await h.run("getPageState", { maxHeadings: 5, maxLinks: 7 })

    expect(h.sent[0]?.params).toEqual({ maxHeadings: 5, maxLinks: 7 })
  })

  test("fails with the content error text", async () => {
    const h = harness()
    h.browser.sendMessageHandler = () =>
      Promise.resolve({ success: false, error: errors.selectorEmpty })

    await expect(h.run("type", { selector: "", text: "hi" })).rejects.toThrow(errors.selectorEmpty)
  })

  test("reports a tabId that names a closed tab before messaging it", async () => {
    const h = harness()

    await expect(h.run("getContent", { tabId: 404 })).rejects.toThrow(
      errors.tabClosed.replace("<id>", "404"),
    )
    expect(h.sent).toHaveLength(0)
  })
})

describe("evaluate gate", () => {
  test("refuses evaluate while the opt-in is unset and messages no tab", async () => {
    const h = harness()

    await expect(h.run("evaluate", { expression: "1 + 1" })).rejects.toThrow(
      "EVALUATE_DISABLED: evaluate is disabled; enable it in the add-on preferences " +
        "(about:addons > Terminal Control for Firefox > Preferences)",
    )
    expect(h.sent).toHaveLength(0)
  })

  test("forwards the expression once the opt-in is stored", async () => {
    const h = harness()
    await writeEvaluateEnabled(h.browser, true)

    const result = await h.run("evaluate", { expression: "1 + 1" })

    expect(result).toMatchObject({ tabId: h.tabId, ok: true })
    expect(h.sent).toEqual([
      { tabId: h.tabId, action: "evaluate", params: { expression: "1 + 1" } },
    ])
  })

  test("reads the setting per call, so a toggle needs no restart", async () => {
    const h = harness()
    await writeEvaluateEnabled(h.browser, true)
    await h.run("evaluate", { expression: "1" })

    await writeEvaluateEnabled(h.browser, false)
    await expect(h.run("evaluate", { expression: "1" })).rejects.toThrow(/^EVALUATE_DISABLED: /)

    await writeEvaluateEnabled(h.browser, true)
    await h.run("evaluate", { expression: "1" })
    expect(h.sent).toHaveLength(2)
  })

  test("fails closed when the settings read rejects", async () => {
    const h = harness()
    await writeEvaluateEnabled(h.browser, true)
    const broken: StorageArea = {
      get: () => Promise.reject(new Error("storage offline")),
      set: (items) => h.browser.storage.local.set(items),
      remove: (keys) => h.browser.storage.local.remove(keys),
    }
    const deps = { ...h.deps, browser: { ...h.browser, storage: { local: broken } } }

    await expect(pageHandlers.evaluate({ expression: "1" }, deps)).rejects.toThrow(
      /^EVALUATE_DISABLED: /,
    )
    expect(h.sent).toHaveLength(0)
  })
})

describe("scroll handler", () => {
  test("warns that a background tab does not scroll", async () => {
    const h = harness({ active: false })
    h.browser.sendMessageHandler = () =>
      Promise.resolve({ success: true, result: { scrolledTo: true, noEffect: true } })

    expect(await h.run("scroll", { y: 200 })).toEqual({
      tabId: h.tabId,
      scrolledTo: true,
      noEffect: true,
      backgroundTab: true,
      hint: "Scroll has no effect on background tabs. Switch tab to active first.",
    })
  })

  test("says nothing about background tabs for the active tab", async () => {
    const h = harness({ active: true })
    h.browser.sendMessageHandler = () =>
      Promise.resolve({ success: true, result: { scrolledTo: true, noEffect: false } })

    expect(await h.run("scroll", { y: 200 })).toEqual({
      tabId: h.tabId,
      scrolledTo: true,
      noEffect: false,
    })
  })
})

describe("registration", () => {
  test("the dispatcher answers every page command", () => {
    const dispatcher = createDispatcher(new FakeBrowser(), new FakeEnvironment({}))
    for (const command of PAGE_COMMANDS) {
      expect(`${command}: ${dispatcher.has(command)}`).toBe(`${command}: true`)
    }
  })

  test("the dispatcher answers the background devtools commands", () => {
    const dispatcher = createDispatcher(new FakeBrowser(), new FakeEnvironment({}))
    for (const command of ["screenshot", "getNetworkRequests"]) {
      expect(`${command}: ${dispatcher.has(command)}`).toBe(`${command}: true`)
    }
  })

  test("the content script serves exactly the page commands and the internal actions", () => {
    const served = Object.keys(pageActions).filter(
      (name) => !INTERNAL_ACTIONS.includes(name as (typeof INTERNAL_ACTIONS)[number]),
    )
    expect(served.sort()).toEqual([...PAGE_COMMANDS].sort())
  })

  test("no internal action is a CLI command", () => {
    for (const action of INTERNAL_ACTIONS) {
      expect(`${action}: ${commandTable.some((entry) => entry.name === action)}`).toBe(
        `${action}: false`,
      )
    }
  })

  test("every page command is declared in the CLI command table", () => {
    for (const command of PAGE_COMMANDS) {
      const spec = commandTable.find((entry) => entry.name === command)
      const flags = new Set(spec?.flags.map((flag) => flag.name))
      expect(`${command}: ${spec !== undefined}`).toBe(`${command}: true`)
      expect(`${command} --tabId: ${flags.has("tabId")}`).toBe(`${command} --tabId: true`)
      expect(`${command} --windowId: ${flags.has("windowId")}`).toBe(`${command} --windowId: true`)
    }
  })

  test("version announces the dom and frames features", async () => {
    const browser = new FakeBrowser()
    const response = await createDispatcher(browser, new FakeEnvironment({})).handle({
      id: "frame-1",
      type: "command",
      command: "version",
      params: {},
    })

    expect(response).toMatchObject({
      success: true,
      result: { features: ["sessions", "dom", "devtools", "frames"] },
    })
  })
})
