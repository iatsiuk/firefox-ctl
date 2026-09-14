// Diagnostics for a selector that matched nothing: a stable selector for an
// element, near-miss candidates for the failed selector and the multi-line
// error the interaction actions throw, with search caps and reason wording.

import type { Page } from "./page"

export interface Alternative {
  selector: string
  reason: string
}

// caps: elements scanned per category and suggestions reported
const maxSearch = 100
const maxAlternatives = 5
const reasonTextLimit = 30

function countMatches(page: Page, selector: string): number {
  try {
    return page.document.querySelectorAll(selector).length
  } catch {
    return 0
  }
}

function classTokens(element: Element): string[] {
  const names = element.className
  if (typeof names !== "string" || !names) {
    return []
  }
  // a Tailwind-style `hover:` prefix needs escaping the utility rarely survives
  return names.split(/\s+/).filter((name) => name && !name.includes(":"))
}

function tagPath(page: Page, element: Element): string {
  const segments: string[] = []
  let current: Element | null = element
  while (current !== null && current !== page.document.body) {
    const parent: Element | null = current.parentElement
    let segment = current.tagName.toLowerCase()
    if (parent !== null) {
      const tag = current.tagName
      const siblings = Array.from(parent.children).filter((child) => child.tagName === tag)
      if (siblings.length > 1) {
        segment += `:nth-of-type(${siblings.indexOf(current) + 1})`
      }
    }
    segments.unshift(segment)
    current = parent
  }
  return segments.join(" > ")
}

/** The shortest selector that picks out this element alone: id, classes, aria-label, path. */
export function generateUniqueSelector(page: Page, element: Element): string {
  if (element.id) {
    return `#${element.id}`
  }

  const classes = classTokens(element)
  if (classes.length > 0) {
    const classSelector = classes.map((name) => `.${page.cssEscape(name)}`).join("")
    if (countMatches(page, classSelector) === 1) {
      return classSelector
    }
  }

  const ariaLabel = element.getAttribute("aria-label")
  if (ariaLabel) {
    const ariaSelector = `[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`
    if (countMatches(page, ariaSelector) === 1) {
      return ariaSelector
    }
  }

  return tagPath(page, element)
}

function scan(page: Page, selector: string): Element[] {
  return Array.from(page.document.querySelectorAll(selector)).slice(0, maxSearch)
}

function controlText(element: Element): string {
  const value = (element as Element & { value?: string }).value
  return (element.textContent || value || "").trim()
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

  function add(selector: string, reason: string): void {
    if (alternatives.length >= maxAlternatives || seen.has(selector)) {
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
        add(`#${element.id}`, "Similar ID found")
      }
    }
  }

  const classMatch = failedSelector.match(/\.([a-zA-Z0-9_-]+)/)
  if (classMatch?.[1] && !full()) {
    const wanted = classMatch[1].toLowerCase()
    for (const element of scan(page, "[class]")) {
      if (classTokens(element).some((name) => name.toLowerCase().includes(wanted))) {
        add(generateUniqueSelector(page, element), "Similar class found")
      }
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
        add(generateUniqueSelector(page, element), `Button: "${text.slice(0, reasonTextLimit)}"`)
      }
    }
  }

  const isLinkSelector = failedSelector.includes("a[") || failedSelector.includes("link")
  if ((isLinkSelector || hint) && !full()) {
    for (const element of scan(page, "a[href]")) {
      const text = (element.textContent ?? "").trim()
      if (hint && text.toLowerCase().includes(hint)) {
        add(generateUniqueSelector(page, element), `Link: "${text.slice(0, reasonTextLimit)}"`)
      }
    }
  }

  if (hint && !full()) {
    for (const element of scan(page, "[aria-label]")) {
      const label = element.getAttribute("aria-label") ?? ""
      if (label.toLowerCase().includes(hint)) {
        add(generateUniqueSelector(page, element), `aria-label="${label}"`)
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
