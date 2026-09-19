import { beforeEach, describe, expect, test } from "bun:test"

import { click, pressKey, type as typeAction } from "../src/content/interact"
import type { JsonObject } from "../src/protocol"
import { assertResolves, type FakePage, fakePage, seamPage, stubLocation, stubRect } from "./dom"
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
      matchedBy: "selector",
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

/** happy-dom has no layout: every element gets a box unless listed in `hidden`. */
function showAll(hidden: string[] = []): void {
  const invisible = new Set<Element>()
  for (const selector of hidden) {
    for (const target of document.querySelectorAll(selector)) {
      invisible.add(target)
    }
  }
  for (const target of document.querySelectorAll("*")) {
    stubRect(target, invisible.has(target) ? {} : { width: 100, height: 20 })
  }
}

/** A page whose every element is visible, the state a text search needs. */
function mount(html: string, hidden: string[] = []): FakePage {
  document.body.innerHTML = html
  showAll(hidden)
  return fakePage()
}

/** Counts the click events one element receives. */
function counter(element: Element): () => number {
  let seen = 0
  element.addEventListener("click", () => {
    seen++
  })
  return () => seen
}

describe("click by text", () => {
  test("clicks the element whose visible text matches", async () => {
    const page = mount(
      '<button id="apply" class="primary">Apply</button><button id="x">Cancel</button>',
    )
    const clicks = counter(el("#apply"))

    const pending = click({ text: "Apply" }, page)
    await page.advance(0)

    const value = result(await pending)
    expect(value).toEqual({
      selector: "#apply",
      clicked: true,
      tagName: "button",
      text: "Apply",
      id: "apply",
      className: "primary",
      matchedBy: "text",
    })
    assertResolves(page, value.selector as string, el("#apply"))
    expect(clicks()).toBe(1)
  })

  test("clicks the nearest actionable ancestor once", async () => {
    const page = mount('<div id="wrap"><button id="apply"><span>Apply</span></button></div>')
    const onButton = counter(el("#apply"))
    const onWrap = counter(el("#wrap"))

    const pending = click({ text: "Apply" }, page)
    await page.advance(0)

    expect(result(await pending).tagName).toBe("button")
    expect(onButton()).toBe(1)
    // the wrapper sees the same event bubble, never a second click
    expect(onWrap()).toBe(1)
  })

  test("refuses to guess between two matches, at once and without clicking", async () => {
    const page = mount('<button id="a">Apply</button><button id="b">Apply</button>')
    const first = counter(el("#a"))
    const second = counter(el("#b"))

    const error = await rejection(click({ text: "Apply" }, page))

    expect(error.message).toBe(errors.ambiguousText)
    expect(first()).toBe(0)
    expect(second()).toBe(0)
    assertResolves(page, "#a", el("#a"))
    assertResolves(page, "#b", el("#b"))
    // autoWait is on, yet nothing was scheduled and no time passed
    expect(page.now()).toBe(0)
    expect(page.pending()).toBe(0)
  })

  test("lists five candidates and counts the rest", async () => {
    const buttons = Array.from({ length: 7 }, (_, index) => `<button id="b${index}">Apply</button>`)
    const page = mount(buttons.join(""))

    const error = await rejection(click({ text: "Apply" }, page))

    expect(error.message).toBe(
      'AMBIGUOUS_TEXT: "Apply" matches 7 elements: #b0, #b1, #b2, #b3, #b4, and 2 more',
    )
  })

  test("names a candidate the generator cannot describe", async () => {
    const base = mount('<button id="a">Apply</button><button class="ghost">Apply</button>')
    // every query but the verified `#a` answers two elements, so nothing
    // describes the second button uniquely
    const page = seamPage(base, (selector) =>
      selector === "#a" ? undefined : [el("#a"), el(".ghost")],
    )

    const error = await rejection(click({ text: "Apply" }, page))

    expect(error.message).toBe(
      'AMBIGUOUS_TEXT: "Apply" matches 2 elements: #a, <button (no unique selector)>',
    )
  })

  test("narrows the search to the scope", async () => {
    const page = mount(
      '<div id="dialog"><button id="in">Apply</button></div><button id="out">Apply</button>',
    )
    const inside = counter(el("#in"))
    const outside = counter(el("#out"))

    const pending = click({ text: "Apply", scope: "#dialog" }, page)
    await page.advance(0)

    expect(result(await pending).selector).toBe("#in")
    expect(inside()).toBe(1)
    expect(outside()).toBe(0)
  })

  test("keeps the scope errors", async () => {
    const page = mount(
      '<button id="a">Apply</button><div class="box"></div><div class="box"></div>',
    )

    await expect(click({ text: "Apply", scope: "#none" }, page)).rejects.toThrow(
      errors.scopeNotFound.replace("<scope>", "#none"),
    )
    await expect(click({ text: "Apply", scope: ".box" }, page)).rejects.toThrow(
      errors.scopeAmbiguous.replace("<scope>", ".box").replace("<n>", "2"),
    )
    await expect(click({ text: "Apply", scope: "   " }, page)).rejects.toThrow(errors.scopeEmpty)
    await expect(click({ scope: "#a" }, page)).rejects.toThrow(errors.scopeRequiresText)
  })

  test("ignores a match whose actionable ancestor is outside the scope", async () => {
    const page = mount('<a href="/x"><span id="scope"><span>Apply</span></span></a>')

    const error = await rejection(click({ text: "Apply", scope: "#scope", autoWait: false }, page))

    expect(error.message).toContain(errors.elementNotFoundText.replace("<text>", "Apply"))
  })

  test("re-resolves the scope at every probe", async () => {
    const page = mount('<div id="dialog"><span>Loading</span></div>')
    let clicks = 0
    const pending = click({ text: "Apply", scope: "#dialog", waitTimeout: 2000 }, page)
    page.setTimeout(() => {
      el("#dialog").remove()
      const fresh = document.createElement("div")
      fresh.id = "dialog"
      fresh.innerHTML = '<button id="fresh">Apply</button>'
      document.body.append(fresh)
      showAll()
      clicks = 0
      el("#fresh").addEventListener("click", () => {
        clicks++
      })
    }, 150)

    await page.advance(2000)

    expect(result(await pending).selector).toBe("#fresh")
    expect(clicks).toBe(1)
  })

  test("fails when the scope disappears while waiting", async () => {
    const page = mount('<div id="dialog"><span>Loading</span></div>')
    const settled = rejection(click({ text: "Apply", scope: "#dialog", waitTimeout: 2000 }, page))
    page.setTimeout(() => {
      el("#dialog").remove()
    }, 150)

    await page.advance(2000)

    expect((await settled).message).toBe(errors.scopeNotFound.replace("<scope>", "#dialog"))
  })

  test("never clicks a target detached during the frame wait", async () => {
    const page = mount('<button id="apply">Apply</button>')
    const button = el("#apply")
    const clicks = counter(button)
    // the scroll is the last thing before the frame wait: the fixture removes
    // the button there, so it is gone by the time the frame resolves
    Object.defineProperty(button, "scrollIntoView", {
      configurable: true,
      value: () => {
        button.remove()
      },
    })

    const settled = rejection(click({ text: "Apply", waitTimeout: 500 }, page))
    await page.advance(1000)

    expect((await settled).message).toContain(errors.elementNotFoundText.replace("<text>", "Apply"))
    expect(clicks()).toBe(0)
  })

  test("fails at once when a target detaches during the frame wait with autoWait off", async () => {
    const page = mount('<button id="apply">Apply</button>')
    const button = el("#apply")
    const clicks = counter(button)
    Object.defineProperty(button, "scrollIntoView", {
      configurable: true,
      value: () => {
        button.remove()
      },
    })

    const settled = rejection(click({ text: "Apply", autoWait: false }, page))
    await page.advance(0)

    expect((await settled).message).toContain(errors.elementNotFoundText.replace("<text>", "Apply"))
    expect(clicks()).toBe(0)
  })

  test("recovers when a fresh match replaces a target that detaches mid-wait", async () => {
    const page = mount('<button id="apply">Apply</button>')
    const original = el("#apply")
    const originalClicks = counter(original)
    let freshClicks = 0
    Object.defineProperty(original, "scrollIntoView", {
      configurable: true,
      value: () => {
        original.remove()
        const fresh = document.createElement("button")
        fresh.id = "fresh"
        fresh.textContent = "Apply"
        document.body.append(fresh)
        showAll()
        fresh.addEventListener("click", () => {
          freshClicks++
        })
      },
    })

    const pending = click({ text: "Apply", waitTimeout: 2000 }, page)
    await page.advance(2000)

    expect(result(await pending).selector).toBe("#fresh")
    expect(freshClicks).toBe(1)
    expect(originalClicks()).toBe(0)
  })

  test("waits for text that appears later", async () => {
    const page = mount("")
    let clicks = 0
    const pending = click({ text: "Apply" }, page)
    page.setTimeout(() => {
      document.body.innerHTML = '<button id="late">Apply</button>'
      showAll()
      el("#late").addEventListener("click", () => {
        clicks++
      })
    }, 200)

    await page.advance(1000)

    expect(result(await pending).selector).toBe("#late")
    expect(clicks).toBe(1)
    expect(page.now()).toBeGreaterThanOrEqual(200)
  })

  test("gives up at the wait timeout with the text diagnostics", async () => {
    const page = mount('<button id="near">Apply changes</button>')
    stubLocation(page.window, "https://example.com/form")

    const settled = rejection(click({ text: "Apply", waitTimeout: 1000 }, page))
    await page.advance(2000)

    const message = (await settled).message
    expect(message).toContain(errors.elementNotFoundText.replace("<text>", "Apply"))
    expect(message).toContain(errors.notFoundSuggestions)
    expect(message).toContain('#near (Button: "Apply changes")')
    expect(message).toContain(errors.notFoundContext)
  })

  test("fails at once with autoWait off or a zero timeout", async () => {
    const page = mount('<button id="other">Cancel</button>')
    const notFound = errors.elementNotFoundText.replace("<text>", "Apply")

    await expect(click({ text: "Apply", autoWait: false }, page)).rejects.toThrow(notFound)
    await expect(click({ text: "Apply", waitTimeout: 0 }, page)).rejects.toThrow(notFound)

    expect(page.now()).toBe(0)
    expect(page.pending()).toBe(0)
  })

  test("answers a null selector when the generator cannot describe the target", async () => {
    const base = mount('<button class="ghost">Apply</button>')
    const clicks = counter(el(".ghost"))
    const page = seamPage(base, () => [el(".ghost"), document.body])

    const pending = click({ text: "Apply" }, page)
    await base.advance(0)

    expect(result(await pending)).toMatchObject({
      selector: null,
      clicked: true,
      tagName: "button",
      matchedBy: "text",
    })
    expect(clicks()).toBe(1)
  })

  test("refuses selector and text together before any lookup", async () => {
    const page = mount('<button id="go">Apply</button>')

    await expect(click({ selector: "#go", text: "Apply" }, page)).rejects.toThrow(
      errors.targetExclusive,
    )
  })
})

describe("type", () => {
  // `text` names what to type here, never a target, so the exclusivity rule of
  // click must never reach this action
  test("types when selector and text are both given", async () => {
    document.body.innerHTML = '<input id="field">'
    const page = fakePage()

    const pending = typeAction({ selector: "#field", text: "hello" }, page)
    await page.advance(0)

    expect(result(await pending)).toMatchObject({ selector: "#field", typed: "hello" })
    expect((el("#field") as HTMLInputElement).value).toBe("hello")
  })

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
