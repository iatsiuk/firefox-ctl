// The per-tab child-frame registry: which child frames of a watched tab run the
// content script, who may connect, and when a waiter learns about one. Every
// case that only the registry can produce - a port from a document injected
// before the last unwatch, a disconnect of a port already replaced, a wait
// outliving its tab - is driven here through the fake browser and the virtual
// clock, so no test depends on real timers.

import { describe, expect, test } from "bun:test"

import type { MessageSender } from "../src/browser"
import { FRAME_PORT_NAME, FRAME_SCRIPT_FILE, FrameRegistry } from "../src/frames"
import { globToRegExp } from "../src/glob"
import { FakeBrowser, FakeEnvironment, FakePort } from "./fakes"

const TAB_ID = 16
const OTHER_TAB_ID = 17
const FRAME_ID = 7
const TOP_URL = "https://stage.overgear.in/checkout"
const FRAME_URL = "https://sdk-web-card.sandbox.y.uno/v1.88.5/pages/secured-fields.html#pan"
const CVV_URL = "https://sdk-web-card.sandbox.y.uno/v1.88.5/pages/secured-fields.html#cvv"
const OTHER_URL = "https://ads.example.com/banner.html"
const MATCH = "*y.uno*"

interface Harness {
  browser: FakeBrowser
  env: FakeEnvironment
  frames: FrameRegistry
}

function harness(): Harness {
  const browser = new FakeBrowser({
    tabs: [
      { id: TAB_ID, windowId: 1, url: TOP_URL },
      { id: OTHER_TAB_ID, windowId: 1, url: "https://example.com/" },
    ],
    windows: [{ id: 1, focused: true }],
  })
  const env = new FakeEnvironment({ now: 1000 })
  const frames = new FrameRegistry(env)
  frames.attach(browser)
  return { browser, env, frames }
}

interface PortOptions {
  name?: string
  tabId?: number
  frameId?: number
  url?: string
  omitTab?: boolean
  omitFrameId?: boolean
}

function framePort(options: PortOptions = {}): FakePort {
  const sender: MessageSender = { url: options.url ?? FRAME_URL }
  if (!options.omitTab) {
    sender.tab = { id: options.tabId ?? TAB_ID }
  }
  if (!options.omitFrameId) {
    sender.frameId = options.frameId ?? FRAME_ID
  }
  return new FakePort({ name: options.name ?? FRAME_PORT_NAME, sender })
}

async function loaded(
  h: Harness,
  overrides: { tabId?: number; frameId?: number; parentFrameId?: number; url?: string } = {},
): Promise<void> {
  await h.frames.frameLoaded({
    tabId: overrides.tabId ?? TAB_ID,
    frameId: overrides.frameId ?? FRAME_ID,
    parentFrameId: overrides.parentFrameId ?? 0,
    url: overrides.url ?? FRAME_URL,
    timeStamp: 0,
  })
}

/** Loads and connects one child frame, the way a real injection ends. */
async function observe(
  h: Harness,
  overrides: { tabId?: number; frameId?: number; parentFrameId?: number; url?: string } = {},
): Promise<FakePort> {
  await loaded(h, overrides)
  const port = framePort({
    tabId: overrides.tabId ?? TAB_ID,
    frameId: overrides.frameId ?? FRAME_ID,
    url: overrides.url ?? FRAME_URL,
  })
  h.browser.emitConnect(port)
  return port
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe("attach", () => {
  test("subscribes once however often it is called", () => {
    const browser = new FakeBrowser()
    const frames = new FrameRegistry(new FakeEnvironment({}))

    frames.attach(browser)
    frames.attach(browser)

    expect(browser.framesLoaded.listeners).toHaveLength(1)
    expect(browser.runtimeConnections.listeners).toHaveLength(1)
    expect(browser.tabsRemoved.listeners).toHaveLength(1)
  })
})

describe("watch", () => {
  test("stores the watch and leaves other tabs alone", () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    expect(h.frames.isWatched(TAB_ID)).toBe(true)
    expect(h.frames.isWatched(OTHER_TAB_ID)).toBe(false)
    expect(h.frames.list(TAB_ID)).toEqual([])
    expect(h.frames.list(OTHER_TAB_ID)).toEqual([])
  })

  test("without a match every child frame qualifies", async () => {
    const h = harness()
    h.frames.watch(TAB_ID)
    await loaded(h, { url: OTHER_URL })
    expect(h.browser.executeScriptCalls).toHaveLength(1)
  })

  test("refuses a second watch of the same tab", () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    expect(() => h.frames.watch(TAB_ID)).toThrow(
      "tab 16 is already watched; call unwatchFrames first",
    )
  })

  test("two watched tabs keep independent state", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    h.frames.watch(OTHER_TAB_ID, "*banner*")
    await observe(h)
    await observe(h, { tabId: OTHER_TAB_ID, frameId: 3, url: OTHER_URL })
    expect(h.frames.list(TAB_ID)).toEqual([{ frameId: FRAME_ID, url: FRAME_URL, parentFrameId: 0 }])
    expect(h.frames.list(OTHER_TAB_ID)).toEqual([{ frameId: 3, url: OTHER_URL, parentFrameId: 0 }])
    expect(h.frames.unwatch(TAB_ID)).toBe(1)
    expect(h.frames.isWatched(OTHER_TAB_ID)).toBe(true)
    expect(h.frames.isObserved(OTHER_TAB_ID, 3)).toBe(true)
  })
})

describe("injection", () => {
  test("injects the content script into a matching child frame", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    await loaded(h)
    expect(h.browser.executeScriptCalls).toEqual([
      {
        tabId: TAB_ID,
        details: { frameId: FRAME_ID, file: FRAME_SCRIPT_FILE, runAt: "document_idle" },
      },
    ])
  })

  test("the webNavigation listener drives the same path", () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    h.browser.emitFrameLoaded({ tabId: TAB_ID, frameId: FRAME_ID, url: FRAME_URL })
    expect(h.browser.executeScriptCalls).toHaveLength(1)
  })

  test("a non-matching url, an unwatched tab and the top document inject nothing", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    await loaded(h, { url: OTHER_URL })
    await loaded(h, { tabId: OTHER_TAB_ID })
    await loaded(h, { frameId: 0 })
    expect(h.browser.executeScriptCalls).toEqual([])
  })

  test("a duplicate event injects once", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    await loaded(h)
    await loaded(h)
    expect(h.browser.executeScriptCalls).toHaveLength(1)
  })

  test("a later non-matching navigation drops the pending record", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    await loaded(h)
    await loaded(h, { url: OTHER_URL })
    const port = framePort()
    h.browser.emitConnect(port)
    expect(port.disconnected).toBe(true)
    expect(h.frames.isObserved(TAB_ID, FRAME_ID)).toBe(false)
  })

  test("a later matching navigation replaces the pending record", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    await loaded(h)
    await loaded(h, { url: CVV_URL })
    expect(h.browser.executeScriptCalls).toHaveLength(2)
    const stale = framePort({ url: FRAME_URL })
    h.browser.emitConnect(stale)
    expect(stale.disconnected).toBe(true)
    const fresh = framePort({ url: CVV_URL })
    h.browser.emitConnect(fresh)
    expect(fresh.disconnected).toBe(false)
    expect(h.frames.list(TAB_ID)).toEqual([{ frameId: FRAME_ID, url: CVV_URL, parentFrameId: 0 }])
  })

  test("an executeScript rejection is recorded and not thrown", async () => {
    const h = harness()
    h.browser.executeScriptHandler = () => Promise.reject(new Error("Missing host permission"))
    h.frames.watch(TAB_ID, MATCH)
    await loaded(h)
    expect(h.frames.injectionError(TAB_ID, FRAME_ID)).toBe("Missing host permission")
    const port = framePort()
    h.browser.emitConnect(port)
    expect(port.disconnected).toBe(true)
  })

  test("a failure from a previous watch leaves the new pending record alone", async () => {
    const h = harness()
    let failFirst: (() => void) | undefined
    h.browser.executeScriptHandler = () =>
      new Promise<unknown[]>((_resolve, reject) => {
        failFirst = () => reject(new Error("no window"))
      })
    h.frames.watch(TAB_ID, MATCH)
    const stalled = loaded(h)
    h.frames.unwatch(TAB_ID)
    h.frames.watch(TAB_ID, MATCH)
    h.browser.executeScriptHandler = undefined
    await loaded(h)
    failFirst?.()
    await stalled
    const port = framePort()
    h.browser.emitConnect(port)
    expect(port.disconnected).toBe(false)
    expect(h.frames.isObserved(TAB_ID, FRAME_ID)).toBe(true)
  })

  test("a failed injection is retried on the next load", async () => {
    const h = harness()
    h.browser.executeScriptHandler = () => Promise.reject(new Error("no window"))
    h.frames.watch(TAB_ID, MATCH)
    await loaded(h)
    h.browser.executeScriptHandler = undefined
    await loaded(h)
    expect(h.browser.executeScriptCalls).toHaveLength(2)
    expect(h.frames.injectionError(TAB_ID, FRAME_ID)).toBeUndefined()
  })
})

describe("admission", () => {
  test("admits the port of a pending injection", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    const port = await observe(h)
    expect(port.disconnected).toBe(false)
    expect(h.frames.isObserved(TAB_ID, FRAME_ID)).toBe(true)
    expect(h.frames.list(TAB_ID)).toEqual([{ frameId: FRAME_ID, url: FRAME_URL, parentFrameId: 0 }])
  })

  test("the pending record is consumed by the first port", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    const first = await observe(h)
    const second = framePort()
    h.browser.emitConnect(second)
    expect(second.disconnected).toBe(true)
    expect(first.disconnected).toBe(false)
    expect(h.frames.isObserved(TAB_ID, FRAME_ID)).toBe(true)
  })

  test("refuses ports that do not belong to a pending injection", async () => {
    const cases: { name: string; options: PortOptions }[] = [
      { name: "the top document", options: { frameId: 0 } },
      { name: "a missing frame id", options: { omitFrameId: true } },
      { name: "a missing tab", options: { omitTab: true } },
      { name: "another port name", options: { name: "firefox-ctl-host" } },
      { name: "a url mismatch", options: { url: CVV_URL } },
      { name: "another frame", options: { frameId: 9 } },
      { name: "an unwatched tab", options: { tabId: OTHER_TAB_ID } },
    ]
    for (const { name, options } of cases) {
      const h = harness()
      h.frames.watch(TAB_ID, MATCH)
      await loaded(h)
      const port = framePort(options)
      h.browser.emitConnect(port)
      expect(`${name}: ${port.disconnected}`).toBe(`${name}: true`)
      expect(h.frames.list(TAB_ID)).toEqual([])
    }
  })

  test("refuses a port of a stale generation", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    await loaded(h)
    h.frames.unwatch(TAB_ID)
    h.frames.watch(TAB_ID, MATCH)
    const port = framePort()
    h.browser.emitConnect(port)
    expect(port.disconnected).toBe(true)
    expect(h.frames.list(TAB_ID)).toEqual([])
  })

  test("lists frames sorted by id with their parent", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    await observe(h, { frameId: 9, url: CVV_URL, parentFrameId: 3 })
    await observe(h, { frameId: 3 })
    expect(h.frames.list(TAB_ID)).toEqual([
      { frameId: 3, url: FRAME_URL, parentFrameId: 0 },
      { frameId: 9, url: CVV_URL, parentFrameId: 3 },
    ])
    expect(h.frames.isObserved(TAB_ID, 0)).toBe(false)
    expect(h.frames.isObserved(TAB_ID, 4)).toBe(false)
    expect(h.frames.isObserved(OTHER_TAB_ID, 3)).toBe(false)
  })
})

describe("teardown", () => {
  test("a disconnect removes the entry", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    const port = await observe(h)
    port.disconnect()
    expect(h.frames.list(TAB_ID)).toEqual([])
    expect(h.frames.isWatched(TAB_ID)).toBe(true)
  })

  test("a late disconnect of a replaced port keeps the new entry", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    const old = await observe(h)
    const fresh = await observe(h, { url: CVV_URL })
    old.disconnect()
    expect(fresh.disconnected).toBe(false)
    expect(h.frames.list(TAB_ID)).toEqual([{ frameId: FRAME_ID, url: CVV_URL, parentFrameId: 0 }])
  })

  test("closing the tab clears the watch", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    await observe(h)
    await loaded(h, { frameId: 9, url: CVV_URL })
    h.browser.removeTab(TAB_ID)
    expect(h.frames.isWatched(TAB_ID)).toBe(false)
    expect(h.frames.list(TAB_ID)).toEqual([])
    h.frames.watch(TAB_ID, MATCH)
    const port = framePort({ frameId: 9, url: CVV_URL })
    h.browser.emitConnect(port)
    expect(port.disconnected).toBe(true)
  })

  test("unwatch deactivates and releases every live frame", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    const first = await observe(h)
    const second = await observe(h, { frameId: 9, url: CVV_URL })
    await loaded(h, { frameId: 11, url: CVV_URL })
    expect(h.frames.unwatch(TAB_ID)).toBe(2)
    expect(first.posted).toEqual([{ type: "deactivate" }])
    expect(second.posted).toEqual([{ type: "deactivate" }])
    expect(first.disconnected).toBe(true)
    expect(second.disconnected).toBe(true)
    expect(h.frames.isWatched(TAB_ID)).toBe(false)
    expect(h.frames.list(TAB_ID)).toEqual([])
    h.frames.watch(TAB_ID, MATCH)
    const pending = framePort({ frameId: 11, url: CVV_URL })
    h.browser.emitConnect(pending)
    expect(pending.disconnected).toBe(true)
  })

  test("unwatch tolerates a port the frame already closed", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    const port = await observe(h)
    port.disconnected = true
    expect(h.frames.unwatch(TAB_ID)).toBe(1)
    expect(port.posted).toEqual([])
  })

  test("unwatch of an unwatched tab releases nothing", () => {
    const h = harness()
    expect(h.frames.unwatch(TAB_ID)).toBe(0)
  })

  test("forget drops one entry", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    await observe(h)
    await observe(h, { frameId: 9, url: CVV_URL })
    h.frames.forget(TAB_ID, FRAME_ID)
    expect(h.frames.list(TAB_ID)).toEqual([{ frameId: 9, url: CVV_URL, parentFrameId: 0 }])
    h.frames.forget(TAB_ID, FRAME_ID)
    h.frames.forget(OTHER_TAB_ID, 9)
    expect(h.frames.list(TAB_ID)).toHaveLength(1)
  })
})

describe("awaitFrame", () => {
  test("resolves at once when a frame already matches", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    await observe(h)
    const result = await h.frames.awaitFrame(TAB_ID, { frameId: FRAME_ID }, h.env.now() + 5000)
    expect(result).toEqual({
      outcome: "found",
      frames: [{ frameId: FRAME_ID, url: FRAME_URL, parentFrameId: 0 }],
    })
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("resolves as soon as a matching frame is admitted", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    const wait = h.frames.awaitFrame(TAB_ID, { match: globToRegExp("*#cvv") }, h.env.now() + 5000)
    await observe(h)
    await observe(h, { frameId: 9, url: CVV_URL })
    const result = await wait
    expect(result).toEqual({
      outcome: "found",
      frames: [{ frameId: 9, url: CVV_URL, parentFrameId: 0 }],
    })
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("times out at the deadline", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    const wait = h.frames.awaitFrame(TAB_ID, {}, h.env.now() + 5000)
    h.env.advance(4999)
    let settled = false
    void wait.then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)
    h.env.advance(1)
    expect(await wait).toEqual({ outcome: "timeout", frames: [] })
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("a deadline already reached does not schedule a timer", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    expect(await h.frames.awaitFrame(TAB_ID, {}, h.env.now())).toEqual({
      outcome: "timeout",
      frames: [],
    })
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("unwatch ends the wait", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    const wait = h.frames.awaitFrame(TAB_ID, {}, h.env.now() + 5000)
    h.frames.unwatch(TAB_ID)
    expect(await wait).toEqual({ outcome: "unwatched", frames: [] })
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("an unwatched tab answers without waiting", async () => {
    const h = harness()
    expect(await h.frames.awaitFrame(TAB_ID, {}, h.env.now() + 5000)).toEqual({
      outcome: "unwatched",
      frames: [],
    })
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("closing the tab ends the wait", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    const wait = h.frames.awaitFrame(TAB_ID, {}, h.env.now() + 5000)
    h.browser.removeTab(TAB_ID)
    expect(await wait).toEqual({ outcome: "closed", frames: [] })
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("concurrent waits on one tab resolve independently", async () => {
    const h = harness()
    h.frames.watch(TAB_ID, MATCH)
    const first = h.frames.awaitFrame(TAB_ID, { frameId: FRAME_ID }, h.env.now() + 5000)
    const second = h.frames.awaitFrame(TAB_ID, { frameId: 9 }, h.env.now() + 5000)
    let secondSettled = false
    void second.then(() => {
      secondSettled = true
    })
    await observe(h)
    expect((await first).frames).toEqual([{ frameId: FRAME_ID, url: FRAME_URL, parentFrameId: 0 }])
    await flush()
    expect(secondSettled).toBe(false)
    expect(h.env.pendingTimers()).toBe(1)
    await observe(h, { frameId: 9, url: CVV_URL })
    expect((await second).frames).toEqual([{ frameId: 9, url: CVV_URL, parentFrameId: 0 }])
    expect(h.env.pendingTimers()).toBe(0)
  })
})
