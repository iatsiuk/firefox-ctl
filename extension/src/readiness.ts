// The readiness pipeline: how long the background page holds off before it
// captures a tab. Network quiet first - critical resources, then the images and
// fonts that only change how the page looks - and a render check inside the tab
// last. It never throws: whatever goes wrong lands in the timeline and the
// caller captures anyway, because a late screenshot beats no
// screenshot at all.

import type { Services } from "./dispatch"
import type { Environment } from "./env"
import { executeInTab } from "./handlers/dom"
import type { CommandContext, JsonObject, JsonValue } from "./protocol"
import { errorText } from "./tab-errors"

/** Absolute ceiling on the whole wait. */
export const DEFAULT_MAX_WAIT_MS = 10000

/** How long without network activity counts as settled. */
export const DEFAULT_IDLE_THRESHOLD_MS = 150

/** Images and fonts never hold a capture longer than this. */
export const VISUAL_MAX_WAIT_MS = 3000

// tight enough that the wait ends within a frame of the page going quiet
const POLL_INTERVAL_MS = 25

// kept back from the command budget so the capture and the reply still fit
const CAPTURE_RESERVE_MS = 500

export interface ReadinessOptions {
  maxWait?: number
  idleThreshold?: number
  requireVisualIdle?: boolean
}

/** One line of the timeline: `t` is the offset from the start of the wait. */
export interface TimelineEvent {
  t: number
  event: string
  [key: string]: JsonValue
}

export interface ReadinessResult {
  totalWaitMs: number
  timeline: TimelineEvent[]
  timedOut: boolean
}

type Log = (event: string, data?: JsonObject) => void

function delay(env: Environment, ms: number): Promise<void> {
  return new Promise((resolve) => {
    env.setTimeout(resolve, ms)
  })
}

/** What is left of the command budget once the capture's share is kept back. */
function budgetLeft(ctx: CommandContext, env: Environment): number {
  return Math.max(0, ctx.deadlineAt - env.now() - CAPTURE_RESERVE_MS)
}

/**
 * The readiness pipeline as the dispatcher hands it to a handler, so a command
 * reaches it through `deps` instead of importing it.
 */
export type ReadinessCheck = (
  deps: Services,
  ctx: CommandContext,
  tabId: number,
  options?: ReadinessOptions,
) => Promise<ReadinessResult>

/**
 * Waits until the tab looks ready to be captured. Phases are bounded by both
 * `maxWait` and the command budget, so a caller with little time left gets a
 * short wait and a capture rather than a COMMAND_TIMEOUT.
 */
export const waitForPageReady: ReadinessCheck = async (
  deps,
  ctx,
  tabId,
  options = {},
): Promise<ReadinessResult> => {
  const { env, network } = deps
  const {
    maxWait = DEFAULT_MAX_WAIT_MS,
    idleThreshold = DEFAULT_IDLE_THRESHOLD_MS,
    requireVisualIdle = true,
  } = options
  const start = env.now()
  const timeline: TimelineEvent[] = []
  const log: Log = (event, data = {}) => {
    timeline.push({ t: env.now() - start, event, ...data })
  }
  const limit = Math.min(maxWait, budgetLeft(ctx, env))
  const deadline = start + limit
  log("start", { maxWait, idleThreshold, requireVisualIdle })

  if (network.tabStatus(tabId).isIdle) {
    log("already_idle")
    await renderCheck(deps, deadline, tabId, log)
    return finish(env, start, limit, timeline)
  }

  await awaitCriticalIdle(deps, tabId, deadline, idleThreshold, log)
  if (requireVisualIdle) {
    await awaitVisualIdle(deps, tabId, deadline, log)
  }
  await renderCheck(deps, deadline, tabId, log)
  return finish(env, start, limit, timeline)
}

function finish(
  env: Environment,
  start: number,
  limit: number,
  timeline: TimelineEvent[],
): ReadinessResult {
  const totalWaitMs = env.now() - start
  timeline.push({ t: totalWaitMs, event: "complete", totalWait: totalWaitMs })
  return { totalWaitMs, timeline, timedOut: totalWaitMs >= limit }
}

/**
 * Phase 1: scripts, stylesheets and XHR, the requests that still change what
 * the page will paint. A tab that keeps a request open without any new activity
 * is given up on after three idle thresholds, so one hung fetch does not hold
 * the capture until `maxWait`.
 */
async function awaitCriticalIdle(
  deps: Services,
  tabId: number,
  deadline: number,
  idleThreshold: number,
  log: Log,
): Promise<void> {
  const { env, network } = deps
  while (env.now() < deadline) {
    const status = network.tabStatus(tabId)
    if (status.isCriticalIdle) {
      log("critical_idle", { pending: status.pending, visualPending: status.visualPending })
      return
    }
    // the tracker's own clock, so a stalled request is told apart from a busy
    // one; measured from the poll, a pending request would reset it every round
    if (env.now() - status.lastActivity > idleThreshold * 3) {
      log("critical_timeout", { pending: status.criticalPending })
      return
    }
    await delay(env, Math.min(POLL_INTERVAL_MS, deadline - env.now()))
  }
}

/** Phase 2: images, fonts and media, capped so a lazy carousel cannot stall. */
async function awaitVisualIdle(
  deps: Services,
  tabId: number,
  deadline: number,
  log: Log,
): Promise<void> {
  const { env, network } = deps
  const start = env.now()
  const limit = Math.max(0, Math.min(VISUAL_MAX_WAIT_MS, deadline - start))
  while (env.now() - start < limit) {
    if (network.tabStatus(tabId).isIdle) {
      log("visual_idle")
      return
    }
    await delay(env, Math.min(POLL_INTERVAL_MS, start + limit - env.now()))
  }
  log("visual_timeout", { visualPending: network.tabStatus(tabId).visualPending })
}

/**
 * Phase 3: the tab's own render settlement. A restricted page, a missing
 * content script or a busy one are all recorded and none of them stop the
 * capture. Bounded by the same deadline as the rest of the wait - `maxWait`
 * as well as the command budget - so an unresponsive content script cannot
 * hold an otherwise-idle tab's capture far past what the caller asked for.
 */
async function renderCheck(
  deps: Services,
  deadline: number,
  tabId: number,
  log: Log,
): Promise<void> {
  const { browser, env } = deps
  const limit = Math.max(0, deadline - env.now())
  try {
    const readiness = await within(
      env,
      limit,
      executeInTab(browser, tabId, "checkPageReadiness", {}),
    )
    log("render_settled", asData(readiness))
  } catch (error) {
    log("render_check_failed", { error: errorText(error) })
  }
}

/** The readiness reply is spread into the event; anything else is kept whole. */
function asData(readiness: JsonValue): JsonObject {
  if (typeof readiness === "object" && readiness !== null && !Array.isArray(readiness)) {
    return readiness
  }
  return { readiness }
}

/** The work, or a rejection once the budget is spent; the work itself runs on. */
function within<T>(env: Environment, limit: number, work: Promise<T>): Promise<T> {
  let timerId = 0
  const expiry = new Promise<never>((_resolve, reject) => {
    timerId = env.setTimeout(
      () => reject(new Error(`checkPageReadiness did not answer within ${limit} ms.`)),
      limit,
    )
  })
  return Promise.race([work, expiry]).finally(() => {
    env.clearTimeout(timerId)
  })
}
