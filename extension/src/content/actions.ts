// The action table the content script serves: one entry per page command the
// background page may send, keyed on the name in `commands.json`, plus the
// internal actions no CLI command maps to - steps the background page drives
// on its own, such as the readiness check before a capture.

import { handleConsent } from "./consent"
import { getConsoleLogs } from "./console"
import { evaluate } from "./evaluate"
import { annotateElements, canvasResizer, removeAnnotations, resizeImageAction } from "./image"
import { click, pressKey, type as typeText } from "./interact"
import { getAccessibilitySnapshot, getContent, getElementInfo, getPageState } from "./read"
import { checkPageReadiness } from "./readiness"
import type { ActionMap } from "./registry"
import { scroll, waitFor } from "./wait"

/** Actions the background page drives itself; not commands of their own. */
export const INTERNAL_ACTIONS = [
  "checkPageReadiness",
  "resizeImage",
  "annotateElements",
  "removeAnnotations",
] as const

export const pageActions: ActionMap = {
  getContent,
  click,
  type: typeText,
  pressKey,
  scroll,
  waitFor,
  getPageState,
  getAccessibilitySnapshot,
  getElementInfo,
  evaluate,
  getConsoleLogs,
  handleConsent,
  checkPageReadiness,
  resizeImage: resizeImageAction(canvasResizer),
  annotateElements,
  removeAnnotations,
}
