// The visibility tests the page actions share: `isRendered`, the interaction
// gate, and `isDisplayNone`, the extraction gate.

import type { Page } from "./page"

export function isRendered(page: Page, element: Element): boolean {
  const rect = element.getBoundingClientRect()
  const styles = page.window.getComputedStyle(element)
  return (
    rect.width > 0 && rect.height > 0 && styles.display !== "none" && styles.visibility !== "hidden"
  )
}

/**
 * `display: none` on the element or one of its ancestors: the subtree the
 * browser never lays out. Not an interaction gate like `isRendered`: a zero
 * box, `visibility: hidden` and `display: contents` all leave text on screen,
 * so none of them counts here.
 */
export function isDisplayNone(page: Page, element: Element): boolean {
  let node: Element | null = element
  while (node !== null) {
    if (page.window.getComputedStyle(node).display === "none") {
      return true
    }
    node = node.parentElement
  }
  return false
}
