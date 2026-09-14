// The screenshot command: presets, the readiness gate, the capture that never
// activates a tab, the annotations around it and the downgrade ladder that
// keeps the reply inside the host's frame limit. No real image is decoded here
// - the content script's `resizeImage` is scripted through the fake browser.

import { describe, expect, test } from "bun:test"

import { AttachedTabs } from "../src/attached"
import type { CaptureOptions } from "../src/browser"
import { CaptureLocks } from "../src/capture-locks"
import type { HandlerDeps } from "../src/dispatch"
import { FRAME_LIMIT_BYTES, screenshot } from "../src/handlers/screenshot"
import { NetworkTracker, type TabNetworkStatus } from "../src/network"
import type { JsonObject } from "../src/protocol"
import { commandContext } from "../src/protocol"
import type { ReadinessCheck, ReadinessOptions } from "../src/readiness"
import { waitForPageReady } from "../src/readiness"
import { Session } from "../src/session"
import { FakeBrowser, FakeEnvironment } from "./fakes"
import errors from "./fixtures/errors.json"
import screenshotFixture from "./fixtures/results/screenshot.json"

// a nested JSON import infers optional-undefined unions the timeline's index
// signature does not accept; the fixture is plain JSON
const expected = screenshotFixture as unknown as JsonObject

const TAB_ID = 1
const RAW = "data:image/jpeg;base64,cmF3"
const SCALED = "data:image/jpeg;base64,c2NhbGVk"

interface Sent {
  action: string
  params: JsonObject
}

interface Harness {
  browser: FakeBrowser
  env: FakeEnvironment
  network: NetworkTracker
  deps: HandlerDeps
  sent: Sent[]
  readinessCalls: ReadinessOptions[]
  actions(): string[]
  resizes(): JsonObject[]
  captures(): (CaptureOptions | undefined)[]
  run(params?: JsonObject): Promise<JsonObject>
}

interface HarnessOptions {
  /** What the content script answers `resizeImage` with, by the params it got. */
  resize?: (params: JsonObject) => JsonObject
  /** Stands in for the readiness pipeline the dispatcher injects. */
  readiness?: ReadinessCheck
}

function defaultResize(params: JsonObject): JsonObject {
  const scale = typeof params.scale === "number" ? params.scale : 1
  return {
    dataUrl: SCALED,
    originalSize: { width: 1280, height: 800 },
    scaledSize: { width: Math.round(1280 * scale), height: Math.round(800 * scale) },
  }
}

function harness(options: HarnessOptions = {}): Harness {
  const browser = new FakeBrowser()
  const env = new FakeEnvironment({ now: 0 })
  const session = new Session(browser, env)
  const network = new NetworkTracker(env)
  network.attach(browser)
  browser.addWindow({ id: 1, focused: true })
  browser.currentWindowId = 1
  browser.addTab({
    id: TAB_ID,
    windowId: 1,
    index: 0,
    url: "https://example.com/",
    active: true,
    status: "complete",
  })
  session.state = {
    windowId: 1,
    tabs: [TAB_ID],
    createdAt: 0,
    groupId: null,
    isPrivate: false,
    adopted: false,
  }
  session.activeTabId = TAB_ID
  const readinessCalls: ReadinessOptions[] = []
  const wait = options.readiness ?? waitForPageReady
  const readiness: ReadinessCheck = (own, ctx, tabId, readinessOptions = {}) => {
    readinessCalls.push(readinessOptions)
    return wait(own, ctx, tabId, readinessOptions)
  }
  const deps: HandlerDeps = {
    browser,
    env,
    session,
    attached: new AttachedTabs(browser, env),
    network,
    captureLocks: new CaptureLocks(),
    readiness,
    ctx: commandContext({}, env),
  }
  const sent: Sent[] = []
  const resize = options.resize ?? defaultResize
  browser.sendMessageHandler = (_tabId, message) => {
    const { action, params } = message as Sent
    sent.push({ action, params })
    switch (action) {
      case "checkPageReadiness":
        return Promise.resolve({ success: true, result: { readyState: "complete", rafWaitMs: 0 } })
      case "resizeImage":
        return Promise.resolve({ success: true, result: resize(params) })
      case "annotateElements":
        return Promise.resolve({
          success: true,
          result: {
            labels: { "1": { selector: "#save", text: "Save", role: "button" } },
            count: 1,
          },
        })
      case "removeAnnotations":
        return Promise.resolve({ success: true, result: { removed: true } })
      default:
        return Promise.reject(new Error(`unexpected action ${action}`))
    }
  }
  browser.captureHandler = () => Promise.resolve(RAW)
  return {
    browser,
    env,
    network,
    deps,
    sent,
    readinessCalls,
    actions: () => sent.map((one) => one.action),
    resizes: () => sent.filter((one) => one.action === "resizeImage").map((one) => one.params),
    captures: () => browser.captures.map((one) => one.options),
    // the real dispatcher builds a fresh `CommandContext` - and so a fresh
    // deadline - per incoming command; sharing one `ctx` across every `run()`
    // call here would leave a request started long after `h.deps.ctx` was
    // built with a deadline already behind it, which no live command ever has
    run: async (params = {}) =>
      (await screenshot(params, { ...deps, ctx: commandContext({}, env) })) as JsonObject,
  }
}

/** A tracker that reports the same status for ever, whatever the tab does. */
function scripted(h: Harness, status: Partial<TabNetworkStatus>): void {
  h.network.tabStatus = () => ({
    pending: 0,
    pendingByType: {},
    criticalPending: 0,
    visualPending: 0,
    lastActivity: h.env.now(),
    isIdle: false,
    isCriticalIdle: false,
    ...status,
  })
}

function events(result: JsonObject): string[] {
  const readiness = result.readiness as { timeline: { event: string }[] }
  return readiness.timeline.map((entry) => entry.event)
}

describe("screenshot", () => {
  test("captures the session tab at the defaults", async () => {
    const h = harness()

    expect(await h.run()).toEqual(expected)
    expect(h.captures()).toEqual([{ format: "jpeg", quality: 60 }])
    expect(h.browser.captures[0]?.tabId).toBe(TAB_ID)
    expect(h.resizes()).toEqual([{ dataUrl: RAW, scale: 0.5, quality: 60, format: "jpeg" }])
  })

  test("never activates the tab it captures", async () => {
    const h = harness()
    h.browser.addTab({ id: 2, windowId: 1, index: 1, url: "https://other.example", active: false })

    const result = await h.run({ tabId: 2 })

    expect(result.tabId).toBe(2)
    expect((await h.browser.tabs.get(TAB_ID)).active).toBe(true)
    expect((await h.browser.tabs.get(2)).active).toBe(false)
  })

  test("resolves the purpose preset", async () => {
    const h = harness()

    const result = await h.run({ purpose: "quick-glance" })

    expect(result.quality).toBe(30)
    expect(result.scale).toBe(0.25)
    expect(h.captures()).toEqual([{ format: "jpeg", quality: 30 }])
    expect(h.resizes()).toEqual([{ dataUrl: RAW, scale: 0.25, quality: 30, format: "jpeg" }])
  })

  test("lets explicit quality and scale override the preset", async () => {
    const h = harness()

    const result = await h.run({ purpose: "quick-glance", quality: 90, scale: 0.75 })

    expect(result.quality).toBe(90)
    expect(result.scale).toBe(0.75)
    expect(h.resizes()).toEqual([{ dataUrl: RAW, scale: 0.75, quality: 90, format: "jpeg" }])
  })

  test("clamps an out-of-range explicit quality and scale", async () => {
    const h = harness()

    const result = await h.run({ quality: 500, scale: 1.5 })

    expect(result.quality).toBe(100)
    expect(result.scale).toBe(1)
    expect(h.captures()).toEqual([{ format: "jpeg", quality: 100 }])
    expect(h.resizes()).toEqual([])
    expect(result.dataUrl).toBe(RAW)
  })

  test("floors a zero or negative scale instead of reporting one nothing was drawn at", async () => {
    const h = harness()

    const result = await h.run({ scale: -1 })
    const scale = result.scale

    expect(typeof scale).toBe("number")
    expect(scale as number).toBeGreaterThan(0)
    expect(h.resizes()).toEqual([
      { dataUrl: RAW, scale: scale as number, quality: 60, format: "jpeg" },
    ])
  })

  test("captures a png without a quality and keeps the raw image at scale 1", async () => {
    const h = harness()

    const result = await h.run({ format: "png", purpose: "full-detail" })

    expect(h.captures()).toEqual([{ format: "png" }])
    expect(result.dataUrl).toBe(RAW)
    expect(result.scale).toBe(1)
    expect(result.quality).toBe(95)
    expect(h.resizes()).toEqual([])
    expect(result.originalSize).toBeUndefined()
  })

  test("skipReadiness reports an empty wait and asks the tab nothing", async () => {
    const h = harness()
    scripted(h, { criticalPending: 2 })

    const result = await h.run({ skipReadiness: true })

    expect(result.readiness).toEqual({ waitMs: 0, timedOut: false, timeline: [] })
    expect(h.actions()).toEqual(["resizeImage"])
    expect(h.readinessCalls).toEqual([])
  })

  test("reports the wait of the injected readiness service", async () => {
    const timeline = [{ t: 5, event: "already_idle" }]
    const h = harness({
      readiness: () => Promise.resolve({ totalWaitMs: 42, timeline, timedOut: true }),
    })

    const result = await h.run({ maxWait: 2000, waitForImages: false })

    expect(result.readiness).toEqual({ waitMs: 42, timedOut: true, timeline })
    expect(h.readinessCalls).toEqual([{ maxWait: 2000, requireVisualIdle: false }])
    expect(h.actions()).toEqual(["resizeImage"])
  })

  test("waitForImages false ends the wait once the critical requests are done", async () => {
    const h = harness()
    scripted(h, { isCriticalIdle: true, visualPending: 3 })

    const result = await h.run({ waitForImages: false })

    expect(events(result)).toEqual(["start", "critical_idle", "render_settled", "complete"])
    expect(h.actions()).toEqual(["checkPageReadiness", "resizeImage"])
  })

  test("annotates before the capture and clears the badges after it", async () => {
    const h = harness()

    const result = await h.run({ annotate: true, scale: 1 })

    expect(h.actions()).toEqual(["checkPageReadiness", "annotateElements", "removeAnnotations"])
    expect(h.sent[1]?.params).toEqual({ maxElements: 30 })
    expect(result.labels).toEqual({ "1": { selector: "#save", text: "Save", role: "button" } })
  })

  test("clears the badges when the capture itself fails", async () => {
    const h = harness()
    h.browser.captureHandler = () => Promise.reject(new Error("Failed to capture tab"))

    await expect(h.run({ annotate: true })).rejects.toThrow("Failed to capture tab")
    expect(h.actions()).toEqual(["checkPageReadiness", "annotateElements", "removeAnnotations"])
  })

  test("captures without labels when annotateElements itself fails", async () => {
    const h = harness()
    const original = h.browser.sendMessageHandler
    if (!original) {
      throw new Error("harness always sets sendMessageHandler")
    }
    h.browser.sendMessageHandler = (tabId, message) => {
      const { action, params } = message as Sent
      if (action === "annotateElements") {
        h.sent.push({ action, params })
        return Promise.reject(new Error("content script gone"))
      }
      return original(tabId, message)
    }

    const result = await h.run({ annotate: true, scale: 1 })

    expect(result.labels).toBeUndefined()
    expect(h.actions()).toEqual(["checkPageReadiness", "annotateElements", "removeAnnotations"])
  })

  test("still returns the capture when removeAnnotations fails", async () => {
    const h = harness()
    const original = h.browser.sendMessageHandler
    if (!original) {
      throw new Error("harness always sets sendMessageHandler")
    }
    h.browser.sendMessageHandler = (tabId, message) => {
      const { action, params } = message as Sent
      if (action === "removeAnnotations") {
        h.sent.push({ action, params })
        return Promise.reject(new Error("content script gone"))
      }
      return original(tabId, message)
    }

    const result = await h.run({ annotate: true, scale: 1 })

    expect(result.labels).toEqual({ "1": { selector: "#save", text: "Save", role: "button" } })
    expect(h.actions()).toEqual(["checkPageReadiness", "annotateElements", "removeAnnotations"])
  })

  test("serialises two annotated captures of the same tab so their badges never race", async () => {
    const h = harness()
    const original = h.browser.sendMessageHandler
    if (!original) {
      throw new Error("harness always sets sendMessageHandler")
    }
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    let annotateCalls = 0
    let releaseFirst: () => void = () => undefined
    const firstGated = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    h.browser.sendMessageHandler = (tabId, message) => {
      const { action, params } = message as Sent
      if (action === "annotateElements") {
        annotateCalls += 1
        if (annotateCalls === 1) {
          // the message is sent (and logged) right away; only its reply is held
          // back, so the second call can be observed still queued behind it
          h.sent.push({ action, params })
          return firstGated.then(() => ({
            success: true,
            result: {
              labels: { "1": { selector: "#save", text: "Save", role: "button" } },
              count: 1,
            },
          }))
        }
      }
      return original(tabId, message)
    }

    const first = h.run({ annotate: true, scale: 1 })
    await flush()
    const second = h.run({ annotate: true, scale: 1 })
    await flush()

    // the second capture's own badges never get sent while the first still
    // holds the tab: it is stuck acquiring the lock behind the first capture
    expect(annotateCalls).toBe(1)
    expect(h.actions().filter((action) => action === "annotateElements")).toHaveLength(1)

    releaseFirst()
    await Promise.all([first, second])

    expect(h.actions()).toEqual([
      "checkPageReadiness",
      "annotateElements",
      "checkPageReadiness",
      "removeAnnotations",
      "annotateElements",
      "removeAnnotations",
    ])
  })

  test("a plain capture waits behind an in-flight annotated capture of the same tab", async () => {
    const h = harness()
    const original = h.browser.sendMessageHandler
    if (!original) {
      throw new Error("harness always sets sendMessageHandler")
    }
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    let releaseFirst: () => void = () => undefined
    const firstGated = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    h.browser.sendMessageHandler = (tabId, message) => {
      const { action, params } = message as Sent
      if (action === "annotateElements") {
        h.sent.push({ action, params })
        return firstGated.then(() => ({
          success: true,
          result: {
            labels: { "1": { selector: "#save", text: "Save", role: "button" } },
            count: 1,
          },
        }))
      }
      return original(tabId, message)
    }

    const first = h.run({ annotate: true, scale: 1 })
    await flush()
    const second = h.run({ scale: 1 })
    await flush()

    // the plain capture must not photograph the tab while the first request's
    // badges are still showing, so its captureTab call stays queued behind
    // the annotated one's whole annotate/capture/remove section
    expect(h.browser.captures).toHaveLength(0)

    releaseFirst()
    await Promise.all([first, second])

    expect(h.browser.captures).toHaveLength(2)
    expect(h.actions()).toEqual([
      "checkPageReadiness",
      "annotateElements",
      "checkPageReadiness",
      "removeAnnotations",
    ])
  })

  test("frees the lock past its deadline so a hung annotate never wedges later captures", async () => {
    const h = harness()
    const original = h.browser.sendMessageHandler
    if (!original) {
      throw new Error("harness always sets sendMessageHandler")
    }
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    h.browser.sendMessageHandler = (tabId, message) => {
      const { action } = message as Sent
      if (action === "annotateElements") {
        // a frozen content script: the message is delivered but never answered
        return new Promise(() => undefined)
      }
      return original(tabId, message)
    }

    const stuck = h.run({ annotate: true, scale: 1 })
    stuck.catch(() => undefined)
    // lets the stuck call run up to its own deadline timer registration before
    // the clock moves past it, exactly as the earlier real timer would
    await flush()

    h.env.advance(h.deps.ctx.deadlineAt)

    // a plain capture never touches the content script, so it must not queue
    // forever behind a lock the hung annotate call can never release itself
    const plain = await h.run({ scale: 1 })

    expect(plain.dataUrl).toBe(RAW)
  })

  test("a stale evicted annotate never wipes the next holder's badges, and the next holder clears the stale ones", async () => {
    const h = harness()
    const original = h.browser.sendMessageHandler
    if (!original) {
      throw new Error("harness always sets sendMessageHandler")
    }
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    let releaseFirst: () => void = () => undefined
    const firstGated = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    h.browser.sendMessageHandler = (tabId, message) => {
      const { action, params } = message as Sent
      if (action === "annotateElements") {
        h.sent.push({ action, params })
        // the reply is held back well past the deadline, as a badly overloaded
        // (but not permanently frozen) content script would
        return firstGated.then(() => ({
          success: true,
          result: {
            labels: { "1": { selector: "#save", text: "Save", role: "button" } },
            count: 1,
          },
        }))
      }
      return original(tabId, message)
    }

    const first = h.run({ annotate: true, scale: 1 })
    first.catch(() => undefined)
    await flush()

    h.env.advance(h.deps.ctx.deadlineAt)

    // the eviction frees the lock; a plain capture right behind it must not
    // photograph the first request's still-painted badges
    const second = await h.run({ scale: 1 })
    expect(second.dataUrl).toBe(RAW)
    expect(h.actions()).toEqual([
      "checkPageReadiness",
      "annotateElements",
      "checkPageReadiness",
      "removeAnnotations",
    ])

    // now the stuck annotate finally answers; the evicted holder must not
    // proceed to captureTab with a stale result, and its own cleanup must be
    // a no-op, since those badges are no longer necessarily its own
    releaseFirst()
    await expect(first).rejects.toThrow("COMMAND_TIMEOUT")

    expect(h.browser.captures).toHaveLength(1)
    expect(h.actions()).toEqual([
      "checkPageReadiness",
      "annotateElements",
      "checkPageReadiness",
      "removeAnnotations",
    ])
  })

  test("an evicted holder stuck in its own inherited cleanup never reaches annotate or captureTab once a later holder has already run", async () => {
    const h = harness()
    const original = h.browser.sendMessageHandler
    if (!original) {
      throw new Error("harness always sets sendMessageHandler")
    }
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    let releaseFirstAnnotate: () => void = () => undefined
    const firstAnnotateGated = new Promise<void>((resolve) => {
      releaseFirstAnnotate = resolve
    })
    let releaseSecondCleanup: () => void = () => undefined
    const secondCleanupGated = new Promise<void>((resolve) => {
      releaseSecondCleanup = resolve
    })
    let removeAnnotationsCalls = 0
    h.browser.sendMessageHandler = (tabId, message) => {
      const { action, params } = message as Sent
      if (action === "annotateElements") {
        h.sent.push({ action, params })
        return firstAnnotateGated.then(() => ({
          success: true,
          result: {
            labels: { "1": { selector: "#save", text: "Save", role: "button" } },
            count: 1,
          },
        }))
      }
      if (action === "removeAnnotations") {
        removeAnnotationsCalls += 1
        // only the second request's inherited handoff cleanup is gated; a
        // third request's own cleanup must go through untouched
        if (removeAnnotationsCalls === 1) {
          h.sent.push({ action, params })
          return secondCleanupGated.then(() => ({ success: true, result: { removed: true } }))
        }
      }
      return original(tabId, message)
    }

    // first: annotated, stuck answering annotateElements
    const first = h.run({ annotate: true, scale: 1 })
    first.catch(() => undefined)
    await flush()
    h.env.advance(h.deps.ctx.deadlineAt)

    // second: annotated too, inherits the handoff cleanup and gets stuck in it
    const second = h.run({ annotate: true, scale: 1 })
    second.catch(() => undefined)
    await flush()
    h.env.advance(h.deps.ctx.deadlineAt)

    // third: a plain capture right behind both evicted holders must see a
    // clean tab and must not wait on either of them
    const third = await h.run({ scale: 1 })
    expect(third.dataUrl).toBe(RAW)
    const expectedActions = [
      "checkPageReadiness",
      "annotateElements",
      "checkPageReadiness",
      "removeAnnotations",
      "checkPageReadiness",
      "removeAnnotations",
    ]
    expect(h.actions()).toEqual(expectedActions)

    // second's stuck inherited cleanup finally answers; it must stop right
    // there instead of going on to annotate or capture behind third's back
    releaseSecondCleanup()
    await expect(second).rejects.toThrow("COMMAND_TIMEOUT")
    expect(h.browser.captures).toHaveLength(1)
    expect(h.actions()).toEqual(expectedActions)

    // first's stuck annotate finally answers too; same story, one step later
    releaseFirstAnnotate()
    await expect(first).rejects.toThrow("COMMAND_TIMEOUT")
    expect(h.browser.captures).toHaveLength(1)
    expect(h.actions()).toEqual(expectedActions)
  })

  test("a plain holder evicted mid inherited-cleanup still hands the duty on, even though it never asked for annotations itself", async () => {
    const h = harness()
    const original = h.browser.sendMessageHandler
    if (!original) {
      throw new Error("harness always sets sendMessageHandler")
    }
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    let releaseFirstAnnotate: () => void = () => undefined
    const firstAnnotateGated = new Promise<void>((resolve) => {
      releaseFirstAnnotate = resolve
    })
    let releaseSecondCleanup: () => void = () => undefined
    const secondCleanupGated = new Promise<void>((resolve) => {
      releaseSecondCleanup = resolve
    })
    let removeAnnotationsCalls = 0
    h.browser.sendMessageHandler = (tabId, message) => {
      const { action, params } = message as Sent
      if (action === "annotateElements") {
        h.sent.push({ action, params })
        return firstAnnotateGated.then(() => ({
          success: true,
          result: {
            labels: { "1": { selector: "#save", text: "Save", role: "button" } },
            count: 1,
          },
        }))
      }
      if (action === "removeAnnotations") {
        removeAnnotationsCalls += 1
        // only the second request's inherited handoff cleanup is gated; a
        // third request's own cleanup must go through untouched
        if (removeAnnotationsCalls === 1) {
          h.sent.push({ action, params })
          return secondCleanupGated.then(() => ({ success: true, result: { removed: true } }))
        }
      }
      return original(tabId, message)
    }

    // first: annotated, stuck answering annotateElements
    const first = h.run({ annotate: true, scale: 1 })
    first.catch(() => undefined)
    await flush()
    h.env.advance(h.deps.ctx.deadlineAt)

    // second: a plain capture that never asked for annotations, but inherits
    // first's handoff cleanup and gets stuck in it - unlike an annotated
    // second holder, its own `annotate` param is false, so the duty can only
    // be tracked by the inherited-cleanup-in-progress state, not by that param
    const second = h.run({ scale: 1 })
    second.catch(() => undefined)
    await flush()
    h.env.advance(h.deps.ctx.deadlineAt)

    // third: a plain capture right behind both evicted holders must still see
    // the handoff and clear the stale badges itself before capturing
    const third = await h.run({ scale: 1 })
    expect(third.dataUrl).toBe(RAW)
    const expectedActions = [
      "checkPageReadiness",
      "annotateElements",
      "checkPageReadiness",
      "removeAnnotations",
      "checkPageReadiness",
      "removeAnnotations",
    ]
    expect(h.actions()).toEqual(expectedActions)

    // second's stuck inherited cleanup finally answers; it must stop right
    // there instead of going on to captureTab behind third's back
    releaseSecondCleanup()
    await expect(second).rejects.toThrow("COMMAND_TIMEOUT")
    expect(h.browser.captures).toHaveLength(1)
    expect(h.actions()).toEqual(expectedActions)

    // first's stuck annotate finally answers too; same story, one step later
    releaseFirstAnnotate()
    await expect(first).rejects.toThrow("COMMAND_TIMEOUT")
    expect(h.browser.captures).toHaveLength(1)
    expect(h.actions()).toEqual(expectedActions)
  })

  test("an annotated capture evicted before it ever acquires the lock leaves no cleanup for the next holder", async () => {
    const h = harness()
    const original = h.browser.sendMessageHandler
    if (!original) {
      throw new Error("harness always sets sendMessageHandler")
    }
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    let releaseCapture: () => void = () => undefined
    const captureGated = new Promise<void>((resolve) => {
      releaseCapture = resolve
    })
    h.browser.captureHandler = () => captureGated.then(() => RAW)
    h.browser.sendMessageHandler = (tabId, message) => {
      const { action } = message as Sent
      // a frozen content script: annotateElements/removeAnnotations are
      // delivered but never answered, so any call to either would hang
      if (action === "annotateElements" || action === "removeAnnotations") {
        return new Promise(() => undefined)
      }
      return original(tabId, message)
    }

    // first: a plain capture that holds the tab lock deep inside captureTab
    const first = h.run({ scale: 1 })
    await flush()

    // second: annotated, queues behind first and its whole budget elapses
    // while it is still waiting for the lock - it never reaches inherited
    // cleanup, its own annotate or captureTab
    const second = h.run({ annotate: true, scale: 1 })
    second.catch(() => undefined)
    await flush()
    h.env.advance(h.deps.ctx.deadlineAt)

    releaseCapture()
    await expect(second).rejects.toThrow("COMMAND_TIMEOUT")
    await first

    // third: a plain capture right behind the evicted annotated one must not
    // be saddled with a cleanup nothing ever needed; if it called
    // removeAnnotations against the frozen content script above it would hang
    const third = await h.run({ scale: 1 })
    expect(third.dataUrl).toBe(RAW)
    expect(h.actions().filter((action) => action === "removeAnnotations")).toHaveLength(0)
  })

  test("leaves a reply just under the frame limit untouched", async () => {
    const h = harness({ resize: () => ({ dataUrl: fill(FRAME_LIMIT_BYTES - 4096) }) })

    const result = await h.run()

    expect(result.reduced).toBeUndefined()
    expect(h.resizes()).toHaveLength(1)
  })

  test("walks the quality ladder down until the reply fits", async () => {
    const h = harness({ resize: (params) => sized(params, (quality) => quality <= 30) })

    const result = await h.run()

    expect(result.quality).toBe(30)
    expect(result.scale).toBe(0.5)
    expect(result.reduced).toEqual({
      from: { format: "jpeg", quality: 60, scale: 0.5 },
      to: { format: "jpeg", quality: 30, scale: 0.5 },
      steps: 3,
    })
    expect(h.resizes().map((one) => one.quality)).toEqual([60, 50, 40, 30])
    expect(h.browser.captures).toHaveLength(1)
  })

  test("re-encodes an oversized png as jpeg before touching the quality", async () => {
    const h = harness({ resize: (params) => sized(params, () => true) })
    h.browser.captureHandler = () => Promise.resolve(fill(FRAME_LIMIT_BYTES + 4096))

    const result = await h.run({ format: "png", purpose: "full-detail" })

    expect(result.format).toBe("jpeg")
    expect(result.quality).toBe(80)
    expect(result.scale).toBe(1)
    expect(result.reduced).toEqual({
      from: { format: "png", quality: 95, scale: 1 },
      to: { format: "jpeg", quality: 80, scale: 1 },
      steps: 1,
    })
    expect(h.captures()).toEqual([{ format: "png" }])
  })

  test("drops the scale once the quality floor is reached", async () => {
    const h = harness({ resize: (params) => sized(params, (_q, scale) => scale <= 0.375) })

    const result = await h.run()

    expect(result.scale).toBe(0.375)
    expect(result.quality).toBe(20)
    expect(h.resizes().map((one) => one.scale)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.375])
  })

  test("fails with SCREENSHOT_TOO_LARGE when even the floor is too big", async () => {
    const h = harness({ resize: (params) => sized(params, () => false) })

    await expect(h.run()).rejects.toThrow(fixturePattern(errors.screenshotTooLarge))
    // the ladder stops at its own step limit instead of re-encoding for ever
    expect(h.resizes().length).toBeLessThanOrEqual(9)
    expect(h.browser.captures).toHaveLength(1)
  })
})

/** Turns a fixture error string's `<bytes>` placeholder into a matching regex. */
function fixturePattern(fixture: string): RegExp {
  const escaped = fixture.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^${escaped.replace("<bytes>", "\\d+")}$`)
}

/** A data URL of about `bytes` characters; base64 is one byte per character. */
function fill(bytes: number): string {
  return `data:image/jpeg;base64,${"A".repeat(bytes)}`
}

/** Answers with an image that fits only when `fits` says the settings are small enough. */
function sized(params: JsonObject, fits: (quality: number, scale: number) => boolean): JsonObject {
  const quality = typeof params.quality === "number" ? params.quality : 60
  const scale = typeof params.scale === "number" ? params.scale : 1
  const dataUrl = fits(quality, scale) ? SCALED : fill(FRAME_LIMIT_BYTES + 4096)
  return {
    dataUrl,
    originalSize: { width: 1280, height: 800 },
    scaledSize: { width: Math.round(1280 * scale), height: Math.round(800 * scale) },
  }
}
