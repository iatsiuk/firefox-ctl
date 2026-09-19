// The interaction page actions: clicking, typing and key presses, with their
// result shapes and key code maps.

import type { JsonObject, JsonValue } from "../protocol"
import type { Page } from "./page"
import {
  autoWaitTimeout,
  pollUntil,
  safeQuerySelector,
  smartQuerySelector,
  validateSelector,
} from "./selector"
import { buildElementNotFoundError, buildTextNotFoundError } from "./suggest"
import { findByText, resolveTarget, scopeRoot } from "./text-target"
import { nextFrame } from "./timing"
import { SelectorUnavailable, uniqueSelector } from "./unique-selector"

const CLICK_TEXT_LIMIT = 100

/** Candidates named in an `AMBIGUOUS_TEXT` message before the count takes over. */
const AMBIGUOUS_LIMIT = 5

/** The `code` map; anything else keeps the key name or becomes `Key<X>`. */
const keyCodes: Record<string, string> = {
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  " ": "Space",
}

/** The legacy keyCode map; a single character falls back to its code point. */
const keyNumbers: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  " ": 32,
}

type Editable = HTMLElement & { value?: string }

function numberParam(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback
}

function boolParam(value: JsonValue | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

/** Looks the selector up, auto-waiting, and reports the diagnostics on a miss. */
async function requireElement(
  params: JsonObject,
  page: Page,
  operation: string,
): Promise<{ selector: string; element: HTMLElement }> {
  const selector = validateSelector(page, params.selector)
  const element = await smartQuerySelector(page, selector, {
    autoWait: boolParam(params.autoWait, true),
    timeout: numberParam(params.waitTimeout, autoWaitTimeout),
  })
  if (!element) {
    throw buildElementNotFoundError(page, selector, operation)
  }
  return { selector, element: element as HTMLElement }
}

/** A verified selector for the element, or `null` when nothing describes it. */
function describeTarget(page: Page, element: Element): string | null {
  try {
    return uniqueSelector(page, element)
  } catch (error) {
    if (error instanceof SelectorUnavailable) {
      return null
    }
    throw error
  }
}

/** How a candidate is named in the ambiguity message. */
function nameCandidate(page: Page, element: Element): string {
  return describeTarget(page, element) ?? `<${element.tagName.toLowerCase()} (no unique selector)>`
}

function ambiguousText(page: Page, text: string, matches: Element[]): Error {
  const shown = matches.slice(0, AMBIGUOUS_LIMIT).map((match) => nameCandidate(page, match))
  const rest = matches.length - shown.length
  const list = rest > 0 ? [...shown, `and ${rest} more`] : shown
  return new Error(
    `AMBIGUOUS_TEXT: "${text}" matches ${matches.length} elements: ${list.join(", ")}`,
  )
}

/**
 * The one actionable element rendering `text`, scrolled into view and still
 * connected. The scope is resolved again at every probe, so a re-rendered
 * dialog is followed; two or more targets fail at once; a target that detaches
 * during the frame wait sends the search back to the poll loop.
 */
async function requireTextTarget(
  params: JsonObject,
  page: Page,
  text: string,
  scope: string | null,
): Promise<HTMLElement> {
  const autoWait = boolParam(params.autoWait, true)
  const deadline = page.now() + numberParam(params.waitTimeout, autoWaitTimeout)
  const probe = (): HTMLElement | null => {
    const matches = findByText(page, text, scopeRoot(page, scope), "actionable")
    if (matches.length > 1) {
      throw ambiguousText(page, text, matches)
    }
    return (matches[0] as HTMLElement) ?? null
  }

  for (;;) {
    const element = await pollUntil(page, probe, {
      autoWait,
      timeout: Math.max(deadline - page.now(), 0),
    })
    if (element === null) {
      throw buildTextNotFoundError(page, text)
    }
    element.scrollIntoView({ behavior: "smooth", block: "center" })
    // let the smooth scroll settle before the click lands
    await nextFrame(page)
    if (element.isConnected) {
      return element
    }
    if (!autoWait || page.now() >= deadline) {
      throw buildTextNotFoundError(page, text)
    }
  }
}

function clickResult(element: HTMLElement, selector: string | null, matchedBy: string): JsonValue {
  return {
    selector,
    clicked: true,
    tagName: element.tagName.toLowerCase(),
    text: element.textContent?.trim().slice(0, CLICK_TEXT_LIMIT) || "",
    id: element.id || null,
    className: element.className || null,
    matchedBy,
  }
}

export async function click(params: JsonObject, page: Page): Promise<JsonValue> {
  const target = resolveTarget(page, params)

  if (target.mode === "selector") {
    const { selector, element } = await requireElement(params, page, "click")
    element.scrollIntoView({ behavior: "smooth", block: "center" })
    // let the smooth scroll settle before the click lands
    await nextFrame(page)
    element.click()
    return clickResult(element, selector, "selector")
  }

  const element = await requireTextTarget(params, page, target.text, target.scope)
  // generated before the click: a click that removes its own element or starts
  // a navigation must not be reported as failed
  const selector = describeTarget(page, element)
  element.click()
  return clickResult(element, selector, "text")
}

function setInputValue(page: Page, element: Editable, value: string): void {
  const setter = page.inputValueSetter(element)
  if (setter === undefined) {
    element.value = value
    return
  }
  setter(value)
}

export async function type(params: JsonObject, page: Page): Promise<JsonValue> {
  if (params.text === undefined) {
    throw new Error("text is required")
  }
  const text = String(params.text)
  const clear = boolParam(params.clear, true)
  const { selector, element } = await requireElement(params, page, "type")

  const tag = element.tagName
  const isInput = tag === "INPUT" || tag === "TEXTAREA"
  if (!isInput && !element.isContentEditable) {
    throw new Error(`Element is not editable: ${selector}`)
  }

  element.focus()

  if (isInput) {
    const input = element as Editable
    setInputValue(page, input, clear ? text : (input.value ?? "") + text)
    // an InputEvent carries the intent frameworks look for
    element.dispatchEvent(
      new page.InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text,
      }),
    )
    element.dispatchEvent(new page.Event("change", { bubbles: true }))
  } else {
    if (clear) {
      element.textContent = ""
    }
    element.textContent += text
    element.dispatchEvent(new page.Event("input", { bubbles: true }))
  }

  return {
    selector,
    typed: text,
    currentValue: isInput ? ((element as Editable).value ?? "") : element.textContent,
  }
}

function codeOf(key: string): string {
  return keyCodes[key] ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key)
}

function numberOf(key: string): number {
  const mapped = keyNumbers[key]
  if (mapped !== undefined) {
    return mapped
  }
  return key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0
}

function keyTarget(params: JsonObject, page: Page): HTMLElement {
  if (!params.selector) {
    return (page.document.activeElement ?? page.document.body) as HTMLElement
  }
  const element = safeQuerySelector(page, params.selector)
  if (!element) {
    throw new Error(`Element not found: ${String(params.selector)}`)
  }
  const target = element as HTMLElement
  target.focus()
  return target
}

export function pressKey(params: JsonObject, page: Page): JsonValue {
  const key = params.key
  if (!key || typeof key !== "string") {
    throw new Error("key is required")
  }
  const modifiers = {
    ctrlKey: boolParam(params.ctrlKey, false),
    shiftKey: boolParam(params.shiftKey, false),
    altKey: boolParam(params.altKey, false),
    metaKey: boolParam(params.metaKey, false),
  }
  const target = keyTarget(params, page)

  const init: KeyboardEventInit = {
    key,
    code: codeOf(key),
    keyCode: numberOf(key),
    which: numberOf(key),
    ...modifiers,
    bubbles: true,
    cancelable: true,
  }

  target.dispatchEvent(new page.KeyboardEvent("keydown", init))
  // keypress is deprecated but some sites still listen for it
  if (key.length === 1) {
    target.dispatchEvent(new page.KeyboardEvent("keypress", init))
  }
  target.dispatchEvent(new page.KeyboardEvent("keyup", init))

  return {
    key,
    selector: params.selector ? String(params.selector) : "(active element)",
    targetTag: target.tagName.toLowerCase(),
    modifiers,
  }
}
