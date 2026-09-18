import { beforeEach, describe, expect, test } from "bun:test"

import type { Page } from "../src/content/page"
import { buildElementNotFoundError, findSelectorAlternatives } from "../src/content/suggest"
import { assertResolves, fakePage, stubLocation, stubTop } from "./dom"
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

describe("findSelectorAlternatives", () => {
  test("suggests ids that contain the failed id fragment", () => {
    document.body.innerHTML = '<input id="search-input"><input id="searchbox"><input id="other">'
    expect(findSelectorAlternatives(fakePage(), "#search")).toEqual([
      { selector: "#search-input", reason: "Similar ID found" },
      { selector: "#searchbox", reason: "Similar ID found" },
    ])
  })

  test("routes the id suggestions through the verified generator", () => {
    document.body.innerHTML =
      '<div id="dup-save" class="alpha">a</div>' +
      '<div id="dup-save" class="beta">b</div>' +
      '<input id="1save" class="digit-save">'
    const page = fakePage()

    const alternatives = findSelectorAlternatives(page, "#sav")

    // the shared id is ambiguous and the leading digit needs escaping, so no
    // suggestion may be the raw `#id` the element carries
    expect(alternatives.map((item) => item.selector)).toEqual([".alpha", ".beta", ".digit-save"])
    expect(alternatives.every((item) => item.reason === "Similar ID found")).toBe(true)
    assertResolves(page, alternatives[0]?.selector ?? "", el("#dup-save"))
    assertResolves(page, alternatives[2]?.selector ?? "", el(".digit-save"))
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
      { selector: '[aria-label="Main menu"]', reason: 'aria-label="Main menu"' },
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
