import { beforeEach, describe, expect, test } from "bun:test"

import type { Page } from "../src/content/page"
import { getElementInfo } from "../src/content/read"
import {
  buildElementNotFoundError,
  buildTextNotFoundError,
  findSelectorAlternatives,
} from "../src/content/suggest"
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

describe("buildTextNotFoundError", () => {
  function context(page: Page): void {
    stubLocation(page.window, "https://example.com/app")
    page.document.title = "Example app"
  }

  function textPage(html: string): Page {
    document.body.innerHTML = html
    const page = fakePage()
    context(page)
    stubTop(page.window, true)
    return page
  }

  test("lists controls and links matching the text, page context and the hint", () => {
    const page = textPage(
      '<button id="save">Save draft</button>' +
        '<button id="drop">Delete</button>' +
        '<div role="button" class="ghost" aria-label="Save everything">Store</div>' +
        '<a href="/save" id="savelink">Save link</a>' +
        '<a href="/x" id="x">Other</a>',
    )

    const error = buildTextNotFoundError(page, "Save")

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe(
      [
        'Element not found: text "Save"',
        "",
        "Suggested alternatives:",
        '  - #save (Button: "Save draft")',
        '  - [aria-label="Save everything"] (Button: "Store")',
        '  - #savelink (Link: "Save link")',
        "",
        "Page context:",
        "  URL: https://example.com/app",
        "  Title: Example app",
        "",
        "Hint: Use getPageState to see available elements.",
      ].join("\n"),
    )
    assertResolves(page, "#save", el("#save"))
    assertResolves(page, '[aria-label="Save everything"]', el(".ghost"))
    assertResolves(page, "#savelink", el("#savelink"))
  })

  test("matches case-insensitively on a substring of the control text", () => {
    const page = textPage('<button id="apply">Apply changes</button>')

    expect(buildTextNotFoundError(page, "apply").message).toContain(
      '  - #apply (Button: "Apply changes")',
    )
  })

  test("uses the pinned first line and blocks", () => {
    const page = textPage('<button id="save">Save draft</button>')

    const message = buildTextNotFoundError(page, "Save").message

    expect(message.startsWith(errors.elementNotFoundText.replace("<text>", "Save"))).toBe(true)
    expect(message).toContain(`\n\n${errors.notFoundSuggestions}\n`)
    expect(message).toContain(`\n\n${errors.notFoundContext}\n`)
    expect(message.endsWith(`\n\n${errors.notFoundHint}`)).toBe(true)
  })

  test("warns when the content script runs inside an iframe", () => {
    document.body.innerHTML = ""
    const page = fakePage()
    context(page)
    stubTop(page.window, false)

    const lines = buildTextNotFoundError(page, "Save").message.split("\n")

    expect(lines).toContain(errors.notFoundIframe)
    expect(lines.indexOf(errors.notFoundIframe)).toBe(lines.indexOf("  Title: Example app") + 1)
  })

  test("matches the text literally and never runs the id or class passes", () => {
    const query = 'Save "draft" #1 (v2.0)\\x'
    const page = textPage(
      `<button id="literal">${query} now</button>` +
        '<div id="1">numbered</div>' +
        '<div class="0">classy</div>' +
        '<button id="v2">v2.0</button>',
    )

    const error = buildTextNotFoundError(page, query)

    expect(error.message.split("\n").slice(0, 4)).toEqual([
      `Element not found: text "${query}"`,
      "",
      "Suggested alternatives:",
      `  - #literal (Button: "${query} now")`,
    ])
    expect(error.message).not.toContain("Similar ID found")
    expect(error.message).not.toContain("Similar class found")
    expect(error.message).not.toContain("#v2")
  })

  test("omits the suggestion block when no control matches", () => {
    const page = textPage("<p>Save</p><div>Save</div>")

    const error = buildTextNotFoundError(page, "Save")

    expect(error.message).toBe(
      [
        'Element not found: text "Save"',
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

  test("caps the alternatives at five", () => {
    const page = textPage(
      Array.from({ length: 8 }, (_, index) => `<button id="go-${index}">Go ${index}</button>`).join(
        "",
      ),
    )

    const suggested = buildTextNotFoundError(page, "Go")
      .message.split("\n")
      .filter((line) => line.startsWith("  - "))

    expect(suggested).toHaveLength(5)
    expect(new Set(suggested).size).toBe(5)
  })
})

describe("form-aware alternatives", () => {
  const FORM_HTML =
    '<form><label for="email-field">Email address</label>' +
    '<input id="email-field" name="email" placeholder="you@example.com">' +
    '<input id="phone-field" name="phone">' +
    '<textarea id="note-field" name="comment-box"></textarea></form>'

  function formPage(): Page {
    document.body.innerHTML = FORM_HTML
    return fakePage()
  }

  test("suggests an input whose name contains the failed name literal", () => {
    const page = formPage()
    expect(findSelectorAlternatives(page, 'input[name="mail"]')).toEqual([
      { selector: "#email-field", reason: "Similar input name found" },
    ])
    assertResolves(page, "#email-field", el("#email-field"))
  })

  test("drops a trailing index from the name literal when nothing matches", () => {
    const page = formPage()
    const expected = [{ selector: "#email-field", reason: "Similar input name found" }]
    expect(findSelectorAlternatives(page, 'input[name="email-1"]')).toEqual(expected)
    expect(findSelectorAlternatives(page, "input[name=email-1]")).toEqual(expected)
    expect(findSelectorAlternatives(page, 'input[name="email_2"]')).toEqual(expected)
  })

  test("scans textareas and selects for the name too", () => {
    const page = formPage()
    expect(findSelectorAlternatives(page, '[name="comment"]')).toEqual([
      { selector: "#note-field", reason: "Similar input name found" },
    ])
  })

  test("adds nothing when no name is close", () => {
    const page = formPage()
    expect(findSelectorAlternatives(page, 'input[name="zed"]')).toEqual([])
    expect(findSelectorAlternatives(page, 'input[name="zed-1"]')).toEqual([])
  })

  test("stops the name scan at the search cap", () => {
    document.body.innerHTML =
      Array.from({ length: 100 }, () => '<input name="zzz">').join("") +
      '<input id="late-field" name="email">'
    expect(findSelectorAlternatives(fakePage(), 'input[name="email"]')).toEqual([])
  })

  test("caps the name suggestions at five", () => {
    document.body.innerHTML = Array.from(
      { length: 8 },
      (_, index) => `<input id="mail-box-${index}" name="email-${index}">`,
    ).join("")
    const page = fakePage()

    const alternatives = findSelectorAlternatives(page, 'input[name="email"]')

    expect(alternatives).toHaveLength(5)
    expect(alternatives.every((item) => item.reason === "Similar input name found")).toBe(true)
    for (const [index, item] of alternatives.entries()) {
      assertResolves(page, item.selector, el(`#mail-box-${index}`))
    }
  })

  test("suggests elements whose data-testid contains the failed literal", () => {
    document.body.innerHTML =
      '<div data-testid="submit-btn-primary">a</div><div data-testid="cancel">b</div>'
    const page = fakePage()

    expect(findSelectorAlternatives(page, '[data-testid="submit-btn"]')).toEqual([
      { selector: '[data-testid="submit-btn-primary"]', reason: "Similar data-testid found" },
    ])
    assertResolves(page, '[data-testid="submit-btn-primary"]', el("[data-testid]"))
  })

  test("drops a trailing index from the data-testid literal", () => {
    document.body.innerHTML = '<div data-testid="submit">a</div>'
    expect(findSelectorAlternatives(fakePage(), '[data-testid="submit-2"]')).toEqual([
      { selector: '[data-testid="submit"]', reason: "Similar data-testid found" },
    ])
  })

  test("adds nothing when no data-testid is close", () => {
    document.body.innerHTML = '<div data-testid="submit">a</div>'
    expect(findSelectorAlternatives(fakePage(), '[data-testid="zzz"]')).toEqual([])
  })

  test("matches a hint against input labels, placeholders and aria-labels", () => {
    document.body.innerHTML =
      '<label for="mail-field">Email address</label><input id="mail-field">' +
      '<input id="other-field" placeholder="Your email here">' +
      '<input id="aria-field" aria-label="Email backup">' +
      '<input id="far-field" placeholder="Phone">'
    const page = fakePage()

    const alternatives = findSelectorAlternatives(page, '[aria-label="mail"]')

    expect(alternatives).toEqual([
      { selector: "#mail-field", reason: 'Input: "Email address"' },
      { selector: "#other-field", reason: 'Input: "Your email here"' },
      { selector: '[aria-label="Email backup"]', reason: 'Input: "Email backup"' },
    ])
    for (const item of alternatives) {
      assertResolves(page, item.selector, el(item.selector))
    }
  })

  test("reports the field that actually matched the hint, not the first non-empty one", () => {
    document.body.innerHTML =
      '<label for="mixed-field">Full Name</label><input id="mixed-field" placeholder="Your mail here">'
    const page = fakePage()

    const alternatives = findSelectorAlternatives(page, '[aria-label="mail"]')

    expect(alternatives).toEqual([{ selector: "#mixed-field", reason: 'Input: "Your mail here"' }])
  })

  test("matches a hint against a second label sharing the same for target", () => {
    document.body.innerHTML =
      '<label for="dual-field">Account</label><label for="dual-field">Email address</label>' +
      '<input id="dual-field">'
    const page = fakePage()

    const alternatives = findSelectorAlternatives(page, '[aria-label="mail"]')

    expect(alternatives).toEqual([{ selector: "#dual-field", reason: 'Input: "Email address"' }])
  })

  test("reaches the new passes through getElementInfo", () => {
    const extra = '<div data-testid="submit-btn">go</div><input id="x-field" aria-label="Mail">'
    document.body.innerHTML = FORM_HTML + extra
    const page = fakePage()

    const messages = [
      'input[name="email-1"]',
      '[data-testid="submit-btn-2"]',
      '[aria-label="ail"]',
    ].map((selector) => {
      try {
        getElementInfo({ selector }, page)
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      throw new Error(`expected a miss for ${selector}`)
    })

    expect(messages[0]).toContain("  - #email-field (Similar input name found)")
    expect(messages[1]).toContain('  - [data-testid="submit-btn"] (Similar data-testid found)')
    expect(messages[2]).toContain('  - [aria-label="Mail"] (Input: "Mail")')
  })
})
