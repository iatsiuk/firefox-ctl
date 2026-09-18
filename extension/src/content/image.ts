// Image work the screenshot command drives inside the tab: the downscale and
// re-encode of a captured data URL, and the numbered badges a vision model
// reads back as selectors.
//
// The resize itself needs an `Image` decode and a canvas, neither of which the
// test DOM has, so it sits behind an injected `ImageResizer`; `canvasResizer`
// is the one the content script installs and is verified in Firefox.

import type { JsonObject, JsonValue } from "../protocol"
import type { Page } from "./page"
import type { Action } from "./registry"
import { SelectorUnavailable, uniqueSelector } from "./unique-selector"

/** The id of the host element the badges hang under. */
export const ANNOTATION_HOST_ID = "__firefox_ctl_annotations__"

/** Defaults applied when the background page names no others. */
const DEFAULT_SCALE = 0.5
const DEFAULT_QUALITY = 60
const DEFAULT_FORMAT = "jpeg"
const DEFAULT_MAX_ELEMENTS = 30

const BADGE_SIZE_PX = 18
const LABEL_TEXT_LIMIT = 80

// the interactive elements, in the order the badges are numbered in
const INTERACTIVE_SELECTORS = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  '[role="button"]',
  '[role="link"]',
]

export interface ImageSize {
  width: number
  height: number
}

export interface ResizeRequest {
  dataUrl: string
  scale: number
  quality: number
  format: string
}

export interface ResizeResult {
  dataUrl: string
  originalSize: ImageSize
  scaledSize: ImageSize
}

/** Decodes one data URL and re-encodes it at the requested scale and quality. */
export type ImageResizer = (request: ResizeRequest, page: Page) => Promise<ResizeResult>

/** The `Image` constructor lives on the window, not on the DOM `Window` type. */
interface ImageWindow {
  Image: new () => HTMLImageElement
}

/** The value and placeholder a label falls back to; absent on most elements. */
interface FieldLike extends Element {
  value?: string
  placeholder?: string
}

function numberParam(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback
}

function mimeType(format: string): string {
  return format === "png" ? "image/png" : "image/jpeg"
}

function size(width: number, height: number): JsonObject {
  return { width, height }
}

/**
 * The real resizer: decode, draw into a canvas of the scaled size, read back a
 * data URL. Smoothing is on, so a downscale stays legible.
 */
export const canvasResizer: ImageResizer = (request, page) =>
  new Promise((resolve, reject) => {
    const image = new (page.window as unknown as ImageWindow).Image()
    image.onload = (): void => {
      try {
        resolve(draw(image, request, page))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    image.onerror = (): void => {
      reject(new Error("Failed to load image for resizing"))
    }
    image.src = request.dataUrl
  })

function draw(image: HTMLImageElement, request: ResizeRequest, page: Page): ResizeResult {
  const originalSize = { width: image.width, height: image.height }
  // a canvas of zero width throws, so a tiny image never scales away entirely
  const scaledSize = {
    width: Math.max(1, Math.round(originalSize.width * request.scale)),
    height: Math.max(1, Math.round(originalSize.height * request.scale)),
  }
  const canvas = page.document.createElement("canvas")
  canvas.width = scaledSize.width
  canvas.height = scaledSize.height
  const context = canvas.getContext("2d")
  if (context === null) {
    throw new Error("Failed to get a canvas context for resizing")
  }
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = "high"
  context.drawImage(image, 0, 0, scaledSize.width, scaledSize.height)
  return {
    dataUrl: canvas.toDataURL(mimeType(request.format), request.quality / 100),
    originalSize,
    scaledSize,
  }
}

/** The `resizeImage` action over one resizer; the content script passes the real one. */
export function resizeImageAction(resize: ImageResizer): Action {
  return async (params, page) => {
    if (typeof params.dataUrl !== "string" || params.dataUrl === "") {
      throw new Error("dataUrl is required and must be a string")
    }
    const result = await resize(
      {
        dataUrl: params.dataUrl,
        scale: numberParam(params.scale, DEFAULT_SCALE),
        quality: numberParam(params.quality, DEFAULT_QUALITY),
        format: typeof params.format === "string" ? params.format : DEFAULT_FORMAT,
      },
      page,
    )
    return {
      dataUrl: result.dataUrl,
      originalSize: size(result.originalSize.width, result.originalSize.height),
      scaledSize: size(result.scaledSize.width, result.scaledSize.height),
    }
  }
}

function collect(page: Page, maxElements: number): Element[] {
  const seen = new Set<Element>()
  const elements: Element[] = []
  for (const selector of INTERACTIVE_SELECTORS) {
    for (const element of page.document.querySelectorAll(selector)) {
      if (!seen.has(element) && elements.length < maxElements) {
        seen.add(element)
        elements.push(element)
      }
    }
  }
  return elements
}

/** The shared generator, or null when nothing describes the element uniquely. */
function selectorFor(page: Page, element: Element): string | null {
  try {
    return uniqueSelector(page, element)
  } catch (error) {
    if (error instanceof SelectorUnavailable) {
      return null
    }
    throw error
  }
}

function labelText(element: Element): string {
  const field = element as FieldLike
  const text =
    element.textContent ||
    field.value ||
    field.placeholder ||
    element.getAttribute("aria-label") ||
    ""
  return text.trim().slice(0, LABEL_TEXT_LIMIT)
}

function badgeFor(page: Page, element: Element, index: number): HTMLElement {
  const rect = element.getBoundingClientRect()
  const badge = page.document.createElement("div")
  badge.textContent = String(index)
  Object.assign(badge.style, {
    position: "fixed",
    top: `${rect.top - BADGE_SIZE_PX / 2}px`,
    left: `${rect.left - BADGE_SIZE_PX / 2}px`,
    background: "#e53e3e",
    color: "#fff",
    borderRadius: "50%",
    width: `${BADGE_SIZE_PX}px`,
    height: `${BADGE_SIZE_PX}px`,
    fontSize: "11px",
    fontWeight: "bold",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: "2147483647",
    pointerEvents: "none",
    fontFamily: "monospace",
    lineHeight: "1",
  })
  return badge
}

/**
 * Paints a numbered badge over every interactive element and answers with the
 * map a vision model reads back. The badges live in a closed shadow root, so
 * neither the page's CSS nor its scripts can see or restyle them; an element
 * with no box at all is skipped entirely - no badge and no label, so its number
 * is missing from the map.
 */
export function annotateElements(params: JsonObject, page: Page): JsonValue {
  const maxElements = numberParam(params.maxElements, DEFAULT_MAX_ELEMENTS)
  page.document.getElementById(ANNOTATION_HOST_ID)?.remove()
  const host = page.document.createElement("div")
  host.id = ANNOTATION_HOST_ID
  page.document.body.appendChild(host)
  const shadow = host.attachShadow({ mode: "closed" })

  const labels: JsonObject = {}
  collect(page, maxElements).forEach((element, position) => {
    const index = position + 1
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) {
      return
    }
    shadow.appendChild(badgeFor(page, element, index))
    labels[String(index)] = {
      selector: selectorFor(page, element),
      text: labelText(element),
      role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
    }
  })
  return { labels, count: Object.keys(labels).length }
}

/** Drops the badges again; a page that has none answers just the same. */
export function removeAnnotations(_params: JsonObject, page: Page): JsonValue {
  page.document.getElementById(ANNOTATION_HOST_ID)?.remove()
  return { removed: true }
}
