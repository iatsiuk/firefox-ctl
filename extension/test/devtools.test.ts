import { describe, expect, test } from "bun:test"

import { AttachedTabs } from "../src/attached"
import type { CompletedDetails, RequestDetails, StorageArea } from "../src/browser"
import { CaptureLocks } from "../src/capture-locks"
import type { HandlerDeps } from "../src/dispatch"
import { FrameRegistry } from "../src/frames"
import { getNetworkRequests } from "../src/handlers/devtools"
import { NetworkTracker } from "../src/network"
import type { JsonObject } from "../src/protocol"
import { commandContext } from "../src/protocol"
import { waitForPageReady } from "../src/readiness"
import { Session } from "../src/session"
import { writeRedactHeaders } from "../src/settings"
import { FakeBrowser, FakeEnvironment } from "./fakes"
import errors from "./fixtures/errors.json"
import networkFixture from "./fixtures/results/getNetworkRequests.json"

interface Harness {
  browser: FakeBrowser
  env: FakeEnvironment
  deps: HandlerDeps
  tabId: number
  run(params?: JsonObject): Promise<JsonObject>
}

/** A managed window with one tab and a tracker already listening. */
function harness(): Harness {
  const browser = new FakeBrowser()
  const env = new FakeEnvironment({ now: 1000 })
  const session = new Session(browser, env)
  const attached = new AttachedTabs(browser, env)
  const network = new NetworkTracker(env)
  network.attach(browser)
  const deps: HandlerDeps = {
    browser,
    env,
    session,
    attached,
    network,
    captureLocks: new CaptureLocks(),
    frames: new FrameRegistry(env),
    readiness: waitForPageReady,
    ctx: commandContext({}, env),
  }
  const tabId = 1
  browser.addWindow({ id: 1, focused: true })
  browser.currentWindowId = 1
  browser.addTab({ id: tabId, windowId: 1, index: 0, url: "https://example.com/", active: true })
  session.state = {
    windowId: 1,
    tabs: [tabId],
    createdAt: 1000,
    groupId: null,
    isPrivate: false,
    adopted: false,
  }
  session.activeTabId = tabId
  return {
    browser,
    env,
    deps,
    tabId,
    run: async (params = {}) => (await getNetworkRequests(params, deps)) as JsonObject,
  }
}

function started(overrides: Partial<RequestDetails> = {}): RequestDetails {
  return {
    requestId: "r1",
    url: "https://example.com/app.js",
    method: "GET",
    type: "script",
    tabId: 1,
    ...overrides,
  }
}

function completed(overrides: Partial<CompletedDetails> = {}): CompletedDetails {
  return { ...started(), statusCode: 200, ...overrides }
}

describe("getNetworkRequests", () => {
  test("reports the requests of the session tab", async () => {
    const h = harness()
    h.browser.emitRequestStarted(started())
    h.browser.emitRequestCompleted(completed())
    h.browser.emitRequestStarted(started({ requestId: "r2", tabId: 2 }))

    expect(await h.run()).toEqual(networkFixture)
  })

  test("targets the tab named by tabId", async () => {
    const h = harness()
    h.browser.addTab({ id: 5, windowId: 1, index: 1, url: "https://other.example", active: false })
    h.browser.emitRequestStarted(started({ requestId: "r1", tabId: 1 }))
    h.browser.emitRequestStarted(started({ requestId: "r2", tabId: 5 }))

    const result = (await h.run({ tabId: 5 })) as {
      tabId: number
      requests: { requestId: string }[]
    }
    expect(result.tabId).toBe(5)
    expect(result.requests.map((request) => request.requestId)).toEqual(["r2"])
  })

  test("forwards the type, status and limit filters", async () => {
    const h = harness()
    h.browser.emitRequestStarted(started({ requestId: "r1", type: "image" }))
    h.browser.emitRequestStarted(started({ requestId: "r2", type: "script" }))
    h.browser.emitRequestStarted(started({ requestId: "r3", type: "script" }))
    h.browser.emitRequestCompleted(completed({ requestId: "r3", type: "script" }))

    const pending = (await h.run({ type: "script", status: "pending" })) as {
      requests: { requestId: string }[]
      filtered: number
    }
    expect(pending.requests.map((request) => request.requestId)).toEqual(["r2"])
    expect(pending.filtered).toBe(1)

    const limited = (await h.run({ limit: 1 })) as { requests: { requestId: string }[] }
    expect(limited.requests.map((request) => request.requestId)).toEqual(["r3"])
  })

  test("hides response headers unless they are asked for", async () => {
    const h = harness()
    h.browser.emitRequestStarted(started())
    h.browser.emitRequestCompleted(
      completed({ responseHeaders: [{ name: "X-Trace", value: "a=1" }] }),
    )

    const hidden = (await h.run()) as { requests: JsonObject[] }
    expect(hidden.requests[0]).not.toHaveProperty("responseHeaders")

    const shown = (await h.run({ includeHeaders: true })) as { requests: JsonObject[] }
    expect(shown.requests[0]?.responseHeaders).toEqual([{ name: "X-Trace", value: "a=1" }])
  })

  test("redacts credential headers when nothing is stored", async () => {
    const h = harness()
    h.browser.emitRequestStarted(started())
    h.browser.emitRequestCompleted(
      completed({
        responseHeaders: [
          { name: "Set-Cookie", value: "session=abc" },
          { name: "Content-Type", value: "text/html" },
        ],
      }),
    )

    const result = (await h.run({ includeHeaders: true })) as { requests: JsonObject[] }
    expect(result.requests[0]?.responseHeaders).toEqual([
      { name: "Set-Cookie", value: "[redacted]" },
      { name: "Content-Type", value: "text/html" },
    ])
  })

  test("returns raw headers only after the opt-out is stored", async () => {
    const h = harness()
    h.browser.emitRequestStarted(started())
    h.browser.emitRequestCompleted(
      completed({ responseHeaders: [{ name: "Set-Cookie", value: "session=abc" }] }),
    )
    await writeRedactHeaders(h.browser, false)

    const raw = (await h.run({ includeHeaders: true })) as { requests: JsonObject[] }
    expect(raw.requests[0]?.responseHeaders).toEqual([{ name: "Set-Cookie", value: "session=abc" }])

    await writeRedactHeaders(h.browser, true)
    const back = (await h.run({ includeHeaders: true })) as { requests: JsonObject[] }
    expect(back.requests[0]?.responseHeaders).toEqual([{ name: "Set-Cookie", value: "[redacted]" }])
  })

  test("a rejected settings read still redacts", async () => {
    const h = harness()
    h.browser.emitRequestStarted(started())
    h.browser.emitRequestCompleted(
      completed({ responseHeaders: [{ name: "Set-Cookie", value: "session=abc" }] }),
    )
    const broken: StorageArea = {
      get: () => Promise.reject(new Error("storage offline")),
      set: (items) => h.browser.storage.local.set(items),
      remove: (keys) => h.browser.storage.local.remove(keys),
    }
    const deps = { ...h.deps, browser: { ...h.browser, storage: { local: broken } } }

    const result = (await getNetworkRequests({ includeHeaders: true }, deps)) as {
      requests: JsonObject[]
    }
    expect(result.requests[0]?.responseHeaders).toEqual([
      { name: "Set-Cookie", value: "[redacted]" },
    ])
  })

  test("clear returns the old list and empties the buffer", async () => {
    const h = harness()
    h.browser.emitRequestStarted(started())

    const cleared = (await h.run({ clear: true })) as { filtered: number; total: number }
    expect(cleared).toMatchObject({ filtered: 1, total: 0 })
    expect(await h.run()).toMatchObject({ requests: [], total: 0, filtered: 0 })
  })

  test("reports a tabId that names a closed tab", async () => {
    const h = harness()

    await expect(h.run({ tabId: 404 })).rejects.toThrow(errors.tabClosed.replace("<id>", "404"))
  })
})
