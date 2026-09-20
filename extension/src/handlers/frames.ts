// The child-frame commands. They run entirely in the background: the registry
// owns the observation, these three only resolve the target tab and translate
// its answers into the documented result shapes.

import type { Handler, HandlerDeps } from "../dispatch"
import type { FrameInfo } from "../frames"
import { globToRegExp } from "../glob"
import type { JsonObject, JsonValue } from "../protocol"
import { ExtensionError } from "../protocol"
import { resolveTargetTab } from "./tabs"
import { WAIT_TIMEOUT_MARGIN_MS } from "./wait"

const INVALID_MATCH = "match must be a non-empty string."
const INVALID_TIMEOUT = "timeout must be a non-negative integer."

/** The tab the command targets; a stale id is TAB_CLOSED, as everywhere else. */
async function targetTabId(params: JsonObject, deps: HandlerDeps): Promise<number> {
  const tab = await resolveTargetTab(deps, params)
  if (tab.id === undefined) {
    throw new Error("Firefox returned a tab without an id.")
  }
  return tab.id
}

function parseMatch(value: JsonValue | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== "string" || value === "") {
    throw new Error(INVALID_MATCH)
  }
  return value
}

function parseTimeout(value: JsonValue | undefined): number {
  if (value === undefined) {
    return 0
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(INVALID_TIMEOUT)
  }
  return value
}

/**
 * Starts observing the child frames this tab loads from now on. There is no
 * backfill: a frame already open when the watch opens stays invisible until it
 * loads again.
 */
export const watchFrames: Handler = async (params, deps) => {
  const match = parseMatch(params.match)
  const tabId = await targetTabId(params, deps)
  deps.frames.watch(tabId, match)
  return { tabId, match: match ?? null, watching: true }
}

/** Stops the watch and deactivates every frame script it had injected. */
export const unwatchFrames: Handler = async (params, deps) => {
  const tabId = await targetTabId(params, deps)
  const released = deps.frames.unwatch(tabId)
  return { tabId, watching: false, released }
}

/**
 * The child frames of the tab that can answer a command. With `timeout` it is
 * a wait-for-first: it returns as soon as one matching frame is admitted, not
 * once the provider has mounted all of them.
 */
export const listFrames: Handler = async (params, deps) => {
  const match = parseMatch(params.match)
  const timeout = parseTimeout(params.timeout)
  const tabId = await targetTabId(params, deps)
  const pattern = match === undefined ? undefined : globToRegExp(match)
  const found = filtered(deps.frames.list(tabId), pattern)
  if (found.length > 0 || timeout === 0 || !deps.frames.isWatched(tabId)) {
    return report(tabId, deps, found)
  }
  const deadline = Math.min(deps.env.now() + timeout, deps.ctx.deadlineAt - WAIT_TIMEOUT_MARGIN_MS)
  const result = await deps.frames.awaitFrame(tabId, { match: pattern }, deadline)
  if (result.outcome === "closed") {
    throw new ExtensionError("TAB_CLOSED", `Tab ${tabId} no longer exists.`)
  }
  return report(tabId, deps, result.frames)
}

function filtered(frames: FrameInfo[], pattern: RegExp | undefined): FrameInfo[] {
  return pattern === undefined ? frames : frames.filter((frame) => pattern.test(frame.url))
}

function report(tabId: number, deps: HandlerDeps, frames: FrameInfo[]): JsonValue {
  return {
    tabId,
    watching: deps.frames.isWatched(tabId),
    frames: frames.map(({ frameId, url, parentFrameId }) => ({ frameId, url, parentFrameId })),
  }
}
