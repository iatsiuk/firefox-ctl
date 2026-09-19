import { beforeEach, describe, expect, test } from "bun:test"

import type { Page } from "../src/content/page"
import {
  ACTIONABLE,
  findByText,
  normaliseText,
  resolveTarget,
  scopeRoot,
  TEXT_LIMIT,
  visibleText,
} from "../src/content/text-target"
import type { JsonValue } from "../src/protocol"
import { fakePage, stubRect, stubStyle } from "./dom"
import errors from "./fixtures/errors.json"

function el(selector: string): Element {
  const found = document.querySelector(selector)
  if (found === null) {
    throw new Error(`fixture element missing: ${selector}`)
  }
  return found
}

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

function mount(html: string, hidden: string[] = []): Page {
  document.body.innerHTML = html
  showAll(hidden)
  return fakePage()
}

function ids(elements: Element[]): string[] {
  return elements.map((element) => element.id || element.tagName.toLowerCase())
}

interface Seam {
  reads: number
}

/** Shadows `innerText` with a counting getter, answering `value` when given. */
function seamText(element: Element, value?: string): Seam {
  const seam: Seam = { reads: 0 }
  const original = (element as HTMLElement).innerText
  Object.defineProperty(element, "innerText", {
    configurable: true,
    get(): string {
      seam.reads += 1
      return value ?? original
    },
  })
  return seam
}

/** The seam the plan asks for on `visibleText`: a proxy answering `innerText`. */
function proxyText(element: Element, value: string): { proxy: Element; seam: Seam } {
  const seam: Seam = { reads: 0 }
  const proxy = new Proxy(element, {
    get(target, key: string | symbol): unknown {
      if (key === "innerText") {
        seam.reads += 1
        return value
      }
      const found = Reflect.get(target, key) as unknown
      return typeof found === "function" ? found.bind(target) : found
    },
  }) as Element
  return { proxy, seam }
}

beforeEach(() => {
  document.body.innerHTML = ""
})

describe("normaliseText", () => {
  test("collapses every run of whitespace to one space and trims", () => {
    expect(normaliseText("  Apply  \t\n now  ")).toBe("Apply now")
    expect(normaliseText("Save\r\n\r\nall")).toBe("Save all")
    expect(normaliseText(" ")).toBe("")
    expect(normaliseText("")).toBe("")
  })

  test("preserves case", () => {
    expect(normaliseText(" ApPly NOW ")).toBe("ApPly NOW")
  })
})

describe("visibleText", () => {
  test("normalises innerText of an HTML element", () => {
    mount('<p id="p">  Hello   world </p>')
    expect(visibleText(el("#p"))).toBe("Hello world")
  })

  test("falls back to textContent when the element has no innerText", () => {
    mount('<svg id="sv"><title id="ti">  Apply  now </title></svg>')
    const title = el("#ti")
    expect((title as Partial<HTMLElement>).innerText).toBeUndefined()
    expect(visibleText(title)).toBe("Apply now")
  })

  test("reads what the browser renders, not textContent", () => {
    mount('<button id="br">Applynow</button><button id="inline">ApXply</button>')
    const lineBreak = proxyText(el("#br"), "Apply\nnow")
    const hiddenInline = proxyText(el("#inline"), "Apply")
    expect(visibleText(lineBreak.proxy)).toBe("Apply now")
    expect(visibleText(hiddenInline.proxy)).toBe("Apply")
  })

  test("is case-sensitive, so text-transform changes what matches", () => {
    mount('<button id="up">Apply</button>')
    const transformed = proxyText(el("#up"), "APPLY")
    expect(visibleText(transformed.proxy)).toBe("APPLY")
    expect(visibleText(transformed.proxy)).not.toBe("Apply")
  })

  test("reads innerText once per call", () => {
    mount('<button id="b">Apply</button>')
    const { proxy, seam } = proxyText(el("#b"), "Apply")
    visibleText(proxy)
    expect(seam.reads).toBe(1)
  })
})

describe("findByText deepest", () => {
  test("returns the match without a matching descendant", () => {
    const page = mount('<div id="root"><span id="inner">Apply</span></div>')
    expect(ids(findByText(page, "Apply", el("#root"), "deepest"))).toEqual(["inner"])
  })

  test("matches the root itself", () => {
    const page = mount('<div id="root">Apply</div>')
    expect(ids(findByText(page, "Apply", el("#root"), "deepest"))).toEqual(["root"])
  })

  test("skips display: none", () => {
    const page = mount('<div id="root"><p id="other">Other</p><span id="s">Apply</span></div>')
    stubStyle(el("#s"), { display: "none" })
    expect(findByText(page, "Apply", el("#root"), "deepest")).toEqual([])
  })

  test("skips a zero box", () => {
    const page = mount('<div id="root"><p id="other">Other</p><span id="s">Apply</span></div>', [
      "#s",
    ])
    expect(findByText(page, "Apply", el("#root"), "deepest")).toEqual([])
  })

  test("skips visibility: hidden on the element", () => {
    const page = mount(
      '<div id="root"><p id="other">Other</p><span id="s" style="visibility: hidden">Apply</span></div>',
    )
    expect(findByText(page, "Apply", el("#root"), "deepest")).toEqual([])
  })

  test("skips visibility: hidden inherited from an ancestor", () => {
    const page = mount(
      '<div id="root"><p id="other">Other</p><div id="veil" style="visibility: hidden"><span id="s">Apply</span></div></div>',
    )
    expect(findByText(page, "Apply", el("#root"), "deepest")).toEqual([])
  })

  test("keeps an element that sets visibility: visible under a hidden ancestor", () => {
    const page = mount(
      '<div id="root"><p id="other">Other</p><div id="veil" style="visibility: hidden"><span id="s" style="visibility: visible">Apply</span></div></div>',
    )
    expect(ids(findByText(page, "Apply", el("#root"), "deepest"))).toEqual(["s"])
  })

  test("never matches inside script, style, noscript or template", () => {
    const page = mount(
      '<div id="root"><script id="sc">Apply</script><style id="st">Apply</style>' +
        '<noscript id="ns"><span id="nsi">Apply</span></noscript>' +
        '<template id="tp">Apply</template></div>',
    )
    // happy-dom already drops script and style from innerText; pin the root so
    // only the excluded subtrees could answer the query
    seamText(el("#root"), "Other")
    seamText(el("#tp"), "Apply")
    expect(findByText(page, "Apply", el("#root"), "deepest")).toEqual([])
  })

  test("matches nothing when the root itself is an excluded element", () => {
    const page = mount('<script id="sc">Apply</script>')
    seamText(el("#sc"), "Apply")
    expect(findByText(page, "Apply", el("#sc"), "deepest")).toEqual([])
  })

  test("returns every sibling match", () => {
    const page = mount('<div id="root"><span id="a">Apply</span><span id="b">Apply</span></div>')
    seamText(el("#root"), "Apply")
    expect(ids(findByText(page, "Apply", el("#root"), "deepest"))).toEqual(["a", "b"])
  })

  test("finds a match placed after two hundred unrelated elements", () => {
    const filler = Array.from({ length: 200 }, (_, index) => `<div>filler ${index}</div>`).join("")
    const page = mount(`<div id="root">${filler}<span id="late">Apply</span></div>`)
    expect(ids(findByText(page, "Apply", el("#root"), "deepest"))).toEqual(["late"])
  })
})

describe("findByText actionable", () => {
  test("lists the documented actionable elements", () => {
    expect(ACTIONABLE).toBe(
      "button, a[href], input[type=button], input[type=submit], [role=button], summary, label",
    )
  })

  test("maps a match to its nearest actionable ancestor-or-self", () => {
    const page = mount('<div id="root"><button id="b"><span id="s">Apply</span></button></div>')
    expect(ids(findByText(page, "Apply", el("#root"), "actionable"))).toEqual(["b"])
  })

  test("rejects an actionable whose own text is longer than the query", () => {
    const page = mount(
      '<div id="root"><button id="b"><span id="s">Apply</span> changes</button></div>',
    )
    expect(findByText(page, "Apply", el("#root"), "actionable")).toEqual([])
  })

  test("rejects an invisible actionable ancestor", () => {
    const page = mount('<div id="root"><button id="b"><span id="s">Apply</span></button></div>', [
      "#b",
    ])
    expect(findByText(page, "Apply", el("#root"), "actionable")).toEqual([])
  })

  test("deduplicates two matches sharing one actionable ancestor", () => {
    const page = mount(
      '<div id="root"><button id="b"><span id="s1">Apply</span><span id="s2">Apply</span></button></div>',
    )
    seamText(el("#b"), "Apply")
    expect(ids(findByText(page, "Apply", el("#root"), "actionable"))).toEqual(["b"])
  })

  test("returns one target per sibling actionable", () => {
    const page = mount(
      '<div id="root"><button id="b1">Apply</button><button id="b2">Apply</button></div>',
    )
    seamText(el("#root"), "Apply")
    expect(ids(findByText(page, "Apply", el("#root"), "actionable"))).toEqual(["b1", "b2"])
  })

  test("returns nothing when the actionable ancestor lies outside the root", () => {
    const page = mount('<button id="b"><div id="root"><span id="s">Apply</span></div></button>')
    expect(findByText(page, "Apply", el("#root"), "actionable")).toEqual([])
  })

  test("returns the inner actionable of a nested pair", () => {
    const page = mount('<div id="root"><a id="a" href="/x"><button id="b">Apply</button></a></div>')
    expect(ids(findByText(page, "Apply", el("#root"), "actionable"))).toEqual(["b"])
  })

  test("ignores a submit value and an aria-label, neither is visible text", () => {
    const page = mount(
      '<div id="root"><input id="sub" type="submit" value="Apply">' +
        '<button id="lab" aria-label="Apply"></button></div>',
    )
    expect(findByText(page, "Apply", el("#root"), "actionable")).toEqual([])
  })

  test("accepts a label, a summary and a role=button", () => {
    const page = mount(
      '<div id="root"><label id="lb"><span id="s1">Apply</span></label>' +
        '<details><summary id="sm"><span id="s2">Apply</span></summary></details>' +
        '<div id="rb" role="button"><span id="s3">Apply</span></div></div>',
    )
    expect(ids(findByText(page, "Apply", el("#root"), "actionable"))).toEqual(["lb", "sm", "rb"])
  })
})

describe("findByText cost", () => {
  test("reads the visible text of an element at most once per call", () => {
    const page = mount(
      '<div id="root"><div id="mid"><button id="b"><span id="s">Apply</span></button></div></div>',
    )
    const seams = ["#root", "#mid", "#b", "#s"].map((selector) => seamText(el(selector)))
    findByText(page, "Apply", el("#root"), "actionable")
    for (const seam of seams) {
      expect(seam.reads).toBeLessThanOrEqual(1)
    }
  })

  test("reads innerText once for every element with a box and never for the others", () => {
    const rows = Array.from(
      { length: 300 },
      (_, index) => `<div id="r${index}">row ${index}</div>`,
    ).join("")
    const page = mount(`<div id="root">${rows}</div>`, ["#r7", "#r99"])
    const seams = new Map<string, Seam>()
    for (const selector of ["#root", ...Array.from({ length: 300 }, (_, i) => `#r${i}`)]) {
      seams.set(selector, seamText(el(selector)))
    }
    expect(ids(findByText(page, "row 42", el("#root"), "deepest"))).toEqual(["r42"])
    expect(seams.get("#r7")?.reads).toBe(0)
    expect(seams.get("#r99")?.reads).toBe(0)
    expect(seams.get("#r42")?.reads).toBe(1)
    expect(seams.get("#root")?.reads).toBe(1)
    const boxed = Array.from(seams.entries()).filter(
      ([selector]) => selector !== "#r7" && selector !== "#r99",
    )
    expect(boxed.every(([, seam]) => seam.reads === 1)).toBe(true)
  })
})

describe("resolveTarget", () => {
  const page = (): Page => {
    document.body.innerHTML = ""
    return fakePage()
  }

  test("answers selector mode with the raw value, unvalidated", () => {
    expect(resolveTarget(page(), { selector: "#go" })).toEqual({
      mode: "selector",
      selector: "#go",
    })
    expect(resolveTarget(page(), { selector: "" })).toEqual({ mode: "selector", selector: "" })
    expect(resolveTarget(page(), { selector: "div[raw" })).toEqual({
      mode: "selector",
      selector: "div[raw",
    })
  })

  test("answers text mode with the normalised text and a null scope", () => {
    expect(resolveTarget(page(), { text: "  Apply   now " })).toEqual({
      mode: "text",
      text: "Apply now",
      scope: null,
    })
  })

  test("answers text mode with the scope selector", () => {
    expect(resolveTarget(page(), { text: "Apply", scope: "#dialog" })).toEqual({
      mode: "text",
      text: "Apply",
      scope: "#dialog",
    })
  })

  test("refuses selector and text together, by presence not truthiness", () => {
    expect(() => resolveTarget(page(), { selector: "#go", text: "Apply" })).toThrow(
      errors.targetExclusive,
    )
    expect(() => resolveTarget(page(), { selector: "", text: "Apply" })).toThrow(
      errors.targetExclusive,
    )
    expect(() => resolveTarget(page(), { selector: "#go", text: "" })).toThrow(
      errors.targetExclusive,
    )
  })

  test("requires a selector when nothing identifies a target", () => {
    expect(() => resolveTarget(page(), {})).toThrow(errors.selectorRequired)
  })

  test("refuses a scope without text", () => {
    expect(() => resolveTarget(page(), { scope: "#dialog" })).toThrow(errors.scopeRequiresText)
    expect(() => resolveTarget(page(), { selector: "#go", scope: "#dialog" })).toThrow(
      errors.scopeRequiresText,
    )
  })

  test("requires text to be a string", () => {
    for (const text of [null, 1, true, [], {}] as JsonValue[]) {
      expect(() => resolveTarget(page(), { text })).toThrow(errors.textNotString)
    }
  })

  test("refuses text that is empty after normalisation", () => {
    expect(() => resolveTarget(page(), { text: "" })).toThrow(errors.textEmpty)
    expect(() => resolveTarget(page(), { text: " \t\n " })).toThrow(errors.textEmpty)
  })

  test("caps the raw text at the exported limit", () => {
    expect(TEXT_LIMIT).toBe(500)
    expect(() => resolveTarget(page(), { text: "a".repeat(TEXT_LIMIT + 1) })).toThrow(
      errors.textTooLong,
    )
    expect(resolveTarget(page(), { text: "a".repeat(TEXT_LIMIT) })).toEqual({
      mode: "text",
      text: "a".repeat(TEXT_LIMIT),
      scope: null,
    })
  })

  test("requires the scope to be a string", () => {
    for (const scope of [null, 1, true, [], {}] as JsonValue[]) {
      expect(() => resolveTarget(page(), { text: "Apply", scope })).toThrow(errors.scopeNotString)
    }
  })

  test("refuses an empty or whitespace-only scope before validating it", () => {
    expect(() => resolveTarget(page(), { text: "Apply", scope: "" })).toThrow(errors.scopeEmpty)
    expect(() => resolveTarget(page(), { text: "Apply", scope: "   " })).toThrow(errors.scopeEmpty)
  })

  // happy-dom memoises a selector string on the shared document, so an invalid
  // selector throws only the first time it is parsed in the process: every
  // suite pinning `selectorInvalid` uses a string of its own
  test("validates the scope as a selector", () => {
    expect(() => resolveTarget(page(), { text: "Apply", scope: `#${"a".repeat(1000)}` })).toThrow(
      errors.selectorTooLong,
    )
    expect(() => resolveTarget(page(), { text: "Apply", scope: "div[scope" })).toThrow(
      errors.selectorInvalid.replace("<message>", ""),
    )
  })

  test("applies exclusivity, then scope-requires-text, then text, then scope", () => {
    expect(() => resolveTarget(page(), { selector: "#go", text: 1, scope: 2 })).toThrow(
      errors.targetExclusive,
    )
    expect(() => resolveTarget(page(), { selector: "#go", scope: 2 })).toThrow(
      errors.scopeRequiresText,
    )
    expect(() => resolveTarget(page(), { text: 1, scope: 2 })).toThrow(errors.textNotString)
    expect(() => resolveTarget(page(), { text: "Apply", scope: 2 })).toThrow(errors.scopeNotString)
  })
})

describe("scopeRoot", () => {
  test("answers the document element for a null scope", () => {
    const page = mount('<div id="a">Apply</div>')
    expect(scopeRoot(page, null)).toBe(document.documentElement)
  })

  test("answers the single element a scope selector matches", () => {
    const page = mount('<div id="dialog"><button id="b">Apply</button></div>')
    expect(scopeRoot(page, "#dialog")).toBe(el("#dialog"))
  })

  test("refuses a scope matching nothing", () => {
    const page = mount('<div id="dialog">Apply</div>')
    expect(() => scopeRoot(page, "#missing")).toThrow(
      errors.scopeNotFound.replace("<scope>", "#missing"),
    )
  })

  test("refuses a scope matching more than one element", () => {
    const page = mount('<div class="row">a</div><div class="row">b</div>')
    expect(() => scopeRoot(page, ".row")).toThrow(
      errors.scopeAmbiguous.replace("<scope>", ".row").replace("<n>", "2"),
    )
  })
})
