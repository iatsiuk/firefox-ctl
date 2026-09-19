// Finding elements by the text a user reads on the page. Pure DOM logic: the
// module takes a `Page` for computed styles and touches no browser global.
// Matching is exact on whitespace-normalised visible text and case-sensitive,
// so `text-transform` changes what matches, as it changes what the user sees.

import type { JsonObject, JsonValue } from "../protocol"
import type { Page } from "./page"
import { validateSelector } from "./selector"
import { isRendered } from "./visibility"

/** The longest text query accepted, measured on the raw value. */
export const TEXT_LIMIT = 500

/** What `click` may press: the nearest one of these wins a text match. */
export const ACTIONABLE =
  "button, a[href], input[type=button], input[type=submit], [role=button], summary, label"

/** Elements whose text the page never renders. */
const excludedTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"])

export type TextMatchMode = "deepest" | "actionable"

export function normaliseText(value: string): string {
  return value.replace(/[\s ]+/g, " ").trim()
}

/**
 * The text the element renders, normalised. `innerText` already drops hidden
 * descendants and turns `<br>` and block boundaries into separators, so a
 * `textContent` prefilter would reject valid matches and is never used.
 */
export function visibleText(element: Element): string {
  const rendered = (element as Partial<HTMLElement>).innerText
  return normaliseText(typeof rendered === "string" ? rendered : (element.textContent ?? ""))
}

function inExcludedSubtree(root: Element, element: Element): boolean {
  let node: Element | null = element
  while (node !== null) {
    if (excludedTags.has(node.tagName.toUpperCase())) {
      return true
    }
    if (node === root) {
      return false
    }
    node = node.parentElement
  }
  return false
}

/** Deep matches first: visible elements whose own text equals the query. */
function collect(page: Page, text: string, root: Element, cache: Map<Element, string>): Element[] {
  const matches: Element[] = []
  for (const candidate of [root, ...root.querySelectorAll("*")]) {
    if (inExcludedSubtree(root, candidate) || !isRendered(page, candidate)) {
      continue
    }
    const own = visibleText(candidate)
    cache.set(candidate, own)
    if (own === text) {
      matches.push(candidate)
    }
  }
  // document order, so a match is deepest when no later match sits inside it
  return matches.filter(
    (match) => !matches.some((other) => other !== match && match.contains(other)),
  )
}

function actionableTarget(
  page: Page,
  text: string,
  root: Element,
  match: Element,
  cache: Map<Element, string>,
): Element | null {
  const target = match.closest(ACTIONABLE)
  if (target === null || !root.contains(target)) {
    return null
  }
  if (!isRendered(page, target)) {
    return null
  }
  const own = cache.get(target) ?? visibleText(target)
  return own === text ? target : null
}

/**
 * Every element under `root` rendering exactly `text`. `deepest` answers the
 * innermost matches; `actionable` maps each of those to the nearest actionable
 * ancestor-or-self inside the root and deduplicates by identity.
 */
export function findByText(
  page: Page,
  text: string,
  root: Element,
  mode: TextMatchMode,
): Element[] {
  const cache = new Map<Element, string>()
  const deepest = collect(page, text, root, cache)
  if (mode === "deepest") {
    return deepest
  }
  const targets: Element[] = []
  for (const match of deepest) {
    const target = actionableTarget(page, text, root, match, cache)
    if (target !== null && !targets.includes(target)) {
      targets.push(target)
    }
  }
  return targets
}

/** Which parameter names the target; the selector is passed through unvalidated. */
export type Target =
  | { mode: "selector"; selector: unknown }
  | { mode: "text"; text: string; scope: string | null }

function requireText(value: JsonValue | undefined): string {
  if (typeof value !== "string") {
    throw new Error("text must be a string")
  }
  const text = normaliseText(value)
  if (text === "") {
    throw new Error("text cannot be empty")
  }
  if (value.length > TEXT_LIMIT) {
    throw new Error(`text too long (max ${TEXT_LIMIT} characters)`)
  }
  return text
}

// the empty check comes first so validateSelector never answers its own
// "selector is required" message for a scope the caller did name
function requireScope(page: Page, value: JsonValue | undefined): string {
  if (typeof value !== "string") {
    throw new Error("scope must be a string")
  }
  if (!value.trim()) {
    throw new Error("scope cannot be empty")
  }
  return validateSelector(page, value)
}

/**
 * The parameter contract `click` and `getElementInfo` share: `selector` and
 * `text` are mutually exclusive by presence, never by truthiness, and `scope`
 * only comes with `text`. Nothing is looked up here.
 */
export function resolveTarget(page: Page, params: JsonObject): Target {
  const hasSelector = "selector" in params
  const hasText = "text" in params
  if (hasSelector && hasText) {
    throw new Error("selector and text are mutually exclusive")
  }
  if ("scope" in params && !hasText) {
    throw new Error("scope requires text")
  }
  if (hasText) {
    const text = requireText(params.text)
    const scope = "scope" in params ? requireScope(page, params.scope) : null
    return { mode: "text", text, scope }
  }
  if (!hasSelector) {
    throw new Error("selector is required and must be a string")
  }
  return { mode: "selector", selector: params.selector }
}

/** The element a text search starts from: the whole page, or the one scope match. */
export function scopeRoot(page: Page, scope: string | null): Element {
  if (scope === null) {
    return page.document.documentElement
  }
  const found = page.document.querySelectorAll(scope)
  const root = found[0]
  if (root === undefined) {
    throw new Error(`Scope not found: ${scope}`)
  }
  if (found.length > 1) {
    throw new Error(`Scope is ambiguous: ${scope} matches ${found.length} elements`)
  }
  return root
}
