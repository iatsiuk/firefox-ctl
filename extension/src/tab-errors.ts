// Failures of tab messaging, translated. Firefox reports a missing content
// script as "Receiving end does not exist" whatever the cause, so the tab is
// inspected once and the outcome carries one of the CLI's error codes.

import type { Browser, Tab } from "./browser"
import { ExtensionError } from "./protocol"

const MISSING_RECEIVER = "Receiving end does not exist"
const RESTRICTED_SCHEMES = ["about:", "chrome:", "moz-extension:"]
const NON_HTML_EXTENSIONS = /\.(json|xml|pdf|csv|txt|bin|zip|gz|tar|woff|woff2|ttf|otf|eot)(\?|$)/i

/** What a command gets when it names a child frame the registry cannot reach. */
export function frameNotObserved(tabId: number, frameId: number): ExtensionError {
  return new ExtensionError(
    "FRAME_NOT_OBSERVED",
    `frame ${frameId} of tab ${tabId} is not observed; ` +
      "call watchFrames before the frame loads or reopen it",
  )
}

/**
 * Replaces Firefox's cryptic "Receiving end does not exist" with a coded error.
 * Any other failure is returned untouched. A send into a child frame is only
 * ever about that frame: whatever the top document is doing, its script is not
 * the one that failed to answer.
 */
export async function describeTabError(
  browser: Browser,
  tabId: number,
  error: unknown,
  frameId = 0,
): Promise<Error> {
  if (!errorText(error).includes(MISSING_RECEIVER)) {
    return error instanceof Error ? error : new Error(errorText(error))
  }
  let tab: Tab
  try {
    tab = await browser.tabs.get(tabId)
  } catch {
    return new ExtensionError(
      "TAB_CLOSED",
      `Tab ${tabId} no longer exists. It may have been closed by the user.`,
    )
  }
  if (frameId !== 0) {
    return frameNotObserved(tabId, frameId)
  }
  const context = `\n  URL: ${tab.url ?? "(none)"}\n  Title: ${tab.title ?? "(none)"}`
  const coded = classifyTab(tab, context, tabId)
  if (coded) {
    return coded
  }
  return new ExtensionError(
    "CONTENT_SCRIPT_UNAVAILABLE",
    `Cannot communicate with tab ${tabId}.${context}` +
      "\n  Hint: the page may still be loading; try again or reload the tab.",
  )
}

/**
 * True when the failure means "no content script answered": either Firefox's
 * raw message or the coded error `describeTabError` makes of it. A tab that is
 * still loading reports the same code, and both cases pass once the script is
 * in place, so `waitFor` retries on either.
 */
export function isContentScriptMissing(error: unknown): boolean {
  if (error instanceof ExtensionError) {
    return error.code === "CONTENT_SCRIPT_UNAVAILABLE"
  }
  return errorText(error).includes(MISSING_RECEIVER)
}

/**
 * True when a send into a child frame found nothing to answer it: the frame
 * script is missing, or the registry entry it was aimed at is stale. A frame
 * that navigates takes its script with it and is injected again, so a wait on
 * that frame may still succeed and retries on either.
 */
export function isFrameUnreachable(error: unknown): boolean {
  if (error instanceof ExtensionError && error.code === "FRAME_NOT_OBSERVED") {
    return true
  }
  return isContentScriptMissing(error)
}

function classifyTab(tab: Tab, context: string, tabId: number): ExtensionError | null {
  if (tab.title === "Problem loading page" || tab.title === "Server Not Found") {
    return new ExtensionError(
      "PAGE_LOAD_FAILED",
      `The page failed to load.${context}` +
        "\n  Hint: check that the server is running, or navigate to a different URL.",
    )
  }
  // while a tab loads, Firefox shows its URL as the title and a fresh tab is
  // still about:blank, so both heuristics below would misread the wait
  if (tab.status === "loading") {
    return new ExtensionError(
      "CONTENT_SCRIPT_UNAVAILABLE",
      `Tab ${tabId} is still loading ${tab.url ?? "(none)"}. ` +
        "Wait for it to finish (waitFor --selector or --url) and retry.",
    )
  }
  const url = tab.url ?? ""
  if (RESTRICTED_SCHEMES.some((scheme) => url.startsWith(scheme))) {
    return new ExtensionError(
      "RESTRICTED_PAGE",
      `Content scripts cannot run on this page.${context}` +
        "\n  Hint: navigate to an http://, https:// or file:// URL.",
    )
  }
  if (looksNonHtml(url, tab.title)) {
    return new ExtensionError(
      "CONTENT_SCRIPT_ERROR",
      `Page is likely a non-HTML response (JSON, PDF, download).${context}` +
        "\n  Hint: navigate to an HTML page first.",
    )
  }
  return null
}

// Firefox's JSON viewer titles the tab with host + path, so the title is as
// telling as the extension
function looksNonHtml(url: string, title: string | undefined): boolean {
  if (NON_HTML_EXTENSIONS.test(url)) {
    return true
  }
  if (!title || !url) {
    return false
  }
  try {
    const parsed = new URL(url)
    return title === parsed.host + parsed.pathname
  } catch {
    return false
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
