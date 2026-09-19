// Finding elements by the text a user reads on the page. Pure DOM logic: the
// module takes a `Page` for computed styles and touches no browser global.
// Matching is exact on whitespace-normalised visible text and case-sensitive,
// so `text-transform` changes what matches, as it changes what the user sees.

import type { Page } from "./page"
import { isRendered } from "./visibility"

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
