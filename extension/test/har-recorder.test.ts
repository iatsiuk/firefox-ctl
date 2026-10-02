// The HAR recorder driven through FakeBrowser webRequest and webNavigation
// events: which listeners a recording installs, how a request's hops, headers,
// errors and bodies are kept, and how navigations become HAR pages.

import { describe, expect, test } from "bun:test"

import type { CertificateInfo, RequestBody, RequestDetails, SecurityInfo } from "../src/browser"
import type { Har, HarEntry, HarRecording } from "../src/har"
import { buildLog } from "../src/har"
import { HAR_KEEP_MS, HarRecorder, type StartOptions } from "../src/har-recorder"
import { FakeBrowser, FakeEnvironment, type FakeStreamFilter } from "./fakes"

const TAB_ID = 1
const OTHER_TAB_ID = 2
const START = 500
const TAB_URL = "https://example.com/start"
const MIB = 1024 * 1024
const ALL_URLS = ["<all_urls>"]

interface Harness {
  browser: FakeBrowser
  env: FakeEnvironment
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
    env,
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

  test("a kept HAR stays while it is built and for HAR_KEEP_MS after", async () => {
    const h = harness()
    h.start()
    const har = Promise.resolve(buildLog(h.stop()))
    h.recorder.keep(TAB_ID, har)
    expect(h.recorder.kept(TAB_ID)).toBe(har)
    expect(h.recorder.kept(OTHER_TAB_ID)).toBeUndefined()
    await har
    h.env.advance(HAR_KEEP_MS - 1)
    expect(h.recorder.kept(TAB_ID)).toBe(har)
    h.env.advance(1)
    expect(h.recorder.kept(TAB_ID)).toBeUndefined()
  })

  test("a HAR still being built is kept however long it takes", () => {
    const h = harness()
    h.start()
    h.stop()
    const building = new Promise<Har>(() => {})
    h.recorder.keep(TAB_ID, building)
    h.env.advance(10 * HAR_KEEP_MS)
    expect(h.recorder.kept(TAB_ID)).toBe(building)
  })

  test("a failed build is kept like a HAR", async () => {
    const h = harness()
    h.start()
    h.stop()
    const failed = Promise.reject(new Error("HAR_TOO_LARGE: too large"))
    h.recorder.keep(TAB_ID, failed)
    await failed.catch(() => undefined)
    expect(h.recorder.kept(TAB_ID)).toBe(failed)
    h.env.advance(HAR_KEEP_MS)
    expect(h.recorder.kept(TAB_ID)).toBeUndefined()
  })

  test("the next recording of the tab releases its kept HAR", () => {
    const h = harness()
    h.start()
    h.recorder.keep(TAB_ID, Promise.resolve(buildLog(h.stop())))
    h.start()
    expect(h.recorder.kept(TAB_ID)).toBeUndefined()
  })

  test("the next recording cancels the kept HAR's expiry", async () => {
    const h = harness()
    h.start()
    const har = Promise.resolve(buildLog(h.stop()))
    h.recorder.keep(TAB_ID, har)
    await har
    const timers = h.env.pendingTimers()
    h.start()
    expect(h.env.pendingTimers()).toBe(timers - 1)
  })

  test("a HAR released while it is built sets no expiry", async () => {
    const h = harness()
    h.start()
    const log = buildLog(h.stop())
    let finish: (har: Har) => void = () => undefined
    const building = new Promise<Har>((resolve) => {
      finish = resolve
    })
    h.recorder.keep(TAB_ID, building)
    h.start()
    const timers = h.env.pendingTimers()
    finish(log)
    await building
    expect(h.env.pendingTimers()).toBe(timers)
  })

  test("an older HAR's expiry leaves a newer HAR of the tab kept", async () => {
    const h = harness()
    h.start()
    const older = Promise.resolve(buildLog(h.stop()))
    h.recorder.keep(TAB_ID, older)
    await older
    h.env.advance(HAR_KEEP_MS / 2)
    h.start()
    const newer = Promise.resolve(buildLog(h.stop()))
    h.recorder.keep(TAB_ID, newer)
    await newer
    h.env.advance(HAR_KEEP_MS / 2)
    expect(h.recorder.kept(TAB_ID)).toBe(newer)
    h.env.advance(HAR_KEEP_MS / 2)
    expect(h.recorder.kept(TAB_ID)).toBeUndefined()
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

  test("a response without a peer address has no serverIPAddress", () => {
    const h = harness()
    h.start()
    void h.browser.emitRequestStarted(req())
    h.browser.emitRequestCompleted({ ...req(), fromCache: true, ip: null })
    expect(only(h.entries()).serverIPAddress).toBeUndefined()
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

  test("a GET under the default maxBodySize is recorded with bodySize 0", () => {
    const h = harness()
    h.start()
    complete(h, req(), 600)

    const entry = only(h.entries())
    expect(entry.request.url).toBe("https://example.com/api")
    expect(entry.request.bodySize).toBe(0)
    expect(entry.request.postData).toBeUndefined()
    expect(entry.response.status).toBe(200)
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

  test("file parts of a multipart body survive the cut", () => {
    const h = harness()
    h.start({ maxBodySize: 2 })
    const body: RequestBody = { raw: [{ bytes: bytes("abcd") }, { file: "<file>" }] }
    post(h, req(), body, "multipart/form-data; boundary=x")
    expect(only(h.entries()).request.postData).toEqual({
      mimeType: "multipart/form-data; boundary=x",
      text: "ab",
      _fileParts: 1,
      _truncated: true,
    })
  })

  test("a body Firefox could not read comes out with _error", () => {
    const h = harness()
    h.start()
    post(h, req(), { error: "Unable to read" }, "text/plain")
    expect(only(h.entries()).request.postData).toEqual({
      mimeType: "text/plain",
      text: "",
      _error: "Unable to read",
    })
  })

  test("a body without bytes is kept once the budget is spent", () => {
    const h = harness()
    h.start({ maxBodySize: 4, bodyBudget: 4 })
    post(h, req({ requestId: "r1" }), rawBody("abcd"), "text/plain")
    post(h, req({ requestId: "r2" }), { raw: [{ file: "<file>" }] }, "text/plain")
    const [, second] = h.entries().map((e) => e.request.postData)
    expect(second).toEqual({ mimeType: "text/plain", text: "", _fileParts: 1 })
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

  // firefox fires onBeforeNavigate again before a cross-process commit
  test("a repeated onBeforeNavigate of a navigation in flight stays on its page", () => {
    const h = harness()
    h.start()
    const hop = req({ requestId: "nav", url: "https://example.com/go", type: "main_frame" })
    h.at(1000)
    void h.browser.emitRequestStarted(hop)
    h.browser.emitBeforeNavigate({ tabId: TAB_ID, frameId: 0, url: hop.url })
    h.browser.emitRedirect({ ...hop, redirectUrl: "https://example.com/html" })
    h.at(1010)
    void h.browser.emitRequestStarted({ ...hop, url: "https://example.com/html" })
    h.at(1900)
    h.browser.emitBeforeNavigate({ tabId: TAB_ID, frameId: 0, url: "https://example.com/html" })
    h.at(1902)
    h.browser.emitCommitted({ tabId: TAB_ID, frameId: 0, url: "https://example.com/html" })
    h.at(1910)
    void h.browser.emitRequestStarted(req({ requestId: "icon", type: "image" }))
    h.at(2000)
    h.browser.emitFrameLoaded({ tabId: TAB_ID, frameId: 0, url: "https://example.com/html" })
    h.at(2100)
    h.browser.emitNavigationCompleted({
      tabId: TAB_ID,
      frameId: 0,
      url: "https://example.com/html",
    })
    h.at(3000)
    navigate(h, "next", "https://example.com/next", ["request", "before", "before", "committed"])
    const log = buildLog(h.stop()).log
    expect(log.pages.map((p) => [p.id, p.title, p.pageTimings])).toEqual([
      ["page_1", TAB_URL, { onContentLoad: -1, onLoad: -1 }],
      ["page_2", "https://example.com/html", { onContentLoad: 1000, onLoad: 1100 }],
      ["page_3", "https://example.com/next", { onContentLoad: -1, onLoad: -1 }],
    ])
    expect(log.entries.map((e) => e.pageref)).toEqual(["page_2", "page_2", "page_2", "page_3"])
  })

  test("a navigation without a request leaves the next navigation's document on its own page", () => {
    const h = harness()
    h.start()
    // about:blank, data: and back-forward cache loads reach no webRequest listener
    h.at(1000)
    h.browser.emitBeforeNavigate({ tabId: TAB_ID, frameId: 0, url: "about:blank" })
    h.browser.emitCommitted({ tabId: TAB_ID, frameId: 0, url: "about:blank" })
    for (const [index, id] of ["one", "two"].entries()) {
      h.at(2000 + index * 1000)
      navigate(h, id, `https://${id}.example/`, ["request", "before", "committed"])
    }
    const log = buildLog(h.stop()).log
    expect(log.pages.map((p) => [p.id, p.title])).toEqual([
      ["page_1", TAB_URL],
      ["page_2", "about:blank"],
      ["page_3", "https://one.example/"],
      ["page_4", "https://two.example/"],
    ])
    expect(log.entries.map((e) => e.pageref)).toEqual(["page_3", "page_4"])
  })

  test("a navigation in flight at start does not shift the pages after it", () => {
    const h = harness()
    h.start()
    // its onBeforeNavigate and request came before start
    h.at(1000)
    h.browser.emitCommitted({ tabId: TAB_ID, frameId: 0, url: "https://early.example/" })
    for (const [index, id] of ["one", "two"].entries()) {
      h.at(2000 + index * 1000)
      navigate(h, id, `https://${id}.example/`, ["before", "request", "committed"])
    }
    const log = buildLog(h.stop()).log
    expect(log.pages.map((p) => [p.id, p.title])).toEqual([
      ["page_1", TAB_URL],
      ["page_2", "https://early.example/"],
      ["page_3", "https://one.example/"],
      ["page_4", "https://two.example/"],
    ])
    expect(log.entries.map((e) => e.pageref)).toEqual(["page_3", "page_4"])
  })

  test("a fragment in the navigation url still binds to the request", () => {
    const h = harness()
    h.start()
    h.at(1000)
    h.browser.emitBeforeNavigate({ tabId: TAB_ID, frameId: 0, url: "https://one.example/#top" })
    void h.browser.emitRequestStarted(
      req({ requestId: "one", url: "https://one.example/", type: "main_frame" }),
    )
    h.browser.emitCommitted({ tabId: TAB_ID, frameId: 0, url: "https://one.example/#top" })
    const log = buildLog(h.stop()).log
    expect(log.pages.map((p) => [p.id, p.title])).toEqual([
      ["page_1", TAB_URL],
      ["page_2", "https://one.example/#top"],
    ])
    expect(log.entries.map((e) => e.pageref)).toEqual(["page_2"])
  })

  test("the old document's load timings never land on the next page", () => {
    const h = harness()
    h.start()
    h.at(1000)
    h.browser.emitBeforeNavigate({ tabId: TAB_ID, frameId: 0, url: "https://one.example/" })
    h.at(1100)
    h.browser.emitFrameLoaded({ tabId: TAB_ID, frameId: 0, url: TAB_URL })
    h.browser.emitNavigationCompleted({ tabId: TAB_ID, frameId: 0, url: TAB_URL })
    h.at(1200)
    void h.browser.emitRequestStarted(
      req({ requestId: "one", url: "https://one.example/", type: "main_frame" }),
    )
    h.browser.emitCommitted({ tabId: TAB_ID, frameId: 0, url: "https://one.example/" })
    h.at(1500)
    h.browser.emitFrameLoaded({ tabId: TAB_ID, frameId: 0, url: "https://one.example/" })
    h.at(1700)
    h.browser.emitNavigationCompleted({ tabId: TAB_ID, frameId: 0, url: "https://one.example/" })
    const log = buildLog(h.stop()).log
    expect(log.pages.map((p) => p.pageTimings)).toEqual([
      { onContentLoad: 600, onLoad: 600 },
      { onContentLoad: 500, onLoad: 700 },
    ])
  })

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

function text(data: Uint8Array): string {
  return new TextDecoder().decode(data)
}

/** The stream filter of the request's latest hop. */
function filterOf(h: Harness, requestId = "r1"): FakeStreamFilter {
  const filter = h.browser.streamFilterFor(requestId)
  if (filter === undefined) {
    throw new Error(`no stream filter for ${requestId}`)
  }
  return filter
}

/** onBeforeRequest and text/plain response headers. */
function textRequest(h: Harness, base: Base): void {
  void h.browser.emitRequestStarted(base)
  void h.browser.emitHeadersReceived({
    ...base,
    responseHeaders: [header("Content-Type", "text/plain")],
  })
}

/** A text response whose body arrives in the given chunks, through onCompleted. */
function respond(h: Harness, base: Base, ...chunks: string[]): FakeStreamFilter {
  textRequest(h, base)
  const filter = filterOf(h, base.requestId)
  filter.pushStart()
  for (const chunk of chunks) {
    filter.pushData(chunk)
  }
  filter.pushStop()
  h.browser.emitRequestCompleted(base)
  return filter
}

describe("HarRecorder response bodies", () => {
  test("every hop gets a stream filter from the blocking onBeforeRequest", () => {
    const h = harness()
    h.start()
    const first = req({ url: "http://example.com/", type: "main_frame" })
    void h.browser.emitRequestStarted(first)
    h.browser.emitRedirect({ ...first, statusCode: 301, redirectUrl: "https://example.com/" })
    void h.browser.emitRequestStarted({ ...first, url: "https://example.com/" })
    void h.browser.emitRequestStarted(req({ requestId: "r2" }))
    expect(h.browser.streamFilters.map((entry) => entry.requestId)).toEqual(["r1", "r1", "r2"])
  })

  test("maxBodySize 0 opens no stream filter", () => {
    const h = harness()
    h.start({ maxBodySize: 0 })
    textRequest(h, req())
    h.browser.emitRequestCompleted(req())
    expect(h.browser.streamFilters).toHaveLength(0)
    const [entry] = h.entries()
    expect(entry?.response.content).toEqual({ size: 0, mimeType: "text/plain" })
  })

  test("every chunk is written through unchanged and in order, then stored", () => {
    const h = harness()
    h.start()
    const filter = respond(h, req(), "ab", "cd", "ef")
    expect(filter.written.map(text)).toEqual(["ab", "cd", "ef"])
    expect(text(filter.pageData())).toBe("abcdef")
    expect(filter.status).toBe("closed")
    const [entry] = h.entries()
    expect(entry?.response.content).toEqual({ size: 6, mimeType: "text/plain", text: "abcdef" })
  })

  test("a chunk the filter cannot write is never stored", () => {
    const h = harness()
    h.start()
    textRequest(h, req())
    const filter = filterOf(h)
    filter.pushStart()
    filter.pushData("ab")
    const write = filter.write.bind(filter)
    filter.write = () => {
      throw new Error("NS_ERROR_FAILURE")
    }
    expect(() => filter.pushData("cd")).toThrow("NS_ERROR_FAILURE")
    filter.write = write
    filter.pushData("ef")
    filter.pushStop()
    expect(h.entries()[0]?.response.content.text).toBe("abef")
  })

  test("binary bodies are stored byte for byte", () => {
    const h = harness()
    h.start()
    void h.browser.emitRequestStarted(req())
    void h.browser.emitHeadersReceived({
      ...req(),
      responseHeaders: [header("Content-Type", "image/png")],
    })
    const filter = filterOf(h)
    filter.pushStart()
    filter.pushData(new Uint8Array([0x89, 0x50, 0x00, 0xff]))
    filter.pushStop()
    h.browser.emitRequestCompleted(req())
    const content = h.entries()[0]?.response.content
    expect(content?.encoding).toBe("base64")
    expect(content?.text).toBe("iVAA/w==")
  })

  test("a late onerror of a redirected hop ends that hop's body only", () => {
    const h = harness()
    h.start()
    const first = req({ url: "http://example.com/", type: "main_frame" })
    void h.browser.emitRequestStarted(first)
    const old = filterOf(h)
    h.browser.emitRedirect({ ...first, statusCode: 301, redirectUrl: "https://example.com/" })
    const second = { ...first, url: "https://example.com/" }
    textRequest(h, second)
    const current = filterOf(h)
    current.pushStart()
    current.pushData("he")
    old.pushError("Channel redirected")
    current.pushData("llo")
    current.pushStop()
    h.browser.emitRequestCompleted(second)
    const [redirect, final] = h.entries()
    expect(redirect?.response.content._bodyError).toBe("Channel redirected")
    expect(final?.response.content._bodyError).toBeUndefined()
    expect(final?.response.content.text).toBe("hello")
    expect(final?.response.content._complete).toBeUndefined()
  })
})

describe("HarRecorder response body limits", () => {
  test("a body past maxBodySize keeps exactly maxBodySize bytes and lets go", () => {
    const h = harness()
    h.start({ maxBodySize: 4 })
    textRequest(h, req())
    const filter = filterOf(h)
    filter.pushStart()
    filter.pushData("ab")
    filter.pushData("cdef")
    expect(filter.status).toBe("disconnected")
    filter.pushData("gh")
    filter.pushStop()
    h.browser.emitRequestCompleted(req())
    expect(filter.written.map(text)).toEqual(["ab", "cdef"])
    expect(text(filter.pageData())).toBe("abcdefgh")
    const content = h.entries()[0]?.response.content
    expect(content?.text).toBe("abcd")
    // the bytes seen up to the disconnect, the overflowing chunk included
    expect(content?.size).toBe(6)
    expect(content?._truncated).toBe(true)
    expect(content?._complete).toBe(false)
  })

  test("a body of exactly maxBodySize bytes is complete", () => {
    const h = harness()
    h.start({ maxBodySize: 4 })
    const filter = respond(h, req(), "ab", "cd")
    expect(filter.status).toBe("closed")
    const content = h.entries()[0]?.response.content
    expect(content?.text).toBe("abcd")
    expect(content?.size).toBe(4)
    expect(content?._truncated).toBeUndefined()
  })

  test("the recording budget cuts the response crossing it and drops the later ones", () => {
    const h = harness()
    h.start({ maxBodySize: 4, bodyBudget: 6 })
    respond(h, req({ requestId: "r1" }), "abcd")
    const crossing = respond(h, req({ requestId: "r2" }), "wxyz")
    void h.browser.emitRequestStarted(req({ requestId: "r3" }))
    void h.browser.emitHeadersReceived({ ...req({ requestId: "r3" }), statusCode: 200 })
    expect(h.browser.streamFilterFor("r3")).toBeUndefined()
    expect(crossing.status).toBe("disconnected")
    expect(text(crossing.pageData())).toBe("wxyz")
    const [first, second, third] = h.entries().map((entry) => entry.response.content)
    expect(first?.text).toBe("abcd")
    expect(second?.text).toBe("wx")
    expect(second?.size).toBe(4)
    expect(second?._truncated).toBe(true)
    expect(third?._bodyDropped).toBe(true)
    expect(third?.text).toBeUndefined()
  })

  test("a spent budget drops nothing from responses that have no body", () => {
    const h = harness()
    h.start({ maxBodySize: 4, bodyBudget: 4 })
    respond(h, req({ requestId: "spend" }), "abcd")
    complete(h, req({ requestId: "head", method: "HEAD" }), 1000)
    complete(h, req({ requestId: "empty" }), 1100, 204)
    complete(h, req({ requestId: "same" }), 1200, 304)
    const hop = req({ requestId: "moved", url: "http://example.com/" })
    void h.browser.emitRequestStarted(hop)
    h.browser.emitRedirect({ ...hop, statusCode: 301, redirectUrl: "https://example.com/" })
    complete(h, req({ requestId: "moved", url: "https://example.com/" }), 1300)
    const log = buildLog(h.stop()).log
    const dropped = log.entries.map((entry) => entry.response.content._bodyDropped === true)
    expect(dropped).toEqual([false, false, false, false, false, true])
    expect(log._recording.droppedBodies).toBe(1)
  })

  test("a spent budget drops nothing from a request that never got a response", () => {
    const h = harness()
    h.start({ maxBodySize: 4, bodyBudget: 4 })
    respond(h, req({ requestId: "spend" }), "abcd")
    const failed = req({ requestId: "dns", url: "https://nowhere.invalid/" })
    void h.browser.emitRequestStarted(failed)
    h.browser.emitRequestFailed({ ...failed, error: "NS_ERROR_UNKNOWN_HOST" })
    const log = buildLog(h.stop()).log
    const entry = log.entries[1]
    expect(entry?.response.status).toBe(0)
    expect(entry?.response.content._bodyDropped).toBeUndefined()
    expect(log._recording.droppedBodies).toBe(0)
  })

  test("a filter whose first data meets a spent budget is dropped, not truncated", () => {
    const h = harness()
    h.start({ maxBodySize: 4, bodyBudget: 4 })
    textRequest(h, req({ requestId: "late" }))
    respond(h, req({ requestId: "spend" }), "abcd")
    const late = filterOf(h, "late")
    late.pushStart()
    late.pushData("wxyz")
    expect(late.status).toBe("disconnected")
    expect(text(late.pageData())).toBe("wxyz")
    h.browser.emitRequestCompleted(req({ requestId: "late" }))
    const log = buildLog(h.stop()).log
    const content = log.entries[0]?.response.content
    expect(content?._bodyDropped).toBe(true)
    expect(content?._truncated).toBeUndefined()
    expect(content?.text).toBeUndefined()
    expect(log._recording).toMatchObject({ truncatedBodies: 0, droppedBodies: 1 })
  })

  test("request bodies spend the budget responses share", () => {
    const h = harness()
    h.start({ maxBodySize: 4, bodyBudget: 4 })
    void h.browser.emitRequestStarted({ ...req(), method: "POST", requestBody: rawBody("abcd") })
    void h.browser.emitHeadersReceived({ ...req(), method: "POST", statusCode: 200 })
    expect(h.browser.streamFilters).toHaveLength(0)
    expect(h.entries()[0]?.response.content._bodyDropped).toBe(true)
  })
})

describe("HarRecorder response body errors", () => {
  test("onerror records _bodyError and keeps the entry", () => {
    const h = harness()
    h.start()
    void h.browser.emitRequestStarted(req())
    void h.browser.emitHeadersReceived({ ...req(), statusCode: 200 })
    const filter = filterOf(h)
    filter.pushStart()
    filter.pushData("ab")
    filter.pushError("NS_ERROR_NET_RESET")
    h.browser.emitRequestFailed({ ...req(), error: "NS_ERROR_NET_RESET" })
    const [entry] = h.entries()
    expect(entry?.response.status).toBe(200)
    expect(entry?._error).toBe("NS_ERROR_NET_RESET")
    expect(entry?.response.content._bodyError).toBe("NS_ERROR_NET_RESET")
    expect(entry?.response.content._complete).toBe(false)
  })

  test("filterResponseData throwing records _bodyError and the request goes on", async () => {
    const h = harness()
    h.start()
    h.browser.failFilterResponseData = "Invalid request ID"
    expect(await h.browser.emitRequestStarted(req())).toEqual([undefined])
    h.browser.emitRequestCompleted(req())
    const [entry] = h.entries()
    expect(entry?.response.status).toBe(200)
    expect(entry?.response.content._bodyError).toBe("Invalid request ID")
  })

  test("cached alternative data ending the filter is recorded as a body error", () => {
    const h = harness()
    h.start()
    void h.browser.emitRequestStarted(req({ type: "script" }))
    const filter = filterOf(h)
    filter.pushStart()
    filter.pushError("Channel is delivering cached alt-data")
    h.browser.emitRequestCompleted(req({ type: "script" }))
    const content = h.entries()[0]?.response.content
    expect(content?._bodyError).toBe("Channel is delivering cached alt-data")
  })
})

describe("HarRecorder stream filter release", () => {
  test("stop disconnects a started filter at once", () => {
    const h = harness()
    h.start()
    textRequest(h, req())
    const filter = filterOf(h)
    filter.pushStart()
    filter.pushData("ab")
    const recording = h.stop()
    expect(filter.status).toBe("disconnected")
    filter.pushData("cd")
    filter.pushStop()
    expect(text(filter.pageData())).toBe("abcd")
    const content = buildLog(recording).log.entries[0]?.response.content
    expect(content?.text).toBe("ab")
    expect(content?._complete).toBe(false)
  })

  for (const status of ["suspended", "finishedtransferringdata"] as const) {
    test(`stop disconnects a filter ${status}`, () => {
      const h = harness()
      h.start()
      textRequest(h, req())
      const filter = filterOf(h)
      filter.pushStart()
      filter.status = status
      h.stop()
      expect(filterOf(h).status).toBe("disconnected")
    })
  }

  test("a filter before onstart disconnects on its onstart and stays out of the recording", () => {
    const h = harness()
    h.start()
    void h.browser.emitRequestStarted(req())
    const filter = filterOf(h)
    const recording = h.stop()
    expect(filter.status).toBe("uninitialized")
    filter.pushStart()
    expect(filter.status).toBe("disconnected")
    filter.pushData("ab")
    expect(text(filter.pageData())).toBe("ab")
    expect(filter.written).toHaveLength(0)
    expect(recording.hops[0]?.body).toEqual({ chunks: [], complete: false })
  })

  test("terminal filters are left alone", () => {
    const h = harness()
    h.start({ maxBodySize: 2 })
    const closed = respond(h, req({ requestId: "r1" }), "ab")
    const cut = respond(h, req({ requestId: "r2" }), "abc")
    void h.browser.emitRequestStarted(req({ requestId: "r3" }))
    const failed = filterOf(h, "r3")
    failed.pushError("NS_ERROR_ABORT")
    expect(() => h.stop()).not.toThrow()
    expect([closed.status, cut.status, failed.status]).toEqual(["closed", "disconnected", "failed"])
  })

  test("a second stop throws HAR_NOT_RECORDING and leaves the filter alone", () => {
    const h = harness()
    h.start()
    void h.browser.emitRequestStarted(req())
    const filter = filterOf(h)
    h.stop()
    expect(() => h.stop()).toThrow("HAR_NOT_RECORDING")
    filter.pushStart()
    filter.pushData("ab")
    expect(filter.status).toBe("disconnected")
    expect(text(filter.pageData())).toBe("ab")
  })

  test("a tab closed while a filter waits for onstart still lets the page through", () => {
    const h = harness()
    h.start()
    void h.browser.emitRequestStarted(req())
    const filter = filterOf(h)
    h.browser.removeTab(TAB_ID)
    const recording = h.stop()
    expect(() => filter.pushStart()).not.toThrow()
    filter.pushData("ab")
    expect(text(filter.pageData())).toBe("ab")
    expect(recording.hops[0]?.body?.chunks).toHaveLength(0)
  })

  test("a body error after stop never reaches the finished recording", () => {
    const h = harness()
    h.start()
    const first = req({ url: "http://example.com/", type: "main_frame" })
    void h.browser.emitRequestStarted(first)
    const old = filterOf(h)
    h.browser.emitRedirect({ ...first, statusCode: 301, redirectUrl: "https://example.com/" })
    const recording = h.stop()
    expect(() => old.pushError("Channel redirected")).not.toThrow()
    expect(recording.hops[0]?.body?.error).toBeUndefined()
  })

  test("a body error of a closed tab before stop is recorded", () => {
    const h = harness()
    h.start()
    void h.browser.emitRequestStarted(req())
    const filter = filterOf(h)
    filter.pushStart()
    h.browser.removeTab(TAB_ID)
    filter.pushError("NS_BINDING_ABORTED")
    expect(h.entries()[0]?.response.content._bodyError).toBe("NS_BINDING_ABORTED")
  })
})

const VALID_FROM = Date.UTC(2026, 0, 1)
const VALID_TO = Date.UTC(2027, 0, 1)

function certificate(subject: string): CertificateInfo {
  return {
    subject: `CN=${subject}`,
    issuer: "CN=Example CA",
    validity: { start: VALID_FROM, end: VALID_TO },
    fingerprint: { sha1: "aa:bb", sha256: `${subject}:sha256` },
    serialNumber: "01",
    isBuiltInRoot: false,
  }
}

const SECURE: SecurityInfo = {
  state: "secure",
  protocolVersion: "TLSv1.3",
  cipherSuite: "TLS_AES_128_GCM_SHA256",
  keaGroupName: "x25519",
  signatureSchemeName: "ECDSA-P256-SHA256",
  secretKeyLength: 128,
  isExtendedValidation: false,
  isDomainMismatch: false,
  certificateTransparencyStatus: "valid",
  hsts: true,
  hpkp: false,
  weaknessReasons: [],
  certificates: [certificate("example.com"), certificate("Example CA")],
}

describe("HarRecorder TLS summary", () => {
  test("an https response gets _securityInfo from the first certificate", async () => {
    const h = harness()
    h.start()
    h.browser.securityInfo = SECURE
    void h.browser.emitRequestStarted(req())
    const answers = await h.browser.emitHeadersReceived({ ...req(), statusCode: 200 })
    expect(answers).toEqual([undefined])
    expect(h.browser.securityInfoCalls).toEqual([{ requestId: "r1", options: {}, blocking: true }])
    expect(only(h.entries())._securityInfo).toStrictEqual({
      state: "secure",
      protocolVersion: "TLSv1.3",
      cipherSuite: "TLS_AES_128_GCM_SHA256",
      keaGroupName: "x25519",
      signatureSchemeName: "ECDSA-P256-SHA256",
      isExtendedValidation: false,
      hsts: true,
      hpkp: false,
      certificate: {
        subject: "CN=example.com",
        issuer: "CN=Example CA",
        validity: {
          start: new Date(VALID_FROM).toISOString(),
          end: new Date(VALID_TO).toISOString(),
        },
        fingerprint: { sha256: "example.com:sha256" },
      },
    })
  })

  test("errorMessage is copied when Firefox gives one", async () => {
    const h = harness()
    h.start()
    h.browser.securityInfo = {
      state: "broken",
      errorMessage: "SSL_ERROR_BAD_CERT",
    }
    void h.browser.emitRequestStarted(req())
    await h.browser.emitHeadersReceived({ ...req(), statusCode: 200 })
    expect(only(h.entries())._securityInfo).toStrictEqual({
      state: "broken",
      errorMessage: "SSL_ERROR_BAD_CERT",
    })
  })

  test("a wss handshake is asked like https", async () => {
    const h = harness()
    h.start()
    h.browser.securityInfo = SECURE
    const socket = req({ url: "wss://example.com/socket", type: "websocket" })
    void h.browser.emitRequestStarted(socket)
    await h.browser.emitHeadersReceived({ ...socket, statusCode: 101 })
    expect(only(h.entries())._securityInfo?.state).toBe("secure")
  })

  test("an http request is not asked and answers at once", async () => {
    const h = harness()
    h.start()
    h.browser.securityInfo = SECURE
    const plain = req({ url: "http://example.com/api" })
    void h.browser.emitRequestStarted(plain)
    const answers = h.browser.emitHeadersReceived({ ...plain, statusCode: 200 })
    expect(h.browser.headersReceived.isBlocking("r1")).toBe(false)
    expect(h.browser.securityInfoCalls).toEqual([])
    expect(await answers).toEqual([undefined])
    expect(only(h.entries())._securityInfo).toBeUndefined()
  })

  test("the summary lands on the hop that asked, not on a later hop", async () => {
    const h = harness()
    h.start()
    const first = req({ url: "https://example.com/old" })
    const second = req({ url: "https://example.com/new" })
    h.browser.securityInfo = { ...SECURE, certificates: [certificate("old.example")] }
    void h.browser.emitRequestStarted(first)
    const asked = h.browser.emitHeadersReceived({ ...first, statusCode: 301 })
    h.browser.emitRedirect({ ...first, statusCode: 301, redirectUrl: second.url })
    void h.browser.emitRequestStarted(second)
    await asked
    const [redirect, current] = h.entries()
    expect(redirect?._securityInfo?.certificate?.subject).toBe("CN=old.example")
    expect(current?._securityInfo).toBeUndefined()
  })

  test("each hop of a redirect keeps its own summary", async () => {
    const h = harness()
    h.start()
    const first = req({ url: "https://example.com/old" })
    const second = req({ url: "https://example.com/new" })
    h.browser.securityInfo = { ...SECURE, certificates: [certificate("old.example")] }
    void h.browser.emitRequestStarted(first)
    const firstAsked = h.browser.emitHeadersReceived({ ...first, statusCode: 301 })
    h.browser.emitRedirect({ ...first, statusCode: 301, redirectUrl: second.url })
    void h.browser.emitRequestStarted(second)
    h.browser.securityInfo = { ...SECURE, certificates: [certificate("new.example")] }
    const secondAsked = h.browser.emitHeadersReceived({ ...second, statusCode: 200 })
    await Promise.all([firstAsked, secondAsked])
    const subjects = h.entries().map((entry) => entry._securityInfo?.certificate?.subject)
    expect(subjects).toEqual(["CN=old.example", "CN=new.example"])
  })

  test("an answer after stop never reaches the finished recording", async () => {
    const h = harness()
    h.start()
    h.browser.securityInfo = SECURE
    void h.browser.emitRequestStarted(req())
    const asked = h.browser.emitHeadersReceived({ ...req(), statusCode: 200 })
    const recording = h.stop()
    await asked
    expect(recording.hops[0]?.securityInfo).toBeUndefined()
  })

  test("a getSecurityInfo rejection leaves the entry without _securityInfo", async () => {
    const h = harness()
    h.start()
    h.browser.securityInfo = new Error("no security info")
    void h.browser.emitRequestStarted(req())
    const answers = await h.browser.emitHeadersReceived({ ...req(), statusCode: 200 })
    expect(answers).toEqual([undefined])
    const entry = only(h.entries())
    expect(entry._securityInfo).toBeUndefined()
    expect(entry.response.status).toBe(200)
  })

  test("events of a stale hop are not asked", () => {
    const h = harness()
    h.start()
    const first = req({ url: "https://example.com/old" })
    void h.browser.emitRequestStarted(first)
    h.browser.emitRedirect({ ...first, statusCode: 302, redirectUrl: "https://example.com/new" })
    void h.browser.emitHeadersReceived({ ...first, statusCode: 500 })
    expect(h.browser.securityInfoCalls).toEqual([])
  })
})
