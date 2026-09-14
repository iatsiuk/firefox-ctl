// User-facing settings, stored in storage.local and read on every use so a
// toggle in the options page takes effect without a background restart. Both
// readers validate what they find: anything but the exact opt-in value is the
// default, and a storage rejection propagates so callers fail safe.

import type { Browser } from "./browser"

/** storage.local key holding the evaluate opt-in. */
export const EVALUATE_ENABLED_KEY = "firefoxCtlEvaluateEnabled"

/** storage.local key holding the response-header redaction switch. */
export const REDACT_HEADERS_KEY = "firefoxCtlRedactHeaders"

/** evaluate runs arbitrary JavaScript, so it is off until the user opts in. */
export const EVALUATE_ENABLED_DEFAULT = false

/** response headers carry credentials, so they are redacted unless opted out. */
export const REDACT_HEADERS_DEFAULT = true

async function readFlag(browser: Browser, key: string, fallback: boolean): Promise<boolean> {
  const items = await browser.storage.local.get(key)
  const value = items[key]
  return typeof value === "boolean" ? value : fallback
}

/** True only when the user has stored an explicit opt-in. */
export function readEvaluateEnabled(browser: Browser): Promise<boolean> {
  return readFlag(browser, EVALUATE_ENABLED_KEY, EVALUATE_ENABLED_DEFAULT)
}

/** False only when the user has stored an explicit opt-out. */
export function readRedactHeaders(browser: Browser): Promise<boolean> {
  return readFlag(browser, REDACT_HEADERS_KEY, REDACT_HEADERS_DEFAULT)
}

export function writeEvaluateEnabled(browser: Browser, enabled: boolean): Promise<void> {
  return browser.storage.local.set({ [EVALUATE_ENABLED_KEY]: enabled })
}

export function writeRedactHeaders(browser: Browser, redact: boolean): Promise<void> {
  return browser.storage.local.set({ [REDACT_HEADERS_KEY]: redact })
}
