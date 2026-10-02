// startHar and stopHar as the dispatcher calls them: which tab they target,
// how maxBodySize is checked, and what the stopped recording turns into.

import { describe, expect, test } from "bun:test"

import { AttachedTabs } from "../src/attached"
import type { RequestBody, StorageArea } from "../src/browser"
import { CaptureLocks } from "../src/capture-locks"
import type { HandlerDeps } from "../src/dispatch"
import { FrameRegistry } from "../src/frames"
import { REPLY_LIMIT, startHar, stopHar, stopHarWithin } from "../src/handlers/har"
import { INVALID_TAB_ID } from "../src/handlers/tabs"
import type { Har } from "../src/har"
import { HarRecorder } from "../src/har-recorder"
import { NetworkTracker } from "../src/network"
import type { JsonObject, JsonValue } from "../src/protocol"
import { commandContext } from "../src/protocol"
import { waitForPageReady } from "../src/readiness"
import { replyBytes } from "../src/reply"
import { Session } from "../src/session"
import { writeRedactHeaders } from "../src/settings"
import { FakeBrowser, FakeEnvironment } from "./fakes"

const TAB_ID = 1
const OTHER_TAB_ID = 2
const START = 1000
const MIB = 1024 * 1024
const KIB = 1024
const BUDGET_TEXT = "maxBodySize must be an integer between 0 and 167772160"

interface Harness {
  browser: FakeBrowser
  deps: HandlerDeps
  start(params?: JsonObject): Promise<JsonObject>
  stop(params?: JsonObject): Promise<Har>
}

/** A managed window whose active tab is TAB_ID, plus a user tab. */
function harness(): Harness {
  const browser = new FakeBrowser({ manifestVersion: "9.8.7", now: () => START })
  const env = new FakeEnvironment({ now: START })
  const session = new Session(browser, env)
  const har = new HarRecorder(env)
  har.attach(browser)
  const deps: HandlerDeps = {
    browser,
    env,
    session,
    attached: new AttachedTabs(browser, env),
    network: new NetworkTracker(env),
    captureLocks: new CaptureLocks(),
    frames: new FrameRegistry(env),
    har,
    readiness: waitForPageReady,
    ctx: commandContext({}, env),
  }
  browser.addWindow({ id: 1, focused: true })
  browser.currentWindowId = 1
  browser.addTab({ id: TAB_ID, windowId: 1, index: 0, url: "https://example.com/", active: true })
  browser.addTab({ id: OTHER_TAB_ID, windowId: 1, index: 1, url: "https://other.example/" })
  session.state = {
    windowId: 1,
    tabs: [TAB_ID],
    createdAt: START,
    groupId: null,
    isPrivate: false,
    adopted: false,
  }
  session.activeTabId = TAB_ID
  return {
    browser,
    deps,
    start: async (params = {}) => (await startHar(params, deps)) as JsonObject,
    stop: async (params = {}) => (await stopHar(params, deps)) as unknown as Har,
  }
}

async function rejection(work: JsonValue | Promise<JsonValue>): Promise<string> {
  try {
    await work
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("expected a rejection")
}

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}

/** A POST with a text body and the credential headers on both sides. */
function exchange(browser: FakeBrowser, requestId: string, body: string, tabId = TAB_ID): void {
  const base = {
    requestId,
    url: `https://example.com/${requestId}`,
    method: "POST",
    type: "xmlhttprequest",
    tabId,
  }
  const requestBody: RequestBody = { raw: [{ bytes: bytes(body) }] }
  void browser.emitRequestStarted({ ...base, requestBody })
  browser.emitSendHeaders({
    ...base,
    requestHeaders: [
      { name: "Content-Type", value: "text/plain" },
      { name: "Cookie", value: "sid=secret" },
    ],
  })
  browser.emitRequestCompleted({
    ...base,
    statusCode: 200,
    statusLine: "HTTP/1.1 200 OK",
    responseHeaders: [{ name: "Set-Cookie", value: "sid=fresh; Path=/" }],
  })
}

function headerValue(headers: { name: string; value: string }[], name: string): string {
  return headers.find((h) => h.name === name)?.value ?? "missing"
}

describe("startHar", () => {
  test("records the session active tab with the default body cap", async () => {
    const h = harness()

    const started = await h.start()

    expect(started).toEqual({
      tabId: TAB_ID,
      startedDateTime: new Date(START).toISOString(),
      maxBodySize: 10485760,
    })
    expect(h.deps.har.isRecording(TAB_ID)).toBe(true)
    expect(h.deps.har.isRecording(OTHER_TAB_ID)).toBe(false)
  })

  test("an explicit tabId records that tab, a windowId alongside is ignored", async () => {
    const h = harness()

    const started = await h.start({ tabId: OTHER_TAB_ID, windowId: 1, maxBodySize: 0 })

    expect(started).toMatchObject({ tabId: OTHER_TAB_ID, maxBodySize: 0 })
    expect(h.deps.har.isRecording(OTHER_TAB_ID)).toBe(true)
    expect(h.deps.har.isRecording(TAB_ID)).toBe(false)
  })

  test.each([0, 1, 167772160])("accepts maxBodySize %p", async (maxBodySize) => {
    const h = harness()
    expect(await h.start({ maxBodySize })).toMatchObject({ maxBodySize })
  })

  test.each<JsonValue>([-1, 1.5, 167772161, "10", true, null])(
    "rejects maxBodySize %p without recording",
    async (maxBodySize) => {
      const h = harness()
      expect(await rejection(startHar({ maxBodySize }, h.deps))).toBe(BUDGET_TEXT)
      expect(h.deps.har.isRecording(TAB_ID)).toBe(false)
    },
  )

  test("a tab already recording is refused", async () => {
    const h = harness()
    await h.start()

    expect(await rejection(startHar({}, h.deps))).toBe(
      `HAR_ALREADY_RECORDING: tab ${TAB_ID} is already recording; call stopHar first`,
    )
  })

  test("a closed tabId is TAB_CLOSED, a malformed one is refused", async () => {
    const h = harness()
    expect(await rejection(startHar({ tabId: 99 }, h.deps))).toBe(
      "TAB_CLOSED: Tab 99 no longer exists.",
    )
    expect(await rejection(startHar({ tabId: -3 }, h.deps))).toBe(INVALID_TAB_ID)
  })

  test("the first page is titled with the tab url", async () => {
    const h = harness()
    await h.start()

    const har = await h.stop()

    expect(har.log.pages[0]?.title).toBe("https://example.com/")
  })
})

describe("stopHar", () => {
  test("answers the HAR of the session active tab and forgets the recording", async () => {
    const h = harness()
    await h.start()
    exchange(h.browser, "r1", "hello")

    const har = await h.stop()

    expect(har.log.version).toBe("1.2")
    expect(har.log.creator).toEqual({ name: "firefox-ctl", version: "9.8.7" })
    expect(har.log.entries).toHaveLength(1)
    expect(har.log.entries[0]?.request.postData?.text).toBe("hello")
    expect(har.log._recording).toMatchObject({ tabId: TAB_ID, droppedBodies: 0, tabClosed: false })
    expect(h.deps.har.isRecording(TAB_ID)).toBe(false)
    expect(await rejection(stopHar({}, h.deps))).toBe(
      `HAR_NOT_RECORDING: no HAR recording on tab ${TAB_ID}`,
    )
  })

  test("a tab that never recorded answers HAR_NOT_RECORDING", async () => {
    const h = harness()
    expect(await rejection(stopHar({ tabId: OTHER_TAB_ID }, h.deps))).toBe(
      `HAR_NOT_RECORDING: no HAR recording on tab ${OTHER_TAB_ID}`,
    )
    expect(await rejection(stopHar({ tabId: 99 }, h.deps))).toBe(
      "TAB_CLOSED: Tab 99 no longer exists.",
    )
  })

  test("only the named tab stops, the other keeps recording", async () => {
    const h = harness()
    await h.start()
    await h.start({ tabId: OTHER_TAB_ID })
    exchange(h.browser, "o1", "other", OTHER_TAB_ID)

    const har = await h.stop({ tabId: OTHER_TAB_ID })

    expect(har.log._recording.tabId).toBe(OTHER_TAB_ID)
    expect(har.log.entries).toHaveLength(1)
    expect(h.deps.har.isRecording(TAB_ID)).toBe(true)
  })

  test("a recording whose tab closed still answers its tabId", async () => {
    const h = harness()
    await h.start({ tabId: OTHER_TAB_ID })
    exchange(h.browser, "o1", "other", OTHER_TAB_ID)
    h.browser.removeTab(OTHER_TAB_ID)

    const har = await h.stop({ tabId: OTHER_TAB_ID })

    expect(har.log._recording.tabClosed).toBe(true)
    expect(har.log.entries).toHaveLength(1)
  })

  test("credential headers and cookie values are redacted by default", async () => {
    const h = harness()
    await h.start()
    exchange(h.browser, "r1", "hello")

    const [entry] = (await h.stop()).log.entries

    expect(headerValue(entry?.request.headers ?? [], "Cookie")).toBe("[redacted]")
    expect(headerValue(entry?.response.headers ?? [], "Set-Cookie")).toBe("[redacted]")
    expect(entry?.request.cookies).toEqual([{ name: "sid", value: "[redacted]" }])
    expect(entry?.response.cookies.map((c) => c.value)).toEqual(["[redacted]"])
    expect(entry?.request.postData?.text).toBe("hello")
  })

  test("an unreadable setting redacts", async () => {
    const h = harness()
    await writeRedactHeaders(h.browser, false)
    await h.start()
    exchange(h.browser, "r1", "hello")
    const broken: StorageArea = {
      get: () => Promise.reject(new Error("storage offline")),
      set: (items) => h.browser.storage.local.set(items),
      remove: (keys) => h.browser.storage.local.remove(keys),
    }
    const deps = { ...h.deps, browser: { ...h.browser, storage: { local: broken } } }

    const har = (await stopHar({}, deps)) as unknown as Har

    expect(headerValue(har.log.entries[0]?.request.headers ?? [], "Cookie")).toBe("[redacted]")
  })

  test("the user's opt-out keeps the raw values", async () => {
    const h = harness()
    await writeRedactHeaders(h.browser, false)
    await h.start()
    exchange(h.browser, "r1", "hello")

    const [entry] = (await h.stop()).log.entries

    expect(headerValue(entry?.request.headers ?? [], "Cookie")).toBe("sid=secret")
    expect(headerValue(entry?.response.headers ?? [], "Set-Cookie")).toBe("sid=fresh; Path=/")
    expect(entry?.request.cookies).toEqual([{ name: "sid", value: "secret" }])
  })

  test("the reply limit is 256 MiB minus the envelope slack", () => {
    expect(REPLY_LIMIT).toBe(256 * MIB - 64 * KIB)
  })

  test("a reply over the limit drops the largest bodies until it fits", async () => {
    const record = async (): Promise<Harness> => {
      const h = harness()
      await h.start()
      exchange(h.browser, "small", "s")
      exchange(h.browser, "large", "x".repeat(4000))
      return h
    }
    // the same recording unfitted, less a bit more than the small body's room
    const limit = replyBytes(await (await record()).stop()) - 1000
    const h = await record()

    const har = (await stopHarWithin(limit)({}, h.deps)) as unknown as Har

    expect(replyBytes(har)).toBeLessThanOrEqual(limit)
    // one entry gave up both its bodies: the request's and the empty response
    expect(har.log._recording.droppedBodies).toBe(2)
    const [small, large] = har.log.entries
    expect(small?.request.postData?.text).toBe("s")
    expect(large?.request.postData?._bodyDropped).toBe(true)
    expect(large?.response.content._bodyDropped).toBe(true)
    expect(h.deps.har.isRecording(TAB_ID)).toBe(false)
  })

  test("a reply too large without bodies fails and still releases the recording", async () => {
    const h = harness()
    await h.start()
    exchange(h.browser, "r1", "hello")

    const text = await rejection(stopHarWithin(100)({}, h.deps))

    expect(text).toMatch(/^HAR_TOO_LARGE: HAR is \d+ bytes without bodies, the limit is 100$/)
    expect(h.deps.har.isRecording(TAB_ID)).toBe(false)
    expect(await rejection(stopHar({}, h.deps))).toBe(
      `HAR_NOT_RECORDING: no HAR recording on tab ${TAB_ID}`,
    )
  })
})
