// The image actions the screenshot command drives inside the tab: the resize
// and re-encode, and the numbered badges a vision model reads. happy-dom has no
// canvas and decodes no image, so the resize runs through an injected
// `ImageResizer`; the real one is exercised in Firefox (Post-Completion).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  ANNOTATION_HOST_ID,
  annotateElements,
  type ImageResizer,
  removeAnnotations,
  resizeImageAction,
} from "../src/content/image"
import type { Page } from "../src/content/page"
import type { JsonObject } from "../src/protocol"
import { assertResolves, fakePage, seamPage, stubRect, stubScroll } from "./dom"
import errors from "./fixtures/errors.json"

interface ResizeCall {
  dataUrl: string
  scale: number
  quality: number
  format: string
}

const SOURCE = "data:image/png;base64,c291cmNl"

/** Records what the action asked for and answers with a fixed image. */
function recordingResizer(calls: ResizeCall[], dataUrl = "data:image/jpeg;base64,c2NhbGVk") {
  const resizer: ImageResizer = (request) => {
    calls.push({ ...request })
    return Promise.resolve({
      dataUrl,
      originalSize: { width: 1280, height: 800 },
      scaledSize: {
        width: Math.round(1280 * request.scale),
        height: Math.round(800 * request.scale),
      },
    })
  }
  return resizer
}

describe("resizeImage", () => {
  test("applies the defaults and reports both sizes", async () => {
    const calls: ResizeCall[] = []
    const page = fakePage()
    const action = resizeImageAction(recordingResizer(calls))

    const result = await action({ dataUrl: SOURCE }, page)

    expect(calls).toEqual([{ dataUrl: SOURCE, scale: 0.5, quality: 60, format: "jpeg" }])
    expect(result).toEqual({
      dataUrl: "data:image/jpeg;base64,c2NhbGVk",
      originalSize: { width: 1280, height: 800 },
      scaledSize: { width: 640, height: 400 },
    })
  })

  test("passes explicit scale, quality and format through", async () => {
    const calls: ResizeCall[] = []
    const page = fakePage()
    const action = resizeImageAction(recordingResizer(calls))

    await action({ dataUrl: SOURCE, scale: 1, quality: 30, format: "png" }, page)

    expect(calls).toEqual([{ dataUrl: SOURCE, scale: 1, quality: 30, format: "png" }])
  })

  test("refuses a call without an image", async () => {
    const page = fakePage()
    const action = resizeImageAction(recordingResizer([]))

    await expect(action({}, page)).rejects.toThrow(errors.resizeMissingDataUrl)
  })

  test("propagates a decoding failure", async () => {
    const page = fakePage()
    const failing: ImageResizer = () => Promise.reject(new Error(errors.resizeDecodeFailed))
    const action = resizeImageAction(failing)

    await expect(action({ dataUrl: SOURCE }, page)).rejects.toThrow(errors.resizeDecodeFailed)
  })
})

const ANNOTATED_HTML =
  '<button id="save">Save</button>' +
  '<a href="/docs" class="nav link">Docs</a>' +
  '<input name="q" placeholder="Search">' +
  '<span role="button" aria-label="Close">x</span>' +
  "<button>Hidden</button>"

interface ShadowSpy {
  root?: ShadowRoot
}

let attachShadowOriginal: typeof Element.prototype.attachShadow

/** The annotation host is closed, so the badges are read through this spy. */
function spyOnShadow(): ShadowSpy {
  const spy: ShadowSpy = {}
  Element.prototype.attachShadow = function attachShadow(this: Element, init: ShadowRootInit) {
    const root = attachShadowOriginal.call(this, init)
    spy.root = root
    return root
  }
  return spy
}

function annotatedPage(): ReturnType<typeof fakePage> {
  const page = fakePage()
  document.body.innerHTML = ANNOTATED_HTML
  for (const element of document.querySelectorAll("*")) {
    stubRect(element, { top: 40, left: 20, width: 100, height: 24 })
  }
  stubRect(document.querySelectorAll("button")[1] as Element, { width: 0, height: 0 })
  stubScroll(page.window, 0, 100)
  return page
}

function labelsOf(result: unknown): JsonObject {
  return (result as { labels: JsonObject }).labels
}

function selectorOf(labels: JsonObject, index: string): string | null {
  return (labels[index] as { selector: string | null }).selector
}

/** Every label selector must resolve back to the element it badged. */
function expectLabelsResolve(page: Page, labels: JsonObject, badged: Record<string, string>) {
  for (const [index, fixture] of Object.entries(badged)) {
    const element = document.querySelector(fixture)
    if (element === null) {
      throw new Error(`fixture element missing: ${fixture}`)
    }
    assertResolves(page, selectorOf(labels, index) as string, element)
  }
}

beforeEach(() => {
  attachShadowOriginal = Element.prototype.attachShadow
})

afterEach(() => {
  Element.prototype.attachShadow = attachShadowOriginal
  document.body.innerHTML = ""
})

describe("annotateElements", () => {
  test("numbers the interactive elements and describes each one", () => {
    const page = annotatedPage()

    const result = annotateElements({}, page)

    expect(result).toEqual({
      labels: {
        "1": { selector: "#save", text: "Save", role: "button" },
        "3": { selector: ".nav.link", text: "Docs", role: "a" },
        "4": { selector: "body > input", text: "Search", role: "input" },
        "5": { selector: '[aria-label="Close"]', text: "x", role: "button" },
      },
      count: 4,
    })
    expectLabelsResolve(page, labelsOf(result), {
      "1": "#save",
      "3": "a[href]",
      "4": "input",
      "5": "span",
    })
  })

  test("paints the badges into a closed shadow root of its own host", () => {
    const page = annotatedPage()
    const spy = spyOnShadow()

    annotateElements({}, page)

    const host = document.getElementById(ANNOTATION_HOST_ID)
    expect(host).not.toBeNull()
    // closed: the page's own scripts cannot reach the badges
    expect(host?.shadowRoot).toBeNull()
    const badges = [...(spy.root?.children ?? [])]
    expect(badges.map((badge) => badge.textContent)).toEqual(["1", "3", "4", "5"])
    const style = (badges[0] as HTMLElement).style
    // fixed positioning tracks the viewport already, so scroll is not added
    // on top of getBoundingClientRect's viewport-relative rect
    expect(style.top).toBe("31px")
    expect(style.left).toBe("11px")
    expect(style.position).toBe("fixed")
  })

  test("stops at maxElements", () => {
    const page = annotatedPage()

    const result = annotateElements({ maxElements: 2 }, page)

    expect(Object.keys(labelsOf(result))).toEqual(["1"])
  })

  test("falls back to the path when the element has no id or class", () => {
    const page = fakePage()
    document.body.innerHTML = "<button>Go</button>"
    stubRect(document.querySelector("button") as Element, { width: 10, height: 10 })

    const result = annotateElements({}, page)

    expect(labelsOf(result)["1"]).toEqual({
      selector: "body > button",
      text: "Go",
      role: "button",
    })
    expectLabelsResolve(page, labelsOf(result), { "1": "button" })
  })

  test("separates two elements that share their class list", () => {
    const page = fakePage()
    document.body.innerHTML = '<button class="btn">One</button><button class="btn">Two</button>'
    for (const button of document.querySelectorAll("button")) {
      stubRect(button, { width: 10, height: 10 })
    }

    const labels = labelsOf(annotateElements({}, page))

    expect(selectorOf(labels, "1")).toBe("body > button:nth-of-type(1)")
    expect(selectorOf(labels, "2")).toBe("body > button:nth-of-type(2)")
    expectLabelsResolve(page, labels, {
      "1": "button:nth-of-type(1)",
      "2": "button:nth-of-type(2)",
    })
  })

  test("escapes an id starting with a digit", () => {
    document.body.innerHTML = '<button id="1save">Save</button>'
    const target = document.querySelector("button") as Element
    stubRect(target, { width: 10, height: 10 })
    // happy-dom does not resolve a `\31 ` identifier the way Firefox does, so
    // the serialised candidate and its acceptance are asserted through the seam
    const page = seamPage(fakePage(), (selector) =>
      selector === "#\\31 save" ? [target] : undefined,
    )

    const labels = labelsOf(annotateElements({}, page))

    expect(selectorOf(labels, "1")).toBe("#\\31 save")
  })

  test("reports a null selector for an element it cannot describe, badge and all", () => {
    document.body.innerHTML = "<button>Go</button>"
    stubRect(document.querySelector("button") as Element, { width: 10, height: 10 })
    // no candidate verifies: the path query answers with no match at all
    const page = seamPage(fakePage(), (selector) =>
      selector.startsWith("body >") ? [] : undefined,
    )
    const spy = spyOnShadow()

    const labels = labelsOf(annotateElements({}, page))

    expect(labels["1"]).toEqual({ selector: null, text: "Go", role: "button" })
    expect([...(spy.root?.children ?? [])].map((badge) => badge.textContent)).toEqual(["1"])
  })

  test("replaces a stale host instead of leaving a duplicate behind", () => {
    const page = annotatedPage()
    annotateElements({}, page)

    annotateElements({}, page)

    expect(document.querySelectorAll(`#${ANNOTATION_HOST_ID}`)).toHaveLength(1)
  })

  test("removes the host again and answers a second call the same way", () => {
    const page = annotatedPage()
    annotateElements({}, page)

    expect(removeAnnotations({}, page)).toEqual({ removed: true })
    expect(document.getElementById(ANNOTATION_HOST_ID)).toBeNull()
    expect(removeAnnotations({}, page)).toEqual({ removed: true })
  })
})
