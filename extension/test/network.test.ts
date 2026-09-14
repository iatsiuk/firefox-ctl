import { describe, expect, test } from "bun:test"
import type { CompletedDetails, ErrorDetails, RequestDetails } from "../src/browser"
import {
  MAX_NETWORK_ENTRIES,
  NetworkTracker,
  RECENT_WINDOW_MS,
  SENSITIVE_HEADERS,
} from "../src/network"
import { FakeBrowser, FakeEnvironment } from "./fakes"

interface Harness {
  browser: FakeBrowser
  env: FakeEnvironment
  tracker: NetworkTracker
}

function harness(): Harness {
  const browser = new FakeBrowser()
  const env = new FakeEnvironment()
  const tracker = new NetworkTracker(env)
  tracker.attach(browser)
  return { browser, env, tracker }
}

function started(overrides: Partial<RequestDetails> = {}): RequestDetails {
  return {
    requestId: "1",
    url: "https://example.com/app.js",
    method: "GET",
    type: "script",
    tabId: 7,
    ...overrides,
  }
}

function completed(overrides: Partial<CompletedDetails> = {}): CompletedDetails {
  return { ...started(), statusCode: 200, ...overrides }
}

function failed(overrides: Partial<ErrorDetails> = {}): ErrorDetails {
  return { ...started(), error: "NS_ERROR_NET_RESET", ...overrides }
}

describe("NetworkTracker", () => {
  test("listens to every webRequest event with a response headers spec", () => {
    const { browser } = harness()

    expect(browser.requestsStarted.listeners).toHaveLength(1)
    expect(browser.requestsStarted.filters[0]).toEqual({ urls: ["<all_urls>"] })
    expect(browser.requestsCompleted.extraInfoSpecs[0]).toEqual(["responseHeaders"])
    expect(browser.requestsFailed.listeners).toHaveLength(1)
  })

  test("records a started request as pending with the current clock", () => {
    const { browser, env, tracker } = harness()
    env.advance(500)

    browser.emitRequestStarted(started())

    const result = tracker.query()
    expect(result).toEqual({
      requests: [
        {
          requestId: "1",
          url: "https://example.com/app.js",
          method: "GET",
          type: "script",
          tabId: 7,
          timestamp: 500,
          status: "pending",
        },
      ],
      total: 1,
      filtered: 1,
    })
  })

  test("completes an entry with the status code and duration", () => {
    const { browser, env, tracker } = harness()
    browser.emitRequestStarted(started())
    env.advance(120)
    browser.emitRequestCompleted(
      completed({ statusCode: 204, responseHeaders: [{ name: "Set-Cookie", value: "a=1" }] }),
    )

    const entry = tracker.query({ includeHeaders: true }).requests[0]
    expect(entry?.status).toBe("completed")
    expect(entry?.statusCode).toBe(204)
    expect(entry?.duration).toBe(120)
    expect(entry?.responseHeaders).toEqual([{ name: "Set-Cookie", value: "a=1" }])
  })

  test("marks a failed entry with the error and duration", () => {
    const { browser, env, tracker } = harness()
    browser.emitRequestStarted(started())
    env.advance(40)
    browser.emitRequestFailed(failed())

    const entry = tracker.query().requests[0]
    expect(entry?.status).toBe("error")
    expect(entry?.error).toBe("NS_ERROR_NET_RESET")
    expect(entry?.duration).toBe(40)
  })

  test("ignores completion and error events for unknown requests", () => {
    const { browser, tracker } = harness()

    browser.emitRequestCompleted(completed({ requestId: "ghost" }))
    browser.emitRequestFailed(failed({ requestId: "ghost" }))

    expect(tracker.query().total).toBe(0)
  })

  test("evicts the oldest entry beyond the ring size", () => {
    const { browser, tracker } = harness()
    for (let i = 0; i < MAX_NETWORK_ENTRIES + 5; i++) {
      browser.emitRequestStarted(started({ requestId: `r${i}` }))
    }

    const result = tracker.query({ limit: MAX_NETWORK_ENTRIES })
    expect(result.total).toBe(MAX_NETWORK_ENTRIES)
    expect(result.requests[0]?.requestId).toBe("r5")
    expect(result.requests.at(-1)?.requestId).toBe(`r${MAX_NETWORK_ENTRIES + 4}`)
  })

  test("redacts sensitive query values, case-insensitively, and keeps safe ones", () => {
    const { browser, tracker } = harness()
    browser.emitRequestStarted(started({ url: "https://example.com/a?token=abc&page=2" }))
    browser.emitRequestStarted(
      started({ requestId: "2", url: "https://example.com/b?X-API-Key=zzz&Secret=s&q=hi" }),
    )

    const urls = tracker.query().requests.map((request) => request.url)
    expect(urls[0]).toBe("https://example.com/a?token=%5BREDACTED%5D&page=2")
    expect(urls[1]).toContain("X-API-Key=%5BREDACTED%5D")
    expect(urls[1]).toContain("Secret=%5BREDACTED%5D")
    expect(urls[1]).toContain("q=hi")
  })

  test("leaves an unparseable url untouched", () => {
    const { browser, tracker } = harness()
    browser.emitRequestStarted(started({ url: "not a url" }))

    expect(tracker.query().requests[0]?.url).toBe("not a url")
  })

  test("filters by tab, type and status and limits to the newest entries", () => {
    const { browser, tracker } = harness()
    browser.emitRequestStarted(started({ requestId: "a", tabId: 1, type: "script" }))
    browser.emitRequestStarted(started({ requestId: "b", tabId: 2, type: "image" }))
    browser.emitRequestStarted(started({ requestId: "c", tabId: 1, type: "image" }))
    browser.emitRequestCompleted(completed({ requestId: "c", tabId: 1, type: "image" }))

    expect(tracker.query({ tabId: 1 }).filtered).toBe(2)
    expect(tracker.query({ type: "image" }).requests.map((r) => r.requestId)).toEqual(["b", "c"])
    expect(tracker.query({ status: "completed" }).requests.map((r) => r.requestId)).toEqual(["c"])
    expect(tracker.query({ limit: 1 }).requests.map((r) => r.requestId)).toEqual(["c"])
    expect(tracker.query({ tabId: 1, type: "image", status: "pending" }).filtered).toBe(0)
  })

  test("limit 0 keeps the newest zero entries instead of the whole buffer", () => {
    const { browser, tracker } = harness()
    browser.emitRequestStarted(started({ requestId: "a" }))
    browser.emitRequestStarted(started({ requestId: "b" }))

    const result = tracker.query({ limit: 0 })

    expect(result.requests).toEqual([])
    expect(result.filtered).toBe(0)
    expect(result.total).toBe(2)
  })

  test("strips response headers unless they are asked for", () => {
    const { browser, tracker } = harness()
    browser.emitRequestStarted(started())
    browser.emitRequestCompleted(completed({ responseHeaders: [{ name: "X-A", value: "1" }] }))

    expect(tracker.query().requests[0]).not.toHaveProperty("responseHeaders")
    expect(tracker.query({ includeHeaders: true }).requests[0]?.responseHeaders).toHaveLength(1)
  })

  test("redacts credential-bearing header values, case-insensitively", () => {
    const { browser, tracker } = harness()
    browser.emitRequestStarted(started())
    browser.emitRequestCompleted(
      completed({
        responseHeaders: [
          { name: "set-cookie", value: "session=abc" },
          { name: "Authorization", value: "Bearer t" },
          { name: "WWW-Authenticate", value: "Basic realm=x" },
          { name: "Content-Type", value: "text/html" },
        ],
      }),
    )

    const headers = tracker.query({ includeHeaders: true, redact: true }).requests[0]
      ?.responseHeaders
    expect(headers).toEqual([
      { name: "set-cookie", value: "[redacted]" },
      { name: "Authorization", value: "[redacted]" },
      { name: "WWW-Authenticate", value: "[redacted]" },
      { name: "Content-Type", value: "text/html" },
    ])
  })

  test("redacts every sensitive header name", () => {
    const { browser, tracker } = harness()
    browser.emitRequestStarted(started())
    browser.emitRequestCompleted(
      completed({
        responseHeaders: SENSITIVE_HEADERS.map((name) => ({ name, value: "secret" })),
      }),
    )

    const headers = tracker.query({ includeHeaders: true, redact: true }).requests[0]
      ?.responseHeaders
    expect(headers?.every((header) => header.value === "[redacted]")).toBe(true)
    expect(headers).toHaveLength(SENSITIVE_HEADERS.length)
  })

  test("drops binaryValue from a redacted header", () => {
    const { browser, tracker } = harness()
    browser.emitRequestStarted(started())
    browser.emitRequestCompleted(
      completed({
        responseHeaders: [{ name: "set-cookie", binaryValue: [115, 101, 115, 115] }],
      }),
    )

    const headers = tracker.query({ includeHeaders: true, redact: true }).requests[0]
      ?.responseHeaders
    expect(headers).toEqual([{ name: "set-cookie", value: "[redacted]" }])
  })

  test("redact false returns the raw header values", () => {
    const { browser, tracker } = harness()
    browser.emitRequestStarted(started())
    browser.emitRequestCompleted(
      completed({ responseHeaders: [{ name: "Set-Cookie", value: "session=abc" }] }),
    )

    expect(
      tracker.query({ includeHeaders: true, redact: false }).requests[0]?.responseHeaders,
    ).toEqual([{ name: "Set-Cookie", value: "session=abc" }])
  })

  test("redaction does not add headers to a query that omits them", () => {
    const { browser, tracker } = harness()
    browser.emitRequestStarted(started())
    browser.emitRequestCompleted(
      completed({ responseHeaders: [{ name: "Set-Cookie", value: "session=abc" }] }),
    )

    expect(tracker.query({ redact: true }).requests[0]).not.toHaveProperty("responseHeaders")
  })

  test("leaves the stored entry untouched after a redacted query", () => {
    const { browser, tracker } = harness()
    browser.emitRequestStarted(started())
    browser.emitRequestCompleted(
      completed({ responseHeaders: [{ name: "Set-Cookie", value: "session=abc" }] }),
    )

    tracker.query({ includeHeaders: true, redact: true })

    expect(
      tracker.query({ includeHeaders: true, redact: false }).requests[0]?.responseHeaders,
    ).toEqual([{ name: "Set-Cookie", value: "session=abc" }])
  })

  test("clear returns the filtered list with an emptied total", () => {
    const { browser, tracker } = harness()
    browser.emitRequestStarted(started({ requestId: "a" }))
    browser.emitRequestStarted(started({ requestId: "b" }))

    const result = tracker.query({ clear: true })
    expect(result.requests.map((r) => r.requestId)).toEqual(["a", "b"])
    expect(result.filtered).toBe(2)
    expect(result.total).toBe(0)
    expect(tracker.query()).toEqual({ requests: [], total: 0, filtered: 0 })
  })

  test("returned entries are copies, so a caller cannot mutate the buffer", () => {
    const { browser, tracker } = harness()
    browser.emitRequestStarted(started())

    const entry = tracker.query().requests[0]
    if (entry) {
      entry.url = "https://evil.example"
    }

    expect(tracker.query().requests[0]?.url).toBe("https://example.com/app.js")
  })

  test("tabStatus counts pending requests by type for the tab", () => {
    const { browser, env, tracker } = harness()
    env.advance(1000)
    browser.emitRequestStarted(started({ requestId: "a", tabId: 1, type: "script" }))
    browser.emitRequestStarted(started({ requestId: "b", tabId: 1, type: "image" }))
    browser.emitRequestStarted(started({ requestId: "c", tabId: 1, type: "font" }))
    browser.emitRequestStarted(started({ requestId: "d", tabId: 1, type: "xmlhttprequest" }))
    browser.emitRequestStarted(started({ requestId: "e", tabId: 2, type: "script" }))
    browser.emitRequestCompleted(completed({ requestId: "a", tabId: 1, type: "script" }))

    expect(tracker.tabStatus(1)).toEqual({
      pending: 3,
      pendingByType: { image: 1, font: 1, xmlhttprequest: 1 },
      criticalPending: 1,
      visualPending: 2,
      lastActivity: 1000,
      isIdle: false,
      isCriticalIdle: false,
    })
  })

  test("tabStatus is idle without requests and reports no activity", () => {
    const { tracker } = harness()

    expect(tracker.tabStatus(1)).toEqual({
      pending: 0,
      pendingByType: {},
      criticalPending: 0,
      visualPending: 0,
      lastActivity: 0,
      isIdle: true,
      isCriticalIdle: true,
    })
  })

  test("tabStatus ignores requests older than the recent window", () => {
    const { browser, env, tracker } = harness()
    browser.emitRequestStarted(started({ tabId: 1, type: "script" }))
    env.advance(RECENT_WINDOW_MS)

    const status = tracker.tabStatus(1)
    expect(status.pending).toBe(0)
    expect(status.isIdle).toBe(true)
    expect(status.lastActivity).toBe(0)
    expect(tracker.query().total).toBe(1)
  })

  test("tabStatus is critical idle while only images are pending", () => {
    const { browser, tracker } = harness()
    browser.emitRequestStarted(started({ tabId: 3, type: "image" }))

    const status = tracker.tabStatus(3)
    expect(status.isIdle).toBe(false)
    expect(status.isCriticalIdle).toBe(true)
    expect(status.visualPending).toBe(1)
  })
})
