import { beforeEach, describe, expect, test } from "bun:test"

import type { Page } from "../src/content/page"
import {
  getAccessibilitySnapshot,
  getContent,
  getElementInfo,
  getPageState,
} from "../src/content/read"
import type { JsonValue } from "../src/protocol"
import {
  assertResolves,
  fakePage,
  seamPage,
  stubLocation,
  stubRect,
  stubScroll,
  stubStyle,
  stubViewport,
} from "./dom"
import errors from "./fixtures/errors.json"
import a11yFixture from "./fixtures/results/getAccessibilitySnapshot.json"
import contentFixture from "./fixtures/results/getContent.json"
import elementInfoFixture from "./fixtures/results/getElementInfo.json"
import pageStateFixture from "./fixtures/results/getPageState.json"

// a nested JSON import infers optional-undefined unions; the fixture is plain JSON
const a11yExpected = a11yFixture as unknown as JsonValue

// One page behind all four fixtures, so the pinned results describe the same
// document: a heading, a visible and an invisible link, a form with a masked
// password and a hidden field, and an image large enough to be reported.
const FIXTURE_HTML =
  "<header><h1>Fixture page</h1></header>" +
  '<nav aria-label="Main"><a href="/docs">Docs</a><a href="/hidden">Hidden</a></nav>' +
  '<main><p id="intro">Hello world</p>' +
  '<form><label for="user">User</label>' +
  '<input id="user" name="user" value="ada" required>' +
  '<input id="pass" name="pass" type="password" value="secret">' +
  '<input type="hidden" name="csrf" value="tok">' +
  '<button type="submit" disabled>Send</button></form>' +
  '<img src="/logo.png" alt="Logo"></main>'

function el(selector: string): Element {
  const found = document.querySelector(selector)
  if (found === null) {
    throw new Error(`fixture element missing: ${selector}`)
  }
  return found
}

/** The message of the error a call throws; fails the test when it throws none. */
function messageOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("expected a throw")
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

function fixturePage(): Page {
  document.title = "Fixture page"
  document.body.innerHTML = FIXTURE_HTML
  showAll(['a[href="/hidden"]', 'input[type="hidden"]'])
  stubRect(el("img"), { width: 40, height: 40 })
  stubRect(el("#intro"), { top: 100, left: 0, width: 200, height: 20 })
  stubStyle(el("#intro"), {
    display: "block",
    visibility: "visible",
    opacity: "1",
    color: "rgb(0, 0, 0)",
    backgroundColor: "rgba(0, 0, 0, 0)",
    fontSize: "16px",
  })
  stubLocation(window, "https://example.com/fixture")
  stubViewport(window, 1200, 800)
  stubScroll(window, 0, 0)
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value: 2000,
  })
  return fakePage()
}

beforeEach(() => {
  document.body.innerHTML = ""
  document.title = ""
})

describe("getContent", () => {
  test("describes the whole page", () => {
    expect(getContent({}, fixturePage())).toEqual(contentFixture)
  })

  test("describes a single element", () => {
    expect(getContent({ selector: "#intro" }, fixturePage())).toEqual({
      selector: "#intro",
      text: "Hello world",
      tagName: "p",
      textLength: 11,
      truncated: false,
    })
  })

  test("includes inner HTML for an element and outer HTML for the page", () => {
    const page = fixturePage()
    const element = getContent({ selector: "nav", includeHtml: true }, page) as { html: string }
    expect(element.html).toBe(el("nav").innerHTML)

    const whole = getContent({ includeHtml: true }, page) as { html: string }
    expect(whole.html).toBe(document.documentElement.outerHTML)
  })

  test("truncates at maxLength and keeps the original length", () => {
    const page = fixturePage()
    expect(getContent({ maxLength: 7 }, page)).toEqual({
      url: "https://example.com/fixture",
      title: "Fixture page",
      text: "Fixture\n\n[... truncated, use selector for specific content]",
      textLength: 41,
      truncated: true,
    })
  })

  test("reports a missing element with the bare message", () => {
    const page = fixturePage()
    document.body.insertAdjacentHTML("beforeend", '<button id="nope-target">Go</button>')
    // getContent keeps the one-line miss; only getElementInfo gained diagnostics
    expect(messageOf(() => getContent({ selector: "#nope" }, page))).toBe(
      "Element not found: #nope",
    )
  })

  test("validates the selector it was given", () => {
    expect(() => getContent({ selector: "   " }, fixturePage())).toThrow(errors.selectorEmpty)
  })
})

describe("getElementInfo", () => {
  test("reports attributes, styles, geometry and visibility", () => {
    expect(getElementInfo({ selector: "#intro" }, fixturePage())).toEqual(elementInfoFixture)
  })

  test("reports a missing element with alternatives and page context", () => {
    const page = fixturePage()
    document.body.insertAdjacentHTML("beforeend", '<button id="nope-target">Go</button>')

    const message = messageOf(() => getElementInfo({ selector: "#nope" }, page))

    expect(message.startsWith("Element not found: #nope")).toBe(true)
    expect(message).toContain(errors.notFoundSuggestions)
    expect(message).toContain("  - #nope-target (Similar ID found)")
    expect(message).toContain(errors.notFoundContext)
  })

  test("reports a miss without alternatives when nothing is close", () => {
    const message = messageOf(() => getElementInfo({ selector: "#zzz" }, fixturePage()))

    expect(message.startsWith("Element not found: #zzz")).toBe(true)
    expect(message).not.toContain(errors.notFoundSuggestions)
    expect(message).toContain(errors.notFoundContext)
  })

  test("requires a selector", () => {
    expect(() => getElementInfo({}, fixturePage())).toThrow(errors.selectorRequired)
  })

  test("calls a zero-sized or undisplayed element invisible", () => {
    const page = fixturePage()
    stubRect(el("#intro"), {})
    expect(getElementInfo({ selector: "#intro" }, page)).toMatchObject({ visible: false })

    stubRect(el("#intro"), { width: 10, height: 10 })
    stubStyle(el("#intro"), { display: "none" })
    expect(getElementInfo({ selector: "#intro" }, page)).toMatchObject({ visible: false })
  })

  test("truncates the text at 500 characters", () => {
    const page = fixturePage()
    el("#intro").textContent = "x".repeat(600)
    const info = getElementInfo({ selector: "#intro" }, page) as { text: string }
    expect(info.text.length).toBe(500)
  })
})

describe("getPageState", () => {
  test("summarises the page", () => {
    expect(getPageState({}, fixturePage())).toEqual(pageStateFixture)
  })

  test("slices every group at its limit and counts the total", () => {
    document.body.innerHTML = "<h1>one</h1><h2>two</h2><h3>three</h3>"
    showAll()
    const state = getPageState({ maxHeadings: 2 }, fakePage()) as {
      headings: unknown[]
      counts: { headings: { shown: number; total: number } }
    }
    expect(state.headings).toEqual([
      { level: "h1", text: "one" },
      { level: "h2", text: "two" },
    ])
    expect(state.counts.headings).toEqual({ shown: 2, total: 3 })
  })

  test("prefers aria-label, then placeholder, then the label element", () => {
    document.body.innerHTML =
      '<input id="a" aria-label="Aria" placeholder="Place"><label for="b">Labelled</label>' +
      '<input id="b" placeholder="Place"><input id="c"><label for="c">For c</label>'
    showAll()
    const state = getPageState({}, fakePage()) as { inputs: { label: string }[] }
    expect(state.inputs.map((input) => input.label)).toEqual(["Aria", "Place", "For c"])
  })

  test("leaves the label empty for an unlabelled input with no id", () => {
    document.body.innerHTML = "<input>"
    showAll()
    const state = getPageState({}, fakePage()) as { inputs: { label: string }[] }
    expect(state.inputs.map((input) => input.label)).toEqual([""])
  })

  test("gives every link, button and input a selector that resolves to its element", () => {
    document.body.innerHTML =
      '<nav><a href="/a">A</a><a href="/b">B</a></nav>' +
      '<form><button>Go</button><button aria-label="Close">x</button>' +
      '<input name="user"><textarea name="bio"></textarea></form>'
    showAll()
    const page = fakePage()
    const state = getPageState({}, page) as Record<string, { selector: unknown }[]>

    const groups = [
      { group: "links", locators: ['a[href="/a"]', 'a[href="/b"]'] },
      { group: "buttons", locators: ["form button:nth-of-type(1)", "form button:nth-of-type(2)"] },
      { group: "inputs", locators: ["input", "textarea"] },
    ]
    for (const { group, locators } of groups) {
      const entries = state[group] ?? []
      expect(entries).toHaveLength(locators.length)
      locators.forEach((locator, index) => {
        const selector = entries[index]?.selector
        expect(typeof selector).toBe("string")
        // identity, not text or href: the selector must find the very element
        assertResolves(page, selector as string, el(locator))
      })
    }
  })

  test("separates two buttons that share their text by their path", () => {
    document.body.innerHTML = "<div><button>Go</button><button>Go</button></div>"
    showAll()
    const page = fakePage()
    const state = getPageState({}, page) as { buttons: { selector: string }[] }
    const [first, second] = state.buttons
    expect(first?.selector).not.toBe(second?.selector)
    assertResolves(page, first?.selector ?? "", el("button:nth-of-type(1)"))
    assertResolves(page, second?.selector ?? "", el("button:nth-of-type(2)"))
  })

  test("leaves headings, images and landmarks untouched", () => {
    const state = getPageState({}, fixturePage()) as Record<string, unknown>
    expect(state.headings).toEqual(pageStateFixture.headings)
    expect(state.images).toEqual(pageStateFixture.images)
    expect(state.landmarks).toEqual(pageStateFixture.landmarks)
  })

  test("keeps the totals while the slice limits how many selectors are returned", () => {
    const cases = [
      { group: "links", limit: "maxLinks", html: '<a href="/1" id="k">1</a>' },
      { group: "buttons", limit: "maxButtons", html: '<button id="k">1</button>' },
      { group: "inputs", limit: "maxInputs", html: '<input id="k">' },
    ]
    for (const { group, limit, html } of cases) {
      document.body.innerHTML = html + html.replace(/id="k"/g, "") + html.replace(/id="k"/g, "")
      showAll()
      const page = fakePage()

      const one = getPageState({ [limit]: 1 }, page) as Record<string, unknown>
      const shown = one[group] as { selector: string }[]
      expect(shown).toHaveLength(1)
      assertResolves(page, shown[0]?.selector ?? "", el("#k"))
      expect((one.counts as Record<string, unknown>)[group]).toEqual({ shown: 1, total: 3 })

      const none = getPageState({ [limit]: 0 }, page) as Record<string, unknown>
      expect(none[group]).toEqual([])
      expect((none.counts as Record<string, unknown>)[group]).toEqual({ shown: 0, total: 3 })
    }
  })

  test("generates selectors for the returned slice only", () => {
    document.body.innerHTML =
      '<a href="/1" id="keep-link">1</a><a href="/2" id="drop-alpha">2</a>' +
      '<button id="keep-button">1</button><button id="drop-beta">2</button>' +
      '<input id="keep-input"><input id="drop-gamma">'
    showAll()
    const page = seamPage(fakePage())
    getPageState({ maxLinks: 1, maxButtons: 1, maxInputs: 1 }, page)

    for (const dropped of ["drop-alpha", "drop-beta", "drop-gamma"]) {
      expect(page.queries.filter((query) => query.includes(dropped))).toEqual([])
    }
    expect(page.queries).toContain("#keep-link")
  })

  test("reports a null selector for an element it cannot describe", () => {
    document.body.innerHTML = '<button id="solo">Go</button>'
    showAll()
    // every candidate query comes back empty, so no candidate ever verifies
    const page = seamPage(fakePage(), (selector) =>
      selector.startsWith("#") || selector.startsWith("body") ? [] : undefined,
    )
    const state = getPageState({}, page) as { buttons: JsonValue[] }
    expect(state.buttons).toEqual([{ text: "Go", disabled: false, type: "submit", selector: null }])
  })

  test("skips hidden inputs, invisible links and small images", () => {
    const state = getPageState({}, fixturePage()) as {
      inputs: { name: string; value: string }[]
      links: unknown[]
      images: unknown[]
    }
    expect(state.inputs.map((input) => input.name)).toEqual(["user", "pass"])
    expect(state.inputs[1]?.value).toBe("***")
    expect(state.links).toHaveLength(1)

    stubRect(el("img"), { width: 20, height: 20 })
    const smaller = getPageState({}, fakePage()) as { images: unknown[] }
    expect(smaller.images).toEqual([])
  })
})

describe("getAccessibilitySnapshot", () => {
  test("walks the fixture page", () => {
    expect(getAccessibilitySnapshot({}, fixturePage())).toEqual(a11yExpected)
  })

  test("roots at a selector and reports a missing one", () => {
    const page = fixturePage()
    expect(getAccessibilitySnapshot({ selector: "nav" }, page)).toMatchObject({
      tree: { role: "navigation", name: "Main" },
    })
    expect(() => getAccessibilitySnapshot({ selector: "#nope" }, page)).toThrow(
      "Element not found: #nope",
    )
  })

  test("keeps a node at maxDepth and drops the one below it", () => {
    document.body.innerHTML =
      '<section role="a"><section role="b"><section role="c"></section></section></section>'
    showAll()
    const snapshot = getAccessibilitySnapshot({ maxDepth: 2 }, fakePage()) as {
      tree: { children: [{ role: string; children?: unknown }] }
      nodeCount: number
    }
    expect(snapshot.tree.children[0]).toEqual({
      role: "a",
      children: [{ role: "b" }],
    })
    expect(snapshot.nodeCount).toBe(3)
  })

  test("collapses a transparent wrapper into its only child at the same depth", () => {
    document.body.innerHTML =
      '<div><div><span role="deep">x</span></div></div>' +
      "<div><button>one</button><button>two</button></div>"
    showAll()
    const snapshot = getAccessibilitySnapshot({ maxDepth: 1 }, fakePage()) as {
      tree: { children: unknown[] }
    }
    // three wrapper levels would exceed maxDepth 1 if they consumed depth
    expect(snapshot.tree.children).toEqual([
      { role: "deep", text: "x" },
      {
        children: [
          { role: "button", text: "one" },
          { role: "button", text: "two" },
        ],
      },
    ])
  })

  test("counts children that the 50-child cap then drops", () => {
    const buttons = Array.from({ length: 55 }, (_, index) => `<button>${index}</button>`).join("")
    document.body.innerHTML = `<form>${buttons}</form>`
    showAll()
    const snapshot = getAccessibilitySnapshot({}, fakePage()) as {
      tree: { children: [{ children: unknown[] }] }
      nodeCount: number
    }
    expect(snapshot.tree.children[0].children).toHaveLength(50)
    // body, form and all 55 buttons were counted before the cap applied
    expect(snapshot.nodeCount).toBe(57)
  })

  test("truncates at maxNodes", () => {
    document.body.innerHTML =
      '<section role="a"></section><section role="b"></section><section role="c"></section>'
    showAll()
    const snapshot = getAccessibilitySnapshot({ maxNodes: 3 }, fakePage()) as {
      tree: { children: unknown[] }
      nodeCount: number
      maxNodes: number
      truncated: boolean
    }
    expect(snapshot.tree.children).toEqual([{ role: "a" }, { role: "b" }])
    expect(snapshot).toMatchObject({ nodeCount: 3, maxNodes: 3, truncated: true })
  })

  test("keeps the root even when it is invisible", () => {
    document.body.innerHTML = '<section role="a"></section>'
    showAll()
    stubRect(document.body, {})
    const snapshot = getAccessibilitySnapshot({}, fakePage()) as { tree: unknown }
    expect(snapshot.tree).toEqual({ children: [{ role: "a" }] })
  })

  test("returns a null tree for an empty invisible root", () => {
    document.body.innerHTML = ""
    stubRect(document.body, {})
    const snapshot = getAccessibilitySnapshot({}, fakePage()) as {
      tree: unknown
      nodeCount: number
    }
    expect(snapshot.tree).toBeNull()
    expect(snapshot.nodeCount).toBe(1)
  })

  test("maps checkbox and radio inputs to their roles", () => {
    document.body.innerHTML =
      '<input type="checkbox" checked><input type="radio"><input type="submit" value="Go">'
    showAll()
    const snapshot = getAccessibilitySnapshot({}, fakePage()) as {
      tree: { children: { role: string; checked?: boolean; value?: string }[] }
    }
    expect(snapshot.tree.children).toEqual([
      { role: "checkbox", checked: true, value: "on" },
      { role: "radio", value: "on" },
      { role: "button", value: "Go" },
    ])
  })

  test("reports aria-expanded and aria-selected state", () => {
    document.body.innerHTML =
      '<div role="tab" aria-selected="true">One</div>' +
      '<div role="tab" aria-selected="false">Two</div>' +
      '<button aria-expanded="true">Menu</button>'
    showAll()
    const snapshot = getAccessibilitySnapshot({}, fakePage()) as {
      tree: { children: { role: string; text?: string; selected?: boolean; expanded?: boolean }[] }
    }
    expect(snapshot.tree.children).toEqual([
      { role: "tab", text: "One", selected: true },
      { role: "tab", text: "Two", selected: false },
      { role: "button", text: "Menu", expanded: true },
    ])
  })

  test("names an element from aria-labelledby before title, alt or its label", () => {
    document.body.innerHTML =
      '<span id="lbl">Named</span><button aria-labelledby="lbl">Ignored</button>'
    showAll()
    const snapshot = getAccessibilitySnapshot({ selector: "button" }, fakePage()) as {
      tree: { name: string }
    }
    expect(snapshot.tree.name).toBe("Named")
  })
})
