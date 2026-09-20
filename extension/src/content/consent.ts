// The consent action: find the button that dismisses a cookie banner and click
// it. Four passes, a set of accept patterns and a reject guard; the whole scan is bounded by
// `scanTimeout`, measured on the page clock.

import type { JsonObject, JsonValue } from "../protocol"
import { isPageActive, type Page } from "./page"
import { nextFrame } from "./timing"
import { isRendered } from "./visibility"

const DEFAULT_SCAN_TIMEOUT = 3000
const BUTTON_TEXT_LIMIT = 50

/** The accept buttons of the common consent platforms, tried in this order. */
const CMP_SELECTORS = [
  // Google consent.google.com
  "#L2AGLb",
  '.fc-consent-root button[aria-label="Accept all"]',
  // OneTrust
  "#onetrust-accept-btn-handler",
  "#accept-recommended-btn-handler",
  // Quantcast
  ".qc-cmp2-summary-buttons button:first-child",
  // Didomi
  "#didomi-notice-agree-button",
  // Cookiebot
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  // generic shapes the platforms above share
  '[id*="accept"][id*="cookie"]',
  '[id*="consent"][id*="accept"]',
  '[class*="accept-all"]',
  '[class*="consent-accept"]',
]

/** Everything a page may use as a button; the same list `getPageState` reads. */
const BUTTON_SELECTOR = 'button, [role="button"], input[type="submit"], input[type="button"]'

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]'

/** Elements likely to host a consent widget's shadow root. */
const SHADOW_HOST_SELECTOR =
  'div[id*="consent"], div[id*="cookie"], div[class*="consent"], ' +
  'div[class*="cookie"], section[id*="consent"], #usercentrics-root'

/** Whole labels only: "accept all" clicks, "accept all except tracking" does not. */
const ACCEPT_PATTERNS = [
  /^i agree$/,
  /^accept all$/,
  /^accept all cookies$/,
  /^allow all$/,
  /^allow all cookies$/,
  /^agree$/,
  /^got it$/,
  /^consent$/,
]

/** A label that opts out never counts as an accept, whatever else it matches. */
const REJECT_GUARD = /\b(reject|decline|refuse|deny|no thanks)\b/i

export type ConsentMethod = "cmp-selector" | "text-match" | "shadow-dom" | "aria-dialog"

/** One scan: where it started on the page clock and how long it may run. */
interface Scan {
  page: Page
  startedAt: number
  scanTimeout: number
}

interface Hit {
  element: HTMLElement
  buttonText: string
  method: ConsentMethod
}

function withinBudget(scan: Scan): boolean {
  return scan.page.now() - scan.startedAt < scan.scanTimeout
}

function elapsed(scan: Scan): number {
  return scan.page.now() - scan.startedAt
}

/** The visible label of a candidate: its text, or the aria-label of an icon. */
function labelOf(element: Element): string {
  return element.textContent?.trim() || element.getAttribute("aria-label") || ""
}

function isAccept(element: Element): boolean {
  const label = labelOf(element).toLowerCase()
  if (label === "") {
    return false
  }
  return ACCEPT_PATTERNS.some((pattern) => pattern.test(label)) && !REJECT_GUARD.test(label)
}

function hit(element: Element, method: ConsentMethod): Hit {
  return {
    element: element as HTMLElement,
    buttonText: labelOf(element).slice(0, BUTTON_TEXT_LIMIT),
    method,
  }
}

/** The CMP list over one root; the first visible match wins. */
function findBySelector(scan: Scan, root: ParentNode, method: ConsentMethod): Hit | null {
  for (const selector of CMP_SELECTORS) {
    if (!withinBudget(scan)) {
      return null
    }
    const element = root.querySelector(selector)
    if (element !== null && isRendered(scan.page, element)) {
      return hit(element, method)
    }
  }
  return null
}

/** Every button under one root, matched on its label. */
function findByText(scan: Scan, root: ParentNode, method: ConsentMethod): Hit | null {
  for (const button of root.querySelectorAll(BUTTON_SELECTOR)) {
    if (!withinBudget(scan)) {
      return null
    }
    if (isAccept(button) && isRendered(scan.page, button)) {
      return hit(button, method)
    }
  }
  return null
}

function scanSelectors(scan: Scan): Hit | null {
  return findBySelector(scan, scan.page.document, "cmp-selector")
}

/**
 * The generic text pass. Buttons inside an aria dialog are left to the last
 * pass, which reports them as `aria-dialog`; they are the same candidates under
 * the same patterns, so no candidate is missed here.
 */
function scanText(scan: Scan): Hit | null {
  const found = findByText(scan, scan.page.document, "text-match")
  return found !== null && found.element.closest(DIALOG_SELECTOR) !== null ? null : found
}

/** Open shadow roots of the likely hosts; a closed root reports none and is skipped. */
function scanShadowHosts(scan: Scan): Hit | null {
  for (const host of scan.page.document.querySelectorAll(SHADOW_HOST_SELECTOR)) {
    if (!withinBudget(scan)) {
      return null
    }
    const root = host.shadowRoot
    if (root === null) {
      continue
    }
    const found = findBySelector(scan, root, "shadow-dom") ?? findByText(scan, root, "shadow-dom")
    if (found !== null) {
      return found
    }
  }
  return null
}

function scanDialogs(scan: Scan): Hit | null {
  for (const dialog of scan.page.document.querySelectorAll(DIALOG_SELECTOR)) {
    if (!withinBudget(scan)) {
      return null
    }
    const found = findByText(scan, dialog, "aria-dialog")
    if (found !== null) {
      return found
    }
  }
  return null
}

const PASSES = [scanSelectors, scanText, scanShadowHosts, scanDialogs]

function findConsentButton(scan: Scan): Hit | null {
  for (const pass of PASSES) {
    if (!withinBudget(scan)) {
      return null
    }
    const found = pass(scan)
    if (found !== null) {
      return found
    }
  }
  return null
}

export async function handleConsent(params: JsonObject, page: Page): Promise<JsonValue> {
  const scan: Scan = {
    page,
    startedAt: page.now(),
    scanTimeout: typeof params.scanTimeout === "number" ? params.scanTimeout : DEFAULT_SCAN_TIMEOUT,
  }
  const found = findConsentButton(scan)
  if (found === null) {
    return { found: false, clicked: false, buttonText: null, method: null, elapsed: elapsed(scan) }
  }

  found.element.scrollIntoView({ behavior: "smooth", block: "center" })
  // let the smooth scroll settle, as `click` does, so the banner is in view
  await nextFrame(page)
  if (!isPageActive(page)) {
    throw new Error("frame is deactivated")
  }
  found.element.click()

  return {
    found: true,
    clicked: true,
    buttonText: found.buttonText,
    method: found.method,
    elapsed: elapsed(scan),
  }
}
