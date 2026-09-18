import { beforeEach, describe, expect, test } from "bun:test"

import {
  classTokens,
  looksGenerated,
  SelectorUnavailable,
  uniqueSelector,
} from "../src/content/unique-selector"
import { assertResolves, fakePage, seamPage } from "./dom"

beforeEach(() => {
  document.body.innerHTML = ""
})

function el(selector: string): Element {
  const found = document.querySelector(selector)
  if (found === null) {
    throw new Error(`fixture element missing: ${selector}`)
  }
  return found
}

/** The generated selector, checked against the contract before it is compared. */
function resolved(page: ReturnType<typeof fakePage>, element: Element): string {
  const selector = uniqueSelector(page, element)
  assertResolves(page, selector, element)
  return selector
}

describe("uniqueSelector candidate order", () => {
  test("prefers data-testid over aria-label, id, classes and the path", () => {
    document.body.innerHTML =
      '<button data-testid="save" id="go" aria-label="Go" class="btn primary">Go</button>'
    const page = fakePage()
    expect(resolved(page, el("#go"))).toBe('[data-testid="save"]')
  })

  test("uses aria-label when the data-testid is shared", () => {
    document.body.innerHTML =
      '<button data-testid="dup" id="go" aria-label="Go" class="btn">a</button>' +
      '<button data-testid="dup">b</button>'
    const page = fakePage()
    expect(resolved(page, el("#go"))).toBe('[aria-label="Go"]')
  })

  test("uses the id when data-testid and aria-label are shared", () => {
    document.body.innerHTML =
      '<button data-testid="dup" id="go" aria-label="Go" class="btn">a</button>' +
      '<button data-testid="dup" aria-label="Go" class="btn">b</button>'
    const page = fakePage()
    expect(resolved(page, el("#go"))).toBe("#go")
  })

  test("uses the class combination when the id is shared too", () => {
    document.body.innerHTML =
      '<button data-testid="dup" id="go" aria-label="Go" class="btn primary">a</button>' +
      '<button data-testid="dup" id="go" aria-label="Go" class="btn">b</button>'
    const page = fakePage()
    expect(resolved(page, el(".primary"))).toBe(".btn.primary")
  })

  test("falls back to the path when every attribute is shared", () => {
    document.body.innerHTML =
      '<button data-testid="dup" id="go" aria-label="Go" class="btn">a</button>' +
      '<button data-testid="dup" id="go" aria-label="Go" class="btn">b</button>'
    const page = fakePage()
    const buttons = document.querySelectorAll("button")
    expect(resolved(page, buttons[1] as Element)).toBe("body > button:nth-of-type(2)")
  })
})

describe("uniqueSelector verification", () => {
  test("rejects a candidate that matches a single other element", () => {
    document.body.innerHTML = '<div data-testid="t" class="only">a</div><div class="other">b</div>'
    const target = el(".only")
    const other = el(".other")
    const page = seamPage(fakePage(), (selector) =>
      selector === '[data-testid="t"]' ? [other] : undefined,
    )
    expect(uniqueSelector(page, target)).toBe(".only")
    expect(page.queries).toContain('[data-testid="t"]')
  })

  test("rejects a candidate that matches the element among others", () => {
    document.body.innerHTML = '<div data-testid="t" class="only">a</div><div class="other">b</div>'
    const target = el(".only")
    const other = el(".other")
    const page = seamPage(fakePage(), (selector) =>
      selector === '[data-testid="t"]' ? [target, other] : undefined,
    )
    expect(uniqueSelector(page, target)).toBe(".only")
  })

  test("rejects a candidate that matches nothing", () => {
    document.body.innerHTML = '<div data-testid="t" class="only">a</div>'
    const target = el(".only")
    const page = seamPage(fakePage(), (selector) =>
      selector === '[data-testid="t"]' ? [] : undefined,
    )
    expect(uniqueSelector(page, target)).toBe(".only")
  })

  test("verifies the path like every other candidate", () => {
    document.body.innerHTML = "<div><span>x</span></div>"
    const target = el("span")
    const page = seamPage(fakePage(), () => [])
    expect(() => uniqueSelector(page, target)).toThrow(SelectorUnavailable)
  })
})

describe("looksGenerated", () => {
  test("demotes digit-only, hex-run and numeric-suffix ids", () => {
    expect(looksGenerated("12345")).toBe(true)
    expect(looksGenerated("x1a2b3c")).toBe(true)
    expect(looksGenerated("item-42")).toBe(true)
    // heuristic noise: ordinary words that happen to be hexadecimal
    expect(looksGenerated("feedback")).toBe(true)
    expect(looksGenerated("decade")).toBe(true)
  })

  test("keeps ids with a shorter hex run", () => {
    expect(looksGenerated("faced")).toBe(false)
    expect(looksGenerated("save-button")).toBe(false)
  })

  test("a generated-looking id loses to a unique class combination", () => {
    document.body.innerHTML =
      '<button id="item-42" class="btn primary">a</button><button class="btn">b</button>'
    const page = fakePage()
    expect(resolved(page, el("#item-42"))).toBe(".btn.primary")
  })

  test("a generated-looking id still beats the path", () => {
    document.body.innerHTML =
      '<button id="item-42" class="btn">a</button><button class="btn">b</button>'
    const page = fakePage()
    expect(resolved(page, el("#item-42"))).toBe("#item-42")
  })

  test("an ordinary id beats a unique class combination", () => {
    document.body.innerHTML =
      '<button id="save-button" class="btn primary">a</button><button class="btn">b</button>'
    const page = fakePage()
    expect(resolved(page, el("#save-button"))).toBe("#save-button")
  })
})

describe("uniqueSelector escaping", () => {
  test("escapes an id containing a colon", () => {
    document.body.innerHTML = '<div id="menu:main">x</div>'
    const page = fakePage()
    expect(resolved(page, el("div"))).toBe("#menu\\:main")
  })

  test("escapes an id starting with a digit", () => {
    document.body.innerHTML = '<div id="1top">x</div>'
    const target = el("div")
    // happy-dom does not resolve a `\31 ` identifier the way Firefox does, so
    // the serialised candidate and its acceptance are asserted through the seam
    const page = seamPage(fakePage(), (selector) =>
      selector === "#\\31 top" ? [target] : undefined,
    )
    expect(uniqueSelector(page, target)).toBe("#\\31 top")
  })

  test("escapes class tokens and skips pseudo-class utilities", () => {
    document.body.innerHTML = '<div class="hover:bg-red w-1/2">x</div><div class="other">y</div>'
    const page = fakePage()
    expect(resolved(page, el(".other + div, div"))).toBe(".w-1\\/2")
  })

  test("splits class tokens and drops the ones carrying a colon", () => {
    document.body.innerHTML = '<div class="  a  hover:b  c ">x</div>'
    expect(classTokens(el("div"))).toEqual(["a", "c"])
  })

  test("reports no class tokens for an element without a string class", () => {
    document.body.innerHTML = "<div>x</div>"
    expect(classTokens(el("div"))).toEqual([])
  })

  const attributeCases = [
    { name: "a double quote", value: 'say "hi"', escaped: 'say \\"hi\\"' },
    { name: "a backslash", value: "a\\b", escaped: "a\\\\b" },
    { name: "a line feed", value: "a\nb", escaped: "a\\a b" },
    { name: "a carriage return", value: "a\rb", escaped: "a\\d b" },
    { name: "a form feed", value: "a\fb", escaped: "a\\c b" },
  ]

  for (const item of attributeCases) {
    test(`writes a data-testid containing ${item.name} as a CSS string`, () => {
      document.body.innerHTML = "<div>x</div>"
      const target = el("div")
      target.setAttribute("data-testid", item.value)
      const expected = `[data-testid="${item.escaped}"]`
      // happy-dom's parser rejects these strings, so the seam answers them
      const page = seamPage(fakePage(), (selector) =>
        selector === expected ? [target] : undefined,
      )
      expect(uniqueSelector(page, target)).toBe(expected)
    })

    test(`writes an aria-label containing ${item.name} as a CSS string`, () => {
      document.body.innerHTML = "<div>x</div>"
      const target = el("div")
      target.setAttribute("aria-label", item.value)
      const expected = `[aria-label="${item.escaped}"]`
      const page = seamPage(fakePage(), (selector) =>
        selector === expected ? [target] : undefined,
      )
      expect(uniqueSelector(page, target)).toBe(expected)
    })
  }
})

describe("uniqueSelector paths", () => {
  test("describes the body and the document element", () => {
    document.body.innerHTML = "<p>x</p>"
    const page = fakePage()
    expect(resolved(page, document.body)).toBe("body")
    const root = document.documentElement
    expect(uniqueSelector(page, root)).toBe("html")
    assertResolves(page, "html", root)
  })

  test("roots a path at the body and numbers identical siblings", () => {
    document.body.innerHTML =
      "<div><div><span>one</span></div></div><div><div><span>two</span></div></div>"
    const page = fakePage()
    const spans = document.querySelectorAll("span")
    expect(resolved(page, spans[0] as Element)).toBe("body > div:nth-of-type(1) > div > span")
    expect(resolved(page, spans[1] as Element)).toBe("body > div:nth-of-type(2) > div > span")
  })

  test("keeps the path when an escaped candidate is syntactically invalid", () => {
    document.body.innerHTML = '<div><span class="a">x</span></div>'
    const page = { ...fakePage(), cssEscape: (value: string) => value.replace("a", "[") }
    expect(resolved(page, el("span"))).toBe("body > div > span")
  })
})

describe("uniqueSelector failures", () => {
  test("throws for a detached element", () => {
    const detached = document.createElement("div")
    const page = fakePage()
    expect(() => uniqueSelector(page, detached)).toThrow(
      new SelectorUnavailable("no unique selector for div"),
    )
  })

  test("throws for an element inside a shadow root", () => {
    document.body.innerHTML = "<div id=host></div>"
    const host = el("#host")
    const shadow = host.attachShadow({ mode: "open" })
    shadow.innerHTML = "<span>x</span>"
    const inner = shadow.querySelector("span")
    if (inner === null) {
      throw new Error("fixture element missing: shadow span")
    }
    const page = fakePage()
    expect(() => uniqueSelector(page, inner)).toThrow(SelectorUnavailable)
    expect(() => uniqueSelector(page, inner)).toThrow("no unique selector for span")
  })

  test("SelectorUnavailable is an Error", () => {
    expect(new SelectorUnavailable("x")).toBeInstanceOf(Error)
  })
})
