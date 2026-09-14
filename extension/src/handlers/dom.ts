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
import { describeTabError } from "../tab-errors"
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
  "evaluate is disabled; enable it in the add-on preferences (about:addons > firefox-ctl > Preferences)"

// targeting is the background page's business; the content script runs in the
// tab that was picked and has no use for these
const TARGET_PARAMS = ["tabId", "windowId"]

/**
 * Runs one action in a tab. A messaging failure becomes a coded error, a
 * refused action keeps the content script's own message.
 */
export async function executeInTab(
  browser: Browser,
  tabId: number,
  action: string,
  params: JsonObject,
): Promise<JsonValue> {
  let reply: unknown
  try {
    reply = await browser.tabs.sendMessage(tabId, { action, params })
  } catch (error) {
    throw await describeTabError(browser, tabId, error)
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

function actionParams(params: JsonObject): JsonObject {
  const forwarded: JsonObject = {}
  for (const [name, value] of Object.entries(params)) {
    if (!TARGET_PARAMS.includes(name)) {
      forwarded[name] = value
    }
  }
  return forwarded
}

/** `{tabId, ...result}`; a result that is not an object is kept whole. */
function withTabId(tabId: number, result: JsonValue): JsonObject {
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    return { tabId, ...result }
  }
  return { tabId, result }
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
    const tabId = await targetTabId(deps, params)
    const result = await executeInTab(deps.browser, tabId, action, actionParams(params))
    return withTabId(tabId, result)
  }
}

/** Scrolling a background tab is a no-op in Firefox, so the reply says so. */
const scroll: Handler = async (params, deps) => {
  const tab = await targetTab(deps, params)
  const tabId = tab.id as number
  const result = withTabId(
    tabId,
    await executeInTab(deps.browser, tabId, "scroll", actionParams(params)),
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
  const tabId = await targetTabId(deps, params)
  const forwarded = actionParams(params)
  if (typeof params.text !== "string" && typeof params.url === "string") {
    return withTabId(tabId, await waitForUrl(deps, deps.ctx, tabId, forwarded))
  }
  const result = await waitInPage(deps, deps.ctx, tabId, forwarded, (id, action, sent) =>
    executeInTab(deps.browser, id, action, sent),
  )
  return withTabId(tabId, result)
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
