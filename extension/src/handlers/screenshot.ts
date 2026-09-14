// The screenshot command: wait for the tab to settle, optionally number its
// interactive elements, render it with `captureTab` - which works on a
// background tab, so nothing is ever activated - and shrink the reply until it
// fits through the native-messaging frame.

import type { CaptureOptions } from "../browser"
import type { TabLock } from "../capture-locks"
import type { Handler, HandlerDeps } from "../dispatch"
import type { JsonObject, JsonValue } from "../protocol"
import { ExtensionError } from "../protocol"
import { executeInTab } from "./dom"
import { resolveTargetTab } from "./tabs"

/** Purpose presets: an intent instead of two numbers. */
const PURPOSE_PRESETS: Record<string, { quality: number; scale: number }> = {
  "quick-glance": { quality: 30, scale: 0.25 },
  "read-text": { quality: 60, scale: 0.5 },
  "inspect-ui": { quality: 80, scale: 0.75 },
  "full-detail": { quality: 95, scale: 1 },
}

const DEFAULT_QUALITY = 60
const DEFAULT_SCALE = 0.5
const MIN_SCALE = 0.01
const MAX_ANNOTATED = 30

/**
 * The host drops any frame above 10 MiB, so a reply is measured against this
 * before it is sent; the difference leaves room for whatever the envelope and
 * the JSON escaping add.
 */
export const FRAME_LIMIT_BYTES = 9 * 1024 * 1024

// the ladder: a PNG becomes a JPEG first, then the quality falls, then the
// scale, each step a re-encode of the image already captured
const PNG_FALLBACK_QUALITY = 80
const QUALITY_STEP = 10
const QUALITY_FLOOR = 20
const SCALE_FACTOR = 0.75
const SCALE_FLOOR = 0.25
const MAX_STEPS = 8

// the id the dispatcher will put in the envelope is a uuid, so a placeholder of
// the same length measures the same frame
const ENVELOPE_ID = "00000000-0000-0000-0000-000000000000"

const NO_READINESS: JsonObject = { waitMs: 0, timedOut: false, timeline: [] }

/** The three knobs the ladder turns, as they are reported back. */
interface Encoding {
  format: string
  quality: number
  scale: number
}

/** What every step of the ladder shares. */
interface Capture {
  tabId: number
  readiness: JsonObject
  labels?: JsonValue
  wanted: Encoding
  raw: string
}

function numberParam(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function shape(encoding: Encoding): JsonObject {
  return { format: encoding.format, quality: encoding.quality, scale: encoding.scale }
}

/**
 * The preset named by `purpose`, with any explicit number winning over it.
 * Quality and scale are clamped to what `canvas.toDataURL` and the downgrade
 * ladder actually understand (1-100 and a positive fraction up to 1); left
 * unclamped, an out-of-range `quality` would re-encode at the same size on
 * every ladder step, using up the step budget without shrinking anything, and
 * a zero or negative `scale` would report a size the image was never actually
 * drawn at.
 */
function encodingOf(params: JsonObject): Encoding {
  const preset = typeof params.purpose === "string" ? PURPOSE_PRESETS[params.purpose] : undefined
  return {
    format: params.format === "png" ? "png" : "jpeg",
    quality: clamp(
      Math.round(numberParam(params.quality, preset?.quality ?? DEFAULT_QUALITY)),
      1,
      100,
    ),
    scale: clamp(numberParam(params.scale, preset?.scale ?? DEFAULT_SCALE), MIN_SCALE, 1),
  }
}

/** A PNG carries no quality; Firefox rejects one outside 1-100. */
function captureOptions(encoding: Encoding): CaptureOptions {
  if (encoding.format === "png") {
    return { format: "png" }
  }
  return { format: "jpeg", quality: Math.min(100, Math.max(1, Math.round(encoding.quality))) }
}

async function readinessOf(
  params: JsonObject,
  deps: HandlerDeps,
  tabId: number,
): Promise<JsonObject> {
  if (params.skipReadiness === true) {
    return NO_READINESS
  }
  const result = await deps.readiness(deps, deps.ctx, tabId, {
    maxWait: typeof params.maxWait === "number" ? params.maxWait : undefined,
    requireVisualIdle: params.waitForImages !== false,
  })
  return { waitMs: result.totalWaitMs, timedOut: result.timedOut, timeline: result.timeline }
}

/** Badges are cosmetic: a page that refuses them is still captured. */
async function annotate(deps: HandlerDeps, tabId: number): Promise<JsonValue | undefined> {
  try {
    const result = await executeInTab(deps.browser, tabId, "annotateElements", {
      maxElements: MAX_ANNOTATED,
    })
    return isObject(result) ? result.labels : undefined
  } catch (error) {
    console.warn("[firefox-ctl] annotateElements failed:", error)
    return undefined
  }
}

async function clearAnnotations(deps: HandlerDeps, tabId: number): Promise<void> {
  try {
    await executeInTab(deps.browser, tabId, "removeAnnotations", {})
  } catch (error) {
    console.warn("[firefox-ctl] removeAnnotations failed:", error)
  }
}

/** The next weaker setting, or null once both floors are reached. */
function downgrade(current: Encoding): Encoding | null {
  if (current.format === "png") {
    return { format: "jpeg", quality: PNG_FALLBACK_QUALITY, scale: current.scale }
  }
  if (current.quality > QUALITY_FLOOR) {
    return { ...current, quality: Math.max(QUALITY_FLOOR, current.quality - QUALITY_STEP) }
  }
  if (current.scale > SCALE_FLOOR) {
    const scale = Math.max(SCALE_FLOOR, Math.round(current.scale * SCALE_FACTOR * 10000) / 10000)
    return { ...current, scale }
  }
  return null
}

/** The bytes the dispatcher would put on the wire for this result. */
function replyBytes(result: JsonObject): number {
  const frame = JSON.stringify({ id: ENVELOPE_ID, success: true, result })
  return new TextEncoder().encode(frame).length
}

/**
 * The image at one setting. A full-scale capture in the format it was taken in
 * needs no work; everything else goes through the content script's canvas,
 * including a re-encode at scale 1, which is how the ladder shrinks a PNG.
 */
async function encode(
  deps: HandlerDeps,
  capture: Capture,
  encoding: Encoding,
  reencode: boolean,
): Promise<JsonObject> {
  if (!reencode && encoding.scale >= 1) {
    return { dataUrl: capture.raw }
  }
  const result = await executeInTab(deps.browser, capture.tabId, "resizeImage", {
    dataUrl: capture.raw,
    scale: encoding.scale,
    quality: encoding.quality,
    format: encoding.format,
  })
  if (!isObject(result) || typeof result.dataUrl !== "string") {
    throw new Error("resizeImage returned no image data.")
  }
  return result
}

function compose(
  capture: Capture,
  applied: Encoding,
  image: JsonObject,
  steps: number,
): JsonObject {
  const result: JsonObject = {
    tabId: capture.tabId,
    format: applied.format,
    quality: applied.quality,
    scale: applied.scale,
    dataUrl: image.dataUrl as string,
    readiness: capture.readiness,
  }
  if (image.originalSize !== undefined) {
    result.originalSize = image.originalSize
  }
  if (image.scaledSize !== undefined) {
    result.scaledSize = image.scaledSize
  }
  if (capture.labels !== undefined) {
    result.labels = capture.labels
  }
  if (steps > 0) {
    result.reduced = { from: shape(capture.wanted), to: shape(applied), steps }
  }
  return result
}

/**
 * Re-encodes the captured image until the reply fits the frame. The capture
 * itself happens once: every step only asks the tab to encode the same pixels
 * again, so a long page costs one render however far the ladder goes.
 */
async function fit(deps: HandlerDeps, capture: Capture): Promise<JsonObject> {
  let applied = capture.wanted
  let result = compose(capture, applied, await encode(deps, capture, applied, false), 0)
  for (let steps = 1; steps <= MAX_STEPS && replyBytes(result) > FRAME_LIMIT_BYTES; steps++) {
    const next = downgrade(applied)
    if (next === null) {
      break
    }
    applied = next
    result = compose(capture, applied, await encode(deps, capture, applied, true), steps)
  }
  const bytes = replyBytes(result)
  if (bytes > FRAME_LIMIT_BYTES) {
    throw new ExtensionError(
      "SCREENSHOT_TOO_LARGE",
      `${bytes} exceeds the 10 MiB frame limit; lower --scale or --quality.`,
    )
  }
  return result
}

/**
 * Renders one tab. `captureTab` renders a background tab as it is, so no tab is
 * activated and a capture of a tab the user is not looking at leaves their
 * window alone. Every capture of a tab serialises behind that tab's entry in
 * `deps.captureLocks`, so a plain capture can never land mid-annotation and
 * come back with someone else's badges baked into an image it never asked to
 * be annotated. The badge host in `content/image.ts` is one element per tab,
 * so without that rendezvous an `--annotate` capture's own badges could be
 * painted over or wiped by another capture of the same tab racing it.
 */
export const screenshot: Handler = async (params, deps) => {
  const tab = await resolveTargetTab(deps, params)
  if (tab.id === undefined) {
    throw new Error("Firefox returned a tab without an id.")
  }
  const tabId = tab.id
  // taken before the first await: a tab closed during readiness has its entry
  // pruned by the lifecycle listener, and a request that reached the registry
  // afterwards would put a fresh one back that nothing ever removes again
  const tabLock = deps.captureLocks.get(tabId)
  try {
    return await capture(deps, params, tabId, tabLock)
  } catch (error) {
    // resolveTargetTab's own `tabs.get` can itself race a removal: it may
    // still report the tab even after `onRemoved` already fired for it, so
    // the `get` above just recreated an entry that listener will never prune
    // again. Confirming the tab is truly gone here corrects it once, rather
    // than leaving it for a `size` that never comes back down.
    if (!(await deps.browser.tabs.get(tabId).catch(() => null))) {
      deps.captureLocks.delete(tabId)
    }
    throw error
  }
}

async function capture(
  deps: HandlerDeps,
  params: JsonObject,
  tabId: number,
  tabLock: TabLock,
): Promise<JsonObject> {
  const wanted = encodingOf(params)
  const readiness = await readinessOf(params, deps, tabId)
  const annotated = params.annotate === true
  const release = await tabLock.lock.acquire()
  let stale = false
  // becomes true once the critical section itself starts (inherited cleanup,
  // annotate, capture or this holder's own cleanup): only past that point can
  // this holder's badges - its own or ones inherited from an earlier evicted
  // holder - actually be on the page. A holder evicted before it (its whole
  // budget spent waiting for the lock) never touched the tab and must not
  // saddle the next holder with a cleanup nothing needs.
  let entered = false
  // true whenever this holder has taken on responsibility for clearing an
  // inherited handoff and has not yet finished doing so - independent of its
  // own `annotated` param, since a plain capture can inherit the duty just as
  // an annotated one can
  let clearingInherited = false
  // annotate/captureTab/removeAnnotations all message the tab, so a content
  // script that never answers (a frozen page) would otherwise hold this lock
  // forever; every later capture of the tab, including a plain one that never
  // touches the content script, would then queue behind a release that never
  // comes. Past this command's own deadline the lock is freed regardless -
  // release() is idempotent, so the normal release below still no-ops safely
  // once the section actually finishes. `stale` marks this holder as evicted:
  // if it is still mid-annotate, or still mid-inherited-cleanup, when that
  // happens, it must not clear annotations afterwards, since by then they may
  // belong to whoever the eviction let in next - but it must hand the duty
  // onward, or the badges it leaves behind are never anyone's job again.
  const evict = (): void => {
    stale = true
    if (entered && (annotated || clearingInherited)) {
      tabLock.staleAnnotations = true
    }
    release()
  }
  // once the deadline evicts this holder, the dispatcher has already answered
  // COMMAND_TIMEOUT for this command and nothing reads this function's result
  // any more; every await inside the critical section is followed by this
  // check so an evicted holder never proceeds to annotate or capture after
  // the lock has been handed to whoever comes next
  const ensureLive = (): void => {
    if (stale) {
      throw new ExtensionError(
        "COMMAND_TIMEOUT",
        `screenshot did not finish within ${deps.ctx.budgetMs} ms.`,
      )
    }
  }
  // a waiter whose whole budget was spent inside acquire() above is already
  // past its deadline the instant it gets the lock; `setTimeout` never fires
  // synchronously (not even at 0 ms), so scheduling the timer below and
  // trusting it to flip `stale` in time is a race against however fast the
  // section's own awaits happen to resolve. Checking the clock directly here,
  // before anything else runs, closes that race regardless of timing.
  if (deps.env.now() >= deps.ctx.deadlineAt) {
    evict()
    ensureLive()
  }
  const deadlineTimer = deps.env.setTimeout(
    evict,
    Math.max(0, deps.ctx.deadlineAt - deps.env.now()),
  )
  let labels: JsonValue | undefined
  let raw: string
  try {
    entered = true
    // an evicted holder before us may have painted badges without ever
    // clearing them; whoever inherits the lock next inherits that cleanup too
    if (tabLock.staleAnnotations) {
      tabLock.staleAnnotations = false
      clearingInherited = true
      await clearAnnotations(deps, tabId)
      clearingInherited = false
    }
    ensureLive()
    labels = annotated ? await annotate(deps, tabId) : undefined
    ensureLive()
    try {
      raw = await deps.browser.tabs.captureTab(tabId, captureOptions(wanted))
    } finally {
      // the badges are removed even when the capture fails, so a failed
      // screenshot never leaves red numbers on the user's page; an evicted
      // holder skips this, since the badges on the page may since have become
      // the next holder's
      if (annotated && !stale) {
        await clearAnnotations(deps, tabId)
      }
    }
  } finally {
    deps.env.clearTimeout(deadlineTimer)
    release()
  }
  return await fit(deps, { tabId, readiness, labels, wanted, raw })
}
