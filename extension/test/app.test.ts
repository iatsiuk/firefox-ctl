import { describe, expect, test } from "bun:test"
import { start } from "../src/app"
import type { ExtensionResponse, HostCommand, JsonObject } from "../src/protocol"
import { GROUP_TITLE, WINDOW_STATE_KEY } from "../src/session"
import { FakeBrowser, FakeEnvironment, type FakePort } from "./fakes"

function hostCommand(id: string, command: string, params: JsonObject = {}): HostCommand {
  return { id, type: "command", command, params }
}

function livePort(browser: FakeBrowser): FakePort {
  const port = browser.lastPort()
  if (!port) {
    throw new Error("no port was created")
  }
  return port
}

// the reply travels through an awaited dispatcher, so give the microtasks a turn
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve()
  }
}

/** Sends one host frame and waits for its reply. */
async function run(
  port: FakePort,
  id: string,
  command: string,
  params: JsonObject = {},
): Promise<ExtensionResponse> {
  port.emitMessage(hostCommand(id, command, params))
  for (let i = 0; i < 100 && port.posted.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const reply = port.posted.shift() as ExtensionResponse
  if (!reply) {
    throw new Error(`no reply for ${command}`)
  }
  return reply
}

function result(reply: ExtensionResponse): JsonObject {
  if (!reply.success) {
    throw new Error(`${reply.error}`)
  }
  return reply.result as JsonObject
}

function number(object: JsonObject, key: string): number {
  const value = object[key]
  if (typeof value !== "number") {
    throw new Error(`${key} is ${String(value)}, not a number`)
  }
  return value
}

describe("start", () => {
  test("connects to the native host on load", () => {
    const browser = new FakeBrowser()
    const handle = start(browser, new FakeEnvironment())
    expect(browser.connectedHosts).toEqual(["firefoxctl"])
    expect(handle.link.status()).toEqual({
      connected: true,
      attempt: 0,
      lastDisconnectReason: null,
      reconnectScheduled: false,
    })
  })

  test("answers a host ping with the environment clock", async () => {
    const browser = new FakeBrowser()
    start(browser, new FakeEnvironment({ now: 1234 }))
    const port = livePort(browser)
    port.emitMessage(hostCommand("a1", "ping"))
    await settle()
    expect(port.posted).toEqual([
      { id: "a1", success: true, result: { pong: true, timestamp: 1234 } },
    ])
  })

  test("answers a host version with the manifest version and features only", async () => {
    const browser = new FakeBrowser({ manifestVersion: "0.4.2" })
    start(browser, new FakeEnvironment())
    const port = livePort(browser)
    port.emitMessage(hostCommand("a2", "version"))
    await settle()
    expect(port.posted).toEqual([
      {
        id: "a2",
        success: true,
        result: {
          extension: "0.4.2",
          features: ["sessions", "dom", "devtools"],
        },
      },
    ])
  })

  test("answers an unimplemented command with UNKNOWN_COMMAND", async () => {
    const browser = new FakeBrowser()
    start(browser, new FakeEnvironment())
    const port = livePort(browser)
    port.emitMessage(hostCommand("a3", "teleport"))
    await settle()
    expect(port.posted).toEqual([{ id: "a3", success: false, error: "UNKNOWN_COMMAND: teleport" }])
  })

  test("reports the link status after a disconnect", async () => {
    const browser = new FakeBrowser()
    const env = new FakeEnvironment()
    const handle = start(browser, env)
    livePort(browser).disconnect("No such native application firefox-ctl")
    expect(handle.link.status()).toEqual({
      connected: false,
      attempt: 1,
      lastDisconnectReason: "No such native application firefox-ctl",
      reconnectScheduled: true,
    })
  })
})

describe("session commands over host frames", () => {
  test("createWindow, navigate and getTabs share one managed window", async () => {
    const browser = new FakeBrowser()
    start(browser, new FakeEnvironment({ now: 1000 }))
    const port = livePort(browser)

    const created = result(await run(port, "s1", "createWindow", { url: "https://example.com" }))
    expect(created).toMatchObject({ tabCount: 1, isNewWindow: true, isPrivate: true })
    const tabId = number(created, "tabId")

    const navigated = result(await run(port, "s2", "navigate", { url: "https://mozilla.org" }))
    expect(navigated).toEqual({
      tabId,
      url: "https://mozilla.org",
      title: null,
      navigated: true,
    })

    expect(result(await run(port, "s3", "getTabs"))).toEqual({
      windowId: number(created, "windowId"),
      tabs: [{ tabId, url: "https://mozilla.org", title: null, active: true }],
      tabCount: 1,
      maxTabs: 12,
    })
  })

  test("a background restart adopts the surviving window", async () => {
    const browser = new FakeBrowser()
    start(browser, new FakeEnvironment({ now: 1000 }))
    const created = result(await run(livePort(browser), "r1", "createWindow", { private: false }))

    // the background page restarts: new session objects, same browser storage
    start(browser, new FakeEnvironment({ now: 2000 }))
    const reopened = result(await run(livePort(browser), "r2", "createWindow", { private: false }))

    expect(reopened).toMatchObject({
      windowId: number(created, "windowId"),
      isNewWindow: false,
      tabCount: 2,
    })
    expect(await browser.windows.getAll({})).toHaveLength(1)
  })

  test("a background restart does not adopt a private window", async () => {
    const browser = new FakeBrowser()
    start(browser, new FakeEnvironment({ now: 1000 }))
    const created = result(await run(livePort(browser), "r1", "createWindow"))
    expect((await browser.storage.local.get(WINDOW_STATE_KEY))[WINDOW_STATE_KEY]).toBeUndefined()

    start(browser, new FakeEnvironment({ now: 2000 }))
    const reopened = result(await run(livePort(browser), "r2", "createWindow"))

    expect(reopened).toMatchObject({ isNewWindow: true, isPrivate: true, tabCount: 1 })
    expect(reopened.windowId).not.toBe(number(created, "windowId"))
  })

  test("sweeps a firefox-ctl window left behind by an earlier background", async () => {
    const browser = new FakeBrowser()
    browser.addWindow({ id: 7 })
    browser.addTab({ id: 70, windowId: 7 })
    const groupId = await browser.tabs.group?.({
      tabIds: [70],
      createProperties: { windowId: 7 },
    })
    await browser.tabGroups?.update(groupId as number, { title: GROUP_TITLE })

    start(browser, new FakeEnvironment())
    await settle()

    expect(await browser.windows.getAll({})).toEqual([])
  })

  test("closeWindow succeeds right after a restart when a duplicate still needs sweeping", async () => {
    const browser = new FakeBrowser()
    // a genuine leftover duplicate from an earlier background lifetime, grouped
    // first so the sweep spends time on it before reaching the session's window
    browser.addWindow({ id: 7 })
    browser.addTab({ id: 70, windowId: 7 })
    const dupGroupId = await browser.tabs.group?.({
      tabIds: [70],
      createProperties: { windowId: 7 },
    })
    await browser.tabGroups?.update(dupGroupId as number, { title: GROUP_TITLE })
    // the restored session's own window: it carries a firefox-ctl group too, so the
    // sweep's tabGroups.query sees it right alongside the real duplicate
    browser.addWindow({ id: 5 })
    browser.addTab({ id: 50, windowId: 5 })
    const sessionGroupId = await browser.tabs.group?.({
      tabIds: [50],
      createProperties: { windowId: 5 },
    })
    await browser.tabGroups?.update(sessionGroupId as number, { title: GROUP_TITLE })
    await browser.storage.local.set({
      [WINDOW_STATE_KEY]: {
        windowId: 5,
        tabs: [50],
        createdAt: 1000,
        groupId: sessionGroupId,
        isPrivate: false,
        adopted: false,
      },
    })

    start(browser, new FakeEnvironment({ now: 1000 }))
    const reply = await run(livePort(browser), "p1", "closeWindow")

    expect(reply.success).toBe(true)
    expect(await browser.windows.getAll({})).toEqual([])
  })

  test("persists the session when a handler throws after mutating it", async () => {
    const browser = new FakeBrowser()
    const handle = start(browser, new FakeEnvironment({ now: 1000 }))
    const port = livePort(browser)
    const created = result(await run(port, "p1", "createWindow", { private: false }))
    handle.dispatcher.register("closeTab", (_params, { session }) => {
      session.state?.tabs.push(99)
      throw new Error("TAB_CLOSED: Tab 99 no longer exists.")
    })

    expect(await run(port, "p2", "closeTab", { tabId: 99 })).toEqual({
      id: "p2",
      success: false,
      error: "TAB_CLOSED: Tab 99 no longer exists.",
    })
    expect((await browser.storage.local.get(WINDOW_STATE_KEY))[WINDOW_STATE_KEY]).toMatchObject({
      windowId: number(created, "windowId"),
      tabs: [number(created, "tabId"), 99],
    })
  })
})

describe("runtime messaging", () => {
  test("answers getConnectionStatus with the link status", async () => {
    const browser = new FakeBrowser()
    const handle = start(browser, new FakeEnvironment())
    expect(await browser.emitRuntimeMessage({ action: "getConnectionStatus" })).toEqual(
      handle.link.status(),
    )
  })

  test("reports the current status, not the one at startup", async () => {
    const browser = new FakeBrowser()
    start(browser, new FakeEnvironment())
    livePort(browser).disconnect("Native application tried to send a too large message")
    expect(await browser.emitRuntimeMessage({ action: "getConnectionStatus" })).toEqual({
      connected: false,
      attempt: 1,
      lastDisconnectReason: "Native application tried to send a too large message",
      reconnectScheduled: true,
    })
  })

  test("leaves other messages to other listeners", async () => {
    const browser = new FakeBrowser()
    start(browser, new FakeEnvironment())
    expect(await browser.emitRuntimeMessage({ action: "click" })).toBeUndefined()
    expect(await browser.emitRuntimeMessage("ping")).toBeUndefined()
    expect(await browser.emitRuntimeMessage(null)).toBeUndefined()
  })
})

describe("devtools and screenshot over host frames", () => {
  const SCALED = "data:image/jpeg;base64,c2NhbGVk"

  /** A started session on a live port, with the tab the commands target. */
  async function managed(): Promise<{
    browser: FakeBrowser
    port: FakePort
    tabId: number
  }> {
    const browser = new FakeBrowser()
    start(browser, new FakeEnvironment({ now: 1000 }))
    const port = livePort(browser)
    const created = result(await run(port, "window", "createWindow", {}))
    return { browser, port, tabId: number(created, "tabId") }
  }

  test("the network tracker listens from startup", () => {
    const browser = new FakeBrowser()
    start(browser, new FakeEnvironment({ now: 1000 }))

    expect(browser.requestsStarted.listeners).toHaveLength(1)
    expect(browser.requestsCompleted.listeners).toHaveLength(1)
    expect(browser.requestsFailed.listeners).toHaveLength(1)
    expect(browser.requestsCompleted.extraInfoSpecs[0]).toEqual(["responseHeaders"])
  })

  test("a webRequest sequence answers getNetworkRequests", async () => {
    const { browser, port, tabId } = await managed()
    const url = "https://example.com/app.js?token=hunter2"
    browser.emitRequestStarted({ requestId: "r1", url, method: "GET", type: "script", tabId })
    browser.emitRequestCompleted({
      requestId: "r1",
      url,
      method: "GET",
      type: "script",
      tabId,
      statusCode: 200,
      responseHeaders: [{ name: "Set-Cookie", value: "sid=1" }],
    })
    browser.emitRequestStarted({
      requestId: "r2",
      url: "https://example.com/logo.png",
      method: "GET",
      type: "image",
      tabId,
    })

    const reply = result(await run(port, "net", "getNetworkRequests", { tabId, type: "script" }))

    expect(reply).toMatchObject({ tabId, total: 2, filtered: 1 })
    const requests = reply.requests as JsonObject[]
    expect(requests[0]).toMatchObject({
      requestId: "r1",
      url: "https://example.com/app.js?token=%5BREDACTED%5D",
      status: "completed",
      statusCode: 200,
    })
    expect(requests[0]?.responseHeaders).toBeUndefined()
  })

  test("screenshot answers a host frame with skipReadiness", async () => {
    const { browser, port, tabId } = await managed()
    browser.sendMessageHandler = (_tabId, message) => {
      const { action } = message as { action: string }
      if (action !== "resizeImage") {
        return Promise.reject(new Error(`unexpected action ${action}`))
      }
      return Promise.resolve({
        success: true,
        result: {
          dataUrl: SCALED,
          originalSize: { width: 1280, height: 800 },
          scaledSize: { width: 640, height: 400 },
        },
      })
    }

    const shot = result(await run(port, "shot", "screenshot", { tabId, skipReadiness: true }))

    expect(shot).toMatchObject({
      tabId,
      format: "jpeg",
      quality: 60,
      scale: 0.5,
      dataUrl: SCALED,
      readiness: { waitMs: 0, timedOut: false, timeline: [] },
    })
    expect(browser.captures).toEqual([{ tabId, options: { format: "jpeg", quality: 60 } }])
  })

  test("version announces the devtools feature", async () => {
    const { port } = await managed()

    expect(result(await run(port, "v", "version")).features).toEqual([
      "sessions",
      "dom",
      "devtools",
    ])
  })
})
