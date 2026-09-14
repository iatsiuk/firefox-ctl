import { describe, expect, test } from "bun:test"

import type { Browser, StorageArea } from "../src/browser"
import {
  EVALUATE_ENABLED_KEY,
  REDACT_HEADERS_KEY,
  readEvaluateEnabled,
  readRedactHeaders,
  writeEvaluateEnabled,
  writeRedactHeaders,
} from "../src/settings"
import { FakeBrowser } from "./fakes"

// a browser whose storage.local.get always rejects
function brokenStorage(): Browser {
  const browser = new FakeBrowser()
  const local: StorageArea = {
    get: () => Promise.reject(new Error("storage offline")),
    set: (items) => browser.storage.local.set(items),
    remove: (keys) => browser.storage.local.remove(keys),
  }
  return { ...browser, storage: { local } }
}

describe("settings defaults", () => {
  test("an empty storage disables evaluate and redacts headers", async () => {
    const browser = new FakeBrowser()
    expect(await readEvaluateEnabled(browser)).toBe(false)
    expect(await readRedactHeaders(browser)).toBe(true)
  })

  test.each([
    ["yes", false, true],
    [1, false, true],
    [0, false, true],
    [null, false, true],
    [{ enabled: true }, false, true],
    [[true], false, true],
    ["true", false, true],
    ["false", false, true],
  ])("a malformed stored value %p yields the defaults", async (stored, evaluate, redact) => {
    const browser = new FakeBrowser()
    await browser.storage.local.set({
      [EVALUATE_ENABLED_KEY]: stored,
      [REDACT_HEADERS_KEY]: stored,
    })
    expect(await readEvaluateEnabled(browser)).toBe(evaluate)
    expect(await readRedactHeaders(browser)).toBe(redact)
  })

  test("only a stored true enables evaluate", async () => {
    const browser = new FakeBrowser()
    await browser.storage.local.set({ [EVALUATE_ENABLED_KEY]: true })
    expect(await readEvaluateEnabled(browser)).toBe(true)
    await browser.storage.local.set({ [EVALUATE_ENABLED_KEY]: false })
    expect(await readEvaluateEnabled(browser)).toBe(false)
  })

  test("only a stored false disables redaction", async () => {
    const browser = new FakeBrowser()
    await browser.storage.local.set({ [REDACT_HEADERS_KEY]: false })
    expect(await readRedactHeaders(browser)).toBe(false)
    await browser.storage.local.set({ [REDACT_HEADERS_KEY]: true })
    expect(await readRedactHeaders(browser)).toBe(true)
  })

  test("the two settings are independent", async () => {
    const browser = new FakeBrowser()
    await browser.storage.local.set({ [EVALUATE_ENABLED_KEY]: true, [REDACT_HEADERS_KEY]: false })
    expect(await readEvaluateEnabled(browser)).toBe(true)
    expect(await readRedactHeaders(browser)).toBe(false)
  })
})

describe("settings failures", () => {
  test("a rejected read propagates so callers fail closed", async () => {
    const browser = brokenStorage()
    expect(readEvaluateEnabled(browser)).rejects.toThrow("storage offline")
    expect(readRedactHeaders(browser)).rejects.toThrow("storage offline")
  })
})

describe("settings writes", () => {
  test("evaluate round trips through storage", async () => {
    const browser = new FakeBrowser()
    await writeEvaluateEnabled(browser, true)
    expect(await browser.storage.local.get(EVALUATE_ENABLED_KEY)).toEqual({
      [EVALUATE_ENABLED_KEY]: true,
    })
    expect(await readEvaluateEnabled(browser)).toBe(true)
    await writeEvaluateEnabled(browser, false)
    expect(await readEvaluateEnabled(browser)).toBe(false)
  })

  test("redaction round trips through storage", async () => {
    const browser = new FakeBrowser()
    await writeRedactHeaders(browser, false)
    expect(await browser.storage.local.get(REDACT_HEADERS_KEY)).toEqual({
      [REDACT_HEADERS_KEY]: false,
    })
    expect(await readRedactHeaders(browser)).toBe(false)
    await writeRedactHeaders(browser, true)
    expect(await readRedactHeaders(browser)).toBe(true)
  })

  test("a write leaves the other setting untouched", async () => {
    const browser = new FakeBrowser()
    await writeEvaluateEnabled(browser, true)
    await writeRedactHeaders(browser, false)
    expect(await readEvaluateEnabled(browser)).toBe(true)
    expect(await readRedactHeaders(browser)).toBe(false)
  })
})
