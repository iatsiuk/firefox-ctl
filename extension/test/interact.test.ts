import { beforeEach, describe, expect, test } from "bun:test"

import { click, pressKey, type as typeAction } from "../src/content/interact"
import type { JsonObject } from "../src/protocol"
import { fakePage, stubLocation } from "./dom"
import errors from "./fixtures/errors.json"

beforeEach(() => {
  document.title = "Interaction page"
  document.body.innerHTML = ""
})

function el(selector: string): HTMLElement {
  const found = document.querySelector(selector)
  if (found === null) {
    throw new Error(`fixture element missing: ${selector}`)
  }
  return found as HTMLElement
}

/** happy-dom implements scrollIntoView as a no-op; this records its arguments. */
function recordScrollIntoView(element: Element): unknown[] {
  const calls: unknown[] = []
  Object.defineProperty(element, "scrollIntoView", {
    configurable: true,
    value: (options: unknown) => {
      calls.push(options)
    },
  })
  return calls
}

function result(value: unknown): JsonObject {
  return value as JsonObject
}

/** The error a rejected action threw, typed for assertions on its message. */
async function rejection(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending
  } catch (error) {
    return error as Error
  }
  throw new Error("expected a rejection")
}

describe("click", () => {
  test("clicks the element and reports its identity", async () => {
    document.body.innerHTML = '<button id="go" class="primary wide">  Go now  </button>'
    const button = el("#go")
    const scrolls = recordScrollIntoView(button)
    let clicked = 0
    button.addEventListener("click", () => {
      clicked++
    })

    const page = fakePage()
    const pending = click({ selector: "#go" }, page)
    await page.advance(0)

    expect(result(await pending)).toEqual({
      selector: "#go",
      clicked: true,
      tagName: "button",
      text: "Go now",
      id: "go",
      className: "primary wide",
    })
    expect(clicked).toBe(1)
    expect(scrolls).toEqual([{ behavior: "smooth", block: "center" }])
  })

  test("reports null id and className and truncates the text at 100 characters", async () => {
    document.body.innerHTML = `<a href="/x">${"word ".repeat(40)}</a>`
    recordScrollIntoView(el("a"))

    const page = fakePage()
    const pending = click({ selector: "a" }, page)
    await page.advance(0)

    const value = result(await pending)
    expect(value.id).toBeNull()
    expect(value.className).toBeNull()
    expect((value.text as string).length).toBe(100)
  })

  test("waits for an element that appears later", async () => {
    const page = fakePage()
    const pending = click({ selector: "#late" }, page)
    page.setTimeout(() => {
      document.body.innerHTML = '<button id="late">later</button>'
      recordScrollIntoView(el("#late"))
    }, 250)

    await page.advance(1000)
    expect(result(await pending).clicked).toBe(true)
    expect(page.now()).toBeGreaterThanOrEqual(250)
  })

  test("fails immediately with suggestions when autoWait is off", async () => {
    document.body.innerHTML = '<button id="submit-button">Send</button>'
    const page = fakePage()
    stubLocation(page.window, "https://example.com/form")

    const pending = click({ selector: "#submit", autoWait: false }, page)
    await expect(pending).rejects.toThrow(errors.elementNotFound.replace("<selector>", "#submit"))
    const error = await rejection(pending)
    expect(error.message).toContain(errors.notFoundSuggestions)
    expect(error.message).toContain("#submit-button (Similar ID found)")
    expect(error.message).toContain("https://example.com/form")
    expect(page.pending()).toBe(0)
  })

  test("gives up at the wait timeout", async () => {
    const page = fakePage()
    const pending = click({ selector: "#never", waitTimeout: 1000 }, page)
    const settled = rejection(pending)
    await page.advance(2000)
    expect((await settled).message).toContain("Element not found: #never")
  })

  test("validates the selector", async () => {
    await expect(click({}, fakePage())).rejects.toThrow(errors.selectorRequired)
  })

  // pinned before text targeting is wired in, so the selector branch keeps its
  // messages once click grows a second way of naming a target
  test("keeps the selector-mode messages", async () => {
    await expect(click({ selector: "" }, fakePage())).rejects.toThrow(errors.selectorRequired)
    await expect(click({ selector: "   " }, fakePage())).rejects.toThrow(errors.selectorEmpty)
    await expect(click({ selector: `#${"a".repeat(1000)}` }, fakePage())).rejects.toThrow(
      errors.selectorTooLong,
    )
    await expect(click({ selector: "button[click" }, fakePage())).rejects.toThrow(
      errors.selectorInvalid.replace("<message>", ""),
    )
  })
})

describe("type", () => {
  test("sets the value through the native setter and fires input and change", async () => {
    document.body.innerHTML = '<input id="q" value="old">'
    const input = el("#q") as HTMLInputElement
    // a framework-style own property shadowing the prototype setter: reads pass
    // through, writes are swallowed, so only the native setter changes the value
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input) as object,
      "value",
    )
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => descriptor?.get?.call(input) as string,
      set: () => {
        /* swallowed, as a controlled input's own descriptor does */
      },
    })
    const seen: { type: string; value: string; inputType?: string }[] = []
    for (const name of ["input", "change"]) {
      input.addEventListener(name, (event) => {
        const target = event.target as HTMLInputElement
        seen.push({
          type: event.type,
          value: target.value,
          inputType: (event as InputEvent).inputType ?? undefined,
        })
      })
    }

    const page = fakePage()
    const pending = typeAction({ selector: "#q", text: "firefox-ctl" }, page)
    await page.advance(0)

    expect(result(await pending)).toEqual({
      selector: "#q",
      typed: "firefox-ctl",
      currentValue: "firefox-ctl",
    })
    expect(seen).toEqual([
      { type: "input", value: "firefox-ctl", inputType: "insertText" },
      { type: "change", value: "firefox-ctl", inputType: undefined },
    ])
  })

  test("appends to the current value when clear is false", async () => {
    document.body.innerHTML = '<textarea id="notes">ab</textarea>'
    const area = el("#notes") as HTMLTextAreaElement
    area.value = "ab"

    const page = fakePage()
    const pending = typeAction({ selector: "#notes", text: "cd", clear: false }, page)
    await page.advance(0)

    expect(result(await pending).currentValue).toBe("abcd")
    expect(area.value).toBe("abcd")
  })

  test("falls back to a direct assignment when no prototype setter is found", async () => {
    document.body.innerHTML = '<input id="q">'
    const page = { ...fakePage(), inputValueSetter: () => undefined }
    const pending = typeAction({ selector: "#q", text: "hi" }, page)
    await page.advance(0)

    expect(result(await pending).currentValue).toBe("hi")
    expect((el("#q") as HTMLInputElement).value).toBe("hi")
  })

  test("writes into a contenteditable element and fires input", async () => {
    document.body.innerHTML = '<div id="editor" contenteditable="true">old</div>'
    const editor = el("#editor")
    let inputs = 0
    editor.addEventListener("input", () => {
      inputs++
    })

    const page = fakePage()
    const pending = typeAction({ selector: "#editor", text: "new" }, page)
    await page.advance(0)

    expect(result(await pending)).toEqual({
      selector: "#editor",
      typed: "new",
      currentValue: "new",
    })
    expect(inputs).toBe(1)

    const appended = typeAction({ selector: "#editor", text: "er", clear: false }, page)
    await page.advance(0)
    expect(result(await appended).currentValue).toBe("newer")
  })

  test("rejects an element that cannot be edited", async () => {
    document.body.innerHTML = '<div id="plain">text</div>'
    const page = fakePage()
    const pending = typeAction({ selector: "#plain", text: "x" }, page)
    await expect(pending).rejects.toThrow("Element is not editable: #plain")
  })

  test("requires text", async () => {
    document.body.innerHTML = '<input id="q">'
    await expect(typeAction({ selector: "#q" }, fakePage())).rejects.toThrow("text is required")
  })

  test("reports a missing element with suggestions", async () => {
    document.body.innerHTML = '<input id="query">'
    const page = fakePage()
    const pending = typeAction({ selector: "#queyr", text: "x", autoWait: false }, page)
    const error = await rejection(pending)
    expect(error.message).toContain("Element not found: #queyr")
    expect(error.message).toContain(errors.notFoundHint)
  })
})

describe("pressKey", () => {
  interface Seen {
    type: string
    key: string
    code: string
    keyCode: number
    which: number
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
    metaKey: boolean
  }

  function record(target: EventTarget): Seen[] {
    const seen: Seen[] = []
    for (const name of ["keydown", "keypress", "keyup"]) {
      target.addEventListener(name, (event) => {
        const key = event as KeyboardEvent
        seen.push({
          type: key.type,
          key: key.key,
          code: key.code,
          keyCode: key.keyCode,
          which: key.which,
          ctrlKey: key.ctrlKey,
          shiftKey: key.shiftKey,
          altKey: key.altKey,
          metaKey: key.metaKey,
        })
      })
    }
    return seen
  }

  test("dispatches keydown, keypress and keyup for a single character", () => {
    document.body.innerHTML = '<input id="q">'
    const input = el("#q")
    const seen = record(input)

    const value = result(pressKey({ selector: "#q", key: "a" }, fakePage()))

    expect(value).toEqual({
      key: "a",
      selector: "#q",
      targetTag: "input",
      modifiers: { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false },
    })
    expect(seen.map((event) => event.type)).toEqual(["keydown", "keypress", "keyup"])
    expect(seen[0]?.code).toBe("KeyA")
    expect(seen[0]?.keyCode).toBe(65)
    expect(seen[0]?.which).toBe(65)
  })

  test("skips keypress for a named key and maps its code", () => {
    document.body.innerHTML = '<input id="q">'
    const seen = record(el("#q"))

    pressKey({ selector: "#q", key: "Enter" }, fakePage())

    expect(seen.map((event) => event.type)).toEqual(["keydown", "keyup"])
    expect(seen[0]?.code).toBe("Enter")
    expect(seen[0]?.keyCode).toBe(13)
  })

  test("maps the space key and passes the modifiers through", () => {
    document.body.innerHTML = '<input id="q">'
    const seen = record(el("#q"))

    const value = result(
      pressKey({ selector: "#q", key: " ", ctrlKey: true, shiftKey: true }, fakePage()),
    )

    expect(seen[0]?.code).toBe("Space")
    expect(seen[0]?.keyCode).toBe(32)
    expect(seen[0]?.ctrlKey).toBe(true)
    expect(seen[0]?.shiftKey).toBe(true)
    expect(seen[0]?.altKey).toBe(false)
    expect(value.modifiers).toEqual({
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    })
  })

  test("leaves an unknown named key unmapped", () => {
    document.body.innerHTML = '<input id="q">'
    const seen = record(el("#q"))

    pressKey({ selector: "#q", key: "F7" }, fakePage())

    expect(seen[0]?.code).toBe("F7")
    expect(seen[0]?.keyCode).toBe(0)
  })

  test("focuses the selector target", () => {
    document.body.innerHTML = '<input id="q">'
    let focused = 0
    Object.defineProperty(el("#q"), "focus", {
      configurable: true,
      value: () => {
        focused++
      },
    })

    pressKey({ selector: "#q", key: "a" }, fakePage())
    expect(focused).toBe(1)
  })

  test("falls back to the active element", () => {
    document.body.innerHTML = '<input id="q">'
    const input = el("#q") as HTMLInputElement
    input.focus()
    const seen = record(input)

    const value = result(pressKey({ key: "Tab" }, fakePage()))

    expect(value.selector).toBe("(active element)")
    expect(value.targetTag).toBe("input")
    expect(seen.map((event) => event.type)).toEqual(["keydown", "keyup"])
  })

  test("reports the active element for an empty selector", () => {
    document.body.innerHTML = '<input id="q">'
    const input = el("#q") as HTMLInputElement
    input.focus()

    const value = result(pressKey({ selector: "", key: "Tab" }, fakePage()))

    expect(value.selector).toBe("(active element)")
    expect(value.targetTag).toBe("input")
  })

  test("falls back to the body when nothing is focused", () => {
    document.body.innerHTML = "<p>idle</p>"
    const page = fakePage()
    Object.defineProperty(page.document, "activeElement", { configurable: true, value: null })
    const seen = record(document.body)

    expect(result(pressKey({ key: "Escape" }, page)).targetTag).toBe("body")
    expect(seen).toHaveLength(2)
  })

  test("requires a key", () => {
    expect(() => pressKey({}, fakePage())).toThrow("key is required")
    expect(() => pressKey({ key: "" }, fakePage())).toThrow("key is required")
  })

  test("reports a missing selector target without waiting", () => {
    document.body.innerHTML = '<input id="q">'
    expect(() => pressKey({ selector: "#absent", key: "a" }, fakePage())).toThrow(
      errors.elementNotFound.replace("<selector>", "#absent"),
    )
    expect(() => pressKey({ selector: "  ", key: "a" }, fakePage())).toThrow(errors.selectorEmpty)
  })
})
