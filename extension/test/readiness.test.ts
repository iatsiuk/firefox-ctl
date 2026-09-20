// The wait before a capture. Nothing here uses real time: the network tracker
// reads the fake clock, the poll loops run on virtual timers, and the content
// script's readiness reply is scripted through the fake browser.

import { describe, expect, test } from "bun:test"

import { AttachedTabs } from "../src/attached"
import { CaptureLocks } from "../src/capture-locks"
import type { Services } from "../src/dispatch"
import { FrameRegistry } from "../src/frames"
import type { NetworkTracker, TabNetworkStatus } from "../src/network"
import { NetworkTracker as Tracker } from "../src/network"
import type { CommandContext, JsonObject, JsonValue } from "../src/protocol"
import type { ReadinessResult } from "../src/readiness"
import { waitForPageReady } from "../src/readiness"
import { Session } from "../src/session"
import { FakeBrowser, FakeEnvironment } from "./fakes"
import idleFixture from "./fixtures/results/waitForPageReady.json"
import busyFixture from "./fixtures/results/waitForPageReady-busy.json"

// the fixtures are plain JSON, so their inferred literal types carry optional
// keys the timeline's index signature does not accept
const idleResult = idleFixture as unknown as ReadinessResult
const busyResult = busyFixture as unknown as ReadinessResult

const TAB_ID = 1

/** What the content script answers `checkPageReadiness` with by default. */
const RENDER_RESULT: JsonValue = { readyState: "complete", rafWaitMs: 0 }

interface HarnessOptions {
  budgetMs?: number
  readiness?: JsonValue
  fail?: Error
  stall?: boolean
}

interface Harness {
  browser: FakeBrowser
  env: FakeEnvironment
  network: NetworkTracker
  deps: Services
  ctx: CommandContext
  sent: { action: string; params: JsonObject }[]
}

// the fake clock only moves on demand, so give the pending microtasks a turn
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** Moves the fake clock in poll-sized steps, letting each poll run in between. */
async function drive(env: FakeEnvironment, totalMs: number, stepMs = 25): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await settle()
    env.advance(stepMs)
  }
  await settle()
}

function harness(options: HarnessOptions = {}): Harness {
  const browser = new FakeBrowser()
  const env = new FakeEnvironment({ now: 0 })
  browser.addWindow({ id: 1, focused: true })
  browser.addTab({
    id: TAB_ID,
    windowId: 1,
    index: 0,
    url: "https://example.com/",
    active: true,
    status: "complete",
  })
  browser.currentWindowId = 1
  const network = new Tracker(env)
  network.attach(browser)
  const deps: Services = {
    browser,
    env,
    session: new Session(browser, env),
    attached: new AttachedTabs(browser, env),
    network,
    captureLocks: new CaptureLocks(),
    frames: new FrameRegistry(env),
    readiness: waitForPageReady,
  }
  const budgetMs = options.budgetMs ?? 30000
  const sent: { action: string; params: JsonObject }[] = []
  browser.sendMessageHandler = (_tabId, message) => {
    sent.push(message as { action: string; params: JsonObject })
    if (options.stall === true) {
      return new Promise<unknown>(() => undefined)
    }
    if (options.fail) {
      return Promise.reject(options.fail)
    }
    return Promise.resolve({ success: true, result: options.readiness ?? RENDER_RESULT })
  }
  return { browser, env, network, deps, ctx: { budgetMs, deadlineAt: env.now() + budgetMs }, sent }
}

/** A tracker that reports the same status for ever, whatever the tab does. */
function scripted(harnessed: Harness, status: Partial<TabNetworkStatus>): void {
  harnessed.network.tabStatus = () => ({
    pending: 0,
    pendingByType: {},
    criticalPending: 0,
    visualPending: 0,
    lastActivity: harnessed.env.now(),
    isIdle: false,
    isCriticalIdle: false,
    ...status,
  })
}

function events(result: { timeline: { event: string }[] }): string[] {
  return result.timeline.map((entry) => entry.event)
}

describe("waitForPageReady", () => {
  test("captures at once when the tab has no pending request", async () => {
    const h = harness()
    const pending = waitForPageReady(h.deps, h.ctx, TAB_ID)
    await drive(h.env, 0)
    expect(await pending).toEqual(idleResult)
    expect(h.sent).toEqual([{ action: "checkPageReadiness", params: {} }])
  })

  test("sends the readiness check to the top frame explicitly", async () => {
    const h = harness()
    const pending = waitForPageReady(h.deps, h.ctx, TAB_ID)
    await drive(h.env, 0)
    await pending
    expect(h.browser.sentMessages.map((sent) => sent.options)).toEqual([{ frameId: 0 }])
  })

  test("waits for the critical requests, then for the visual ones", async () => {
    const h = harness()
    h.browser.emitRequestStarted({
      requestId: "r1",
      url: "https://example.com/app.js",
      method: "GET",
      type: "script",
      tabId: TAB_ID,
    })
    h.env.setTimeout(() => {
      h.browser.emitRequestCompleted({
        requestId: "r1",
        url: "https://example.com/app.js",
        method: "GET",
        type: "script",
        tabId: TAB_ID,
      })
    }, 50)
    const pending = waitForPageReady(h.deps, h.ctx, TAB_ID)
    await drive(h.env, 200)
    expect(await pending).toEqual(busyResult)
  })

  test("gives the images three seconds and no more", async () => {
    const h = harness()
    scripted(h, { pending: 2, pendingByType: { image: 2 }, visualPending: 2, isCriticalIdle: true })
    const pending = waitForPageReady(h.deps, h.ctx, TAB_ID)
    await drive(h.env, 3200)
    const result = await pending
    expect(events(result)).toEqual([
      "start",
      "critical_idle",
      "visual_timeout",
      "render_settled",
      "complete",
    ])
    expect(result.timeline[2]).toEqual({ t: 3000, event: "visual_timeout", visualPending: 2 })
    expect(result.totalWaitMs).toBe(3000)
    expect(result.timedOut).toBe(false)
  })

  test("stops at maxWait while the critical requests keep coming", async () => {
    const h = harness()
    scripted(h, { pending: 1, pendingByType: { script: 1 }, criticalPending: 1 })
    const pending = waitForPageReady(h.deps, h.ctx, TAB_ID, { maxWait: 500 })
    await drive(h.env, 800)
    const result = await pending
    expect(events(result)).toEqual(["start", "visual_timeout", "render_settled", "complete"])
    expect(result.totalWaitMs).toBe(500)
    expect(result.timedOut).toBe(true)
  })

  test("gives up on a request that stalls without any new activity", async () => {
    const h = harness()
    scripted(h, {
      pending: 1,
      pendingByType: { xmlhttprequest: 1 },
      criticalPending: 1,
      lastActivity: 0,
    })
    const pending = waitForPageReady(h.deps, h.ctx, TAB_ID, { requireVisualIdle: false })
    await drive(h.env, 1000)
    const result = await pending
    expect(events(result)).toEqual(["start", "critical_timeout", "render_settled", "complete"])
    expect(result.timeline[1]).toEqual({ t: 475, event: "critical_timeout", pending: 1 })
    expect(result.timedOut).toBe(false)
  })

  test("cuts the phases short when little of the command budget is left", async () => {
    const h = harness({ budgetMs: 600 })
    scripted(h, { pending: 1, pendingByType: { script: 1 }, criticalPending: 1 })
    const pending = waitForPageReady(h.deps, h.ctx, TAB_ID)
    await drive(h.env, 400)
    const result = await pending
    expect(events(result)).toEqual(["start", "visual_timeout", "render_settled", "complete"])
    expect(result.totalWaitMs).toBe(100)
    expect(result.timedOut).toBe(true)
  })

  test("records a refused readiness check instead of failing the wait", async () => {
    const h = harness({
      fail: new Error("Could not establish connection. Receiving end does not exist."),
    })
    const pending = waitForPageReady(h.deps, h.ctx, TAB_ID)
    await drive(h.env, 0)
    const result = await pending
    expect(events(result)).toEqual(["start", "already_idle", "render_check_failed", "complete"])
    expect(String(result.timeline[2]?.error)).toContain("CONTENT_SCRIPT_UNAVAILABLE")
  })

  test("bounds the readiness check by the budget the capture leaves", async () => {
    const h = harness({ budgetMs: 1000, stall: true })
    const pending = waitForPageReady(h.deps, h.ctx, TAB_ID)
    await drive(h.env, 600)
    const result = await pending
    expect(events(result)).toEqual(["start", "already_idle", "render_check_failed", "complete"])
    expect(result.timeline[2]?.error).toBe("checkPageReadiness did not answer within 500 ms.")
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("resolves immediately when the capture reserve already exhausts the budget", async () => {
    const h = harness({ budgetMs: 300, stall: true })
    const pending = waitForPageReady(h.deps, h.ctx, TAB_ID)
    await drive(h.env, 25)
    const result = await pending
    expect(events(result)).toEqual(["start", "already_idle", "render_check_failed", "complete"])
    expect(result.timeline[2]?.error).toBe("checkPageReadiness did not answer within 0 ms.")
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("bounds the render check by maxWait even when the command budget is generous", async () => {
    // a huge command budget (the harness default is 30000) must not let an
    // unresponsive content script hold an idle tab's capture past maxWait
    const h = harness({ stall: true })
    const pending = waitForPageReady(h.deps, h.ctx, TAB_ID, { maxWait: 100 })
    await drive(h.env, 100)
    const result = await pending
    expect(events(result)).toEqual(["start", "already_idle", "render_check_failed", "complete"])
    expect(result.timeline[2]?.error).toBe("checkPageReadiness did not answer within 100 ms.")
    expect(result.totalWaitMs).toBeLessThanOrEqual(100)
    expect(result.timedOut).toBe(true)
    expect(h.env.pendingTimers()).toBe(0)
  })

  test("caps the critical-idle poll at what remains of the deadline", async () => {
    const h = harness()
    scripted(h, { pending: 1, pendingByType: { script: 1 }, criticalPending: 1 })
    const pending = waitForPageReady(h.deps, h.ctx, TAB_ID, {
      maxWait: 10,
      requireVisualIdle: false,
    })
    await drive(h.env, 50, 5)
    const result = await pending
    expect(result.totalWaitMs).toBe(10)
  })
})
