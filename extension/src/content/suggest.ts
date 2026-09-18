// Diagnostics for a selector that matched nothing: near-miss candidates for
// the failed selector and the multi-line error the interaction actions throw,
// with search caps and reason wording. Every suggested selector comes from the
// shared generator, so it is verified before it is offered.

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

/** The text of every `label[for]`, keyed by the id the label points at. */
function labelTexts(page: Page): Map<string, string> {
  const texts = new Map<string, string>()
  for (const label of scan(page, "label[for]")) {
    const target = label.getAttribute("for") ?? ""
    if (target && !texts.has(target)) {
      texts.set(target, (label.textContent ?? "").trim())
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

/** Candidates for a selector that matched nothing, best-effort and deduplicated. */
export function findSelectorAlternatives(page: Page, failedSelector: string): Alternative[] {
  const alternatives: Alternative[] = []
  const seen = new Set<string>()

  function add(element: Element, reason: string): void {
    if (alternatives.length >= maxAlternatives) {
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
    alternatives.push({ selector, reason })
  }

  function full(): boolean {
    return alternatives.length >= maxAlternatives
  }

  const hint = textHint(failedSelector).toLowerCase()

  const idMatch = failedSelector.match(/#([a-zA-Z0-9_-]+)/)
  if (idMatch?.[1] && !full()) {
    const wanted = idMatch[1].toLowerCase()
    for (const element of scan(page, "[id]")) {
      if (element.id.toLowerCase().includes(wanted)) {
        add(element, "Similar ID found")
      }
    }
  }

  const classMatch = failedSelector.match(/\.([a-zA-Z0-9_-]+)/)
  if (classMatch?.[1] && !full()) {
    const wanted = classMatch[1].toLowerCase()
    for (const element of scan(page, "[class]")) {
      if (classTokens(element).some((name) => name.toLowerCase().includes(wanted))) {
        add(element, "Similar class found")
      }
    }
  }

  const wantedName = attributeLiteral(failedSelector, "name")
  if (wantedName && !full()) {
    const fields = byAttributeValue(page, wantedName, fieldSelector, attributeOf("name"))
    for (const element of fields) {
      add(element, "Similar input name found")
    }
  }

  const wantedTestId = attributeLiteral(failedSelector, "data-testid")
  if (wantedTestId && !full()) {
    const tagged = byAttributeValue(page, wantedTestId, "[data-testid]", attributeOf("data-testid"))
    for (const element of tagged) {
      add(element, "Similar data-testid found")
    }
  }

  const isButtonSelector = failedSelector.includes("button") || failedSelector.includes("btn")
  if ((isButtonSelector || hint) && !full()) {
    const controls = scan(
      page,
      'button, [role="button"], input[type="submit"], input[type="button"]',
    )
    for (const element of controls) {
      const text = controlText(element)
      const label = (element.getAttribute("aria-label") ?? "").toLowerCase()
      const matches =
        (hint && (text.toLowerCase().includes(hint) || label.includes(hint))) ||
        (isButtonSelector && text)
      if (matches) {
        add(element, `Button: "${text.slice(0, reasonTextLimit)}"`)
      }
    }
  }

  const isLinkSelector = failedSelector.includes("a[") || failedSelector.includes("link")
  if ((isLinkSelector || hint) && !full()) {
    for (const element of scan(page, "a[href]")) {
      const text = (element.textContent ?? "").trim()
      if (hint && text.toLowerCase().includes(hint)) {
        add(element, `Link: "${text.slice(0, reasonTextLimit)}"`)
      }
    }
  }

  if (hint && !full()) {
    const labels = labelTexts(page)
    for (const element of scan(page, fieldSelector)) {
      const described = [
        labels.get(element.id) ?? "",
        element.getAttribute("placeholder") ?? "",
        element.getAttribute("aria-label") ?? "",
      ]
      if (described.some((value) => value.toLowerCase().includes(hint))) {
        const name = described.find((value) => value !== "") ?? ""
        add(element, `Input: "${name.slice(0, reasonTextLimit)}"`)
      }
    }
  }

  if (hint && !full()) {
    for (const element of scan(page, "[aria-label]")) {
      const label = element.getAttribute("aria-label") ?? ""
      if (label.toLowerCase().includes(hint)) {
        add(element, `aria-label="${label}"`)
      }
    }
  }

  return alternatives
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
  const lines = [`Element not found: ${selector}`]

  const suggestions = findSelectorAlternatives(page, selector)
  if (suggestions.length > 0) {
    lines.push("", "Suggested alternatives:")
    for (const suggestion of suggestions) {
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
