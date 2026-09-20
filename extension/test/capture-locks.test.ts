// The per-tab capture registry: entries are shared by every capture of a tab
// and dropped when the tab closes, so a long-lived background page never keeps
// one lock per tab ever captured. The screenshot handler is driven end to end
// here, since the window that could leak an entry - a tab removed while a
// request sits in readiness - only exists inside it.

import { describe, expect, test } from "bun:test"

import { start } from "../src/app"
import { AttachedTabs } from "../src/attached"
import { CaptureLocks } from "../src/capture-locks"
import type { HandlerDeps } from "../src/dispatch"
import { FrameRegistry } from "../src/frames"
import { screenshot } from "../src/handlers/screenshot"
import { NetworkTracker } from "../src/network"
import type { JsonObject } from "../src/protocol"
import { commandContext } from "../src/protocol"
import type { ReadinessCheck, ReadinessResult } from "../src/readiness"
import { Session } from "../src/session"
import { FakeBrowser, FakeEnvironment } from "./fakes"

const TAB_ID = 1
const OTHER_TAB_ID = 2
const RAW = "data:image/jpeg;base64,cmF3"

const READY: ReadinessResult = { totalWaitMs: 0, timedOut: false, timeline: [] }

interface Sent {
  action: string
  params: JsonObject
}

interface Harness {
  browser: FakeBrowser
  env: FakeEnvironment
  locks: CaptureLocks
  deps: HandlerDeps
  actions(): string[]
  /** Holds every readiness call until the returned function is called. */
  gateReadiness(): () => void
  run(params?: JsonObject): Promise<JsonObject>
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function harness(): Harness {
  const browser = new FakeBrowser()
  const env = new FakeEnvironment({ now: 0 })
  const session = new Session(browser, env)
  const locks = new CaptureLocks()
  locks.attach(browser)
  browser.addWindow({ id: 1, focused: true })
  browser.currentWindowId = 1
  for (const id of [TAB_ID, OTHER_TAB_ID]) {
    browser.addTab({
      id,
      windowId: 1,
      index: id - 1,
      url: "https://example.com/",
      active: id === TAB_ID,
      status: "complete",
    })
  }
  session.state = {
    windowId: 1,
    tabs: [TAB_ID],
    createdAt: 0,
    groupId: null,
    isPrivate: false,
    adopted: false,
  }
  session.activeTabId = TAB_ID
  let gate: Promise<void> | null = null
  const readiness: ReadinessCheck = async () => {
    if (gate) {
      await gate
    }
    return READY
  }
  const deps: HandlerDeps = {
    browser,
    env,
    session,
    attached: new AttachedTabs(browser, env),
    network: new NetworkTracker(env),
    captureLocks: locks,
    frames: new FrameRegistry(env),
    readiness,
    ctx: commandContext({}, env),
  }
  const sent: Sent[] = []
  browser.sendMessageHandler = (_tabId, message) => {
    const { action, params } = message as Sent
    sent.push({ action, params })
    switch (action) {
      case "annotateElements":
        return Promise.resolve({ success: true, result: { labels: {}, count: 0 } })
      case "removeAnnotations":
        return Promise.resolve({ success: true, result: { removed: true } })
      default:
        return Promise.reject(new Error(`unexpected action ${action}`))
    }
  }
  browser.captureHandler = (tabId) =>
    browser.tabs
      .get(tabId)
      .then(() => RAW)
      .catch(() => Promise.reject(new Error(`Invalid tab ID: ${tabId}`)))
  return {
    browser,
    env,
    locks,
    deps,
    actions: () => sent.map((one) => one.action),
    gateReadiness: () => {
      let open: () => void = () => undefined
      gate = new Promise<void>((resolve) => {
        open = resolve
      })
      return () => {
        gate = null
        open()
      }
    },
    run: async (params = {}) =>
      (await screenshot(
        { scale: 1, ...params },
        { ...deps, ctx: commandContext({}, env) },
      )) as JsonObject,
  }
}

describe("CaptureLocks", () => {
  test("hands the same entry to every caller for one tab", () => {
    const locks = new CaptureLocks()

    const first = locks.get(TAB_ID)

    expect(locks.get(TAB_ID)).toBe(first)
    expect(locks.get(OTHER_TAB_ID)).not.toBe(first)
    expect(locks.size).toBe(2)
  })

  test("attach subscribes once however often it is called", () => {
    const browser = new FakeBrowser()
    const locks = new CaptureLocks()

    locks.attach(browser)
    locks.attach(browser)

    expect(browser.tabsRemoved.listeners).toHaveLength(1)
  })

  test("drops the entry of a removed tab", () => {
    const browser = new FakeBrowser()
    const locks = new CaptureLocks()
    locks.attach(browser)
    locks.get(TAB_ID)
    locks.get(OTHER_TAB_ID)

    browser.removeTab(TAB_ID)

    expect(locks.size).toBe(1)
    expect(locks.get(OTHER_TAB_ID)).toBeDefined()
  })

  test("an entry taken again after the removal is a fresh one", () => {
    const browser = new FakeBrowser()
    const locks = new CaptureLocks()
    locks.attach(browser)
    const before = locks.get(TAB_ID)

    browser.removeTab(TAB_ID)

    expect(locks.get(TAB_ID)).not.toBe(before)
  })
})

describe("screenshot capture locks", () => {
  test("two captures of one tab share a single entry", async () => {
    const h = harness()

    await h.run()
    const entry = h.locks.get(TAB_ID)
    await h.run()

    expect(h.locks.size).toBe(1)
    expect(h.locks.get(TAB_ID)).toBe(entry)
  })

  test("closing the tab drops the entry the captures used", async () => {
    const h = harness()
    await h.run()
    expect(h.locks.size).toBe(1)

    h.browser.removeTab(TAB_ID)

    expect(h.locks.size).toBe(0)
  })

  test("a capture of another tab gets its own entry", async () => {
    const h = harness()

    await h.run()
    await h.run({ tabId: OTHER_TAB_ID })

    expect(h.locks.size).toBe(2)
  })

  test("a tab removed while a capture waits in readiness leaves no entry behind", async () => {
    const h = harness()
    const open = h.gateReadiness()
    const first = h.run({ annotate: true })
    const second = h.run()
    await flush()
    const shared = h.locks.get(TAB_ID)
    expect(h.locks.size).toBe(1)

    // the tab goes away while both requests are still inside readiness; the
    // entry they took before that await is theirs to finish with, and the
    // registry must not gain a new one when they continue
    for (const listener of h.browser.tabsRemoved.snapshot()) {
      listener(TAB_ID, { windowId: 1, isWindowClosing: false })
    }
    expect(h.locks.size).toBe(0)

    open()
    await Promise.all([first, second])

    expect(h.locks.size).toBe(0)
    // both still rendezvous through the entry they took before the removal,
    // so the annotated capture's badges are gone before the plain one shoots
    expect(h.actions()).toEqual(["annotateElements", "removeAnnotations"])
    expect(h.browser.captures.map((one) => one.tabId)).toEqual([TAB_ID, TAB_ID])
    expect(h.locks.get(TAB_ID)).not.toBe(shared)
  })

  test("a capture whose tab closes mid-flight fails with a tab error and leaves no entry", async () => {
    const h = harness()
    const open = h.gateReadiness()
    const capture = h.run()
    capture.catch(() => undefined)
    await flush()

    h.browser.removeTab(TAB_ID)
    expect(h.locks.size).toBe(0)
    open()

    await expect(capture).rejects.toThrow(`Invalid tab ID: ${TAB_ID}`)
    expect(h.locks.size).toBe(0)
  })

  test("a tab removed while resolveTargetTab's own tabs.get is in flight leaves no entry behind", async () => {
    const h = harness()

    // resolveTargetTab's `tabs.get(tabId)` has already looked the tab up and
    // is merely awaiting that result when the removal below runs; the entry
    // this call takes right after is for a tab whose `onRemoved` already
    // fired and will never fire again
    const capture = h.run({ tabId: TAB_ID })
    capture.catch(() => undefined)
    h.browser.removeTab(TAB_ID)

    await expect(capture).rejects.toThrow(`Invalid tab ID: ${TAB_ID}`)
    expect(h.locks.size).toBe(0)
  })
})

describe("start", () => {
  test("wires the capture-lock cleanup to tabs.onRemoved", () => {
    const browser = new FakeBrowser()
    browser.addWindow({ id: 1, focused: true })
    browser.addTab({ id: TAB_ID, windowId: 1, index: 0, url: "https://example.com/" })
    const handle = start(browser, new FakeEnvironment())
    const { captureLocks } = handle.dispatcher.deps
    captureLocks.get(TAB_ID)
    expect(captureLocks.size).toBe(1)

    browser.removeTab(TAB_ID)

    expect(captureLocks.size).toBe(0)
  })
})
