import { beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { Browser, StorageArea } from "../src/browser"
import {
  bindForm,
  EVALUATE_INPUT_ID,
  LOAD_FAILED_STATUS,
  loadSettings,
  REDACT_INPUT_ID,
  readForm,
  SAVE_FAILED_STATUS,
  SAVED_STATUS,
  STATUS_ID,
  saveSetting,
} from "../src/options"
import { readEvaluateEnabled, readRedactHeaders, writeEvaluateEnabled } from "../src/settings"
import { FakeBrowser } from "./fakes"

/** A browser whose storage refuses one operation, as a full disk does. */
function withStorage(browser: FakeBrowser, area: Partial<StorageArea>): Browser {
  const local: StorageArea = { ...browser.storage.local, ...area }
  return { ...browser, storage: { local } } as Browser
}

const brokenGet: Partial<StorageArea> = {
  get: () => Promise.reject(new Error("storage offline")),
}

const brokenSet: Partial<StorageArea> = {
  set: () => Promise.reject(new Error("quota exceeded")),
}

describe("loadSettings", () => {
  test("reports the defaults while nothing is stored", async () => {
    const outcome = await loadSettings(new FakeBrowser())

    expect(outcome.state).toEqual({ evaluateEnabled: false, redactHeaders: true })
    expect(outcome.status).toBe("")
  })

  test("reports what the user stored", async () => {
    const browser = new FakeBrowser()
    await browser.storage.local.set({
      firefoxCtlEvaluateEnabled: true,
      firefoxCtlRedactHeaders: false,
    })

    expect((await loadSettings(browser)).state).toEqual({
      evaluateEnabled: true,
      redactHeaders: false,
    })
  })

  test("falls back to the defaults and says so when storage is unreadable", async () => {
    const outcome = await loadSettings(withStorage(new FakeBrowser(), brokenGet))

    expect(outcome.state).toEqual({ evaluateEnabled: false, redactHeaders: true })
    expect(outcome.status).toBe(LOAD_FAILED_STATUS)
  })
})

describe("saveSetting", () => {
  test("stores the evaluate opt-in", async () => {
    const browser = new FakeBrowser()

    const outcome = await saveSetting(browser, "evaluateEnabled", true)

    expect(outcome).toEqual({
      state: { evaluateEnabled: true, redactHeaders: true },
      status: SAVED_STATUS,
    })
    expect(await readEvaluateEnabled(browser)).toBe(true)
  })

  test("stores the header opt-out", async () => {
    const browser = new FakeBrowser()

    const outcome = await saveSetting(browser, "redactHeaders", false)

    expect(outcome.state).toEqual({ evaluateEnabled: false, redactHeaders: false })
    expect(await readRedactHeaders(browser)).toBe(false)
  })

  test("reports the stored state again when the write fails", async () => {
    const browser = new FakeBrowser()
    await writeEvaluateEnabled(browser, true)

    const outcome = await saveSetting(withStorage(browser, brokenSet), "evaluateEnabled", false)

    expect(outcome.state.evaluateEnabled).toBe(true)
    expect(outcome.status).toBe(SAVE_FAILED_STATUS)
    expect(await readEvaluateEnabled(browser)).toBe(true)
  })

  test("reports the read failure, not a false Saved., when the write succeeds but the read-back fails", async () => {
    const browser = new FakeBrowser()

    const outcome = await saveSetting(withStorage(browser, brokenGet), "evaluateEnabled", true)

    expect(outcome.status).toBe(LOAD_FAILED_STATUS)
    expect(outcome.state).toEqual({ evaluateEnabled: false, redactHeaders: true })
    expect(await readEvaluateEnabled(browser)).toBe(true)
  })

  test("reports the read failure when both the write and the read-back fail", async () => {
    const browser = new FakeBrowser()

    const outcome = await saveSetting(
      withStorage(browser, { ...brokenSet, ...brokenGet }),
      "evaluateEnabled",
      true,
    )

    expect(outcome.status).toBe(LOAD_FAILED_STATUS)
    expect(outcome.state).toEqual({ evaluateEnabled: false, redactHeaders: true })
  })
})

describe("options page", () => {
  const page = readFileSync(join(import.meta.dir, "..", "options.html"), "utf8")

  beforeEach(() => {
    document.body.innerHTML = page.replace(/^[\s\S]*<body>/, "").replace(/<\/body>[\s\S]*$/, "")
  })

  test("the page carries both inputs and a status line", () => {
    const form = readForm(document)

    expect(form).not.toBeNull()
    expect(form?.evaluateEnabled.type).toBe("checkbox")
    expect(form?.redactHeaders.type).toBe("checkbox")
  })

  test("reports a document without the form instead of throwing", () => {
    document.body.innerHTML = "<p>nothing here</p>"

    expect(readForm(document)).toBeNull()
  })

  test("reports a document missing just the status line", () => {
    document.getElementById(STATUS_ID)?.remove()

    expect(readForm(document)).toBeNull()
  })

  test("reports a document missing just one checkbox", () => {
    document.getElementById(EVALUATE_INPUT_ID)?.remove()

    expect(readForm(document)).toBeNull()
  })

  test("shows the stored values on load", async () => {
    const browser = new FakeBrowser()
    await browser.storage.local.set({
      firefoxCtlEvaluateEnabled: true,
      firefoxCtlRedactHeaders: false,
    })
    const form = readForm(document)
    if (!form) {
      throw new Error("options.html lost its form")
    }

    await bindForm(browser, form)

    expect(form.evaluateEnabled.checked).toBe(true)
    expect(form.redactHeaders.checked).toBe(false)
    expect(form.status.textContent).toBe("")
  })

  test("shows the defaults when nothing is stored", async () => {
    const form = readForm(document)
    if (!form) {
      throw new Error("options.html lost its form")
    }

    await bindForm(new FakeBrowser(), form)

    expect(form.evaluateEnabled.checked).toBe(false)
    expect(form.redactHeaders.checked).toBe(true)
  })

  test("stores each checkbox when it changes", async () => {
    const browser = new FakeBrowser()
    const form = readForm(document)
    if (!form) {
      throw new Error("options.html lost its form")
    }
    await bindForm(browser, form)

    form.evaluateEnabled.checked = true
    await form.evaluateEnabled.onchange?.(new Event("change"))
    expect(await readEvaluateEnabled(browser)).toBe(true)
    expect(form.status.textContent).toBe(SAVED_STATUS)

    form.redactHeaders.checked = false
    await form.redactHeaders.onchange?.(new Event("change"))
    expect(await readRedactHeaders(browser)).toBe(false)
  })

  test("puts a failed save back on the checkbox", async () => {
    const browser = withStorage(new FakeBrowser(), brokenSet)
    const form = readForm(document)
    if (!form) {
      throw new Error("options.html lost its form")
    }
    await bindForm(browser, form)

    form.evaluateEnabled.checked = true
    await form.evaluateEnabled.onchange?.(new Event("change"))

    expect(form.evaluateEnabled.checked).toBe(false)
    expect(form.status.textContent).toBe(SAVE_FAILED_STATUS)
  })
})

describe("options.html", () => {
  const page = readFileSync(join(import.meta.dir, "..", "options.html"), "utf8")

  test("loads the built bundle and no inline script", () => {
    expect(page).toContain('src="dist/options.js"')
    expect(page).not.toMatch(/<script(?![^>]*\bsrc=)/)
  })

  test("warns that evaluate lets the terminal run arbitrary JavaScript", () => {
    expect(page).toContain("arbitrary JavaScript")
  })

  test("names the ids the bundle binds to", () => {
    for (const id of [EVALUATE_INPUT_ID, REDACT_INPUT_ID, STATUS_ID]) {
      expect(page).toContain(`id="${id}"`)
    }
  })
})
