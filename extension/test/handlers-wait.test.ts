// The URL wait lives in the background, so it survives the navigation that
// replaces the document hosting the content script.

import { describe, expect, test } from "bun:test"

import { AttachedTabs } from "../src/attached"
import { CaptureLocks } from "../src/capture-locks"
import type { HandlerDeps } from "../src/dispatch"
import { FRAME_PORT_NAME, FrameRegistry } from "../src/frames"
import { pageHandlers } from "../src/handlers/dom"
import { waitForUrl } from "../src/handlers/wait"
import { NetworkTracker } from "../src/network"
import type { JsonObject, JsonValue } from "../src/protocol"
import { commandContext } from "../src/protocol"
import { waitForPageReady } from "../src/readiness"
import { Session } from "../src/session"
import { FakeBrowser, FakeEnvironment, FakePort } from "./fakes"
import errors from "./fixtures/errors.json"

interface Sent {
  tabId: number
  action: string
  params: JsonObject
}

interface Harness {
  browser: FakeBrowser
  env: FakeEnvironment
  deps: HandlerDeps
  frames: FrameRegistry
  sent: Sent[]
  tabId: number
  listeners(): number
  wait(params: JsonObject): Promise<JsonObject>
}

// the fake clock only moves on demand, so give the pending microtasks a turn
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function harness(options: { url?: string; timeout?: number; status?: string } = {}): Harness {
  const browser = new FakeBrowser()
  const env = new FakeEnvironment({ now: 1000 })
  const session = new Session(browser, env)
  const attached = new AttachedTabs(browser, env)
  const params: JsonObject = options.timeout === undefined ? {} : { _timeout: options.timeout }
  const frames = new FrameRegistry(env)
  const deps: HandlerDeps = {
    browser,
    env,
    session,
    attached,
    network: new NetworkTracker(env),
    captureLocks: new CaptureLocks(),
    frames,
    readiness: waitForPageReady,
    ctx: commandContext(params, env),
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
    active: true,
    status: options.status ?? "complete",
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
  browser.sendMessageHandler = (messageTabId, message) => {
    const frame = message as { action: string; params: JsonObject }
    sent.push({ tabId: messageTabId, action: frame.action, params: frame.params })
    return Promise.resolve({ success: true, result: { forwarded: true } })
  }
  return {
    browser,
    env,
    deps,
    frames,
    sent,
    tabId,
    listeners: () => browser.tabsUpdated.listeners.length + browser.tabsRemoved.listeners.length,
    wait: async (waitParams) => (await pageHandlers.waitFor(waitParams, deps)) as JsonObject,
  }
}

function caught(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => error as Error,
  )
}

function url(h: Harness, params: JsonObject): Promise<JsonValue> {
  return waitForUrl(h.deps, h.deps.ctx, h.tabId, params)
}

describe("waitForUrl", () => {
  test("matches the current URL without any event", async () => {
    const h = harness()

    expect(await url(h, { url: "https://example.com/*" })).toEqual({
      url: "https://example.com/*",
      matched: "https://example.com/",
      found: true,
      elapsed: 0,
    })
    expect(h.listeners()).toBe(0)
  })

  test("matches a later update carrying the new URL", async () => {
    const h = harness({ url: "https://example.com/" })
    const pending = url(h, { url: "https://www.iana.org/*" })
    await settle()
    expect(h.listeners()).toBe(2)

    h.env.advance(300)
    h.browser.emitTabUpdated(h.tabId, { url: "https://www.iana.org/help" })

    expect(await pending).toEqual({
      url: "https://www.iana.org/*",
      matched: "https://www.iana.org/help",
      found: true,
      elapsed: 300,
    })
    expect(h.listeners()).toBe(0)
  })

  test("falls back to the tab URL when the update carries none", async () => {
    const h = harness()
    const pending = url(h, { url: "https://www.iana.org/*" })
    await settle()

    h.browser.addTab({ id: h.tabId, windowId: 1, url: "https://www.iana.org/help" })
    h.browser.emitTabUpdated(h.tabId, { status: "complete" })

    expect(await pending).toMatchObject({ matched: "https://www.iana.org/help", found: true })
  })

  test("ignores updates of other tabs", async () => {
    const h = harness()
    h.browser.addTab({ id: 2, windowId: 1, url: "https://example.com/" })
    const pending = caught(url(h, { url: "https://www.iana.org/*", timeout: 500 }))
    await settle()

    h.browser.emitTabUpdated(2, { url: "https://www.iana.org/help" })
    await settle()
    h.env.advance(500)

    expect((await pending).message).toBe(
      errors.timeoutUrl.replace("<url>", "https://www.iana.org/*"),
    )
  })

  test("matches a glob with dots, question marks and wildcards", async () => {
    const h = harness({ url: "https://example.com/" })
    const pending = url(h, { url: "https://example.com/search?q=*" })
    await settle()

    h.browser.emitTabUpdated(h.tabId, { url: "https://example.com/search?q=firefox-ctl" })
    expect(await pending).toMatchObject({ matched: "https://example.com/search?q=firefox-ctl" })

    const other = harness()
    const missed = caught(url(other, { url: "https://examplexcom/*", timeout: 200 }))
    await settle()
    other.env.advance(200)
    expect((await missed).message).toContain("Timeout waiting for URL matching")
  })

  test("uses its own timeout when it is shorter than the command budget", async () => {
    const h = harness({ timeout: 300000 })
    const pending = caught(url(h, { url: "https://www.iana.org/*", timeout: 2000 }))
    await settle()

    h.env.advance(1999)
    await settle()
    h.env.advance(1)

    expect((await pending).message).toBe(
      errors.timeoutUrl.replace("<url>", "https://www.iana.org/*"),
    )
    expect(h.listeners()).toBe(0)
  })

  test("caps its timeout at the remaining command budget", async () => {
    const h = harness({ timeout: 5000 })
    const pending = caught(url(h, { url: "https://www.iana.org/*", timeout: 60000 }))
    await settle()

    h.env.advance(4000)

    expect((await pending).message).toBe(
      errors.timeoutUrl.replace("<url>", "https://www.iana.org/*"),
    )
  })

  test("keeps a margin before the command deadline instead of tying with it", async () => {
    const h = harness({ timeout: 5000 })
    const pending = caught(url(h, { url: "https://www.iana.org/*", timeout: 60000 }))
    await settle()

    // one ms short of the margin-adjusted cap: still pending
    h.env.advance(3899)
    await settle()
    expect(h.listeners()).toBe(2)

    h.env.advance(1)

    expect((await pending).message).toBe(
      errors.timeoutUrl.replace("<url>", "https://www.iana.org/*"),
    )
    expect(h.listeners()).toBe(0)
  })

  test("defaults to a ten second wait", async () => {
    const h = harness({ timeout: 300000 })
    const pending = caught(url(h, { url: "https://www.iana.org/*" }))
    await settle()

    h.env.advance(9999)
    await settle()
    expect(h.listeners()).toBe(2)
    h.env.advance(1)

    expect((await pending).message).toContain("Timeout waiting for URL matching")
  })

  test("reports a tab closed while it waits", async () => {
    const h = harness()
    const pending = caught(url(h, { url: "https://www.iana.org/*" }))
    await settle()

    h.browser.removeTab(h.tabId)

    expect((await pending).message).toBe(errors.tabClosed.replace("<id>", String(h.tabId)))
    expect(h.listeners()).toBe(0)
  })

  test("reports a tab that is already gone", async () => {
    const h = harness()
    h.browser.removeTab(h.tabId)

    const error = await caught(url(h, { url: "https://www.iana.org/*" }))

    expect(error.message).toBe(errors.tabClosed.replace("<id>", String(h.tabId)))
    expect(h.listeners()).toBe(0)
  })
})

describe("waitFor routing", () => {
  test("answers a url wait in the background", async () => {
    const h = harness()

    expect(await h.wait({ url: "https://example.com/*" })).toEqual({
      tabId: h.tabId,
      url: "https://example.com/*",
      matched: "https://example.com/",
      found: true,
      elapsed: 0,
    })
    expect(h.sent).toEqual([])
  })

  test("forwards a text wait to the content script even with a url", async () => {
    const h = harness()

    expect(await h.wait({ text: "Example", url: "https://example.com/*" })).toEqual({
      tabId: h.tabId,
      forwarded: true,
    })
    expect(h.sent).toEqual([
      {
        tabId: h.tabId,
        action: "waitFor",
        params: { text: "Example", url: "https://example.com/*", timeout: 9900 },
      },
    ])
  })

  test("forwards a selector wait to the content script", async () => {
    const h = harness()

    expect(await h.wait({ selector: "h1" })).toEqual({ tabId: h.tabId, forwarded: true })
    expect(h.sent[0]?.params).toEqual({ selector: "h1", timeout: 9900 })
  })

  test("forwards a wait with no mode so the content script validates it", async () => {
    const h = harness()

    await h.wait({})

    expect(h.sent[0]?.action).toBe("waitFor")
  })

  test("drops the targeting params from the background wait", async () => {
    const h = harness()

    const result = await h.wait({ url: "https://example.com/*", tabId: h.tabId, windowId: 1 })

    expect(result).toMatchObject({ tabId: h.tabId, found: true })
  })
})

describe("waitFor on a loading tab", () => {
  function failing(h: Harness, message: string): () => number {
    let attempts = 0
    h.browser.sendMessageHandler = () => {
      attempts++
      return Promise.reject(new Error(message))
    }
    return () => attempts
  }

  const missing = "Could not establish connection. Receiving end does not exist."

  test("waits for the tab to complete and then runs the selector wait", async () => {
    const h = harness({ status: "loading" })
    h.browser.sendMessageHandler = (tabId, message) => {
      const frame = message as { action: string; params: JsonObject }
      h.sent.push({ tabId, action: frame.action, params: frame.params })
      return Promise.resolve({
        success: true,
        result: { selector: "h1", found: true, elapsed: 40 },
      })
    }
    const pending = h.wait({ selector: "h1" })
    await settle()
    expect(h.sent).toEqual([])
    expect(h.listeners()).toBe(2)

    h.env.advance(300)
    h.browser.emitTabUpdated(h.tabId, { status: "complete" })

    // elapsed covers both phases, the forwarded timeout only what is left
    expect(await pending).toEqual({ tabId: h.tabId, selector: "h1", found: true, elapsed: 340 })
    expect(h.sent[0]?.params).toEqual({ selector: "h1", timeout: 9600 })
    expect(h.listeners()).toBe(0)
  })

  test("a complete tab goes straight to the content action", async () => {
    const h = harness()

    expect(await h.wait({ selector: "h1" })).toEqual({ tabId: h.tabId, forwarded: true })
    expect(h.listeners()).toBe(0)
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("caps the forwarded timeout at the remaining command budget, not just --timeout", async () => {
    const h = harness({ timeout: 5000 })

    await h.wait({ selector: "h1", timeout: 60000 })

    // budget is 5000 - 1000 margin = 4000; minus this wait's own 100 ms margin
    expect(h.sent[0]?.params).toEqual({ selector: "h1", timeout: 3900 })
  })

  test("a tab that never completes yields the wait's own timeout text", async () => {
    const h = harness({ status: "loading", timeout: 300000 })
    const pending = caught(h.wait({ selector: "h1" }))
    await settle()

    h.env.advance(9999)
    await settle()
    expect(h.sent).toEqual([])
    h.env.advance(1)

    expect((await pending).message).toBe(errors.timeoutElement.replace("<selector>", "h1"))
    expect(h.listeners()).toBe(0)
  })

  test("a text wait on a stuck tab reports the text timeout", async () => {
    const h = harness({ status: "loading" })
    const pending = caught(h.wait({ text: "Hello", timeout: 2000 }))
    await settle()

    h.env.advance(2000)

    expect((await pending).message).toBe(errors.timeoutText.replace("<text>", "Hello"))
  })

  test("reports a tab closed while it waits for the load", async () => {
    const h = harness({ status: "loading" })
    const pending = caught(h.wait({ selector: "h1" }))
    await settle()

    h.browser.removeTab(h.tabId)

    expect((await pending).message).toBe(errors.tabClosed.replace("<id>", String(h.tabId)))
    expect(h.listeners()).toBe(0)
  })

  test("retries the send while the content script is not there yet", async () => {
    const h = harness()
    let attempts = 0
    h.browser.sendMessageHandler = (tabId, message) => {
      attempts++
      if (attempts <= 2) {
        return Promise.reject(new Error(missing))
      }
      const frame = message as { action: string; params: JsonObject }
      h.sent.push({ tabId, action: frame.action, params: frame.params })
      return Promise.resolve({ success: true, result: { found: true, elapsed: 0 } })
    }
    const pending = h.wait({ selector: "h1" })
    for (let i = 0; i < 3; i++) {
      await settle()
      h.env.advance(100)
    }
    await settle()

    expect(await pending).toEqual({ tabId: h.tabId, found: true, elapsed: 200 })
    expect(attempts).toBe(3)
    expect(h.sent).toHaveLength(1)
  })

  test("gives up with the wait's timeout text when every send fails", async () => {
    const h = harness()
    const attempts = failing(h, missing)
    const pending = caught(h.wait({ selector: "h1", timeout: 500 }))
    for (let i = 0; i < 8; i++) {
      await settle()
      h.env.advance(100)
    }
    await settle()

    expect((await pending).message).toBe(errors.timeoutElement.replace("<selector>", "h1"))
    expect(attempts()).toBe(5)
  })

  test("does not retry a failure the content script itself reported", async () => {
    const h = harness()
    const attempts = failing(h, "boom")
    const pending = caught(h.wait({ selector: "h1" }))
    await settle()

    expect((await pending).message).toBe("boom")
    expect(attempts()).toBe(1)
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("other page commands fail fast on a loading tab", async () => {
    const h = harness({ status: "loading" })
    const attempts = failing(h, missing)

    const error = await caught(Promise.resolve(pageHandlers.getContent({}, h.deps)))

    expect(error.message).toBe(
      errors.tabLoading.replace("<id>", String(h.tabId)).replace("<url>", "https://example.com/"),
    )
    expect(attempts()).toBe(1)
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("a url wait wins over a selector", async () => {
    const h = harness()

    expect(await h.wait({ url: "https://example.com/*", selector: "h1" })).toMatchObject({
      tabId: h.tabId,
      matched: "https://example.com/",
      found: true,
    })
    expect(h.sent).toEqual([])
  })
})

describe("waitFor inside a child frame", () => {
  const FRAME_ID = 7
  const FRAME_URL = "https://sdk-web-card.sandbox.y.uno/v1.88.5/pages/secured-fields.html#pan"
  const MISSING = "Could not establish connection. Receiving end does not exist."

  // FRAME_NOT_OBSERVED is documented with the rest of the frame commands, and
  // the fixture suite only accepts prefixes that are already in the docs
  const notObserved = (tabId: number, frameId: number): string =>
    `FRAME_NOT_OBSERVED: frame ${frameId} of tab ${tabId} is not observed; ` +
    "call watchFrames before the frame loads or reopen it"

  function frameHarness(options: { timeout?: number; status?: string } = {}): Harness {
    const h = harness(options)
    h.frames.attach(h.browser)
    return h
  }

  /** Puts one child frame of the tab on the registry, the way an injection ends. */
  async function observe(h: Harness, frameId = FRAME_ID): Promise<FakePort> {
    if (!h.frames.isWatched(h.tabId)) {
      h.frames.watch(h.tabId)
    }
    await h.frames.frameLoaded({
      tabId: h.tabId,
      frameId,
      parentFrameId: 0,
      url: FRAME_URL,
      timeStamp: 0,
    })
    const port = new FakePort({
      name: FRAME_PORT_NAME,
      sender: { tab: { id: h.tabId }, frameId, url: FRAME_URL },
    })
    h.browser.emitConnect(port)
    return port
  }

  test("refuses a url wait in a child frame before anything is sent", async () => {
    const h = frameHarness()
    await observe(h)

    const error = await caught(h.wait({ url: "https://example.com/*", frameId: FRAME_ID }))

    expect(error.message).toBe("waitFor --url is not supported with --frameId")
    expect(h.browser.sentMessages).toEqual([])
    expect(h.listeners()).toBe(1)
  })

  test("refuses a url wait in a frame even when text would win", async () => {
    const h = frameHarness()
    await observe(h)

    const error = await caught(
      h.wait({ text: "Pay", url: "https://example.com/*", frameId: FRAME_ID }),
    )

    expect(error.message).toBe("waitFor --url is not supported with --frameId")
    expect(h.browser.sentMessages).toEqual([])
  })

  test("awaits the frame instead of the tab load, then sends within one deadline", async () => {
    const h = frameHarness({ status: "loading" })
    h.frames.watch(h.tabId)

    const pending = h.wait({ selector: "#pan", frameId: FRAME_ID })
    await settle()
    // no awaitTabComplete: the frame is ready on its own schedule
    expect(h.browser.tabsUpdated.listeners.length).toBe(0)
    expect(h.browser.sentMessages).toEqual([])

    h.env.advance(2000)
    await observe(h)
    await settle()

    expect(await pending).toEqual({ tabId: h.tabId, frameId: FRAME_ID, forwarded: true })
    // the registry wait spent 2000 of the shared 9900 ms budget
    expect(h.sent[0]?.params).toEqual({ selector: "#pan", timeout: 7900 })
    expect(h.browser.sentMessages.map((message) => message.options)).toEqual([
      { frameId: FRAME_ID },
    ])
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("sends at once when the frame is already observed", async () => {
    const h = frameHarness({ status: "loading" })
    await observe(h)

    expect(await h.wait({ text: "Card number", frameId: FRAME_ID })).toEqual({
      tabId: h.tabId,
      frameId: FRAME_ID,
      forwarded: true,
    })
    expect(h.sent[0]?.params).toEqual({ text: "Card number", timeout: 9900 })
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("refuses at once when nobody watches the tab", async () => {
    const h = frameHarness()

    const error = await caught(h.wait({ selector: "#pan", frameId: FRAME_ID }))

    expect(error.message).toBe(notObserved(h.tabId, FRAME_ID))
    expect(h.browser.sentMessages).toEqual([])
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("reports the frame as unobserved when it never connects", async () => {
    const h = frameHarness()
    h.frames.watch(h.tabId)
    const pending = caught(h.wait({ selector: "#pan", frameId: FRAME_ID, timeout: 2000 }))
    await settle()

    h.env.advance(1899)
    await settle()
    expect(h.env.pendingTimers()).toBe(1)
    h.env.advance(1)

    expect((await pending).message).toBe(notObserved(h.tabId, FRAME_ID))
    expect(h.browser.sentMessages).toEqual([])
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("reports the frame as unobserved when the watch closes while it waits", async () => {
    const h = frameHarness()
    h.frames.watch(h.tabId)
    const pending = caught(h.wait({ selector: "#pan", frameId: FRAME_ID }))
    await settle()

    h.frames.unwatch(h.tabId)

    expect((await pending).message).toBe(notObserved(h.tabId, FRAME_ID))
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("reports the tab closed while it waits for the frame", async () => {
    const h = frameHarness()
    h.frames.watch(h.tabId)
    const pending = caught(h.wait({ selector: "#pan", frameId: FRAME_ID }))
    await settle()

    h.browser.removeTab(h.tabId)

    expect((await pending).message).toBe(errors.tabClosed.replace("<id>", String(h.tabId)))
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("forgets the frame and awaits it again when the send finds no receiver", async () => {
    const h = frameHarness()
    await observe(h)
    let attempts = 0
    h.browser.sendMessageHandler = (tabId, message) => {
      attempts++
      if (attempts === 1) {
        return Promise.reject(new Error(MISSING))
      }
      const frame = message as { action: string; params: JsonObject }
      h.sent.push({ tabId, action: frame.action, params: frame.params })
      return Promise.resolve({ success: true, result: { forwarded: true } })
    }

    const pending = h.wait({ selector: "#pan", frameId: FRAME_ID })
    await settle()
    // the stale entry is gone, so the frame has to be admitted afresh
    expect(h.frames.list(h.tabId)).toEqual([])
    h.env.advance(100)
    await settle()
    expect(attempts).toBe(1)

    await observe(h)
    await settle()

    expect(await pending).toEqual({ tabId: h.tabId, frameId: FRAME_ID, forwarded: true })
    expect(attempts).toBe(2)
    expect(h.sent[0]?.params).toEqual({ selector: "#pan", timeout: 9800 })
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("gives up with FRAME_NOT_OBSERVED when the frame never answers again", async () => {
    const h = frameHarness()
    await observe(h)
    let attempts = 0
    h.browser.sendMessageHandler = () => {
      attempts++
      return Promise.reject(new Error(MISSING))
    }
    const pending = caught(h.wait({ selector: "#pan", frameId: FRAME_ID, timeout: 500 }))
    for (let i = 0; i < 8; i++) {
      await settle()
      h.env.advance(100)
    }
    await settle()

    expect((await pending).message).toBe(notObserved(h.tabId, FRAME_ID))
    expect(attempts).toBe(1)
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("frameId 0 still waits for the tab to finish loading", async () => {
    const h = frameHarness({ status: "loading" })
    const pending = h.wait({ selector: "h1", frameId: 0 })
    await settle()
    expect(h.browser.tabsUpdated.listeners.length).toBe(1)
    expect(h.sent).toEqual([])

    h.env.advance(300)
    h.browser.emitTabUpdated(h.tabId, { status: "complete" })

    expect(await pending).toEqual({ tabId: h.tabId, forwarded: true })
    expect(h.sent[0]?.params).toEqual({ selector: "h1", timeout: 9600 })
  })

  test("frameId 0 keeps the url wait in the background", async () => {
    const h = frameHarness()

    expect(await h.wait({ url: "https://example.com/*", frameId: 0 })).toMatchObject({
      tabId: h.tabId,
      matched: "https://example.com/",
      found: true,
    })
    expect(h.browser.sentMessages).toEqual([])
  })
})
