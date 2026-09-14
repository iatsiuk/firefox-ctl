import { describe, expect, test } from "bun:test"

import { nativeValueSetter, realPage } from "../src/content/page"

describe("realPage", () => {
  test("binds the page globals", () => {
    const page = realPage()
    expect(page.document).toBe(document)
    expect(page.window).toBe(window)
    expect(page.cssEscape("a b")).toBe(CSS.escape("a b"))
    expect(page.inputValueSetter).toBe(nativeValueSetter)
    expect(Math.abs(page.now() - Date.now())).toBeLessThan(1000)
  })

  test("schedules frames and timers on the real event loop", async () => {
    const page = realPage()
    await new Promise<void>((resolve) => {
      page.raf(() => resolve())
    })
    const handle = page.setTimeout(() => {
      throw new Error("cleared timer fired")
    }, 5)
    page.clearTimeout(handle)
    await new Promise<void>((resolve) => {
      page.setTimeout(resolve, 10)
    })
  })

  test("binds requestIdleCallback only where the page has one", async () => {
    expect(realPage().requestIdleCallback).toBeUndefined()
    const asked: number[] = []
    Object.defineProperty(globalThis, "requestIdleCallback", {
      configurable: true,
      value: (callback: () => void, options: { timeout: number }) => {
        asked.push(options.timeout)
        callback()
      },
    })
    try {
      await new Promise<void>((resolve) => {
        realPage().requestIdleCallback?.(resolve, { timeout: 100 })
      })
    } finally {
      Reflect.deleteProperty(globalThis, "requestIdleCallback")
    }
    expect(asked).toEqual([100])
  })

  test("builds the events typing and key pressing dispatch", () => {
    const page = realPage()
    expect(new page.InputEvent("input", { inputType: "insertText" }).inputType).toBe("insertText")
    expect(new page.KeyboardEvent("keydown", { key: "Enter" }).key).toBe("Enter")
    expect(new page.Event("change", { bubbles: true }).bubbles).toBe(true)
  })
})
