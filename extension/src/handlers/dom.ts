// The page commands. Each one resolves the target tab, hands the remaining
// params to the content-script action of the same name and merges the tab id
// into its reply. `scroll` also reports a background tab, where the page never
// moves however the content script answers.

import type { Browser, Tab } from "../browser"
import type { Handler, HandlerDeps } from "../dispatch"
import type { ActionResponse } from "../messages"
import type { JsonObject, JsonValue } from "../protocol"
import { ExtensionError } from "../protocol"
import { EVALUATE_ENABLED_DEFAULT, readEvaluateEnabled } from "../settings"
import { describeTabError, frameNotObserved } from "../tab-errors"
import { resolveTargetTab } from "./tabs"
import { waitForUrl, waitInPage } from "./wait"

/** The commands the content script serves, in `commands.json` order. */
export const PAGE_COMMANDS = [
  "getContent",
  "click",
  "type",
  "pressKey",
  "scroll",
  "waitFor",
  "getPageState",
  "getAccessibilitySnapshot",
  "getElementInfo",
  "evaluate",
  "getConsoleLogs",
  "handleConsent",
] as const

export type PageCommand = (typeof PAGE_COMMANDS)[number]

const BACKGROUND_HINT = "Scroll has no effect on background tabs. Switch tab to active first."

const EVALUATE_DISABLED_HINT =
  "evaluate is disabled; enable it in the add-on preferences (about:addons > Terminal Control for Firefox > Preferences)"

// targeting is the background page's business; the content script runs in the
// tab and frame that were picked and has no use for these
const TARGET_PARAMS = ["tabId", "windowId", "frameId"]

const INVALID_FRAME_ID = "frameId must be a non-negative integer."

/**
 * Runs one action in one frame of a tab. A messaging failure becomes a coded
 * error, a refused action keeps the content script's own message. The frame is
 * always named: with a second content script in the tab an unaddressed send
 * would go to whichever frame answers first.
 */
export async function executeInTab(
  browser: Browser,
  tabId: number,
  action: string,
  params: JsonObject,
  frameId = 0,
): Promise<JsonValue> {
  let reply: unknown
  try {
    reply = await browser.tabs.sendMessage(tabId, { action, params }, { frameId })
  } catch (error) {
    throw await describeTabError(browser, tabId, error, frameId)
  }
  const response = asActionResponse(reply)
  if (!response) {
    throw new ExtensionError(
      "CONTENT_SCRIPT_ERROR",
      `Tab ${tabId} gave no answer to ${action}.` +
        "\n  Hint: reload the tab so the content script loads again.",
    )
  }
  if (!response.success) {
    throw new Error(response.error)
  }
  return response.result
}

function asActionResponse(reply: unknown): ActionResponse | null {
  if (typeof reply !== "object" || reply === null) {
    return null
  }
  const candidate = reply as { success?: unknown; result?: unknown; error?: unknown }
  if (
    candidate.success === true &&
    Object.hasOwn(candidate, "result") &&
    candidate.result !== undefined
  ) {
    return reply as ActionResponse
  }
  if (candidate.success === false && typeof candidate.error === "string") {
    return reply as ActionResponse
  }
  return null
}

/**
 * A child frame id straight from the CLI. Absent and `0` both mean the top
 * document, which every tab has; anything else is a typo rather than a frame.
 */
export function parseFrameId(value: JsonValue | undefined): number {
  if (value === undefined) {
    return 0
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(INVALID_FRAME_ID)
  }
  return value
}

/**
 * Runs one action in the frame the command named. An unobserved frame is
 * refused before anything is sent, and a frame whose script is already gone
 * leaves the registry, so the next `listFrames` no longer offers it.
 */
export async function executeInFrame(
  deps: HandlerDeps,
  tabId: number,
  action: string,
  params: JsonObject,
  frameId: number,
): Promise<JsonValue> {
  if (frameId !== 0 && !deps.frames.isObserved(tabId, frameId)) {
    throw frameNotObserved(tabId, frameId)
  }
  try {
    return await executeInTab(deps.browser, tabId, action, params, frameId)
  } catch (error) {
    if (frameId !== 0 && error instanceof ExtensionError && error.code === "FRAME_NOT_OBSERVED") {
      deps.frames.forget(tabId, frameId)
    }
    throw error
  }
}

function actionParams(params: JsonObject): JsonObject {
  const forwarded: JsonObject = {}
  for (const [name, value] of Object.entries(params)) {
    if (!TARGET_PARAMS.includes(name)) {
      forwarded[name] = value
    }
  }
  return forwarded
}

/**
 * `{tabId, ...result}`, plus the frame when the command ran in a child one; a
 * result that is not an object is kept whole.
 */
function withTabId(tabId: number, result: JsonValue, frameId = 0): JsonObject {
  const target: JsonObject = frameId === 0 ? { tabId } : { tabId, frameId }
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    return { ...target, ...result }
  }
  return { ...target, result: result }
}

async function targetTab(deps: HandlerDeps, params: JsonObject): Promise<Tab> {
  const tab = await resolveTargetTab(deps, params)
  if (tab.id === undefined) {
    throw new Error("Firefox returned a tab without an id.")
  }
  return tab
}

async function targetTabId(deps: HandlerDeps, params: JsonObject): Promise<number> {
  return (await targetTab(deps, params)).id as number
}

function pageCommand(action: PageCommand): Handler {
  return async (params, deps) => {
    const frameId = parseFrameId(params.frameId)
    const tabId = await targetTabId(deps, params)
    const result = await executeInFrame(deps, tabId, action, actionParams(params), frameId)
    return withTabId(tabId, result, frameId)
  }
}

/** Scrolling a background tab is a no-op in Firefox, so the reply says so. */
const scroll: Handler = async (params, deps) => {
  const frameId = parseFrameId(params.frameId)
  const tab = await targetTab(deps, params)
  const tabId = tab.id as number
  // the content script scrolls its own document, so the reply of a child frame
  // carries that frame's coordinates and needs no translation
  const result = withTabId(
    tabId,
    await executeInFrame(deps, tabId, "scroll", actionParams(params), frameId),
    frameId,
  )
  if (!(tab.active ?? false)) {
    result.backgroundTab = true
    result.hint = BACKGROUND_HINT
  }
  return result
}

/**
 * Precedence: text, then URL, then selector. A URL wait runs in
 * the background, where it survives the navigation it waits for; the other two
 * belong to the document, so they go through `waitInPage`, which first lets the
 * tab finish loading.
 */
const waitFor: Handler = async (params, deps) => {
  const frameId = parseFrameId(params.frameId)
  const tabId = await targetTabId(deps, params)
  const forwarded = actionParams(params)
  if (typeof params.text !== "string" && typeof params.url === "string") {
    return withTabId(tabId, await waitForUrl(deps, deps.ctx, tabId, forwarded))
  }
  const result = await waitInPage(deps, deps.ctx, tabId, forwarded, (id, action, sent) =>
    executeInFrame(deps, id, action, sent, frameId),
  )
  return withTabId(tabId, result, frameId)
}

const forwardEvaluate = pageCommand("evaluate")

/** Reads the opt-in on every call; an unreadable storage keeps evaluate off. */
async function evaluateOptIn(deps: HandlerDeps): Promise<boolean> {
  try {
    return await readEvaluateEnabled(deps.browser)
  } catch {
    return EVALUATE_ENABLED_DEFAULT
  }
}

/**
 * `evaluate` runs whatever expression the terminal sends, so it stays off until
 * the user ticks it in the add-on preferences. The opt-in is read on every call
 * - a toggle needs no restart - and an unreadable storage keeps it off.
 */
const evaluate: Handler = async (params, deps) => {
  if (!(await evaluateOptIn(deps))) {
    throw new ExtensionError("EVALUATE_DISABLED", EVALUATE_DISABLED_HINT)
  }
  return forwardEvaluate(params, deps)
}

export const pageHandlers: Record<PageCommand, Handler> = {
  getContent: pageCommand("getContent"),
  click: pageCommand("click"),
  type: pageCommand("type"),
  pressKey: pageCommand("pressKey"),
  scroll,
  waitFor,
  getPageState: pageCommand("getPageState"),
  getAccessibilitySnapshot: pageCommand("getAccessibilitySnapshot"),
  getElementInfo: pageCommand("getElementInfo"),
  evaluate,
  getConsoleLogs: pageCommand("getConsoleLogs"),
  handleConsent: pageCommand("handleConsent"),
}
