// Scrolling and waiting, with their result shapes and mode precedence.

import type { JsonObject, JsonValue } from "../protocol"
import type { Page } from "./page"
import { safeQuerySelector, validateSelector } from "./selector"
import { sleep } from "./timing"

const DEFAULT_TIMEOUT = 10000
const DEFAULT_INTERVAL = 100

function numberParam(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback
}

function optionalNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined
}

function stringParam(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function scroll(params: JsonObject, page: Page): JsonValue {
  const behavior = stringParam(params.behavior) ?? "smooth"
  const win = page.window

  if (params.selector) {
    const element = safeQuerySelector(page, params.selector)
    if (!element) {
      throw new Error(`Element not found: ${String(params.selector)}`)
    }
    element.scrollIntoView({ behavior: behavior as ScrollBehavior, block: "center" })
    const rect = element.getBoundingClientRect()
    return {
      selector: String(params.selector),
      scrolledTo: true,
      elementPosition: { x: rect.x, y: rect.y },
    }
  }

  const x = optionalNumber(params.x)
  const y = optionalNumber(params.y)
  if (x !== undefined || y !== undefined) {
    const beforeX = win.scrollX
    const beforeY = win.scrollY
    win.scrollTo({ left: x ?? beforeX, top: y ?? beforeY, behavior: behavior as ScrollBehavior })
    const afterX = win.scrollX
    const afterY = win.scrollY
    return {
      scrolledTo: true,
      // a background tab never moves; the background handler explains why
      noEffect: afterX === beforeX && afterY === beforeY,
      position: { x: afterX, y: afterY },
    }
  }

  return {
    position: { x: win.scrollX, y: win.scrollY },
    pageHeight: page.document.documentElement.scrollHeight,
    viewportHeight: win.innerHeight,
  }
}

async function waitForText(params: JsonObject, page: Page, text: string): Promise<JsonValue> {
  const timeout = numberParam(params.timeout, DEFAULT_TIMEOUT)
  const interval = numberParam(params.interval, DEFAULT_INTERVAL)
  const start = page.now()

  while (page.now() - start < timeout) {
    const body = page.document.body
    if (body?.innerText.includes(text)) {
      return { text, found: true, elapsed: page.now() - start }
    }
    // never sleep past the timeout, even when interval is larger
    await sleep(page, Math.min(interval, timeout - (page.now() - start)))
  }
  throw new Error(`Timeout waiting for text: "${text}"`)
}

async function waitForSelector(params: JsonObject, page: Page): Promise<JsonValue> {
  const timeout = numberParam(params.timeout, DEFAULT_TIMEOUT)
  const interval = numberParam(params.interval, DEFAULT_INTERVAL)
  const selector = validateSelector(page, params.selector)
  const start = page.now()

  while (page.now() - start < timeout) {
    const element = page.document.querySelector(selector)
    if (element) {
      const rect = element.getBoundingClientRect()
      return {
        selector,
        found: true,
        elapsed: page.now() - start,
        visible: rect.width > 0 && rect.height > 0,
        position: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }
    }
    // never sleep past the timeout, even when interval is larger
    await sleep(page, Math.min(interval, timeout - (page.now() - start)))
  }
  throw new Error(`Timeout waiting for element: ${selector}`)
}

/**
 * Text, then selector: the precedence for the modes this document
 * owns. A URL wait never reaches here, the background handler answers it.
 */
export function waitFor(params: JsonObject, page: Page): Promise<JsonValue> {
  const text = stringParam(params.text)
  if (text !== undefined) {
    return waitForText(params, page, text)
  }
  // with no mode at all this raises the selector validation error
  return waitForSelector(params, page)
}
