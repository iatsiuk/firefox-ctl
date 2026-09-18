// The one selector generator every read command shares. Its guarantee is
// narrow: the returned selector matches exactly one element in the light DOM
// of the page document and that element is the one described. It says nothing
// about surviving a re-render. Every candidate is verified before it is
// returned; when none verifies the caller gets `SelectorUnavailable` rather
// than a string that may point at the wrong element.

import type { Page } from "./page"

/** No candidate described the element: shadow DOM, detached or too ambiguous. */
export class SelectorUnavailable extends Error {}

// an id that looks machine-generated is demoted below the classes, never dropped
const generatedId = [/^\d+$/, /[0-9a-fA-F]{6}/, /-\d+$/]

const cssStringEscapes: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\a ",
  "\r": "\\d ",
  "\f": "\\c ",
}

export function classTokens(element: Element): string[] {
  const names = element.className
  if (typeof names !== "string" || !names) {
    return []
  }
  // a Tailwind-style `hover:` prefix needs escaping the utility rarely survives
  return names.split(/\s+/).filter((name) => name && !name.includes(":"))
}

/** True for ids a framework most likely minted, such as `ember1234` or `tab-3`. */
export function looksGenerated(id: string): boolean {
  return generatedId.some((pattern) => pattern.test(id))
}

/** An attribute value as a double-quoted CSS string. */
export function cssString(value: string): string {
  return `"${value.replace(/[\\"\n\r\f]/g, (char) => cssStringEscapes[char] ?? char)}"`
}

/** The contract: exactly one match and that match is the element itself. */
export function verified(page: Page, selector: string, element: Element): boolean {
  try {
    const matches = page.document.querySelectorAll(selector)
    return matches.length === 1 && matches[0] === element
  } catch {
    return false
  }
}

function segment(element: Element): string {
  const tag = element.tagName.toLowerCase()
  const parent = element.parentElement
  if (parent === null) {
    return tag
  }
  const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName)
  return siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(element) + 1})` : tag
}

/** A child path rooted at `body`, or null when the element hangs off no root. */
function tagPath(page: Page, element: Element): string | null {
  const segments: string[] = []
  let current: Element | null = element
  while (current !== null) {
    segments.unshift(segment(current))
    if (current === page.document.body || current === page.document.documentElement) {
      return segments.join(" > ")
    }
    current = current.parentElement
  }
  return null
}

function attributeCandidate(element: Element, name: string): string | null {
  const value = element.getAttribute(name)
  return value ? `[${name}=${cssString(value)}]` : null
}

function candidates(page: Page, element: Element): string[] {
  const list: string[] = []
  for (const name of ["data-testid", "aria-label"]) {
    const candidate = attributeCandidate(element, name)
    if (candidate !== null) {
      list.push(candidate)
    }
  }
  const id = element.id
  const idSelector = id ? `#${page.cssEscape(id)}` : null
  const classes = classTokens(element)
  const classSelector =
    classes.length > 0 ? classes.map((name) => `.${page.cssEscape(name)}`).join("") : null
  if (idSelector !== null && !looksGenerated(id)) {
    list.push(idSelector)
  }
  if (classSelector !== null) {
    list.push(classSelector)
  }
  if (idSelector !== null && looksGenerated(id)) {
    list.push(idSelector)
  }
  const path = tagPath(page, element)
  if (path !== null) {
    list.push(path)
  }
  return list
}

/** A verified selector for this element, or `SelectorUnavailable`. */
export function uniqueSelector(page: Page, element: Element): string {
  for (const candidate of candidates(page, element)) {
    if (verified(page, candidate, element)) {
      return candidate
    }
  }
  throw new SelectorUnavailable(`no unique selector for ${element.tagName.toLowerCase()}`)
}
