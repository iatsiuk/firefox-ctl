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
import type { JsonObject } from "../src/protocol"
import { fakePage, stubRect, stubScroll } from "./dom"
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
        "3": { selector: "a.nav.link", text: "Docs", role: "a" },
        "4": { selector: "input", text: "Search", role: "input" },
        "5": { selector: "span", text: "x", role: "button" },
      },
      count: 4,
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

  test("falls back to the tag name when the element has no id or class", () => {
    const page = fakePage()
    document.body.innerHTML = "<button>Go</button>"
    stubRect(document.querySelector("button") as Element, { width: 10, height: 10 })

    const result = annotateElements({}, page)

    expect(labelsOf(result)["1"]).toEqual({ selector: "button", text: "Go", role: "button" })
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
