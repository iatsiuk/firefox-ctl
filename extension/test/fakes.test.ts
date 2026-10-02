import { describe, expect, test } from "bun:test"

import type {
  Browser,
  CookieSetDetails,
  ErrorDetails,
  FrameNavigationDetails,
  HeadersReceivedDetails,
  HttpHeader,
  MessageSender,
  RedirectDetails,
  RequestBody,
  RequestDetails,
  ResponseDetails,
  SecurityInfo,
  SendHeadersDetails,
  SendMessageOptions,
  WebRequestEvent,
} from "../src/browser"
import type { Environment } from "../src/env"
import { FakeBrowser, FakeEnvironment, FakePort, type FakeStreamFilter } from "./fakes"

describe("FakePort", () => {
  test("records posted frames in order", () => {
    const port = new FakePort()
    port.postMessage({ id: "1" })
    port.postMessage({ id: "2" })
    expect(port.posted).toEqual([{ id: "1" }, { id: "2" }])
  })

  test("delivers messages to listeners in registration order", () => {
    const port = new FakePort()
    const seen: string[] = []
    port.onMessage.addListener(() => seen.push("first"))
    port.onMessage.addListener(() => seen.push("second"))
    port.emitMessage({ id: "1" })
    expect(seen).toEqual(["first", "second"])
  })

  test("stops delivering to a removed listener", () => {
    const port = new FakePort()
    const seen: unknown[] = []
    const listener = (frame: unknown) => seen.push(frame)
    port.onMessage.addListener(listener)
    expect(port.onMessage.hasListener(listener)).toBe(true)
    port.onMessage.removeListener(listener)
    expect(port.onMessage.hasListener(listener)).toBe(false)
    port.emitMessage({ id: "1" })
    expect(seen).toEqual([])
  })

  test("fires disconnect listeners once with the port and its error", () => {
    const port = new FakePort()
    const seen: FakePort[] = []
    port.onDisconnect.addListener((p) => seen.push(p as FakePort))
    port.disconnect("native host has exited")
    port.disconnect("second call is ignored")
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(port)
    expect(seen[0]?.error?.message).toBe("native host has exited")
    expect(port.disconnected).toBe(true)
  })

  test("leaves error unset when disconnecting without a reason", () => {
    const port = new FakePort()
    let received: FakePort | undefined
    port.onDisconnect.addListener((p) => {
      received = p as FakePort
    })
    port.disconnect()
    expect(received).toBe(port)
    expect(received?.error).toBeUndefined()
  })

  test("rejects postMessage after disconnect, as Firefox does", () => {
    const port = new FakePort()
    port.disconnect("gone")
    expect(() => port.postMessage({ id: "1" })).toThrow(
      "Attempt to postMessage on disconnected port",
    )
    expect(port.posted).toEqual([])
  })

  test("drops messages emitted after disconnect", () => {
    const port = new FakePort()
    const seen: unknown[] = []
    port.onMessage.addListener((frame) => seen.push(frame))
    port.disconnect()
    port.emitMessage({ id: "1" })
    expect(seen).toEqual([])
  })
})

describe("FakeBrowser.runtime", () => {
  test("connectNative records the host name and returns a fresh port", () => {
    const browser = new FakeBrowser()
    const first = browser.runtime.connectNative("firefoxctl")
    const second = browser.runtime.connectNative("firefoxctl")
    expect(browser.connectedHosts).toEqual(["firefoxctl", "firefoxctl"])
    expect(browser.ports).toEqual([first as FakePort, second as FakePort])
    expect(browser.lastPort()).toBe(second as FakePort)
    expect(first).not.toBe(second)
  })

  test("connectNative throws synchronously when failConnect is set", () => {
    const browser = new FakeBrowser()
    browser.failConnect = "No such native application firefox-ctl"
    expect(() => browser.runtime.connectNative("firefoxctl")).toThrow(
      "No such native application firefox-ctl",
    )
    expect(browser.ports).toEqual([])
    expect(browser.connectedHosts).toEqual(["firefoxctl"])
  })

  test("getManifest returns the configured version", () => {
    const browser = new FakeBrowser({ manifestVersion: "9.9.9" })
    expect(browser.runtime.getManifest().version).toBe("9.9.9")
  })

  test("emitRuntimeMessage awaits the listener return value", async () => {
    const browser = new FakeBrowser()
    browser.runtime.onMessage.addListener((message) => {
      const action = (message as { action?: string }).action
      if (action !== "getConnectionStatus") {
        return undefined
      }
      return Promise.resolve({ connected: true })
    })
    expect(await browser.emitRuntimeMessage({ action: "getConnectionStatus" })).toEqual({
      connected: true,
    })
    expect(await browser.emitRuntimeMessage({ action: "other" })).toBeUndefined()
  })

  test("emitRuntimeMessage resolves to undefined without listeners", async () => {
    const browser = new FakeBrowser()
    expect(await browser.emitRuntimeMessage({ action: "ping" })).toBeUndefined()
  })

  test("emitRuntimeMessage hands the sender to the listener", async () => {
    const browser = new FakeBrowser()
    const seen: MessageSender[] = []
    browser.runtime.onMessage.addListener((_message, sender) => {
      seen.push(sender)
      return undefined
    })
    await browser.emitRuntimeMessage({ action: "ping" }, { tab: { id: 7 }, frameId: 3 })
    expect(seen).toEqual([{ tab: { id: 7 }, frameId: 3 }])
  })

  test("connect records the port under its name and returns it", () => {
    const browser = new FakeBrowser()
    const port = browser.runtime.connect({ name: "firefox-ctl-frame" }) as FakePort
    expect(port.name).toBe("firefox-ctl-frame")
    expect(browser.connectedPorts).toEqual([port])
    expect(browser.ports).not.toContain(port)
  })

  test("emitConnect delivers a port with its sender to onConnect listeners", () => {
    const browser = new FakeBrowser()
    const seen: FakePort[] = []
    browser.runtime.onConnect.addListener((port) => seen.push(port as FakePort))
    const port = new FakePort({
      name: "firefox-ctl-frame",
      sender: { tab: { id: 16 }, frameId: 7, url: "https://sdk.example/fields.html" },
    })
    browser.emitConnect(port)
    expect(seen).toEqual([port])
    expect(seen[0]?.name).toBe("firefox-ctl-frame")
    expect(seen[0]?.sender).toEqual({
      tab: { id: 16 },
      frameId: 7,
      url: "https://sdk.example/fields.html",
    })
  })

  test("a port without an explicit name carries an empty one", () => {
    expect(new FakePort().name).toBe("")
  })
})

describe("FakeBrowser.tabs", () => {
  test("query filters by windowId and active", async () => {
    const browser = new FakeBrowser()
    browser.addTab({ id: 1, windowId: 1, active: true, url: "https://a.example" })
    browser.addTab({ id: 2, windowId: 1, active: false, url: "https://b.example" })
    browser.addTab({ id: 3, windowId: 2, active: true, url: "https://c.example" })

    expect((await browser.tabs.query({})).map((tab) => tab.id)).toEqual([1, 2, 3])
    expect((await browser.tabs.query({ windowId: 1 })).map((tab) => tab.id)).toEqual([1, 2])
    expect((await browser.tabs.query({ active: true })).map((tab) => tab.id)).toEqual([1, 3])
    expect((await browser.tabs.query({ windowId: 2, active: true })).map((tab) => tab.id)).toEqual([
      3,
    ])
  })

  test("get resolves a known tab and rejects an unknown one", async () => {
    const browser = new FakeBrowser()
    browser.addTab({ id: 7, windowId: 1, url: "https://a.example", title: "A" })
    expect((await browser.tabs.get(7)).title).toBe("A")
    expect(browser.tabs.get(8)).rejects.toThrow("Invalid tab ID: 8")
  })

  test("removeTab makes the tab unavailable and emits onRemoved", async () => {
    const browser = new FakeBrowser()
    browser.addTab({ id: 7, windowId: 1 })
    const removed: number[] = []
    browser.tabs.onRemoved.addListener((tabId) => removed.push(tabId))
    browser.removeTab(7)
    expect(removed).toEqual([7])
    expect(browser.tabs.get(7)).rejects.toThrow("Invalid tab ID: 7")
  })

  test("sendMessage uses the configured handler and rejects by default", async () => {
    const browser = new FakeBrowser()
    browser.addTab({ id: 7, windowId: 1 })
    expect(browser.tabs.sendMessage(7, { action: "ping" })).rejects.toThrow(
      "Receiving end does not exist",
    )

    browser.sendMessageHandler = (tabId, message) => Promise.resolve({ tabId, message })
    expect(await browser.tabs.sendMessage(7, { action: "ping" })).toEqual({
      tabId: 7,
      message: { action: "ping" },
    })
  })

  test("sendMessage records its options and passes them to the handler", async () => {
    const browser = new FakeBrowser()
    browser.addTab({ id: 7, windowId: 1 })
    const seen: (SendMessageOptions | undefined)[] = []
    browser.sendMessageHandler = (tabId, message, options) => {
      seen.push(options)
      return Promise.resolve({ tabId, message, options })
    }

    await browser.tabs.sendMessage(7, { action: "ping" }, { frameId: 3 })
    await browser.tabs.sendMessage(7, { action: "ping" })

    expect(seen).toEqual([{ frameId: 3 }, undefined])
    expect(browser.sentMessages).toEqual([
      { tabId: 7, message: { action: "ping" }, options: { frameId: 3 } },
      { tabId: 7, message: { action: "ping" }, options: undefined },
    ])
  })

  test("executeScript records the injection and resolves", async () => {
    const browser = new FakeBrowser()
    browser.addTab({ id: 7, windowId: 1 })

    const result = await browser.tabs.executeScript(7, {
      frameId: 3,
      file: "/dist/content.js",
      runAt: "document_idle",
    })

    expect(result).toEqual([])
    expect(browser.executeScriptCalls).toEqual([
      { tabId: 7, details: { frameId: 3, file: "/dist/content.js", runAt: "document_idle" } },
    ])
  })

  test("executeScript uses the configured handler", async () => {
    const browser = new FakeBrowser()
    browser.executeScriptHandler = () => Promise.reject(new Error("Missing host permission"))

    expect(browser.tabs.executeScript(7, { frameId: 3, file: "/dist/content.js" })).rejects.toThrow(
      "Missing host permission",
    )
    expect(browser.executeScriptCalls).toHaveLength(1)
  })

  test("emitTabUpdated notifies onUpdated listeners", () => {
    const browser = new FakeBrowser()
    browser.addTab({ id: 7, windowId: 1 })
    const seen: Array<{ tabId: number; status?: string }> = []
    browser.tabs.onUpdated.addListener((tabId, changeInfo) =>
      seen.push({ tabId, status: changeInfo.status }),
    )
    browser.emitTabUpdated(7, { status: "complete" })
    expect(seen).toEqual([{ tabId: 7, status: "complete" }])
  })
})

describe("FakeBrowser.webNavigation", () => {
  test("emitFrameLoaded notifies onDOMContentLoaded listeners", () => {
    const browser = new FakeBrowser()
    const seen: FrameNavigationDetails[] = []
    browser.webNavigation.onDOMContentLoaded.addListener((details) => seen.push(details))

    browser.emitFrameLoaded({
      tabId: 16,
      frameId: 7,
      parentFrameId: 0,
      url: "https://sdk.example/fields.html",
    })

    expect(seen).toEqual([
      {
        tabId: 16,
        frameId: 7,
        parentFrameId: 0,
        url: "https://sdk.example/fields.html",
        timeStamp: 0,
      },
    ])
  })

  test("emitFrameLoaded defaults the parent frame to the top document", () => {
    const browser = new FakeBrowser()
    const seen: FrameNavigationDetails[] = []
    browser.webNavigation.onDOMContentLoaded.addListener((details) => seen.push(details))

    browser.emitFrameLoaded({ tabId: 16, frameId: 7, url: "https://sdk.example/fields.html" })

    expect(seen[0]?.parentFrameId).toBe(0)
  })
})

describe("FakeBrowser.windows", () => {
  test("get resolves a known window and rejects an unknown one", async () => {
    const browser = new FakeBrowser()
    browser.addWindow({ id: 1, focused: true })
    expect((await browser.windows.get(1)).focused).toBe(true)
    expect(browser.windows.get(2)).rejects.toThrow("Invalid window ID: 2")
  })
})

describe("FakeBrowser.storage", () => {
  test("round trips values and reads by key", async () => {
    const browser = new FakeBrowser()
    await browser.storage.local.set({ a: 1, b: "two" })
    expect(await browser.storage.local.get()).toEqual({ a: 1, b: "two" })
    expect(await browser.storage.local.get("a")).toEqual({ a: 1 })
    expect(await browser.storage.local.get(["b", "missing"])).toEqual({ b: "two" })
  })

  test("remove drops a single key and leaves the rest", async () => {
    const browser = new FakeBrowser()
    await browser.storage.local.set({ a: 1, b: "two" })
    await browser.storage.local.remove("a")
    expect(await browser.storage.local.get()).toEqual({ b: "two" })
  })

  test("remove drops a list of keys and ignores absent ones", async () => {
    const browser = new FakeBrowser()
    await browser.storage.local.set({ a: 1, b: "two", c: 3 })
    await browser.storage.local.remove(["a", "c", "missing"])
    expect(await browser.storage.local.get()).toEqual({ b: "two" })
  })
})

describe("FakeEnvironment", () => {
  test("hands out a deterministic uuid sequence", () => {
    const env = new FakeEnvironment()
    expect(env.randomUUID()).toBe("uuid-1")
    expect(env.randomUUID()).toBe("uuid-2")
  })

  test("exposes a manual clock and no user agent", () => {
    const env = new FakeEnvironment({ now: 1000 })
    expect("userAgent" in env).toBe(false)
    expect(env.now()).toBe(1000)
    env.advance(500)
    expect(env.now()).toBe(1500)
  })

  test("fires virtual timers in due order and moves the clock to each deadline", () => {
    const env = new FakeEnvironment()
    const seen: Array<[string, number]> = []
    env.setTimeout(() => seen.push(["late", env.now()]), 200)
    env.setTimeout(() => seen.push(["early", env.now()]), 100)
    env.setTimeout(() => seen.push(["same", env.now()]), 100)

    env.advance(99)
    expect(seen).toEqual([])
    env.advance(1)
    expect(seen).toEqual([
      ["early", 100],
      ["same", 100],
    ])
    env.advance(100)
    expect(seen).toEqual([
      ["early", 100],
      ["same", 100],
      ["late", 200],
    ])
    expect(env.pendingTimers()).toBe(0)
  })

  test("runs timers scheduled from inside a timer within the same advance", () => {
    const env = new FakeEnvironment()
    const seen: number[] = []
    env.setTimeout(() => {
      seen.push(env.now())
      env.setTimeout(() => seen.push(env.now()), 10)
    }, 10)
    env.advance(25)
    expect(seen).toEqual([10, 20])
  })

  test("clearTimeout cancels a pending timer", () => {
    const env = new FakeEnvironment()
    let fired = false
    const id = env.setTimeout(() => {
      fired = true
    }, 10)
    expect(env.pendingTimers()).toBe(1)
    env.clearTimeout(id)
    expect(env.pendingTimers()).toBe(0)
    env.advance(100)
    expect(fired).toBe(false)
  })

  test("hands out distinct timer ids and ignores unknown clearTimeout", () => {
    const env = new FakeEnvironment()
    const first = env.setTimeout(() => {}, 1)
    const second = env.setTimeout(() => {}, 1)
    expect(first).not.toBe(second)
    expect(() => env.clearTimeout(9999)).not.toThrow()
  })
})

describe("injection", () => {
  test("the fakes satisfy the Browser and Environment interfaces", () => {
    const browser: Browser = new FakeBrowser()
    const env: Environment = new FakeEnvironment()
    expect(typeof browser.runtime.connectNative).toBe("function")
    expect(typeof browser.tabs.query).toBe("function")
    expect(typeof browser.windows.get).toBe("function")
    expect(typeof browser.storage.local.set).toBe("function")
    expect(typeof browser.storage.local.remove).toBe("function")
    expect(typeof env.setTimeout).toBe("function")
    expect(typeof env.clearTimeout).toBe("function")
  })
})

describe("FakeBrowser.windows lifecycle", () => {
  test("create assigns incrementing ids and seeds one active tab", async () => {
    const browser = new FakeBrowser()
    const first = await browser.windows.create({ url: "https://a.example" })
    const second = await browser.windows.create({})

    expect(first.id).toBe(1)
    expect(second.id).toBe(2)
    expect(first.type).toBe("normal")
    expect(first.incognito).toBe(false)
    expect(first.tabs?.map((tab) => tab.url)).toEqual(["https://a.example"])
    expect(first.tabs?.[0]?.id).toBe(1)
    expect(first.tabs?.[0]?.active).toBe(true)
    expect(second.tabs?.[0]?.url).toBe("about:blank")
    expect(second.tabs?.[0]?.id).toBe(2)
  })

  test("create marks the window private and its tabs incognito", async () => {
    const browser = new FakeBrowser()
    const win = await browser.windows.create({ incognito: true, focused: false })
    expect(win.incognito).toBe(true)
    expect(win.focused).toBe(false)
    expect(win.tabs?.[0]?.incognito).toBe(true)
  })

  test("create rejects a private window while failPrivate is set", async () => {
    const browser = new FakeBrowser()
    browser.failPrivate = "Extension does not have permission for incognito mode"

    expect(browser.windows.create({ incognito: true })).rejects.toThrow(
      "permission for incognito mode",
    )
    const normal = await browser.windows.create({ incognito: false })
    expect(normal.incognito).toBe(false)
  })

  test("getLastFocused returns the last focused window with its type and mode", async () => {
    const browser = new FakeBrowser()
    const normal = await browser.windows.create({})
    const popup = await browser.windows.create({})
    browser.addWindow({ id: 99, type: "popup", focused: true })

    expect((await browser.windows.getLastFocused()).id).toBe(99)
    expect((await browser.windows.getLastFocused()).type).toBe("popup")

    browser.focusWindow(popup.id as number)
    expect((await browser.windows.getLastFocused()).id).toBe(popup.id)

    browser.focusWindow(normal.id as number)
    const focused = await browser.windows.getLastFocused({ populate: true })
    expect(focused.id).toBe(normal.id)
    expect(focused.type).toBe("normal")
    expect(focused.tabs).toHaveLength(1)
  })

  test("getLastFocused rejects when no window exists", () => {
    const browser = new FakeBrowser()
    expect(browser.windows.getLastFocused()).rejects.toThrow("No window found")
  })

  test("getAll populates tabs only when asked", async () => {
    const browser = new FakeBrowser()
    await browser.windows.create({})
    await browser.windows.create({ incognito: true })

    const bare = await browser.windows.getAll()
    expect(bare.map((win) => win.id)).toEqual([1, 2])
    expect(bare[0]?.tabs).toBeUndefined()

    const populated = await browser.windows.getAll({ populate: true })
    expect(populated[1]?.tabs?.map((tab) => tab.id)).toEqual([2])
  })

  test("update merges only the provided geometry", async () => {
    const browser = new FakeBrowser()
    const win = await browser.windows.create({})
    const before = await browser.windows.get(win.id as number)

    const updated = await browser.windows.update(win.id as number, { width: 390, top: 20 })
    expect(updated.width).toBe(390)
    expect(updated.top).toBe(20)
    expect(updated.height).toBe(before.height)
    expect(updated.left).toBe(before.left)
    expect((await browser.windows.get(win.id as number)).width).toBe(390)
  })

  test("update rejects an unknown window", () => {
    const browser = new FakeBrowser()
    expect(browser.windows.update(42, { width: 100 })).rejects.toThrow("Invalid window ID: 42")
  })

  test("remove closes the window with its tabs and fires both events", async () => {
    const browser = new FakeBrowser()
    const win = await browser.windows.create({})
    const windowId = win.id as number
    const extra = await browser.tabs.create({ windowId, url: "https://b.example" })

    const removedTabs: Array<[number, boolean]> = []
    const removedWindows: number[] = []
    browser.tabs.onRemoved.addListener((tabId, info) =>
      removedTabs.push([tabId, info.isWindowClosing]),
    )
    browser.windows.onRemoved.addListener((id) => removedWindows.push(id))

    await browser.windows.remove(windowId)
    expect(removedTabs).toEqual([
      [1, true],
      [extra.id as number, true],
    ])
    expect(removedWindows).toEqual([windowId])
    expect(browser.windows.get(windowId)).rejects.toThrow(`Invalid window ID: ${windowId}`)
    expect(browser.tabs.get(extra.id as number)).rejects.toThrow("Invalid tab ID")
  })

  test("remove rejects an unknown window", () => {
    const browser = new FakeBrowser()
    expect(browser.windows.remove(3)).rejects.toThrow("Invalid window ID: 3")
  })
})

describe("FakeBrowser.tabs lifecycle", () => {
  test("create assigns ids and deactivates siblings in the same window", async () => {
    const browser = new FakeBrowser()
    const win = await browser.windows.create({})
    const windowId = win.id as number
    const second = await browser.tabs.create({ windowId, url: "https://b.example", active: true })
    const background = await browser.tabs.create({
      windowId,
      url: "https://c.example",
      active: false,
    })

    expect(second.id).toBe(2)
    expect(background.id).toBe(3)
    expect((await browser.tabs.get(1)).active).toBe(false)
    expect(second.active).toBe(true)
    expect(background.active).toBe(false)
    expect((await browser.tabs.query({ windowId, active: true })).map((tab) => tab.id)).toEqual([2])
  })

  test("create rejects an unknown window", () => {
    const browser = new FakeBrowser()
    expect(browser.tabs.create({ windowId: 5, url: "https://a.example" })).rejects.toThrow(
      "Invalid window ID: 5",
    )
  })

  test("remove fires onRemoved and cascades into windows.onRemoved for the last tab", async () => {
    const browser = new FakeBrowser()
    const win = await browser.windows.create({})
    const windowId = win.id as number
    const second = await browser.tabs.create({ windowId, url: "https://b.example" })

    const events: string[] = []
    browser.tabs.onRemoved.addListener((tabId, info) =>
      events.push(`tab:${tabId}:${info.windowId}:${info.isWindowClosing}`),
    )
    browser.windows.onRemoved.addListener((id) => events.push(`window:${id}`))

    await browser.tabs.remove(1)
    expect(events).toEqual([`tab:1:${windowId}:false`])

    await browser.tabs.remove(second.id as number)
    expect(events).toEqual([
      `tab:1:${windowId}:false`,
      `tab:${second.id}:${windowId}:true`,
      `window:${windowId}`,
    ])
    expect(browser.windows.get(windowId)).rejects.toThrow("Invalid window ID")
  })

  test("remove rejects an unknown tab", () => {
    const browser = new FakeBrowser()
    expect(browser.tabs.remove(11)).rejects.toThrow("Invalid tab ID: 11")
  })

  test("update changes the url and firing active moves onActivated", async () => {
    const browser = new FakeBrowser()
    const win = await browser.windows.create({})
    const windowId = win.id as number
    const second = await browser.tabs.create({ windowId, url: "https://b.example" })

    const activated: Array<{ tabId: number; windowId: number }> = []
    browser.tabs.onActivated.addListener((info) =>
      activated.push({ tabId: info.tabId, windowId: info.windowId }),
    )

    const navigated = await browser.tabs.update(1, { url: "https://moved.example" })
    expect(navigated.url).toBe("https://moved.example")
    expect(activated).toEqual([])

    await browser.tabs.update(1, { active: true })
    expect(activated).toEqual([{ tabId: 1, windowId }])
    expect((await browser.tabs.get(second.id as number)).active).toBe(false)
  })

  test("update rejects an unknown tab", () => {
    const browser = new FakeBrowser()
    expect(browser.tabs.update(4, { url: "https://a.example" })).rejects.toThrow(
      "Invalid tab ID: 4",
    )
  })

  test("group assigns a group id to every tab and tabGroups renames it", async () => {
    const browser = new FakeBrowser()
    const win = await browser.windows.create({})
    const windowId = win.id as number
    const second = await browser.tabs.create({ windowId, url: "https://b.example" })

    const groupId = await browser.tabs.group?.({ tabIds: [1], createProperties: { windowId } })
    expect(groupId).toBe(1)
    expect((await browser.tabs.get(1)).groupId).toBe(groupId)

    await browser.tabs.group?.({ tabIds: [second.id as number], groupId })
    expect((await browser.tabs.get(second.id as number)).groupId).toBe(groupId)

    await browser.tabGroups?.update(groupId as number, { title: "firefox-ctl", color: "orange" })
    expect(await browser.tabGroups?.query({ title: "firefox-ctl" })).toEqual([
      { id: groupId as number, title: "firefox-ctl", color: "orange", windowId },
    ])
    expect(await browser.tabGroups?.query({ title: "other" })).toEqual([])
  })

  test("tab groups are absent when the fake is built without them", async () => {
    const browser = new FakeBrowser({ tabGroups: false })
    await browser.windows.create({})
    expect(browser.tabs.group).toBeUndefined()
    expect(browser.tabGroups).toBeUndefined()
    expect((await browser.tabs.get(1)).groupId).toBeUndefined()
  })
})

describe("FakeBrowser.extension", () => {
  test("isAllowedIncognitoAccess follows the flag", async () => {
    const browser = new FakeBrowser()
    expect(await browser.extension.isAllowedIncognitoAccess()).toBe(true)

    const denied = new FakeBrowser({ allowedIncognitoAccess: false })
    expect(await denied.extension.isAllowedIncognitoAccess()).toBe(false)
    denied.allowedIncognitoAccess = true
    expect(await denied.extension.isAllowedIncognitoAccess()).toBe(true)
  })
})

describe("FakeBrowser.cookies", () => {
  const future = 4_000_000_000

  async function seeded(): Promise<FakeBrowser> {
    const browser = new FakeBrowser()
    await browser.cookies.set({ url: "https://example.com/", name: "host", value: "1" })
    await browser.cookies.set({
      url: "https://example.com/",
      name: "wide",
      value: "2",
      domain: "example.com",
      path: "/",
      expirationDate: future,
    })
    await browser.cookies.set({
      url: "https://sub.example.com/app/",
      name: "deep",
      value: "3",
      path: "/app",
      secure: true,
    })
    await browser.cookies.set({ url: "https://other.test/", name: "other", value: "4" })
    return browser
  }

  const names = (cookies: { name: string }[]) => cookies.map((cookie) => cookie.name)

  test("set without a path stores the url directory with its trailing slash", async () => {
    const browser = new FakeBrowser()
    await browser.cookies.set({ url: "https://example.com/app/login", name: "a", value: "1" })
    await browser.cookies.set({ url: "https://example.com/app", name: "b", value: "2" })
    const found = await browser.cookies.getAll({ storeId: "firefox-default" })
    expect(found.map((cookie) => `${cookie.name} ${cookie.path}`).sort()).toEqual([
      "a /app/",
      "b /",
    ])
  })

  test("getAll filters by url host, path and secure", async () => {
    const browser = await seeded()
    await browser.cookies.set({ url: "https://sub.example.com/", name: "safe", secure: true })

    expect(names(await browser.cookies.getAll({ url: "https://sub.example.com/app/x" }))).toEqual([
      "wide",
      "deep",
      "safe",
    ])
    expect(names(await browser.cookies.getAll({ url: "https://sub.example.com/" }))).toEqual([
      "wide",
      "safe",
    ])
    expect(names(await browser.cookies.getAll({ url: "http://sub.example.com/app/" }))).toEqual([
      "wide",
    ])
    expect(names(await browser.cookies.getAll({ url: "https://example.com/" }))).toEqual([
      "host",
      "wide",
    ])
  })

  test("getAll filters by domain with subdomains, by name and by store", async () => {
    const browser = await seeded()
    await browser.cookies.set({
      url: "https://example.com/",
      name: "host",
      value: "c",
      storeId: "firefox-container-1",
    })

    expect(names(await browser.cookies.getAll({ domain: "example.com" }))).toEqual([
      "host",
      "wide",
      "deep",
    ])
    expect(names(await browser.cookies.getAll({ domain: "sub.example.com" }))).toEqual(["deep"])
    expect(names(await browser.cookies.getAll({ name: "other" }))).toEqual(["other"])
    const container = await browser.cookies.getAll({ storeId: "firefox-container-1" })
    expect(container.map((cookie) => [cookie.name, cookie.value, cookie.storeId])).toEqual([
      ["host", "c", "firefox-container-1"],
    ])
  })

  test("returns full cookie fields with partitionKey null for an unpartitioned cookie", async () => {
    const browser = await seeded()
    const [host, wide] = await browser.cookies.getAll({ url: "https://example.com/" })

    expect(host).toEqual({
      name: "host",
      value: "1",
      domain: "example.com",
      hostOnly: true,
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "unspecified",
      session: true,
      storeId: "firefox-default",
      firstPartyDomain: "",
      partitionKey: null,
    })
    expect(wide?.domain).toBe(".example.com")
    expect(wide?.hostOnly).toBe(false)
    expect(wide?.session).toBe(false)
    expect(wide?.expirationDate).toBe(future)
  })

  test("an IP host is host-only and an IPv6 one comes back in brackets", async () => {
    const browser = new FakeBrowser()
    await browser.cookies.set({ url: "http://[::1]/", name: "v6", value: "1" })
    await browser.cookies.set({ url: "http://[::1]/", name: "v6d", value: "1", domain: "::1" })
    await browser.cookies.set({
      url: "http://127.0.0.1/",
      name: "v4",
      value: "1",
      domain: "127.0.0.1",
    })
    const all = await browser.cookies.getAll({})
    expect(all.map((cookie) => [cookie.name, cookie.domain, cookie.hostOnly])).toEqual([
      ["v6", "[::1]", true],
      ["v6d", "[::1]", true],
      ["v4", "127.0.0.1", true],
    ])
    expect(names(await browser.cookies.getAll({ url: "http://[::1]/" }))).toEqual(["v6", "v6d"])
  })

  test("a partitioned cookie outside the top-level site has a cross-site ancestor", async () => {
    const browser = new FakeBrowser()
    const top = "https://example.com"
    await browser.cookies.set({
      url: "https://widget.test/",
      name: "w",
      value: "0",
      partitionKey: { topLevelSite: top },
    })
    await browser.cookies.set({
      url: "https://widget.test/",
      name: "w",
      value: "1",
      partitionKey: { topLevelSite: top, hasCrossSiteAncestor: true },
    })
    await browser.cookies.set({
      url: "https://sub.example.com/",
      name: "s",
      partitionKey: { topLevelSite: top, hasCrossSiteAncestor: false },
    })
    await browser.cookies.set({
      url: "http://[::1]/",
      name: "v6",
      partitionKey: { topLevelSite: "http://[::1]" },
    })
    const all = await browser.cookies.getAll({ partitionKey: {} })
    expect(all.map((cookie) => [cookie.name, cookie.value, cookie.partitionKey])).toEqual([
      ["w", "1", { topLevelSite: top, hasCrossSiteAncestor: true }],
      ["s", "", { topLevelSite: top, hasCrossSiteAncestor: false }],
      ["v6", "", { topLevelSite: "http://[::1]", hasCrossSiteAncestor: true }],
    ])
  })

  test("rejects a partition key Firefox cannot parse or place", async () => {
    const browser = new FakeBrowser()
    const cases: [string, string, boolean | undefined][] = [
      ["https://widget.test/", "https://example.com", false],
      ["https://widget.test/", "not a url", undefined],
    ]
    for (const [url, topLevelSite, hasCrossSiteAncestor] of cases) {
      await expect(
        browser.cookies.set({
          url,
          name: "p",
          partitionKey: { topLevelSite, hasCrossSiteAncestor },
        }),
      ).rejects.toThrow("Invalid value for 'partitionKey' attribute")
    }
    expect(await browser.cookies.getAll({ partitionKey: {} })).toEqual([])
  })

  test("a partitioned cookie keeps only the site of its top-level url", async () => {
    const browser = new FakeBrowser()
    const cases: [string, string, string, boolean][] = [
      ["https://widget.example.com/", "https://shop.example.com", "https://example.com", false],
      ["https://widget.test/", "https://a.b.example.com:8443/x", "https://example.com", true],
      ["http://localhost:8080/", "http://localhost:8080", "http://localhost", false],
      ["http://127.0.0.1/", "http://127.0.0.1:9000", "http://127.0.0.1", false],
    ]
    for (const [url, topLevelSite, site, ancestor] of cases) {
      await browser.cookies.set({ url, name: "p", partitionKey: { topLevelSite } })
      const [cookie] = await browser.cookies.getAll({ url, partitionKey: {} })
      expect(cookie?.partitionKey).toEqual({ topLevelSite: site, hasCrossSiteAncestor: ancestor })
    }
  })

  test("a topLevelSite filter without url matches the site of that url", async () => {
    const browser = new FakeBrowser()
    const url = "https://widget.example.com/"
    await browser.cookies.set({ url, name: "a", partitionKey: { topLevelSite: "https://com" } })
    await browser.cookies.set({
      url,
      name: "b",
      partitionKey: { topLevelSite: "https://example.com" },
    })
    const found = await browser.cookies.getAll({
      partitionKey: { topLevelSite: "https://shop.example.com:8443/x" },
    })
    expect(names(found)).toEqual(["b"])
  })

  test("returns partitioned cookies only when asked with partitionKey {}", async () => {
    const browser = new FakeBrowser()
    await browser.cookies.set({ url: "https://a.test/", name: "plain" })
    await browser.cookies.set({
      url: "https://a.test/",
      name: "part",
      partitionKey: { topLevelSite: "https://top.test" },
    })

    expect(names(await browser.cookies.getAll({}))).toEqual(["plain"])
    const all = await browser.cookies.getAll({ partitionKey: {} })
    expect(names(all)).toEqual(["plain", "part"])
    expect(all[1]?.partitionKey).toEqual({
      topLevelSite: "https://top.test",
      hasCrossSiteAncestor: true,
    })
    const scoped = await browser.cookies.getAll({
      partitionKey: { topLevelSite: "https://top.test" },
    })
    expect(names(scoped)).toEqual(["part"])
  })

  test("firstPartyDomain null returns every first-party domain", async () => {
    const browser = new FakeBrowser()
    await browser.cookies.set({ url: "https://a.test/", name: "plain" })
    await browser.cookies.set({ url: "https://a.test/", name: "fpi", firstPartyDomain: "a.test" })

    expect(names(await browser.cookies.getAll({}))).toEqual(["plain"])
    expect(names(await browser.cookies.getAll({ firstPartyDomain: "a.test" }))).toEqual(["fpi"])
    expect(names(await browser.cookies.getAll({ firstPartyDomain: null }))).toEqual([
      "plain",
      "fpi",
    ])
  })

  test("set requires a url", async () => {
    const browser = new FakeBrowser()
    const details = { name: "x" } as unknown as CookieSetDetails
    await expect(browser.cookies.set(details)).rejects.toThrow("url")
  })

  test("set replaces a cookie with the same identity", async () => {
    const browser = new FakeBrowser()
    await browser.cookies.set({ url: "https://a.test/", name: "sid", value: "old" })
    await browser.cookies.set({ url: "https://a.test/", name: "sid", value: "new", path: "/" })
    await browser.cookies.set({
      url: "https://a.test/",
      name: "sid",
      value: "dom",
      domain: "a.test",
    })

    const cookies = await browser.cookies.getAll({})
    expect(cookies.map((cookie) => [cookie.domain, cookie.value])).toEqual([
      ["a.test", "new"],
      [".a.test", "dom"],
    ])
  })

  test("an expired set removes exactly that identity", async () => {
    const browser = new FakeBrowser()
    await browser.cookies.set({ url: "https://a.test/", name: "sid", domain: "a.test" })
    await browser.cookies.set({ url: "https://sub.a.test/", name: "sid" })

    const answer = await browser.cookies.set({
      url: "https://sub.a.test/",
      name: "sid",
      path: "/",
      expirationDate: 0,
    })

    // cookies.get(url, name) now finds the parent-domain cookie
    expect(answer?.domain).toBe(".a.test")
    const left = await browser.cookies.getAll({})
    expect(left.map((cookie) => cookie.domain)).toEqual([".a.test"])
  })

  test("the set answer is cookies.get(url, name), not necessarily the written cookie", async () => {
    const browser = new FakeBrowser()
    await browser.cookies.set({ url: "https://example.com/", name: "sid", domain: "example.com" })

    const shadowed = await browser.cookies.set({ url: "https://sub.example.com/", name: "sid" })
    const offPath = await browser.cookies.set({
      url: "https://example.com/",
      name: "app",
      path: "/app",
    })

    expect(shadowed?.domain).toBe(".example.com")
    expect(offPath).toBeNull()
    expect(browser.cookieSets).toHaveLength(3)
  })

  test("cookies differing only in firstPartyDomain or hasCrossSiteAncestor stay distinct", async () => {
    const browser = new FakeBrowser()
    const url = "https://a.test/"
    await browser.cookies.set({ url, name: "sid", value: "plain" })
    await browser.cookies.set({ url, name: "sid", value: "fpi", firstPartyDomain: "a.test" })
    const top = "https://a.test"
    await browser.cookies.set({
      url,
      name: "sid",
      value: "p0",
      partitionKey: { topLevelSite: top },
    })
    await browser.cookies.set({
      url,
      name: "sid",
      value: "p1",
      partitionKey: { topLevelSite: top, hasCrossSiteAncestor: true },
    })

    const all = await browser.cookies.getAll({ partitionKey: {}, firstPartyDomain: null })
    expect(all.map((cookie) => cookie.value)).toEqual(["plain", "fpi", "p0", "p1"])
  })

  test("rejects what Firefox rejects", async () => {
    const browser = new FakeBrowser()
    const url = "https://a.test/"
    await expect(browser.cookies.set({ url, name: "", value: "" })).rejects.toThrow("rejected")
    await expect(
      browser.cookies.set({ url, name: "n", sameSite: "no_restriction" }),
    ).rejects.toThrow("secure")
    await expect(
      browser.cookies.set({
        url,
        name: "n",
        firstPartyDomain: "a.test",
        partitionKey: { topLevelSite: "https://top.test" },
      }),
    ).rejects.toThrow("firstPartyDomain")
    await expect(browser.cookies.getAll({ storeId: "nope" })).rejects.toThrow(
      "Invalid cookie store id",
    )
    expect(await browser.cookies.getAll({})).toEqual([])
  })

  test("the private store rejects without incognito access", async () => {
    const browser = new FakeBrowser({ allowedIncognitoAccess: false })
    const storeId = "firefox-private"
    await expect(browser.cookies.getAll({ storeId })).rejects.toThrow(
      "Extension disallowed access to the private cookies storeId.",
    )
    await expect(browser.cookies.set({ url: "https://a.test/", storeId })).rejects.toThrow(
      "Extension disallowed access to the private cookies storeId.",
    )

    browser.allowedIncognitoAccess = true
    await browser.cookies.set({ url: "https://a.test/", name: "p", storeId })
    expect(names(await browser.cookies.getAll({ storeId }))).toEqual(["p"])
    expect(await browser.cookies.getAll({})).toEqual([])
  })

  test("records queries and uses cookieSetHandler when set", async () => {
    const browser = new FakeBrowser()
    browser.cookieSetHandler = (details) =>
      details.name === "bad" ? Promise.reject(new Error("nope")) : browser.writeCookie(details)

    await browser.cookies.set({ url: "https://a.test/", name: "good" })
    await expect(browser.cookies.set({ url: "https://a.test/", name: "bad" })).rejects.toThrow(
      "nope",
    )
    await browser.cookies.getAll({ name: "good" })

    expect(browser.cookieQueries).toEqual([{ name: "good" }])
    expect(names(await browser.cookies.getAll({}))).toEqual(["good"])
  })

  test("insert stores a cookie as is, one Firefox would no longer accept", async () => {
    const browser = new FakeBrowser()
    const legacy = {
      name: "old",
      value: "1",
      domain: "example.com",
      hostOnly: true,
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "no_restriction" as const,
      session: true,
      storeId: "firefox-container-1",
      firstPartyDomain: "",
      partitionKey: null,
    }
    browser.cookieJar.insert(legacy)
    legacy.value = "changed"

    const [found] = await browser.cookies.getAll({ storeId: "firefox-container-1" })
    expect(found).toEqual({ ...legacy, value: "1" })
    await browser.cookies.set({
      url: "http://example.com/",
      name: "old",
      value: "",
      expirationDate: 0,
      storeId: "firefox-container-1",
    })
    expect(await browser.cookies.getAll({ storeId: "firefox-container-1" })).toEqual([])
  })

  test("tabs carry the cookie store of their window", async () => {
    const browser = new FakeBrowser()
    const normal = await browser.windows.create({})
    const incognito = await browser.windows.create({ incognito: true })
    const tab = await browser.tabs.create({ windowId: incognito.id })

    expect(normal.tabs?.[0]?.cookieStoreId).toBe("firefox-default")
    expect(incognito.tabs?.[0]?.cookieStoreId).toBe("firefox-private")
    expect(tab.cookieStoreId).toBe("firefox-private")
  })
})

function request(overrides: Partial<RequestDetails> = {}): Omit<RequestDetails, "timeStamp"> {
  return {
    requestId: "r1",
    url: "https://example.com/",
    method: "GET",
    type: "main_frame",
    tabId: 1,
    frameId: 0,
    ...overrides,
  }
}

describe("FakeBrowser.webRequest delivery", () => {
  test("delivers only to listeners whose filter tab matches or has no tab", () => {
    const browser = new FakeBrowser()
    const seen: string[] = []
    browser.webRequest.onBeforeRequest.addListener(
      () => {
        seen.push("any")
        return undefined
      },
      { urls: ["<all_urls>"] },
    )
    browser.webRequest.onBeforeRequest.addListener(
      () => {
        seen.push("tab 1")
        return undefined
      },
      { urls: ["<all_urls>"], tabId: 1 },
    )
    browser.webRequest.onBeforeRequest.addListener(
      () => {
        seen.push("tab 2")
        return undefined
      },
      { urls: ["<all_urls>"], tabId: 2 },
    )

    browser.emitRequestStarted(request({ tabId: 1 }))
    browser.emitRequestStarted(request({ tabId: -1 }))

    expect(seen).toEqual(["any", "tab 1", "any"])
  })

  test("removeListener stops delivery on every event", () => {
    const browser = new FakeBrowser()
    const seen: string[] = []
    const filter = { urls: ["<all_urls>"], tabId: 1 }
    const sent = (details: SendHeadersDetails) => {
      seen.push(`sent ${details.requestId}`)
    }
    const received = (details: HeadersReceivedDetails) => {
      seen.push(`received ${details.requestId}`)
      return undefined
    }
    const started = (details: ResponseDetails) => {
      seen.push(`started ${details.requestId}`)
    }
    const redirected = (details: RedirectDetails) => {
      seen.push(`redirected ${details.requestId}`)
    }
    const failed = (details: ErrorDetails) => {
      seen.push(`failed ${details.requestId}`)
    }
    browser.webRequest.onSendHeaders.addListener(sent, filter)
    browser.webRequest.onHeadersReceived.addListener(received, filter)
    browser.webRequest.onResponseStarted.addListener(started, filter)
    browser.webRequest.onBeforeRedirect.addListener(redirected, filter)
    browser.webRequest.onErrorOccurred.addListener(failed, filter)

    const emitAll = (requestId: string) => {
      browser.emitSendHeaders(request({ requestId }))
      browser.emitHeadersReceived(request({ requestId }))
      browser.emitResponseStarted(request({ requestId }))
      browser.emitRedirect({ ...request({ requestId }), redirectUrl: "https://example.com/b" })
      browser.emitRequestFailed({ ...request({ requestId }), error: "NS_BINDING_ABORTED" })
    }
    emitAll("a")
    browser.webRequest.onSendHeaders.removeListener(sent)
    browser.webRequest.onHeadersReceived.removeListener(received)
    browser.webRequest.onResponseStarted.removeListener(started)
    browser.webRequest.onBeforeRedirect.removeListener(redirected)
    browser.webRequest.onErrorOccurred.removeListener(failed)
    emitAll("b")

    expect(seen).toEqual(["sent a", "received a", "started a", "redirected a", "failed a"])
    expect(browser.webRequest.onSendHeaders.hasListener(sent)).toBe(false)
  })

  test("each event accepts only the extraInfoSpec values Firefox accepts", () => {
    const browser = new FakeBrowser()
    const filter = { urls: ["<all_urls>"] }
    const noop = () => undefined
    const accepted: [string, WebRequestEvent<() => undefined>, string[]][] = [
      ["onBeforeRequest", browser.webRequest.onBeforeRequest, ["blocking", "requestBody"]],
      ["onSendHeaders", browser.webRequest.onSendHeaders, ["requestHeaders"]],
      ["onHeadersReceived", browser.webRequest.onHeadersReceived, ["blocking", "responseHeaders"]],
      ["onResponseStarted", browser.webRequest.onResponseStarted, ["responseHeaders"]],
      ["onBeforeRedirect", browser.webRequest.onBeforeRedirect, ["responseHeaders"]],
      ["onCompleted", browser.webRequest.onCompleted, ["responseHeaders"]],
    ]
    for (const [name, event, specs] of accepted) {
      expect(() => event.addListener(noop, filter, specs)).not.toThrow()
      expect(() => event.addListener(noop, filter, [])).not.toThrow()
      expect(() => event.addListener(noop, filter)).not.toThrow()
      for (const wrong of ["requestBody", "requestHeaders", "responseHeaders", "blocking"]) {
        if (specs.includes(wrong)) {
          continue
        }
        expect(() => event.addListener(noop, filter, [wrong])).toThrow(
          `Invalid enumeration value "${wrong}") for webRequest.${name}.addListener`,
        )
      }
      expect(() => event.addListener(noop, filter, ["extraHeaders"])).toThrow(
        "Invalid enumeration value",
      )
    }
  })

  test("onErrorOccurred accepts no extraInfoSpec at all", () => {
    const browser = new FakeBrowser()
    const failed = browser.webRequest.onErrorOccurred as WebRequestEvent<() => void>
    const filter = { urls: ["<all_urls>"] }

    expect(() => failed.addListener(() => {}, filter, [])).toThrow(
      "Incorrect argument types for webRequest.onErrorOccurred.addListener.",
    )
    expect(() => failed.addListener(() => {}, filter)).not.toThrow()
  })

  test("a rejected addListener registers nothing", () => {
    const browser = new FakeBrowser()

    expect(() =>
      browser.webRequest.onSendHeaders.addListener(() => {}, { urls: ["<all_urls>"] }, [
        "blocking",
      ]),
    ).toThrow()

    expect(browser.headersSent.listeners).toHaveLength(0)
  })

  test("optional details reach only listeners that asked for them", () => {
    const browser = new FakeBrowser()
    const filter = { urls: ["<all_urls>"] }
    const bodies: (RequestBody | null | undefined)[] = []
    const requestHeaders: (HttpHeader[] | undefined)[] = []
    const responseHeaders: (HttpHeader[] | undefined)[] = []
    for (const spec of [["requestBody"], []]) {
      browser.webRequest.onBeforeRequest.addListener(
        (details) => {
          bodies.push(details.requestBody)
          return undefined
        },
        filter,
        spec,
      )
    }
    for (const spec of [["requestHeaders"], []]) {
      browser.webRequest.onSendHeaders.addListener(
        (details) => {
          requestHeaders.push(details.requestHeaders)
        },
        filter,
        spec,
      )
    }
    for (const spec of [["responseHeaders"], []]) {
      browser.webRequest.onCompleted.addListener(
        (details) => {
          responseHeaders.push(details.responseHeaders)
        },
        filter,
        spec,
      )
    }
    const body: RequestBody = { formData: { a: ["1"] } }
    const headers = [{ name: "X-A", value: "1" }]

    browser.emitRequestStarted(request({ requestBody: body }))
    browser.emitSendHeaders({ ...request(), requestHeaders: headers })
    browser.emitRequestCompleted({ ...request(), responseHeaders: headers })

    expect(bodies).toEqual([body, undefined])
    expect(requestHeaders).toEqual([headers, undefined])
    expect(responseHeaders).toEqual([headers, undefined])
  })

  test("a request without a body reaches a requestBody listener as null", () => {
    const browser = new FakeBrowser()
    const filter = { urls: ["<all_urls>"] }
    const bodies: (RequestBody | null | undefined)[] = []
    for (const spec of [["requestBody"], []]) {
      browser.webRequest.onBeforeRequest.addListener(
        (details) => {
          bodies.push(details.requestBody)
          return undefined
        },
        filter,
        spec,
      )
    }

    browser.emitRequestStarted(request())

    expect(bodies).toEqual([null, undefined])
  })

  test("emitters default timeStamp to the fake clock and fill response fields", () => {
    let clock = 1000
    const browser = new FakeBrowser({ now: () => clock })
    const filter = { urls: ["<all_urls>"] }
    const stamps: number[] = []
    const responses: ResponseDetails[] = []
    const redirects: RedirectDetails[] = []
    browser.webRequest.onBeforeRequest.addListener((details) => {
      stamps.push(details.timeStamp)
      return undefined
    }, filter)
    browser.webRequest.onSendHeaders.addListener((details) => {
      stamps.push(details.timeStamp)
    }, filter)
    browser.webRequest.onHeadersReceived.addListener((details) => {
      stamps.push(details.timeStamp)
      return undefined
    }, filter)
    browser.webRequest.onResponseStarted.addListener((details) => {
      responses.push(details)
    }, filter)
    browser.webRequest.onBeforeRedirect.addListener((details) => {
      redirects.push(details)
    }, filter)
    browser.webRequest.onErrorOccurred.addListener((details) => {
      stamps.push(details.timeStamp)
    }, filter)

    browser.emitRequestStarted(request())
    clock = 1005
    browser.emitSendHeaders(request())
    clock = 1010
    browser.emitHeadersReceived(request())
    browser.emitResponseStarted(request())
    browser.emitRedirect({ ...request(), redirectUrl: "https://example.com/b" })
    browser.emitRequestFailed({ ...request(), error: "x", timeStamp: 7 })

    expect(stamps).toEqual([1000, 1005, 1010, 7])
    expect(responses[0]).toMatchObject({
      timeStamp: 1010,
      statusCode: 200,
      statusLine: "HTTP/1.1 200",
      fromCache: false,
    })
    expect(redirects[0]).toMatchObject({
      statusCode: 302,
      statusLine: "HTTP/1.1 302",
      redirectUrl: "https://example.com/b",
      fromCache: false,
    })
  })

  test("an emitter awaits a blocking listener's promise before it resolves", async () => {
    const browser = new FakeBrowser()
    const filter = { urls: ["<all_urls>"] }
    let release: (() => void) | undefined
    browser.webRequest.onHeadersReceived.addListener(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined)
        }),
      filter,
      ["blocking"],
    )
    browser.webRequest.onBeforeRequest.addListener(
      () => Promise.resolve({ cancel: true }),
      filter,
      ["blocking"],
    )

    let settled = false
    const emitted = browser.emitHeadersReceived(request()).then((results) => {
      settled = true
      return results
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    release?.()

    expect(await emitted).toEqual([undefined])
    expect(await browser.emitRequestStarted(request())).toEqual([{ cancel: true }])
  })

  test("a non-blocking listener's return value is not awaited", async () => {
    const browser = new FakeBrowser()
    browser.webRequest.onBeforeRequest.addListener(() => new Promise<undefined>(() => {}), {
      urls: ["<all_urls>"],
    })

    expect(await browser.emitRequestStarted(request())).toEqual([])
  })
})

describe("FakeStreamFilter", () => {
  test("follows the public status values through a full transfer", () => {
    const browser = new FakeBrowser()
    const filter = browser.webRequest.filterResponseData("r1")
    const events: string[] = []
    filter.onstart = () => events.push(`start ${filter.status}`)
    filter.ondata = (event) => {
      events.push(`data ${new TextDecoder().decode(event.data)}`)
      filter.write(event.data)
    }
    filter.onstop = () => {
      events.push(`stop ${filter.status}`)
      filter.close()
    }
    const fake = browser.streamFilterFor("r1") as FakeStreamFilter

    expect(filter.status).toBe("uninitialized")
    fake.pushStart()
    fake.pushData("ab")
    fake.pushData("cd")
    fake.pushStop()

    expect(events).toEqual([
      "start transferringdata",
      "data ab",
      "data cd",
      "stop finishedtransferringdata",
    ])
    expect(filter.status).toBe("closed")
    expect(fake.written.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["ab", "cd"])
    expect(new TextDecoder().decode(fake.pageData())).toBe("abcd")
  })

  test("an error moves the filter to failed with its message", () => {
    const browser = new FakeBrowser()
    const filter = browser.webRequest.filterResponseData("r1")
    const errors: string[] = []
    filter.onerror = () => errors.push(`${filter.status} ${filter.error}`)

    browser.streamFilterFor("r1")?.pushError("Channel redirected")

    expect(errors).toEqual(["failed Channel redirected"])
  })

  test("disconnect passes later data straight to the page", () => {
    const browser = new FakeBrowser()
    const filter = browser.webRequest.filterResponseData("r1")
    const seen: string[] = []
    filter.ondata = (event) => {
      seen.push(new TextDecoder().decode(event.data))
      filter.write(event.data)
      filter.disconnect()
    }
    const fake = browser.streamFilterFor("r1") as FakeStreamFilter

    fake.pushStart()
    fake.pushData("ab")
    fake.pushData("cd")
    fake.pushStop()

    expect(filter.status).toBe("disconnected")
    expect(seen).toEqual(["ab"])
    expect(new TextDecoder().decode(fake.pageData())).toBe("abcd")
    expect(() => filter.disconnect()).not.toThrow()
  })

  test("disconnect throws before onstart, after close and after an error", () => {
    const browser = new FakeBrowser()
    const early = browser.webRequest.filterResponseData("early")
    const closed = browser.webRequest.filterResponseData("closed")
    const failed = browser.webRequest.filterResponseData("failed")
    browser.streamFilterFor("closed")?.pushStart()
    closed.close()
    browser.streamFilterFor("failed")?.pushError("boom")

    expect(() => early.disconnect()).toThrow("NS_ERROR_FAILURE")
    expect(() => closed.disconnect()).toThrow("NS_ERROR_FAILURE")
    expect(() => failed.disconnect()).toThrow("NS_ERROR_FAILURE")
  })

  test("disconnect works while transferring and after the stop", () => {
    const browser = new FakeBrowser()
    const transferring = browser.webRequest.filterResponseData("a")
    const finished = browser.webRequest.filterResponseData("b")
    browser.streamFilterFor("a")?.pushStart()
    browser.streamFilterFor("b")?.pushStart()
    browser.streamFilterFor("b")?.pushStop()

    transferring.disconnect()
    finished.disconnect()

    expect(transferring.status).toBe("disconnected")
    expect(finished.status).toBe("disconnected")
  })

  test("write and close throw where Firefox throws", () => {
    const browser = new FakeBrowser()
    const filter = browser.webRequest.filterResponseData("r1")

    expect(() => filter.write(new Uint8Array([1]))).toThrow("NS_ERROR_FAILURE")
    expect(() => filter.close()).toThrow("NS_ERROR_FAILURE")
    browser.streamFilterFor("r1")?.pushStart()
    filter.write(new Uint8Array([1]))
    filter.close()
    expect(() => filter.close()).not.toThrow()
    expect(() => filter.write(new Uint8Array([2]))).toThrow("NS_ERROR_FAILURE")
    expect(browser.streamFilterFor("r1")?.written).toEqual([new Uint8Array([1])])
  })

  test("a written chunk is a copy of what the listener passed", () => {
    const browser = new FakeBrowser()
    const filter = browser.webRequest.filterResponseData("r1")
    browser.streamFilterFor("r1")?.pushStart()
    const chunk = new Uint8Array([1, 2])

    filter.write(chunk)
    chunk[0] = 9

    expect(browser.streamFilterFor("r1")?.written).toEqual([new Uint8Array([1, 2])])
  })

  test("data after close or an error never reaches the listener", () => {
    const browser = new FakeBrowser()
    const filter = browser.webRequest.filterResponseData("r1")
    const seen: number[] = []
    filter.ondata = (event) => seen.push(event.data.byteLength)
    const fake = browser.streamFilterFor("r1") as FakeStreamFilter
    fake.pushStart()
    filter.close()

    fake.pushData("late")
    fake.pushStop()
    fake.pushError("late")

    expect(seen).toEqual([])
    expect(filter.status).toBe("closed")
  })

  test("filterResponseData records every filter and can be scripted to throw", () => {
    const browser = new FakeBrowser()
    browser.webRequest.filterResponseData("r1")
    browser.webRequest.filterResponseData("r1")

    expect(browser.streamFilters.map((entry) => entry.requestId)).toEqual(["r1", "r1"])
    expect(browser.streamFilterFor("r1")).toBe(browser.streamFilters[1]?.filter)
    browser.failFilterResponseData = "Invalid request ID"
    expect(() => browser.webRequest.filterResponseData("r2")).toThrow("Invalid request ID")
    expect(browser.streamFilters).toHaveLength(2)
  })
})

describe("FakeBrowser.webRequest.getSecurityInfo", () => {
  const info: SecurityInfo = {
    state: "secure",
    protocolVersion: "TLSv1.3",
    certificates: [],
  }

  test("answers the scripted value inside a pending blocking onHeadersReceived", async () => {
    const browser = new FakeBrowser()
    browser.securityInfo = info
    const answers: (SecurityInfo | undefined)[] = []
    browser.webRequest.onHeadersReceived.addListener(
      async (details) => {
        answers.push(await browser.webRequest.getSecurityInfo(details.requestId, {}))
        return undefined
      },
      { urls: ["<all_urls>"] },
      ["blocking"],
    )

    await browser.emitHeadersReceived(request({ requestId: "r7" }))

    expect(answers).toEqual([info])
    expect(browser.securityInfoCalls).toEqual([{ requestId: "r7", options: {}, blocking: true }])
  })

  test("records a call after the blocking window and answers undefined", async () => {
    const browser = new FakeBrowser()
    browser.securityInfo = info
    const pending: Promise<SecurityInfo | undefined>[] = []
    browser.webRequest.onHeadersReceived.addListener(
      (details) => {
        pending.push(
          Promise.resolve().then(() => browser.webRequest.getSecurityInfo(details.requestId, {})),
        )
        return undefined
      },
      { urls: ["<all_urls>"] },
      ["blocking"],
    )

    await browser.emitHeadersReceived(request())

    expect(await pending[0]).toBeUndefined()
    expect(browser.securityInfoCalls[0]?.blocking).toBe(false)
  })

  test("a non-blocking listener does not open the window", async () => {
    const browser = new FakeBrowser()
    browser.securityInfo = info
    let answer: Promise<SecurityInfo | undefined> | undefined
    browser.webRequest.onHeadersReceived.addListener(
      (details) => {
        answer = browser.webRequest.getSecurityInfo(details.requestId, {})
        return undefined
      },
      { urls: ["<all_urls>"] },
    )

    await browser.emitHeadersReceived(request())

    expect(await answer).toBeUndefined()
    expect(browser.securityInfoCalls[0]?.blocking).toBe(false)
  })

  test("rejects with a scripted error", async () => {
    const browser = new FakeBrowser()
    browser.securityInfo = new Error("no security info")
    let answer: Promise<SecurityInfo | undefined> | undefined
    browser.webRequest.onHeadersReceived.addListener(
      (details) => {
        answer = browser.webRequest.getSecurityInfo(details.requestId, {})
        return answer.then(() => undefined).catch(() => undefined)
      },
      { urls: ["<all_urls>"] },
      ["blocking"],
    )

    await browser.emitHeadersReceived(request())

    await expect(answer as Promise<unknown>).rejects.toThrow("no security info")
  })

  test("the window belongs to the request that is blocked", async () => {
    const browser = new FakeBrowser()
    browser.securityInfo = info
    let other: Promise<SecurityInfo | undefined> | undefined
    browser.webRequest.onHeadersReceived.addListener(
      async () => {
        other = browser.webRequest.getSecurityInfo("other", {})
        return undefined
      },
      { urls: ["<all_urls>"] },
      ["blocking"],
    )

    await browser.emitHeadersReceived(request())

    expect(await other).toBeUndefined()
  })
})

describe("FakeBrowser.webNavigation lifecycle", () => {
  test("emits onBeforeNavigate, onCommitted and onCompleted with the fake clock", () => {
    const browser = new FakeBrowser({ now: () => 42 })
    const seen: string[] = []
    const before = (details: FrameNavigationDetails) =>
      seen.push(`before ${details.frameId} ${details.timeStamp}`)
    browser.webNavigation.onBeforeNavigate.addListener(before)
    browser.webNavigation.onCommitted.addListener((details) =>
      seen.push(`committed ${details.url} ${details.timeStamp}`),
    )
    browser.webNavigation.onDOMContentLoaded.addListener((details) =>
      seen.push(`loaded ${details.timeStamp}`),
    )
    browser.webNavigation.onCompleted.addListener((details) =>
      seen.push(`completed ${details.parentFrameId} ${details.timeStamp}`),
    )

    browser.emitBeforeNavigate({ tabId: 1, frameId: 0, url: "https://example.com/" })
    browser.emitCommitted({ tabId: 1, frameId: 0, url: "https://example.com/", timeStamp: 50 })
    browser.emitFrameLoaded({ tabId: 1, frameId: 0, url: "https://example.com/" })
    browser.emitNavigationCompleted({
      tabId: 1,
      frameId: 0,
      parentFrameId: -1,
      url: "https://example.com/",
    })
    browser.webNavigation.onBeforeNavigate.removeListener(before)
    browser.emitBeforeNavigate({ tabId: 1, frameId: 0, url: "https://example.com/" })

    expect(seen).toEqual([
      "before 0 42",
      "committed https://example.com/ 50",
      "loaded 42",
      "completed -1 42",
    ])
  })
})
