import { beforeEach, describe, expect, test } from "bun:test"

import { safeQuerySelector, smartQuerySelector, validateSelector } from "../src/content/selector"
import { fakePage } from "./dom"
import errors from "./fixtures/errors.json"

beforeEach(() => {
  document.body.innerHTML = ""
})

describe("validateSelector", () => {
  test("returns the selector it accepted", () => {
    expect(validateSelector(fakePage(), "#go")).toBe("#go")
  })

  test("rejects a missing or non-string selector", () => {
    const page = fakePage()
    for (const value of [undefined, null, 7, {}, []]) {
      expect(() => validateSelector(page, value)).toThrow(errors.selectorRequired)
    }
  })

  test("rejects an empty or whitespace-only selector", () => {
    const page = fakePage()
    // the empty string fails the falsy check first
    expect(() => validateSelector(page, "")).toThrow(errors.selectorRequired)
    expect(() => validateSelector(page, "   ")).toThrow(errors.selectorEmpty)
    expect(() => validateSelector(page, "\n\t")).toThrow(errors.selectorEmpty)
  })

  test("rejects a selector longer than 1000 characters", () => {
    const page = fakePage()
    expect(() => validateSelector(page, `#${"a".repeat(999)}`)).not.toThrow()
    expect(() => validateSelector(page, `#${"a".repeat(1000)}`)).toThrow(errors.selectorTooLong)
  })

  test("rejects a syntactically invalid selector with the browser message", () => {
    const page = fakePage()
    const prefix = errors.selectorInvalid.replace("<message>", "")
    try {
      validateSelector(page, "div[")
      throw new Error("expected a throw")
    } catch (error) {
      const message = (error as Error).message
      expect(message.startsWith(prefix)).toBe(true)
      expect(message.length).toBeGreaterThan(prefix.length)
    }
  })
})

describe("safeQuerySelector", () => {
  test("returns the first match", () => {
    document.body.innerHTML = "<p class='x'>one</p><p class='x'>two</p>"
    expect(safeQuerySelector(fakePage(), ".x")?.textContent).toBe("one")
  })

  test("returns null when nothing matches", () => {
    expect(safeQuerySelector(fakePage(), "#absent")).toBeNull()
  })

  test("validates before querying", () => {
    expect(() => safeQuerySelector(fakePage(), "")).toThrow(errors.selectorRequired)
  })
})

describe("smartQuerySelector", () => {
  test("returns an existing element without waiting", async () => {
    document.body.innerHTML = "<button id='go'>go</button>"
    const page = fakePage()
    const found = await smartQuerySelector(page, "#go")
    expect(found?.id).toBe("go")
    expect(page.now()).toBe(0)
    expect(page.pending()).toBe(0)
  })

  test("finds an element appended after two polls", async () => {
    const page = fakePage()
    const pending = smartQuerySelector(page, "#late")
    page.setTimeout(() => {
      document.body.innerHTML = "<div id='late'></div>"
    }, 250)

    await page.advance(1000)
    const found = await pending
    expect(found?.id).toBe("late")
    expect(page.now()).toBeGreaterThanOrEqual(250)
  })

  test("gives up at the timeout", async () => {
    const page = fakePage()
    const pending = smartQuerySelector(page, "#never", { timeout: 1000 })
    await page.advance(2000)
    await expect(pending).resolves.toBeNull()
  })

  test("returns null immediately when autoWait is off", async () => {
    const page = fakePage()
    await expect(smartQuerySelector(page, "#never", { autoWait: false })).resolves.toBeNull()
    expect(page.pending()).toBe(0)
  })

  test("validates the selector before polling", async () => {
    await expect(smartQuerySelector(fakePage(), "  ")).rejects.toThrow(errors.selectorEmpty)
  })
})
