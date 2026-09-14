// The visibility test the page actions share: a non-zero box
// plus the two computed properties that hide an element without shrinking it.

import type { Page } from "./page"

export function isRendered(page: Page, element: Element): boolean {
  const rect = element.getBoundingClientRect()
  const styles = page.window.getComputedStyle(element)
  return (
    rect.width > 0 && rect.height > 0 && styles.display !== "none" && styles.visibility !== "hidden"
  )
}
