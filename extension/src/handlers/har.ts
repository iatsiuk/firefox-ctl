// The HAR commands. Both answer from the background page: the recorder lives
// there, so neither goes through the content script.

import type { Handler } from "../dispatch"
import type { Har } from "../har"
import { buildLog, fitLog, redactEntry } from "../har"
import { BODY_BUDGET, MAX_BODY_DEFAULT } from "../har-recorder"
import type { JsonObject, JsonValue } from "../protocol"
import { redactHeadersOrDefault } from "../settings"
import type { TabsDeps } from "./tabs"
import { idOf, parseTabId, resolveTargetTab } from "./tabs"

/**
 * The bytes a stopHar reply may take: the host's 256 MiB frame cap less slack
 * for the envelope, so the extension never relies on the host to refuse it.
 */
export const REPLY_LIMIT = 256 * 1024 * 1024 - 64 * 1024

const INVALID_MAX_BODY = `maxBodySize must be an integer between 0 and ${BODY_BUDGET}`

function maxBodySize(value: JsonValue | undefined): number {
  if (value === undefined) {
    return MAX_BODY_DEFAULT
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > BODY_BUDGET) {
    throw new Error(INVALID_MAX_BODY)
  }
  return value
}

/** Starts recording the target tab: every request, headers and bodies. */
export const startHar: Handler = async (params, deps) => {
  const cap = maxBodySize(params.maxBodySize)
  const tab = await resolveTargetTab(deps, params)
  const tabId = idOf(tab)
  const start = deps.har.start(tabId, { maxBodySize: cap, url: tab.url ?? "" })
  return { tabId, startedDateTime: new Date(start).toISOString(), maxBodySize: cap }
}

/**
 * The tab whose recording stops. A recording outlives its tab, so an explicit
 * tabId that still records answers before the tab is looked up.
 */
async function recordedTab(deps: TabsDeps, params: JsonObject): Promise<number> {
  if (params.tabId !== undefined && params.tabId !== null) {
    const tabId = parseTabId(params.tabId)
    if (deps.har.isRecording(tabId)) {
      return tabId
    }
  }
  return idOf(await resolveTargetTab(deps, params))
}

/**
 * stopHar with its reply fitted to `limitBytes`. The recording is handed over
 * before anything can fail, so even HAR_TOO_LARGE releases its memory.
 */
export function stopHarWithin(limitBytes: number): Handler {
  return async (params, deps) => {
    const recording = deps.har.stop(await recordedTab(deps, params))
    const redact = await redactHeadersOrDefault(deps.browser)
    const har = buildLog(recording)
    const shown: Har = redact
      ? { log: { ...har.log, entries: har.log.entries.map(redactEntry) } }
      : har
    return fitLog(shown, limitBytes) as unknown as JsonValue
  }
}

/** Stops the target tab's recording and answers its HAR 1.2 log. */
export const stopHar: Handler = stopHarWithin(REPLY_LIMIT)
