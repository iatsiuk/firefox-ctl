// The add-on preferences page. Reading and writing the two settings is pure -
// it takes a Browser and the form the page holds - so only the binding at the
// bottom of this file touches the real globals, and only when the page is there.

import type { Browser } from "./browser"
import { realBrowser } from "./browser"
import {
  EVALUATE_ENABLED_DEFAULT,
  REDACT_HEADERS_DEFAULT,
  readEvaluateEnabled,
  readRedactHeaders,
  writeEvaluateEnabled,
  writeRedactHeaders,
} from "./settings"

/** The element ids `options.html` and this bundle agree on. */
export const EVALUATE_INPUT_ID = "evaluate-enabled"
export const REDACT_INPUT_ID = "redact-headers"
export const STATUS_ID = "status"

export const SAVED_STATUS = "Saved."
export const SAVE_FAILED_STATUS = "Could not save the setting; nothing changed."
export const LOAD_FAILED_STATUS = "Could not read the settings; showing the defaults."

export type SettingName = "evaluateEnabled" | "redactHeaders"

/** What both checkboxes show. */
export interface OptionsState {
  evaluateEnabled: boolean
  redactHeaders: boolean
}

/** The state to render plus the line to show under it; an empty line says nothing. */
export interface Outcome {
  state: OptionsState
  status: string
}

const DEFAULT_STATE: OptionsState = {
  evaluateEnabled: EVALUATE_ENABLED_DEFAULT,
  redactHeaders: REDACT_HEADERS_DEFAULT,
}

const writers: Record<SettingName, (browser: Browser, value: boolean) => Promise<void>> = {
  evaluateEnabled: writeEvaluateEnabled,
  redactHeaders: writeRedactHeaders,
}

/** Both settings as stored; an unreadable storage shows the safe defaults. */
export async function loadSettings(browser: Browser): Promise<Outcome> {
  try {
    return {
      state: {
        evaluateEnabled: await readEvaluateEnabled(browser),
        redactHeaders: await readRedactHeaders(browser),
      },
      status: "",
    }
  } catch {
    return { state: DEFAULT_STATE, status: LOAD_FAILED_STATUS }
  }
}

/**
 * Stores one toggle and reads both settings back, so the checkboxes always show
 * what storage holds - a rejected write leaves the old value on the page. If the
 * read-back itself fails, that failure is reported as-is rather than papered
 * over with a "Saved." status the read never confirmed.
 */
export async function saveSetting(
  browser: Browser,
  name: SettingName,
  value: boolean,
): Promise<Outcome> {
  try {
    await writers[name](browser, value)
  } catch {
    const readBack = await loadSettings(browser)
    return { state: readBack.state, status: readBack.status || SAVE_FAILED_STATUS }
  }
  const readBack = await loadSettings(browser)
  return readBack.status ? readBack : { state: readBack.state, status: SAVED_STATUS }
}

/** The controls of `options.html`. */
export interface OptionsForm {
  evaluateEnabled: HTMLInputElement
  redactHeaders: HTMLInputElement
  status: HTMLElement
}

function input(doc: Document, id: string): HTMLInputElement | null {
  const element = doc.getElementById(id)
  return element instanceof HTMLInputElement ? element : null
}

/** The form of a loaded options page, or null in any other document. */
export function readForm(doc: Document): OptionsForm | null {
  const evaluateEnabled = input(doc, EVALUATE_INPUT_ID)
  const redactHeaders = input(doc, REDACT_INPUT_ID)
  const status = doc.getElementById(STATUS_ID)
  if (!evaluateEnabled || !redactHeaders || !status) {
    return null
  }
  return { evaluateEnabled, redactHeaders, status }
}

function render(form: OptionsForm, outcome: Outcome): void {
  form.evaluateEnabled.checked = outcome.state.evaluateEnabled
  form.redactHeaders.checked = outcome.state.redactHeaders
  form.status.textContent = outcome.status
}

/** Fills the form from storage and stores every later change. */
export async function bindForm(browser: Browser, form: OptionsForm): Promise<void> {
  const toggle = (name: SettingName, element: HTMLInputElement) => {
    element.onchange = () => saveSetting(browser, name, element.checked).then(update)
  }
  const update = (outcome: Outcome) => {
    render(form, outcome)
  }
  toggle("evaluateEnabled", form.evaluateEnabled)
  toggle("redactHeaders", form.redactHeaders)
  update(await loadSettings(browser))
}

// the bundle is a classic script at the end of the page body; imported without
// that page - under test - there is no form and the globals stay untouched
const loaded = typeof document === "undefined" ? null : readForm(document)
if (loaded) {
  void bindForm(realBrowser(), loaded)
}
