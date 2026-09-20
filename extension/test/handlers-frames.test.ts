// The three background commands that drive the child-frame registry. They own
// no DOM work: watchFrames opens a watch on the resolved tab, unwatchFrames
// closes it, and listFrames reports - or waits for - the frames admitted since.

import { describe, expect, test } from "bun:test"

import { AttachedTabs } from "../src/attached"
import { CaptureLocks } from "../src/capture-locks"
import type { HandlerDeps } from "../src/dispatch"
import { FrameRegistry } from "../src/frames"
import { listFrames, unwatchFrames, watchFrames } from "../src/handlers/frames"
import { NetworkTracker } from "../src/network"
import type { JsonObject, JsonValue } from "../src/protocol"
import { commandContext } from "../src/protocol"
import { waitForPageReady } from "../src/readiness"
import { Session } from "../src/session"
import { FakeBrowser, FakeEnvironment, FakePort } from "./fakes"

const TAB_ID = 16
const OTHER_TAB_ID = 17
const FRAME_ID = 7
const TOP_URL = "https://stage.overgear.in/checkout"
const FRAME_URL = "https://sdk-web-card.sandbox.y.uno/v1.88.5/pages/secured-fields.html#pan"
const CVV_URL = "https://sdk-web-card.sandbox.y.uno/v1.88.5/pages/secured-fields.html#cvv"
const MATCH = "*y.uno*"

interface Harness {
  browser: FakeBrowser
  env: FakeEnvironment
  frames: FrameRegistry
  deps: HandlerDeps
}

function harness(options: { timeout?: number } = {}): Harness {
  const browser = new FakeBrowser({
    tabs: [
      { id: TAB_ID, windowId: 1, url: TOP_URL, active: true },
      { id: OTHER_TAB_ID, windowId: 1, url: "https://example.com/" },
    ],
    windows: [{ id: 1, focused: true }],
  })
  browser.currentWindowId = 1
  const env = new FakeEnvironment({ now: 1000 })
  const session = new Session(browser, env)
  session.state = {
    windowId: 1,
    tabs: [TAB_ID],
    createdAt: 1000,
    groupId: null,
    isPrivate: false,
    adopted: false,
  }
  session.activeTabId = TAB_ID
  const frames = new FrameRegistry(env)
  frames.attach(browser)
  const params: JsonObject = options.timeout === undefined ? {} : { _timeout: options.timeout }
  const deps: HandlerDeps = {
    browser,
    env,
    session,
    attached: new AttachedTabs(browser, env),
    network: new NetworkTracker(env),
    captureLocks: new CaptureLocks(),
    frames,
    readiness: waitForPageReady,
    ctx: commandContext(params, env),
  }
  return { browser, env, frames, deps }
}

async function observe(
  h: Harness,
  overrides: { frameId?: number; parentFrameId?: number; url?: string } = {},
): Promise<FakePort> {
  const frameId = overrides.frameId ?? FRAME_ID
  const url = overrides.url ?? FRAME_URL
  await h.frames.frameLoaded({
    tabId: TAB_ID,
    frameId,
    parentFrameId: overrides.parentFrameId ?? 0,
    url,
    timeStamp: 0,
  })
  const port = new FakePort({
    name: "firefox-ctl-frame",
    sender: { tab: { id: TAB_ID }, frameId, url },
  })
  h.browser.emitConnect(port)
  return port
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function object(value: JsonValue): JsonObject {
  return value as JsonObject
}

describe("watchFrames", () => {
  test("opens a watch on the named tab", async () => {
    const h = harness()
    const result = object(await watchFrames({ tabId: TAB_ID, match: MATCH }, h.deps))
    expect(result).toEqual({ tabId: TAB_ID, match: MATCH, watching: true })
    expect(h.frames.isWatched(TAB_ID)).toBe(true)
  })

  test("without a match every child frame of the tab is observed", async () => {
    const h = harness()
    const result = object(await watchFrames({ tabId: TAB_ID }, h.deps))
    expect(result).toEqual({ tabId: TAB_ID, match: null, watching: true })
  })

  test("without a tabId it takes the session tab", async () => {
    const h = harness()
    const result = object(await watchFrames({ match: MATCH }, h.deps))
    expect(result.tabId).toBe(TAB_ID)
    expect(h.frames.isWatched(TAB_ID)).toBe(true)
  })

  test("a closed tab fails with TAB_CLOSED", async () => {
    const h = harness()
    h.browser.removeTab(TAB_ID)
    expect(watchFrames({ tabId: TAB_ID }, h.deps)).rejects.toThrow(
      `TAB_CLOSED: Tab ${TAB_ID} no longer exists.`,
    )
  })

  test("an empty match is a plain error", async () => {
    const h = harness()
    expect(watchFrames({ tabId: TAB_ID, match: "" }, h.deps)).rejects.toThrow(
      "match must be a non-empty string.",
    )
    expect(watchFrames({ tabId: TAB_ID, match: 7 }, h.deps)).rejects.toThrow(
      "match must be a non-empty string.",
    )
    expect(h.frames.isWatched(TAB_ID)).toBe(false)
  })

  test("a second watch of the same tab is a plain error", async () => {
    const h = harness()
    await watchFrames({ tabId: TAB_ID, match: MATCH }, h.deps)
    expect(watchFrames({ tabId: TAB_ID }, h.deps)).rejects.toThrow(
      "tab 16 is already watched; call unwatchFrames first",
    )
  })
})

describe("unwatchFrames", () => {
  test("reports how many live frames it released", async () => {
    const h = harness()
    await watchFrames({ tabId: TAB_ID, match: MATCH }, h.deps)
    await observe(h)
    await observe(h, { frameId: 9, url: CVV_URL })
    const result = object(await unwatchFrames({ tabId: TAB_ID }, h.deps))
    expect(result).toEqual({ tabId: TAB_ID, watching: false, released: 2 })
    expect(h.frames.isWatched(TAB_ID)).toBe(false)
  })

  test("is idempotent on a tab that was never watched", async () => {
    const h = harness()
    const result = object(await unwatchFrames({ tabId: TAB_ID }, h.deps))
    expect(result).toEqual({ tabId: TAB_ID, watching: false, released: 0 })
  })

  test("without a tabId it takes the session tab", async () => {
    const h = harness()
    await watchFrames({}, h.deps)
    const result = object(await unwatchFrames({}, h.deps))
    expect(result).toEqual({ tabId: TAB_ID, watching: false, released: 0 })
  })

  test("a closed tab fails with TAB_CLOSED", async () => {
    const h = harness()
    h.browser.removeTab(TAB_ID)
    expect(unwatchFrames({ tabId: TAB_ID }, h.deps)).rejects.toThrow("TAB_CLOSED")
  })
})

describe("listFrames", () => {
  test("reports the observed frames of a watched tab", async () => {
    const h = harness()
    await watchFrames({ tabId: TAB_ID, match: MATCH }, h.deps)
    await observe(h, { frameId: 9, url: CVV_URL, parentFrameId: 7 })
    await observe(h)
    const result = object(await listFrames({ tabId: TAB_ID }, h.deps))
    expect(result).toEqual({
      tabId: TAB_ID,
      watching: true,
      frames: [
        { frameId: FRAME_ID, url: FRAME_URL, parentFrameId: 0 },
        { frameId: 9, url: CVV_URL, parentFrameId: 7 },
      ],
    })
  })

  test("an unwatched tab answers with an empty list", async () => {
    const h = harness()
    const result = object(await listFrames({ tabId: TAB_ID }, h.deps))
    expect(result).toEqual({ tabId: TAB_ID, watching: false, frames: [] })
  })

  test("filters by match", async () => {
    const h = harness()
    await watchFrames({ tabId: TAB_ID }, h.deps)
    await observe(h)
    await observe(h, { frameId: 9, url: CVV_URL })
    const result = object(await listFrames({ tabId: TAB_ID, match: "*#cvv" }, h.deps))
    expect(result.frames).toEqual([{ frameId: 9, url: CVV_URL, parentFrameId: 0 }])
  })

  test("an empty match is a plain error", async () => {
    const h = harness()
    await watchFrames({ tabId: TAB_ID }, h.deps)
    expect(listFrames({ tabId: TAB_ID, match: "" }, h.deps)).rejects.toThrow(
      "match must be a non-empty string.",
    )
  })

  test("without a timeout it does not wait", async () => {
    const h = harness()
    await watchFrames({ tabId: TAB_ID }, h.deps)
    const result = object(await listFrames({ tabId: TAB_ID }, h.deps))
    expect(result.frames).toEqual([])
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("waits for the first matching frame and stops there", async () => {
    const h = harness()
    await watchFrames({ tabId: TAB_ID }, h.deps)
    const pending = listFrames({ tabId: TAB_ID, match: MATCH, timeout: 5000 }, h.deps)
    await flush()
    expect(h.env.pendingTimers()).toBe(1)
    await observe(h)
    const result = object(await pending)
    expect(result).toEqual({
      tabId: TAB_ID,
      watching: true,
      frames: [{ frameId: FRAME_ID, url: FRAME_URL, parentFrameId: 0 }],
    })
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("answers an empty list when the wait runs out", async () => {
    const h = harness()
    await watchFrames({ tabId: TAB_ID }, h.deps)
    const pending = listFrames({ tabId: TAB_ID, timeout: 5000 }, h.deps)
    await flush()
    h.env.advance(5000)
    const result = object(await pending)
    // the watch is still open, it just has nothing to report yet
    expect(result).toEqual({ tabId: TAB_ID, watching: true, frames: [] })
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("answers an empty list when the watch is dropped under it", async () => {
    const h = harness()
    await watchFrames({ tabId: TAB_ID }, h.deps)
    const pending = listFrames({ tabId: TAB_ID, timeout: 5000 }, h.deps)
    await flush()
    await unwatchFrames({ tabId: TAB_ID }, h.deps)
    const result = object(await pending)
    expect(result).toEqual({ tabId: TAB_ID, watching: false, frames: [] })
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("fails with TAB_CLOSED when the tab goes while it waits", async () => {
    const h = harness()
    await watchFrames({ tabId: TAB_ID }, h.deps)
    const pending = listFrames({ tabId: TAB_ID, timeout: 5000 }, h.deps)
    await flush()
    h.browser.removeTab(TAB_ID)
    expect(pending).rejects.toThrow(`TAB_CLOSED: Tab ${TAB_ID} no longer exists.`)
    await flush()
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("the command deadline caps a longer wait", async () => {
    const h = harness({ timeout: 6000 })
    await watchFrames({ tabId: TAB_ID }, h.deps)
    const pending = listFrames({ tabId: TAB_ID, timeout: 60000 }, h.deps)
    await flush()
    // the budget is 5000 ms after the host margin, minus the 100 ms the waits keep
    h.env.advance(4900)
    const result = object(await pending)
    expect(result.frames).toEqual([])
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("rejects a timeout that is not a non-negative integer", async () => {
    const h = harness()
    await watchFrames({ tabId: TAB_ID }, h.deps)
    for (const timeout of [-1, 1.5, "7", null]) {
      expect(listFrames({ tabId: TAB_ID, timeout } as JsonObject, h.deps)).rejects.toThrow(
        "timeout must be a non-negative integer.",
      )
    }
    expect(h.env.pendingTimers()).toBe(0)
  })
})
