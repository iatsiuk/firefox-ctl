// Selector validation and lookup shared by every DOM action. The error texts
// are pinned by test/fixtures/errors.json.

import type { Page } from "./page"
import { nextFrame, sleep } from "./timing"

const maxSelectorLength = 1000

/** Poll settings for the autoWait retry. */
export const autoWaitTimeout = 5000
const pollInterval = 100

export interface QueryOptions {
  autoWait?: boolean
  timeout?: number
}

export function validateSelector(page: Page, selector: unknown): string {
  if (!selector || typeof selector !== "string") {
    throw new Error("selector is required and must be a string")
  }
  if (!selector.trim()) {
    throw new Error("selector cannot be empty")
  }
  if (selector.length > maxSelectorLength) {
    throw new Error(`selector too long (max ${maxSelectorLength} characters)`)
  }
  try {
    page.document.querySelector(selector)
  } catch (error) {
    throw new Error(`Invalid CSS selector: ${error instanceof Error ? error.message : error}`)
  }
  return selector
}

export function safeQuerySelector(page: Page, selector: unknown): Element | null {
  return page.document.querySelector(validateSelector(page, selector))
}

/**
 * Queries once and, unless auto-wait is off, keeps polling until the element
 * appears or the timeout passes.
 */
export async function smartQuerySelector(
  page: Page,
  selector: unknown,
  options: QueryOptions = {},
): Promise<Element | null> {
  const { autoWait = true, timeout = autoWaitTimeout } = options
  const valid = validateSelector(page, selector)

  const immediate = page.document.querySelector(valid)
  if (immediate) {
    return immediate
  }
  if (!autoWait) {
    return null
  }

  const start = page.now()
  while (page.now() - start < timeout) {
    await nextFrame(page)
    const element = page.document.querySelector(valid)
    if (element) {
      return element
    }
    await sleep(page, pollInterval)
  }
  return null
}
