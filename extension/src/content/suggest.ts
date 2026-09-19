// Diagnostics for a target that matched nothing: near-miss candidates for the
// failed selector or text and the multi-line error the interaction actions
// throw, with search caps and reason wording. Every suggested selector comes
// from the shared generator, so it is verified before it is offered.

import type { Page } from "./page"
import { classTokens, uniqueSelector } from "./unique-selector"

export interface Alternative {
  selector: string
  reason: string
}

// caps: elements scanned per category and suggestions reported
const maxSearch = 100
const maxAlternatives = 5
const reasonTextLimit = 30

const fieldSelector = "input, textarea, select"

function scan(page: Page, selector: string): Element[] {
  return Array.from(page.document.querySelectorAll(selector)).slice(0, maxSearch)
}

function controlText(element: Element): string {
  const value = (element as Element & { value?: string }).value
  return (element.textContent || value || "").trim()
}

// the value literal of `[name=...]` or `[data-testid=...]`, quoted or bare
function attributeLiteral(failedSelector: string, attribute: string): string {
  const pattern = new RegExp(
    `\\[${attribute}[*~|^$]?=\\s*(?:"([^"]*)"|'([^']*)'|([^\\]\\s]+))`,
    "i",
  )
  const match = failedSelector.match(pattern)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? ""
}

/** `email-1` and `email_1` become `email`; anything else yields nothing. */
function withoutIndexSuffix(value: string): string {
  const stripped = value.replace(/[-_]\d+$/, "")
  return stripped === value ? "" : stripped
}

/**
 * Elements whose attribute contains the wanted value, retried once without a
 * trailing index when the direct pass found nothing.
 */
function byAttributeValue(
  page: Page,
  wanted: string,
  scanSelector: string,
  read: (element: Element) => string,
): Element[] {
  const elements = scan(page, scanSelector)
  const hits = (needle: string): Element[] =>
    needle ? elements.filter((element) => read(element).toLowerCase().includes(needle)) : []
  const direct = hits(wanted.toLowerCase())
  return direct.length > 0 ? direct : hits(withoutIndexSuffix(wanted).toLowerCase())
}

function attributeOf(name: string): (element: Element) => string {
  return (element) => element.getAttribute(name) ?? ""
}

/** The text of every `label[for]`, keyed by the id the label points at; an id can have more than one label. */
function labelTexts(page: Page): Map<string, string[]> {
  const texts = new Map<string, string[]>()
  for (const label of scan(page, "label[for]")) {
    const target = label.getAttribute("for") ?? ""
    if (!target) {
      continue
    }
    const text = (label.textContent ?? "").trim()
    const existing = texts.get(target)
    if (existing) {
      existing.push(text)
    } else {
      texts.set(target, [text])
    }
  }
  return texts
}

function textHint(failedSelector: string): string {
  const contains = failedSelector.match(/:contains\(['"](.+?)['"]\)/i)
  if (contains?.[1]) {
    return contains[1]
  }
  const aria = failedSelector.match(/\[aria-label[*~|^$]?=['"](.+?)['"]\]/i)
  return aria?.[1] ?? ""
}

const controlSelector = 'button, [role="button"], input[type="submit"], input[type="button"]'

interface Collector {
  readonly list: Alternative[]
  add(element: Element, reason: string): void
  full(): boolean
}

/** Collects verified, deduplicated suggestions up to the cap. */
function collector(page: Page): Collector {
  const list: Alternative[] = []
  const seen = new Set<string>()
  return {
    list,
    add(element: Element, reason: string): void {
      if (list.length >= maxAlternatives) {
        return
      }
      let selector: string
      try {
        selector = uniqueSelector(page, element)
      } catch {
        // nothing describes this element uniquely: suggesting it would mislead
        return
      }
      if (seen.has(selector)) {
        return
      }
      seen.add(selector)
      list.push({ selector, reason })
    },
    full(): boolean {
      return list.length >= maxAlternatives
    },
  }
}

/** Controls whose text or `aria-label` contains the hint; `anyWithText` takes every labelled one. */
function buttonPass(page: Page, into: Collector, hint: string, anyWithText: boolean): void {
  if ((hint === "" && !anyWithText) || into.full()) {
    return
  }
  for (const element of scan(page, controlSelector)) {
    const text = controlText(element)
    const label = (element.getAttribute("aria-label") ?? "").toLowerCase()
    const matches =
      (hint !== "" && (text.toLowerCase().includes(hint) || label.includes(hint))) ||
      (anyWithText && text !== "")
    if (matches) {
      into.add(element, `Button: "${text.slice(0, reasonTextLimit)}"`)
    }
  }
}

/** Links whose text contains the hint. */
function linkPass(page: Page, into: Collector, hint: string): void {
  if (hint === "" || into.full()) {
    return
  }
  for (const element of scan(page, "a[href]")) {
    const text = (element.textContent ?? "").trim()
    if (text.toLowerCase().includes(hint)) {
      into.add(element, `Link: "${text.slice(0, reasonTextLimit)}"`)
    }
  }
}

/** Candidates for a selector that matched nothing, best-effort and deduplicated. */
export function findSelectorAlternatives(page: Page, failedSelector: string): Alternative[] {
  const into = collector(page)

  const hint = textHint(failedSelector).toLowerCase()

  const idMatch = failedSelector.match(/#([a-zA-Z0-9_-]+)/)
  if (idMatch?.[1] && !into.full()) {
    const wanted = idMatch[1].toLowerCase()
    for (const element of scan(page, "[id]")) {
      if (element.id.toLowerCase().includes(wanted)) {
        into.add(element, "Similar ID found")
      }
    }
  }

  const classMatch = failedSelector.match(/\.([a-zA-Z0-9_-]+)/)
  if (classMatch?.[1] && !into.full()) {
    const wanted = classMatch[1].toLowerCase()
    for (const element of scan(page, "[class]")) {
      if (classTokens(element).some((name) => name.toLowerCase().includes(wanted))) {
        into.add(element, "Similar class found")
      }
    }
  }

  const wantedName = attributeLiteral(failedSelector, "name")
  if (wantedName && !into.full()) {
    const fields = byAttributeValue(page, wantedName, fieldSelector, attributeOf("name"))
    for (const element of fields) {
      into.add(element, "Similar input name found")
    }
  }

  const wantedTestId = attributeLiteral(failedSelector, "data-testid")
  if (wantedTestId && !into.full()) {
    const tagged = byAttributeValue(page, wantedTestId, "[data-testid]", attributeOf("data-testid"))
    for (const element of tagged) {
      into.add(element, "Similar data-testid found")
    }
  }

  const isButtonSelector = failedSelector.includes("button") || failedSelector.includes("btn")
  buttonPass(page, into, hint, isButtonSelector)
  linkPass(page, into, hint)

  if (hint && !into.full()) {
    const labels = labelTexts(page)
    for (const element of scan(page, fieldSelector)) {
      const described = [
        ...(labels.get(element.id) ?? []),
        element.getAttribute("placeholder") ?? "",
        element.getAttribute("aria-label") ?? "",
      ]
      const matched = described.find((value) => value.toLowerCase().includes(hint))
      if (matched !== undefined) {
        into.add(element, `Input: "${matched.slice(0, reasonTextLimit)}"`)
      }
    }
  }

  if (hint && !into.full()) {
    for (const element of scan(page, "[aria-label]")) {
      const label = element.getAttribute("aria-label") ?? ""
      if (label.toLowerCase().includes(hint)) {
        into.add(element, `aria-label="${label}"`)
      }
    }
  }

  return into.list
}

/**
 * The error an action throws when its selector matched nothing: alternatives,
 * page context and the iframe warning. `operation` is accepted by every call
 * site; the message is the same for every operation.
 */
export function buildElementNotFoundError(
  page: Page,
  selector: string,
  _operation?: string,
): Error {
  return formatNotFound(
    page,
    `Element not found: ${selector}`,
    findSelectorAlternatives(page, selector),
  )
}

/**
 * The error a text target throws when nothing rendered the wanted text. The
 * query is matched literally against control and link text, never parsed as
 * CSS, so `#` and `.` inside it never reach the id and class passes.
 */
export function buildTextNotFoundError(page: Page, text: string): Error {
  const into = collector(page)
  const hint = text.toLowerCase()
  buttonPass(page, into, hint, false)
  linkPass(page, into, hint)
  return formatNotFound(page, `Element not found: text "${text}"`, into.list)
}

/** The shared shape: first line, optional alternatives, page context, hint. */
function formatNotFound(page: Page, firstLine: string, alternatives: Alternative[]): Error {
  const lines = [firstLine]

  if (alternatives.length > 0) {
    lines.push("", "Suggested alternatives:")
    for (const suggestion of alternatives) {
      lines.push(`  - ${suggestion.selector} (${suggestion.reason})`)
    }
  }

  lines.push(
    "",
    "Page context:",
    `  URL: ${page.window.location.href}`,
    `  Title: ${page.document.title}`,
  )
  if (page.window !== page.window.top) {
    lines.push("  Warning: Inside iframe - element may be in parent frame")
  }

  lines.push("", "Hint: Use getPageState to see available elements.")
  return new Error(lines.join("\n"))
}
