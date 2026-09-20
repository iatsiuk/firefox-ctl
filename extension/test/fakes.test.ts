import { describe, expect, test } from "bun:test"

import type {
  Browser,
  FrameNavigationDetails,
  MessageSender,
  SendMessageOptions,
} from "../src/browser"
import type { Environment } from "../src/env"
import { FakeBrowser, FakeEnvironment, FakePort } from "./fakes"

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
