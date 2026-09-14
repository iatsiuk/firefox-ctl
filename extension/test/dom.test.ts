import { beforeEach, describe, expect, test } from "bun:test"

import {
  fakePage,
  stubLocation,
  stubRect,
  stubScroll,
  stubStyle,
  stubTop,
  stubViewport,
} from "./dom"

beforeEach(() => {
  document.body.innerHTML = ""
})

describe("fakePage scheduler", () => {
  test("runs timers in due order and moves virtual time", async () => {
    const page = fakePage()
    const order: string[] = []
    page.setTimeout(() => order.push(`late@${page.now()}`), 200)
    page.setTimeout(() => order.push(`early@${page.now()}`), 50)

    await page.advance(100)
    expect(order).toEqual(["early@50"])
    expect(page.now()).toBe(100)

    await page.advance(200)
    expect(order).toEqual(["early@50", "late@200"])
    expect(page.now()).toBe(300)
  })

  test("drops a cleared timer", async () => {
    const page = fakePage()
    let fired = false
    const handle = page.setTimeout(() => {
      fired = true
    }, 10)
    page.clearTimeout(handle)
    await page.advance(100)
    expect(fired).toBe(false)
    expect(page.pending()).toBe(0)
  })

  test("flushes a double raf so an awaiting poller makes progress", async () => {
    const page = fakePage()
    let rounds = 0
    let resolved = false
    const waited = new Promise<void>((resolve) => {
      page.raf(() => {
        rounds++
        page.raf(() => {
          rounds++
          resolve()
        })
      })
    }).then(() => {
      resolved = true
    })

    expect(rounds).toBe(0)
    await page.advance(0)
    expect(rounds).toBe(2)
    await waited
    expect(resolved).toBe(true)
  })

  test("advance does not run a timer scheduled past the window", async () => {
    const page = fakePage()
    let fired = false
    page.setTimeout(() => {
      fired = true
    }, 500)
    await page.advance(499)
    expect(fired).toBe(false)
    expect(page.pending()).toBe(1)
  })
})

describe("fakePage globals", () => {
  test("exposes the injected document and window", () => {
    const page = fakePage()
    expect(page.document).toBe(document)
    expect(page.window).toBe(window)
  })

  test("escapes css identifiers and builds events", () => {
    const page = fakePage()
    expect(page.cssEscape("a:b")).toBe("a\\:b")
    const input = new page.InputEvent("input", { inputType: "insertText", data: "hi" })
    expect(input.inputType).toBe("insertText")
    expect(new page.KeyboardEvent("keydown", { key: "a" }).key).toBe("a")
    expect(new page.Event("change").type).toBe("change")
  })

  test("hands out the native value setter of inputs only", () => {
    document.body.innerHTML = "<input id='i'><textarea id='t'></textarea><div id='d'></div>"
    const page = fakePage()
    const input = document.getElementById("i") as HTMLInputElement
    const setter = page.inputValueSetter(input)
    expect(setter).toBeDefined()
    setter?.("typed")
    expect(input.value).toBe("typed")

    const area = document.getElementById("t") as HTMLTextAreaElement
    page.inputValueSetter(area)?.("note")
    expect(area.value).toBe("note")

    const div = document.getElementById("d") as HTMLElement
    expect(page.inputValueSetter(div)).toBeUndefined()
  })

  test("reaches the prototype setter behind an own property, as React installs it", () => {
    document.body.innerHTML = "<input id='i'>"
    const page = fakePage()
    const input = document.getElementById("i") as HTMLInputElement
    let seen: string | undefined
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => "framework",
      set: (next: string) => {
        seen = next
      },
    })
    page.inputValueSetter(input)?.("native")
    expect(seen).toBeUndefined()
  })
})

describe("dom stubs", () => {
  test("stubRect pins geometry happy-dom returns as zeros", () => {
    document.body.innerHTML = "<p id='p'>hi</p>"
    const el = document.getElementById("p") as HTMLElement
    expect(el.getBoundingClientRect().width).toBe(0)
    stubRect(el, { top: 10, left: 20, width: 30, height: 40 })
    const rect = el.getBoundingClientRect()
    expect([rect.top, rect.left, rect.width, rect.height]).toEqual([10, 20, 30, 40])
    expect([rect.right, rect.bottom]).toEqual([50, 50])
  })

  test("stubStyle overrides computed values and keeps the rest", () => {
    document.body.innerHTML = "<p id='p' style='color: rgb(1, 2, 3)'>hi</p>"
    const el = document.getElementById("p") as HTMLElement
    stubStyle(el, { display: "none", opacity: "0.5" })
    const computed = window.getComputedStyle(el)
    expect(computed.display).toBe("none")
    expect(computed.opacity).toBe("0.5")
    expect(computed.color).toBe("rgb(1, 2, 3)")
    expect(computed.getPropertyValue("display")).toBe("none")
  })

  test("stubStyle leaves other elements alone", () => {
    document.body.innerHTML = "<p id='a'></p><p id='b'></p>"
    const a = document.getElementById("a") as HTMLElement
    const b = document.getElementById("b") as HTMLElement
    stubStyle(a, { visibility: "hidden" })
    expect(window.getComputedStyle(a).visibility).toBe("hidden")
    expect(window.getComputedStyle(b).visibility).not.toBe("hidden")
  })

  test("stubScroll records scrollTo and moves scrollX/scrollY", () => {
    const recorder = stubScroll(window, 0, 0)
    window.scrollTo({ top: 200, left: 10, behavior: "smooth" })
    expect(recorder.calls).toEqual([{ x: 10, y: 200, behavior: "smooth" }])
    expect(window.scrollY).toBe(200)
    expect(window.scrollX).toBe(10)
  })

  test("stubViewport, stubLocation and stubTop describe the frame", () => {
    stubViewport(window, 800, 600)
    stubLocation(window, "https://example.com/a?b=1")
    stubTop(window, false)
    expect([window.innerWidth, window.innerHeight]).toEqual([800, 600])
    expect(window.location.href).toBe("https://example.com/a?b=1")
    expect(window.location.pathname).toBe("/a")
    expect(window.top === window).toBe(false)
    stubTop(window, true)
    expect(window.top === window).toBe(true)
  })
})
