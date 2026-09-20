// The waits. A navigation replaces the document that hosts the content script,
// so any promise the old script owes the background dies with it; only the
// background can watch a tab across that boundary, which is why the URL wait
// lives here. Text and selector waits stay in the content script, where they
// target the current document, but the background still holds the tab until it
// has finished loading and a content script exists to answer.

import type { Tab, TabChangeInfo } from "../browser"
import type { Services } from "../dispatch"
import type { Environment } from "../env"
import { globToRegExp } from "../glob"
import type { CommandContext, JsonObject, JsonValue } from "../protocol"
import { ExtensionError } from "../protocol"
import {
  describeTabError,
  frameNotObserved,
  isContentScriptMissing,
  isFrameUnreachable,
} from "../tab-errors"

const DEFAULT_TIMEOUT = 10000

// how long to leave between two sends while the content script is still
// missing; the same cadence as the content script's own poll
const RETRY_INTERVAL_MS = 100

// subtracted from the remaining command budget so this wait's own timer fires
// strictly before the dispatcher's COMMAND_TIMEOUT, even when the requested
// timeout is at or above the remaining budget
export const WAIT_TIMEOUT_MARGIN_MS = 100

/**
 * Resolves as soon as the tab's URL matches the glob. The wait is event-driven,
 * so the CLI's `interval` is accepted for parity and ignored; its own timeout
 * is capped at whatever is left of the command budget, so the caller sees this
 * message rather than COMMAND_TIMEOUT whenever it can.
 */
export function waitForUrl(
  deps: Services,
  ctx: CommandContext,
  tabId: number,
  params: JsonObject,
): Promise<JsonValue> {
  const { browser, env } = deps
  const glob = typeof params.url === "string" ? params.url : ""
  const pattern = globToRegExp(glob)
  const start = env.now()

  return new Promise<JsonValue>((resolve, reject) => {
    let settled = false
    let timerId = 0
    const onUpdated = (id: number, changeInfo: TabChangeInfo, tab: Tab): void => {
      if (id === tabId) {
        match(changeInfo.url ?? tab.url)
      }
    }
    const onRemoved = (id: number): void => {
      if (id === tabId) {
        fail(tabClosed(tabId))
      }
    }
    const done = (): boolean => {
      if (settled) {
        return true
      }
      settled = true
      browser.tabs.onUpdated.removeListener(onUpdated)
      browser.tabs.onRemoved.removeListener(onRemoved)
      env.clearTimeout(timerId)
      return false
    }
    const match = (href: string | undefined): void => {
      if (href === undefined || !pattern.test(href) || done()) {
        return
      }
      resolve({ url: glob, matched: href, found: true, elapsed: env.now() - start })
    }
    const fail = (error: Error): void => {
      if (!done()) {
        reject(error)
      }
    }

    // the listeners go up before the first look at the tab, so an update
    // arriving while tabs.get is in flight is not lost
    browser.tabs.onUpdated.addListener(onUpdated)
    browser.tabs.onRemoved.addListener(onRemoved)
    timerId = env.setTimeout(
      () => fail(new Error(`Timeout waiting for URL matching: "${glob}"`)),
      waitLimit(ctx, env.now(), params.timeout),
    )
    browser.tabs.get(tabId).then(
      (tab) => match(tab.url),
      () => fail(tabClosed(tabId)),
    )
  })
}

function waitLimit(ctx: CommandContext, now: number, timeout: JsonValue | undefined): number {
  const wanted = typeof timeout === "number" ? timeout : DEFAULT_TIMEOUT
  const remaining = ctx.deadlineAt - now - WAIT_TIMEOUT_MARGIN_MS
  return Math.max(0, Math.min(wanted, remaining))
}

function tabClosed(tabId: number): ExtensionError {
  return new ExtensionError("TAB_CLOSED", `Tab ${tabId} no longer exists.`)
}

/** Sends one action to a tab's content script; `executeInTab` in practice. */
export type SendAction = (tabId: number, action: string, params: JsonObject) => Promise<JsonValue>

/**
 * Resolves true once the tab reports `status: complete`, false when the wait
 * runs out; rejects TAB_CLOSED if the tab goes away first. A tab without a
 * status is treated as loaded, which is what Firefox reports for a tab that
 * has been sitting there.
 */
export function awaitTabComplete(
  deps: Services,
  ctx: CommandContext,
  tabId: number,
  maxMs: number,
): Promise<boolean> {
  const { browser, env } = deps

  return new Promise<boolean>((resolve, reject) => {
    let settled = false
    let timerId = 0
    const onUpdated = (id: number, changeInfo: TabChangeInfo, tab: Tab): void => {
      if (id === tabId && (changeInfo.status ?? tab.status) === "complete") {
        finish(true)
      }
    }
    const onRemoved = (id: number): void => {
      if (id === tabId) {
        fail(tabClosed(tabId))
      }
    }
    const done = (): boolean => {
      if (settled) {
        return true
      }
      settled = true
      browser.tabs.onUpdated.removeListener(onUpdated)
      browser.tabs.onRemoved.removeListener(onRemoved)
      env.clearTimeout(timerId)
      return false
    }
    const finish = (complete: boolean): void => {
      if (!done()) {
        resolve(complete)
      }
    }
    const fail = (error: Error): void => {
      if (!done()) {
        reject(error)
      }
    }

    // the listeners go up before the first look at the tab, so the completion
    // arriving while tabs.get is in flight is not lost
    browser.tabs.onUpdated.addListener(onUpdated)
    browser.tabs.onRemoved.addListener(onRemoved)
    timerId = env.setTimeout(() => finish(false), waitLimit(ctx, env.now(), maxMs))
    browser.tabs.get(tabId).then(
      (tab) => {
        if (tab.status !== "loading") {
          finish(true)
        }
      },
      () => fail(tabClosed(tabId)),
    )
  })
}

/**
 * A text or selector wait: hold until the tab has loaded, then let the content
 * script do the waiting with whatever is left of the timeout. Right after
 * `status: complete` the `document_idle` content script may still be missing,
 * so a failed delivery is retried; only this command may, because it changes
 * nothing and a repeat costs nothing.
 */
export async function waitInPage(
  deps: Services,
  ctx: CommandContext,
  tabId: number,
  params: JsonObject,
  send: SendAction,
): Promise<JsonValue> {
  const { env } = deps
  const start = env.now()
  const total = typeof params.timeout === "number" ? params.timeout : DEFAULT_TIMEOUT
  // the margin keeps this wait's own message ahead of COMMAND_TIMEOUT; bounded
  // by the command budget too, so a generous --timeout can never outlive the
  // dispatcher's own COMMAND_TIMEOUT for this command
  const deadline = Math.min(start + total, ctx.deadlineAt) - WAIT_TIMEOUT_MARGIN_MS

  if (!(await awaitTabComplete(deps, ctx, tabId, total))) {
    throw await waitTimeout(deps, tabId, params)
  }
  for (;;) {
    const before = env.now()
    try {
      const left = Math.max(0, deadline - before)
      return withElapsed(await send(tabId, "waitFor", { ...params, timeout: left }), before - start)
    } catch (error) {
      if (!isContentScriptMissing(error)) {
        throw error
      }
      if (env.now() >= deadline) {
        throw await waitTimeout(deps, tabId, params)
      }
    }
    // bounded by what is left before the deadline, so a retry can never wake
    // up after it and send once more
    await delay(env, Math.min(RETRY_INTERVAL_MS, Math.max(0, deadline - env.now())))
  }
}

/**
 * A text or selector wait inside a child frame. A frame loads on its own
 * schedule, so instead of the tab's load this wait holds until the registry
 * admits the frame, then lets the frame script wait with whatever is left of
 * the one deadline both phases share. A frame that navigates mid-wait takes its
 * script with it and is injected again, so a send that finds no receiver drops
 * the stale entry and waits for the frame once more.
 */
export async function waitInFrame(
  deps: Services,
  ctx: CommandContext,
  tabId: number,
  params: JsonObject,
  frameId: number,
  send: SendAction,
): Promise<JsonValue> {
  const { env, frames } = deps
  const start = env.now()
  const total = typeof params.timeout === "number" ? params.timeout : DEFAULT_TIMEOUT
  const deadline = Math.min(start + total, ctx.deadlineAt) - WAIT_TIMEOUT_MARGIN_MS

  for (;;) {
    const admission = await frames.awaitFrame(tabId, { frameId }, deadline)
    if (admission.outcome === "closed") {
      throw tabClosed(tabId)
    }
    // a frame that never connected and a watch that was closed leave the same
    // gap: nothing in that tab can answer for this frame id
    if (admission.outcome !== "found") {
      throw frameNotObserved(tabId, frameId)
    }
    const before = env.now()
    try {
      const left = Math.max(0, deadline - before)
      return withElapsed(await send(tabId, "waitFor", { ...params, timeout: left }), before - start)
    } catch (error) {
      if (!isFrameUnreachable(error)) {
        throw error
      }
      if (env.now() >= deadline) {
        throw frameNotObserved(tabId, frameId)
      }
    }
    // bounded by what is left before the deadline, so a retry can never wake
    // up after it and send once more
    await delay(env, Math.min(RETRY_INTERVAL_MS, Math.max(0, deadline - env.now())))
  }
}

/** The message the content script would have raised had it been able to run. */
function waitTimeout(deps: Services, tabId: number, params: JsonObject): Promise<Error> {
  const text = params.text
  if (typeof text === "string") {
    return Promise.resolve(new Error(`Timeout waiting for text: "${text}"`))
  }
  const selector = params.selector
  if (typeof selector === "string") {
    return Promise.resolve(new Error(`Timeout waiting for element: ${selector}`))
  }
  // no mode to time out on: say why the content script stayed out of reach
  return describeTabError(deps.browser, tabId, new Error("Receiving end does not exist"))
}

// the content script only times its own phase, so the time this wait spent on
// the load and on the retries is added to it
function withElapsed(result: JsonValue, extra: number): JsonValue {
  if (extra <= 0 || typeof result !== "object" || result === null || Array.isArray(result)) {
    return result
  }
  const elapsed = result.elapsed
  if (typeof elapsed !== "number") {
    return result
  }
  return { ...result, elapsed: elapsed + extra }
}

function delay(env: Environment, ms: number): Promise<void> {
  return new Promise((resolve) => {
    env.setTimeout(resolve, ms)
  })
}
