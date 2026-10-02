// The HAR commands. Both answer from the background page: the recorder lives
// there, so neither goes through the content script.

import type { Handler, HandlerDeps } from "../dispatch"
import type { Har, HarRecording } from "../har"
import { buildLog, fitLog, redactEntry } from "../har"
import { BODY_BUDGET, MAX_BODY_DEFAULT } from "../har-recorder"
import type { JsonObject, JsonValue } from "../protocol"
import { ExtensionError } from "../protocol"
import { HAR_ENABLED_DEFAULT, readHarEnabled, redactHeadersOrDefault } from "../settings"
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

const HAR_DISABLED_HINT =
  "HAR recording is disabled; enable it in the add-on preferences (about:addons > Terminal Control for Firefox > Preferences)"

/** Reads the opt-in on every call; an unreadable storage keeps recording off. */
async function harOptIn(deps: HandlerDeps): Promise<boolean> {
  try {
    return await readHarEnabled(deps.browser)
  } catch {
    return HAR_ENABLED_DEFAULT
  }
}

/**
 * Starts recording the target tab: every request, headers and bodies. Off
 * until the user ticks it in the add-on preferences; stopHar is never gated,
 * so a recording started before the opt-in was withdrawn can still be ended.
 */
export const startHar: Handler = async (params, deps) => {
  if (!(await harOptIn(deps))) {
    throw new ExtensionError("HAR_DISABLED", HAR_DISABLED_HINT)
  }
  const cap = maxBodySize(params.maxBodySize)
  const tab = await resolveTargetTab(deps, params)
  const tabId = idOf(tab)
  const start = deps.har.start(tabId, { maxBodySize: cap, url: tab.url ?? "" })
  return { tabId, startedDateTime: new Date(start).toISOString(), maxBodySize: cap }
}

/**
 * The tab whose recording stops. A recording outlives its tab, so an explicit
 * tabId that still records, or whose HAR is kept, answers before the tab is
 * looked up.
 */
async function recordedTab(deps: TabsDeps, params: JsonObject): Promise<number> {
  if (params.tabId !== undefined && params.tabId !== null) {
    const tabId = parseTabId(params.tabId)
    if (deps.har.isRecording(tabId) || deps.har.kept(tabId) !== undefined) {
      return tabId
    }
  }
  return idOf(await resolveTargetTab(deps, params))
}

/** The stopped recording's HAR: redacted unless the user opted out, fitted to `limitBytes`. */
async function harOf(recording: HarRecording, deps: HandlerDeps, limitBytes: number): Promise<Har> {
  const redact = await redactHeadersOrDefault(deps.browser)
  const har = buildLog(recording)
  const shown: Har = redact
    ? { log: { ...har.log, entries: har.log.entries.map(redactEntry) } }
    : har
  return fitLog(shown, limitBytes)
}

/**
 * stopHar with its reply fitted to `limitBytes`. The recording is handed over
 * before anything can fail, so even HAR_TOO_LARGE releases its memory. The
 * HAR is kept from the moment the recording stops, so a stopHar whose reply
 * was lost, timed out or still building, is answered by the next one.
 */
export function stopHarWithin(limitBytes: number): Handler {
  return async (params, deps) => {
    const tabId = await recordedTab(deps, params)
    const kept = deps.har.kept(tabId)
    if (kept !== undefined) {
      return (await kept) as unknown as JsonValue
    }
    const har = harOf(deps.har.stop(tabId), deps, limitBytes)
    deps.har.keep(tabId, har)
    return (await har) as unknown as JsonValue
  }
}

/** Stops the target tab's recording and answers its HAR 1.2 log. */
export const stopHar: Handler = stopHarWithin(REPLY_LIMIT)
