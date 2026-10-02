// The HAR recorder driven through FakeBrowser webRequest and webNavigation
// events: which listeners a recording installs, how a request's hops, headers,
// errors and bodies are kept, and how navigations become HAR pages.

import { describe, expect, test } from "bun:test"

import type { RequestBody, RequestDetails } from "../src/browser"
import type { HarEntry, HarRecording } from "../src/har"
import { buildLog } from "../src/har"
import { HarRecorder, type StartOptions } from "../src/har-recorder"
import { FakeBrowser, FakeEnvironment } from "./fakes"

const TAB_ID = 1
const OTHER_TAB_ID = 2
const START = 500
const TAB_URL = "https://example.com/start"
const MIB = 1024 * 1024
const ALL_URLS = ["<all_urls>"]

interface Harness {
  browser: FakeBrowser
  recorder: HarRecorder
  /** Moves the clock the event emitters stamp with. */
  at(ms: number): void
  start(options?: Partial<StartOptions>, tabId?: number): void
  stop(tabId?: number): HarRecording
  entries(tabId?: number): HarEntry[]
}

function harness(): Harness {
  let clock = START
  const browser = new FakeBrowser({ manifestVersion: "9.8.7", now: () => clock })
  const env = new FakeEnvironment({ now: START })
  const recorder = new HarRecorder(env)
  recorder.attach(browser)
  for (const id of [TAB_ID, OTHER_TAB_ID]) {
    browser.addTab({ id, windowId: 1, url: TAB_URL })
  }
  return {
    browser,
    recorder,
    at: (ms) => {
      clock = ms
    },
    start: (options = {}, tabId = TAB_ID) => {
      recorder.start(tabId, { maxBodySize: 10 * MIB, url: TAB_URL, ...options })
    },
    stop: (tabId = TAB_ID) => recorder.stop(tabId),
    entries: (tabId = TAB_ID) => buildLog(recorder.stop(tabId)).log.entries,
  }
}

type Base = Pick<RequestDetails, "requestId" | "url" | "method" | "type" | "tabId">

function req(overrides: Partial<Base> = {}): Base {
  return {
    requestId: "r1",
    url: "https://example.com/api",
    method: "GET",
    type: "xmlhttprequest",
    tabId: TAB_ID,
    ...overrides,
  }
}

function header(name: string, value: string): { name: string; value: string } {
  return { name, value }
}

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}

function rawBody(...parts: string[]): RequestBody {
  return { raw: parts.map((part) => ({ bytes: bytes(part) })) }
}

/** One request through every event up to onCompleted. */
function complete(h: Harness, base: Base, from: number, status = 200): void {
  const statusLine = `HTTP/1.1 ${status} OK`
  h.at(from)
  void h.browser.emitRequestStarted(base)
  h.at(from + 10)
  h.browser.emitSendHeaders({ ...base, requestHeaders: [header("Accept", "*/*")] })
  h.at(from + 40)
  void h.browser.emitHeadersReceived({
    ...base,
    statusCode: status,
    statusLine,
    responseHeaders: [header("Content-Type", "text/plain")],
  })
  h.at(from + 45)
  h.browser.emitResponseStarted({ ...base, statusCode: status, statusLine, ip: "192.0.2.1" })
  h.at(from + 90)
  h.browser.emitRequestCompleted({ ...base, statusCode: status, statusLine, ip: "192.0.2.1" })
}

/** One request with a body, through onSendHeaders. */
function post(h: Harness, base: Base, requestBody: RequestBody, contentType: string): void {
  void h.browser.emitRequestStarted({ ...base, method: "POST", requestBody })
  h.browser.emitSendHeaders({
    ...base,
    method: "POST",
    requestHeaders: [header("Content-Type", contentType)],
  })
}

function listenerCounts(browser: FakeBrowser): number[] {
  return [
    browser.requestsStarted,
    browser.headersSent,
    browser.headersReceived,
    browser.responsesStarted,
    browser.requestsRedirected,
    browser.requestsCompleted,
    browser.requestsFailed,
  ].map((event) => event.listeners.length)
}

function only<T>(items: T[]): T {
  expect(items).toHaveLength(1)
  const [item] = items
  if (item === undefined) {
    throw new Error("no item")
  }
  return item
}

describe("HarRecorder start and stop", () => {
  test("start registers every webRequest listener filtered to the tab", () => {
    const h = harness()
    h.start()
    const filter = { urls: ALL_URLS, tabId: TAB_ID }
    const b = h.browser
    expect(b.requestsStarted.filters).toEqual([filter])
    expect(b.requestsStarted.extraInfoSpecs).toEqual([["blocking", "requestBody"]])
    expect(b.headersSent.filters).toEqual([filter])
    expect(b.headersSent.extraInfoSpecs).toEqual([["requestHeaders"]])
    expect(b.headersReceived.filters).toEqual([filter])
    expect(b.headersReceived.extraInfoSpecs).toEqual([["blocking", "responseHeaders"]])
    for (const event of [b.responsesStarted, b.requestsRedirected, b.requestsCompleted]) {
      expect(event.filters).toEqual([filter])
      expect(event.extraInfoSpecs).toEqual([["responseHeaders"]])
    }
    expect(b.requestsFailed.filters).toEqual([filter])
    expect(b.requestsFailed.extraInfoSpecs).toEqual([undefined])
  })

  test("maxBodySize 0 asks for neither the request body nor blocking", () => {
    const h = harness()
    h.start({ maxBodySize: 0 })
    expect(h.browser.requestsStarted.extraInfoSpecs).toEqual([undefined])
  })

  test("start before attach is refused", () => {
    const recorder = new HarRecorder(new FakeEnvironment())
    expect(() => recorder.start(TAB_ID, { maxBodySize: 0, url: TAB_URL })).toThrow(
      "HAR recorder is not attached",
    )
  })

  test("a second start on the same tab throws HAR_ALREADY_RECORDING", () => {
    const h = harness()
    h.start()
    expect(() => h.start()).toThrow(
      `HAR_ALREADY_RECORDING: tab ${TAB_ID} is already recording; call stopHar first`,
    )
    expect(listenerCounts(h.browser)).toEqual([1, 1, 1, 1, 1, 1, 1])
  })

  test("a failing addListener removes the listeners already added", () => {
    const h = harness()
    h.browser.requestsCompleted.addListener = () => {
      throw new Error("boom")
    }
    expect(() => h.start()).toThrow("boom")
    expect(listenerCounts(h.browser)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(h.recorder.isRecording(TAB_ID)).toBe(false)
    expect(() => h.stop()).toThrow("HAR_NOT_RECORDING")
  })

  test("requests of other tabs are not recorded", () => {
    const h = harness()
    h.start()
    complete(h, req({ tabId: OTHER_TAB_ID }), 1000)
    complete(h, req({ requestId: "r2", tabId: -1 }), 1000)
    expect(h.stop().hops).toEqual([])
  })

  test("stop removes every listener and returns the recording", () => {
    const h = harness()
    h.start({ maxBodySize: 2048 })
    complete(h, req(), 1000)
    const recording = h.stop()
    expect(listenerCounts(h.browser)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(recording.tabId).toBe(TAB_ID)
    expect(recording.start).toBe(START)
    expect(recording.maxBodySize).toBe(2048)
    expect(recording.creatorVersion).toBe("9.8.7")
    expect(recording.tabClosed).toBe(false)
    expect(recording.hops).toHaveLength(1)
    expect(h.recorder.isRecording(TAB_ID)).toBe(false)
  })

  test("stop of a tab without a recording throws HAR_NOT_RECORDING", () => {
    const h = harness()
    expect(() => h.stop()).toThrow(`HAR_NOT_RECORDING: no HAR recording on tab ${TAB_ID}`)
    h.start()
    h.stop()
    expect(() => h.stop()).toThrow(`HAR_NOT_RECORDING: no HAR recording on tab ${TAB_ID}`)
  })

  test("a second tab records independently", () => {
    const h = harness()
    h.start()
    h.start({}, OTHER_TAB_ID)
    complete(h, req({ url: "https://one.example/" }), 1000)
    complete(h, req({ url: "https://two.example/", tabId: OTHER_TAB_ID }), 1000)
    expect(h.stop().hops.map((hop) => hop.url)).toEqual(["https://one.example/"])
    expect(listenerCounts(h.browser)).toEqual([1, 1, 1, 1, 1, 1, 1])
    complete(h, req({ requestId: "r3", url: "https://three.example/", tabId: OTHER_TAB_ID }), 2000)
    expect(h.stop(OTHER_TAB_ID).hops.map((hop) => hop.url)).toEqual([
      "https://two.example/",
      "https://three.example/",
    ])
  })
})

describe("HarRecorder request lifecycle", () => {
  test("a GET gives one entry with headers, status, server and timings", () => {
    const h = harness()
    h.start()
    complete(h, req(), 1000)
    const entry = only(h.entries())
    expect(entry.startedDateTime).toBe(new Date(1000).toISOString())
    expect(entry.request.method).toBe("GET")
    expect(entry.request.url).toBe("https://example.com/api")
    expect(entry.request.headers).toEqual([header("Accept", "*/*")])
    expect(entry.response.status).toBe(200)
    expect(entry.response.statusText).toBe("OK")
    expect(entry.response.httpVersion).toBe("HTTP/1.1")
    expect(entry.response.headers).toEqual([header("Content-Type", "text/plain")])
    expect(entry.response.redirectURL).toBe("")
    expect(entry.serverIPAddress).toBe("192.0.2.1")
    expect(entry._fromCache).toBe(false)
    expect(entry.cache).toEqual({})
    expect(entry.timings).toEqual({
      blocked: 10,
      dns: -1,
      connect: -1,
      ssl: -1,
      send: 0,
      wait: 30,
      receive: 50,
    })
    expect(entry.time).toBe(90)
    expect(entry._pending).toBeUndefined()
    expect(entry._error).toBeUndefined()
  })

  test("a cached response carries _fromCache", () => {
    const h = harness()
    h.start()
    void h.browser.emitRequestStarted(req())
    h.browser.emitRequestCompleted({ ...req(), fromCache: true })
    expect(only(h.entries())._fromCache).toBe(true)
  })

  test("a redirect chain gives one entry per hop", () => {
    const h = harness()
    h.start()
    const first = req({ url: "http://example.com/", type: "main_frame" })
    h.at(1000)
    void h.browser.emitRequestStarted(first)
    h.at(1010)
    void h.browser.emitHeadersReceived({
      ...first,
      statusCode: 301,
      statusLine: "HTTP/1.1 301 Moved Permanently",
      responseHeaders: [header("Location", "https://example.com/")],
    })
    h.at(1020)
    h.browser.emitRedirect({
      ...first,
      statusCode: 301,
      statusLine: "HTTP/1.1 301 Moved Permanently",
      redirectUrl: "https://example.com/",
      ip: "192.0.2.7",
    })
    complete(h, req({ url: "https://example.com/", type: "main_frame" }), 1030)
    const [redirect, final] = h.entries()
    expect(redirect?.request.url).toBe("http://example.com/")
    expect(redirect?.response.status).toBe(301)
    expect(redirect?.response.statusText).toBe("Moved Permanently")
    expect(redirect?.response.redirectURL).toBe("https://example.com/")
    expect(redirect?.serverIPAddress).toBe("192.0.2.7")
    expect(redirect?.time).toBe(20)
    expect(redirect?._pending).toBeUndefined()
    expect(final?.request.url).toBe("https://example.com/")
    expect(final?.response.status).toBe(200)
    expect(final?.response.redirectURL).toBe("")
  })

  test("late events of an old hop never touch the current one", () => {
    const h = harness()
    h.start()
    const first = req({ url: "http://example.com/" })
    void h.browser.emitRequestStarted(first)
    h.browser.emitRedirect({ ...first, statusCode: 302, redirectUrl: "https://example.com/" })
    const second = req({ url: "https://example.com/" })
    void h.browser.emitRequestStarted(second)
    void h.browser.emitHeadersReceived({ ...first, statusCode: 500 })
    h.browser.emitRequestFailed({ ...first, error: "late" })
    h.browser.emitRequestCompleted({ ...first, statusCode: 500 })
    const [redirect, current] = h.entries()
    expect(redirect?.response.status).toBe(302)
    expect(redirect?._error).toBeUndefined()
    expect(current?.response.status).toBe(0)
    expect(current?._error).toBeUndefined()
    expect(current?._pending).toBe(true)
  })

  test("an error after headers keeps the status and headers", () => {
    const h = harness()
    h.start()
    void h.browser.emitRequestStarted(req())
    void h.browser.emitHeadersReceived({
      ...req(),
      statusCode: 200,
      responseHeaders: [header("Content-Length", "10")],
    })
    h.browser.emitRequestFailed({ ...req(), error: "NS_ERROR_NET_RESET" })
    const entry = only(h.entries())
    expect(entry.response.status).toBe(200)
    expect(entry.response.headers).toEqual([header("Content-Length", "10")])
    expect(entry._error).toBe("NS_ERROR_NET_RESET")
    expect(entry._pending).toBeUndefined()
  })

  test("an error before headers gives status 0", () => {
    const h = harness()
    h.start()
    void h.browser.emitRequestStarted(req())
    h.browser.emitRequestFailed({ ...req(), error: "NS_ERROR_UNKNOWN_HOST" })
    const entry = only(h.entries())
    expect(entry.response.status).toBe(0)
    expect(entry._error).toBe("NS_ERROR_UNKNOWN_HOST")
  })

  test("a request in flight at stop keeps what it has and is _pending", () => {
    const h = harness()
    h.start()
    const withHeaders = req({ requestId: "r1", url: "https://example.com/a" })
    const withoutHeaders = req({ requestId: "r2", url: "https://example.com/b" })
    h.at(1000)
    void h.browser.emitRequestStarted(withHeaders)
    void h.browser.emitHeadersReceived({
      ...withHeaders,
      statusCode: 206,
      responseHeaders: [header("Content-Range", "bytes 0-9/100")],
    })
    h.at(1001)
    void h.browser.emitRequestStarted(withoutHeaders)
    const recording = h.stop()
    expect(recording.hops.map((hop) => hop.pending)).toEqual([true, true])
    const [a, b] = buildLog(recording).log.entries
    expect(a?.response.status).toBe(206)
    expect(a?.response.headers).toEqual([header("Content-Range", "bytes 0-9/100")])
    expect(a?._pending).toBe(true)
    expect(b?.response.status).toBe(0)
    expect(b?._pending).toBe(true)
  })

  test("child frame requests carry _frameId and every entry its _resourceType", () => {
    const h = harness()
    h.start()
    void h.browser.emitRequestStarted({ ...req({ type: "image" }), frameId: 5 })
    const entry = only(h.entries())
    expect(entry._frameId).toBe(5)
    expect(entry._resourceType).toBe("image")
  })
})

describe("HarRecorder request bodies", () => {
  test("a raw body becomes postData in the request's Content-Type", () => {
    const h = harness()
    h.start()
    post(h, req(), rawBody('{"a":1}'), "application/json")
    const entry = only(h.entries())
    expect(entry.request.postData).toEqual({ mimeType: "application/json", text: '{"a":1}' })
    expect(entry.request.bodySize).toBe(7)
  })

  test("form data becomes params", () => {
    const h = harness()
    h.start()
    post(h, req(), { formData: { a: ["1"], b: ["2"] } }, "application/x-www-form-urlencoded")
    const entry = only(h.entries())
    expect(entry.request.postData).toEqual({
      mimeType: "application/x-www-form-urlencoded",
      params: [
        { name: "a", value: "1" },
        { name: "b", value: "2" },
      ],
      _formData: true,
    })
  })

  test("a body without request headers keeps an empty mime type", () => {
    const h = harness()
    h.start()
    void h.browser.emitRequestStarted({ ...req(), method: "POST", requestBody: rawBody("x") })
    expect(only(h.entries()).request.postData).toEqual({ mimeType: "", text: "x" })
  })

  test("maxBodySize 0 stores no request body", () => {
    const h = harness()
    h.start({ maxBodySize: 0 })
    post(h, req(), rawBody("secret"), "text/plain")
    const hop = only(h.stop().hops)
    expect(hop.postData).toBeUndefined()
    expect(hop.requestBody).toBeUndefined()
    expect(hop.bodyCaptured).toBe(false)
  })

  test("a body Firefox truncated comes out with _truncatedByBrowser", () => {
    const h = harness()
    h.start({ maxBodySize: 32 * MIB })
    const body: RequestBody = {
      raw: [{ bytes: new ArrayBuffer(16 * MIB), truncated: true, originalSize: 20 * MIB }],
    }
    post(h, req(), body, "application/octet-stream")
    const entry = only(h.entries())
    expect(entry.request.postData?._truncatedByBrowser).toBe(true)
    expect(entry.request.postData?._originalSize).toBe(20 * MIB)
    expect(entry.request.postData?._truncated).toBeUndefined()
    expect(entry.request.postData?.text).toHaveLength(16 * MIB)
    expect(entry.request.bodySize).toBe(-1)
  })

  test("a raw body above maxBodySize is cut to exactly maxBodySize bytes", () => {
    const h = harness()
    h.start({ maxBodySize: 4 })
    post(h, req(), rawBody("abcdefgh"), "text/plain")
    const entry = only(h.entries())
    expect(entry.request.postData).toEqual({
      mimeType: "text/plain",
      text: "abcd",
      _truncated: true,
    })
    // the size Firefox gave, not the stored prefix
    expect(entry.request.bodySize).toBe(8)
  })

  test("raw parts crossing the cap are cut inside the part that crosses it", () => {
    const h = harness()
    h.start({ maxBodySize: 6 })
    post(h, req(), rawBody("abcd", "efgh", "ijkl"), "text/plain")
    const entry = only(h.entries())
    expect(entry.request.postData?.text).toBe("abcdef")
    expect(entry.request.postData?._truncated).toBe(true)
    expect(entry.request.bodySize).toBe(12)
  })

  test("form data above maxBodySize keeps the params that fit", () => {
    const h = harness()
    h.start({ maxBodySize: 5 })
    post(h, req(), { formData: { ab: ["12"], cd: ["34"] } }, "application/x-www-form-urlencoded")
    const entry = only(h.entries())
    expect(entry.request.postData?.params).toEqual([{ name: "ab", value: "12" }])
    expect(entry.request.postData?._truncated).toBe(true)
  })

  test("the recording budget cuts below maxBodySize and then drops", () => {
    const h = harness()
    h.start({ maxBodySize: 8, bodyBudget: 10 })
    post(h, req({ requestId: "r1" }), rawBody("aaaaaaaa"), "text/plain")
    post(h, req({ requestId: "r2" }), rawBody("bbbbbbbb"), "text/plain")
    post(h, req({ requestId: "r3" }), rawBody("cccccccc"), "text/plain")
    const [first, second, third] = h.entries().map((e) => e.request.postData)
    expect(first).toEqual({ mimeType: "text/plain", text: "aaaaaaaa" })
    expect(second).toEqual({ mimeType: "text/plain", text: "bb", _truncated: true })
    expect(third).toEqual({ mimeType: "text/plain", _bodyDropped: true })
  })

  test("form data counts against the recording budget", () => {
    const h = harness()
    h.start({ maxBodySize: 8, bodyBudget: 4 })
    post(h, req({ requestId: "r1" }), { formData: { ab: ["12"] } }, "text/plain")
    post(h, req({ requestId: "r2" }), rawBody("x"), "text/plain")
    const [, second] = h.entries()
    expect(second?.request.postData).toEqual({ mimeType: "text/plain", _bodyDropped: true })
  })

  test("only the stored prefix is kept, never Firefox's buffers", () => {
    const h = harness()
    h.start({ maxBodySize: 3 })
    const buffer = bytes("abcdef")
    post(h, req(), { raw: [{ bytes: buffer }] }, "text/plain")
    new Uint8Array(buffer).fill(0x7a)
    const recording = h.stop()
    const part = recording.hops[0]?.requestBody?.raw?.[0]
    expect(part?.bytes).not.toBe(buffer)
    expect(part?.bytes).not.toBeInstanceOf(ArrayBuffer)
    expect(part?.bytes?.byteLength).toBe(6)
    expect(buildLog(recording).log.entries[0]?.request.postData?.text).toBe("abc")
  })
})

type NavigationEvent = "request" | "before" | "committed"

const ORDERS: NavigationEvent[][] = [
  ["request", "before", "committed"],
  ["request", "committed", "before"],
  ["before", "request", "committed"],
  ["before", "committed", "request"],
  ["committed", "request", "before"],
  ["committed", "before", "request"],
]

/** The three events of one top-level navigation in the given order. */
function navigate(h: Harness, requestId: string, url: string, order: NavigationEvent[]): void {
  for (const event of order) {
    switch (event) {
      case "request":
        void h.browser.emitRequestStarted(req({ requestId, url, type: "main_frame" }))
        break
      case "before":
        h.browser.emitBeforeNavigate({ tabId: TAB_ID, frameId: 0, url })
        break
      case "committed":
        h.browser.emitCommitted({ tabId: TAB_ID, frameId: 0, url })
        break
    }
  }
}

describe("HarRecorder pages", () => {
  test("start opens a page for the document already loaded", () => {
    const h = harness()
    h.start()
    complete(h, req(), 1000)
    const log = buildLog(h.stop()).log
    expect(log.pages).toEqual([
      {
        id: "page_1",
        startedDateTime: new Date(START).toISOString(),
        title: TAB_URL,
        pageTimings: { onContentLoad: -1, onLoad: -1 },
      },
    ])
    expect(log.entries[0]?.pageref).toBe("page_1")
  })

  test("a top-level navigation opens a page its redirect hops and subresources share", () => {
    const h = harness()
    h.start()
    const first = req({ requestId: "nav", url: "http://example.com/", type: "main_frame" })
    h.at(1000)
    h.browser.emitBeforeNavigate({ tabId: TAB_ID, frameId: 0, url: "http://example.com/" })
    void h.browser.emitRequestStarted(first)
    h.browser.emitRedirect({ ...first, redirectUrl: "https://example.com/" })
    h.at(1010)
    void h.browser.emitRequestStarted({ ...first, url: "https://example.com/" })
    h.at(1050)
    h.browser.emitCommitted({ tabId: TAB_ID, frameId: 0, url: "https://example.com/" })
    h.at(1060)
    void h.browser.emitRequestStarted(req({ requestId: "css", type: "stylesheet" }))
    h.at(1200)
    h.browser.emitFrameLoaded({ tabId: TAB_ID, frameId: 0, url: "https://example.com/" })
    h.at(1400)
    h.browser.emitNavigationCompleted({ tabId: TAB_ID, frameId: 0, url: "https://example.com/" })
    const log = buildLog(h.stop()).log
    expect(log.pages.map((p) => p.id)).toEqual(["page_1", "page_2"])
    expect(log.pages[1]).toEqual({
      id: "page_2",
      startedDateTime: new Date(1000).toISOString(),
      title: "https://example.com/",
      pageTimings: { onContentLoad: 200, onLoad: 400 },
    })
    expect(log.entries.map((e) => e.pageref)).toEqual(["page_2", "page_2", "page_2"])
  })

  test("a navigation seen only through webRequest still opens a page", () => {
    const h = harness()
    h.start()
    h.at(1000)
    void h.browser.emitRequestStarted(req({ requestId: "nav", type: "main_frame" }))
    const log = buildLog(h.stop()).log
    expect(log.pages.map((p) => [p.id, p.title, p.startedDateTime])).toEqual([
      ["page_1", TAB_URL, new Date(START).toISOString()],
      ["page_2", "https://example.com/api", new Date(1000).toISOString()],
    ])
    expect(log.entries[0]?.pageref).toBe("page_2")
  })

  test("two consecutive navigations with redirects give two pages", () => {
    const h = harness()
    h.start()
    for (const [index, id] of ["one", "two"].entries()) {
      const from = 1000 + index * 1000
      const hop = req({ requestId: id, url: `http://${id}.example/`, type: "main_frame" })
      h.at(from)
      h.browser.emitBeforeNavigate({ tabId: TAB_ID, frameId: 0, url: hop.url })
      void h.browser.emitRequestStarted(hop)
      h.browser.emitRedirect({ ...hop, redirectUrl: `https://${id}.example/` })
      h.at(from + 10)
      void h.browser.emitRequestStarted({ ...hop, url: `https://${id}.example/` })
      h.at(from + 20)
      h.browser.emitCommitted({ tabId: TAB_ID, frameId: 0, url: `https://${id}.example/` })
      h.at(from + 30)
      void h.browser.emitRequestStarted(req({ requestId: `${id}-img`, type: "image" }))
    }
    const log = buildLog(h.stop()).log
    expect(log.pages.map((p) => [p.id, p.title])).toEqual([
      ["page_1", TAB_URL],
      ["page_2", "https://one.example/"],
      ["page_3", "https://two.example/"],
    ])
    expect(log.entries.map((e) => e.pageref)).toEqual([
      "page_2",
      "page_2",
      "page_2",
      "page_3",
      "page_3",
      "page_3",
    ])
  })

  for (const order of ORDERS) {
    test(`events in the order ${order.join(", ")} give one page per navigation`, () => {
      const h = harness()
      h.start()
      h.at(1000)
      navigate(h, "one", "https://one.example/", order)
      h.at(2000)
      navigate(h, "two", "https://two.example/", order)
      const log = buildLog(h.stop()).log
      expect(log.pages.map((p) => [p.id, p.title, p.startedDateTime])).toEqual([
        ["page_1", TAB_URL, new Date(START).toISOString()],
        ["page_2", "https://one.example/", new Date(1000).toISOString()],
        ["page_3", "https://two.example/", new Date(2000).toISOString()],
      ])
      expect(log.entries.map((e) => e.pageref)).toEqual(["page_2", "page_3"])
    })
  }

  test("navigation events of other tabs and child frames are ignored", () => {
    const h = harness()
    h.start()
    h.at(1000)
    h.browser.emitBeforeNavigate({ tabId: OTHER_TAB_ID, frameId: 0, url: "https://other/" })
    h.browser.emitCommitted({ tabId: OTHER_TAB_ID, frameId: 0, url: "https://other/" })
    h.browser.emitFrameLoaded({ tabId: OTHER_TAB_ID, frameId: 0, url: "https://other/" })
    h.browser.emitBeforeNavigate({ tabId: TAB_ID, frameId: 3, url: "https://frame/" })
    h.browser.emitCommitted({ tabId: TAB_ID, frameId: 3, url: "https://frame/" })
    h.browser.emitFrameLoaded({ tabId: TAB_ID, frameId: 3, url: "https://frame/" })
    h.browser.emitNavigationCompleted({ tabId: TAB_ID, frameId: 3, url: "https://frame/" })
    void h.browser.emitRequestStarted({ ...req({ type: "sub_frame" }), frameId: 3 })
    const log = buildLog(h.stop()).log
    expect(log.pages).toEqual([
      {
        id: "page_1",
        startedDateTime: new Date(START).toISOString(),
        title: TAB_URL,
        pageTimings: { onContentLoad: -1, onLoad: -1 },
      },
    ])
    expect(log.entries[0]?.pageref).toBe("page_1")
  })

  test("pages of tabs without a recording are not tracked", () => {
    const h = harness()
    h.browser.emitBeforeNavigate({ tabId: TAB_ID, frameId: 0, url: "https://early/" })
    h.start()
    expect(buildLog(h.stop()).log.pages.map((p) => p.id)).toEqual(["page_1"])
  })
})

describe("HarRecorder tab close", () => {
  test("closing the tab removes the listeners and keeps the data", () => {
    const h = harness()
    h.start()
    void h.browser.emitRequestStarted(req())
    h.browser.removeTab(TAB_ID)
    expect(listenerCounts(h.browser)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(h.recorder.isRecording(TAB_ID)).toBe(true)
    const recording = h.stop()
    expect(recording.tabClosed).toBe(true)
    expect(recording.hops).toHaveLength(1)
    expect(buildLog(recording).log._recording.tabClosed).toBe(true)
  })

  test("closing another tab leaves the recording alone", () => {
    const h = harness()
    h.start()
    h.browser.removeTab(OTHER_TAB_ID)
    expect(listenerCounts(h.browser)).toEqual([1, 1, 1, 1, 1, 1, 1])
    expect(h.stop().tabClosed).toBe(false)
  })

  test("attach is once only", () => {
    const h = harness()
    const removals = h.browser.tabsRemoved.listeners.length
    const navigations = h.browser.navigationsStarted.listeners.length
    h.recorder.attach(h.browser)
    expect(h.browser.tabsRemoved.listeners).toHaveLength(removals)
    expect(h.browser.navigationsStarted.listeners).toHaveLength(navigations)
  })
})
