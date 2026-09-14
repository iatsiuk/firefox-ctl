import { beforeEach, describe, expect, test } from "bun:test"

import type { Page } from "../src/content/page"
import {
  buildElementNotFoundError,
  findSelectorAlternatives,
  generateUniqueSelector,
} from "../src/content/suggest"
import { fakePage, stubLocation, stubTop } from "./dom"
import errors from "./fixtures/errors.json"

beforeEach(() => {
  document.body.innerHTML = ""
  document.title = ""
})

function el(selector: string): Element {
  const found = document.querySelector(selector)
  if (found === null) {
    throw new Error(`fixture element missing: ${selector}`)
  }
  return found
}

describe("generateUniqueSelector", () => {
  test("prefers the id", () => {
    document.body.innerHTML = '<button id="go" class="btn primary" aria-label="Go">Go</button>'
    expect(generateUniqueSelector(fakePage(), el("#go"))).toBe("#go")
  })

  test("falls back to a unique class combination", () => {
    document.body.innerHTML =
      '<button class="btn primary" aria-label="Go">Go</button><button class="btn">Other</button>'
    expect(generateUniqueSelector(fakePage(), el(".primary"))).toBe(".btn.primary")
  })

  test("escapes class names and skips pseudo-class utilities", () => {
    document.body.innerHTML = '<div class="hover:bg-red w-1/2">x</div><div class="other">y</div>'
    expect(generateUniqueSelector(fakePage(), el(".other + div, div"))).toBe(".w-1\\/2")
  })

  test("uses aria-label when the classes are not unique", () => {
    document.body.innerHTML =
      '<button class="btn" aria-label="Send message">a</button><button class="btn">b</button>'
    expect(generateUniqueSelector(fakePage(), el("[aria-label]"))).toBe(
      '[aria-label="Send message"]',
    )
  })

  test("escapes quotes inside the aria-label", () => {
    document.body.innerHTML =
      '<button class="btn" aria-label=\'say "hi"\'>a</button><button class="btn">b</button>'
    const labelled = el("[aria-label]")
    const base = fakePage()
    // happy-dom's selector parser rejects an escaped quote inside an attribute
    // value, so the match is counted the way a real browser counts it
    const page: Page = {
      ...base,
      document: new Proxy(base.document, {
        get(target, key: string | symbol): unknown {
          if (key === "querySelectorAll") {
            return (selector: string): unknown =>
              selector === '[aria-label="say \\"hi\\""]'
                ? [labelled]
                : target.querySelectorAll(selector)
          }
          const value = Reflect.get(target, key) as unknown
          return typeof value === "function" ? value.bind(target) : value
        },
      }) as Document,
    }
    expect(generateUniqueSelector(page, labelled)).toBe('[aria-label="say \\"hi\\""]')
  })

  test("falls back to a tag path with nth-of-type", () => {
    document.body.innerHTML = "<main><section><p>one</p><p>two</p></section></main>"
    const page = fakePage()
    expect(generateUniqueSelector(page, el("main > section > p:nth-of-type(2)"))).toBe(
      "main > section > p:nth-of-type(2)",
    )
    expect(generateUniqueSelector(page, el("section"))).toBe("main > section")
  })

  test("stops the path below the body", () => {
    document.body.innerHTML = "<div><span>x</span></div>"
    expect(generateUniqueSelector(fakePage(), el("span"))).toBe("div > span")
  })

  test("keeps the path when a selector is syntactically invalid", () => {
    // an unescapable class cannot make a valid selector, so the path wins
    document.body.innerHTML = '<div><span class="a">x</span></div>'
    const span = el("span")
    const page: Page = {
      ...fakePage(),
      cssEscape: (value: string) => value.replace("a", "["),
    }
    expect(generateUniqueSelector(page, span)).toBe("div > span")
  })
})

describe("findSelectorAlternatives", () => {
  test("suggests ids that contain the failed id fragment", () => {
    document.body.innerHTML = '<input id="search-input"><input id="searchbox"><input id="other">'
    expect(findSelectorAlternatives(fakePage(), "#search")).toEqual([
      { selector: "#search-input", reason: "Similar ID found" },
      { selector: "#searchbox", reason: "Similar ID found" },
    ])
  })

  test("suggests elements whose class contains the failed class fragment", () => {
    document.body.innerHTML = '<div class="card-body">a</div><div class="footer">b</div>'
    expect(findSelectorAlternatives(fakePage(), ".card")).toEqual([
      { selector: ".card-body", reason: "Similar class found" },
    ])
  })

  test("suggests buttons with text for a button selector", () => {
    document.body.innerHTML =
      '<button id="send">Send it now please, all of it</button>' +
      "<button>   </button>" +
      '<div role="button" class="ghost">Cancel</div>'
    expect(findSelectorAlternatives(fakePage(), "button.missing")).toEqual([
      { selector: "#send", reason: 'Button: "Send it now please, all of it"' },
      { selector: ".ghost", reason: 'Button: "Cancel"' },
    ])
  })

  test("matches button and link text against a :contains hint", () => {
    document.body.innerHTML =
      '<button id="save">Save draft</button><button id="drop">Delete</button>' +
      '<a href="/save" id="savelink">Save link</a><a href="/x" id="x">Other</a>'
    expect(findSelectorAlternatives(fakePage(), ':contains("save")')).toEqual([
      { selector: "#save", reason: 'Button: "Save draft"' },
      { selector: "#savelink", reason: 'Link: "Save link"' },
    ])
  })

  test("matches an aria-label hint on any element", () => {
    document.body.innerHTML = '<div class="menu" aria-label="Main menu">m</div>'
    expect(findSelectorAlternatives(fakePage(), '[aria-label="main"]')).toEqual([
      { selector: ".menu", reason: 'aria-label="Main menu"' },
    ])
  })

  test("returns nothing when the selector offers no hint", () => {
    document.body.innerHTML = "<p>text</p>"
    expect(findSelectorAlternatives(fakePage(), "section > p.gone")).toEqual([])
  })

  test("reports each element once and caps the list at five", () => {
    document.body.innerHTML = Array.from(
      { length: 8 },
      (_, index) => `<button id="btn-${index}" class="btn">Go ${index}</button>`,
    ).join("")
    const alternatives = findSelectorAlternatives(fakePage(), "#btn")
    expect(alternatives).toHaveLength(5)
    expect(new Set(alternatives.map((item) => item.selector)).size).toBe(5)
  })
})

describe("buildElementNotFoundError", () => {
  function context(page: Page): void {
    stubLocation(page.window, "https://example.com/app")
    page.document.title = "Example app"
  }

  test("lists suggestions, page context and the hint", () => {
    document.body.innerHTML = '<button id="submit-button">Submit</button>'
    const page = fakePage()
    context(page)
    stubTop(page.window, true)

    const error = buildElementNotFoundError(page, "#submit", "click")

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe(
      [
        "Element not found: #submit",
        "",
        "Suggested alternatives:",
        "  - #submit-button (Similar ID found)",
        "",
        "Page context:",
        "  URL: https://example.com/app",
        "  Title: Example app",
        "",
        "Hint: Use getPageState to see available elements.",
      ].join("\n"),
    )
  })

  test("omits the suggestion block when nothing matches", () => {
    document.body.innerHTML = "<p>text</p>"
    const page = fakePage()
    context(page)
    stubTop(page.window, true)

    const error = buildElementNotFoundError(page, "#gone", "type")

    expect(error.message).toBe(
      [
        "Element not found: #gone",
        "",
        "Page context:",
        "  URL: https://example.com/app",
        "  Title: Example app",
        "",
        "Hint: Use getPageState to see available elements.",
      ].join("\n"),
    )
    expect(error.message).not.toContain(errors.notFoundSuggestions)
  })

  test("warns when the content script runs inside an iframe", () => {
    const page = fakePage()
    context(page)
    stubTop(page.window, false)

    const lines = buildElementNotFoundError(page, "#gone", "click").message.split("\n")

    expect(lines).toContain(errors.notFoundIframe)
    expect(lines.indexOf(errors.notFoundIframe)).toBe(lines.indexOf("  Title: Example app") + 1)
  })

  test("uses the pinned error texts", () => {
    document.body.innerHTML = '<div id="pane-main">x</div>'
    const page = fakePage()
    context(page)
    stubTop(page.window, true)

    const message = buildElementNotFoundError(page, "#pane", "click").message

    expect(message.startsWith(errors.elementNotFound.replace("<selector>", "#pane"))).toBe(true)
    expect(message).toContain(`\n\n${errors.notFoundSuggestions}\n`)
    expect(message).toContain(`\n\n${errors.notFoundContext}\n`)
    expect(message.endsWith(`\n\n${errors.notFoundHint}`)).toBe(true)
  })
})
