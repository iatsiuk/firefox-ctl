// Arbitrary expression evaluation in the content script's isolated world. The
// opt-in that guards this action lives in the background page, which refuses
// the command before any message reaches the tab; there is no length cap or
// pattern blocklist, as the socket protects everything equally.

import type { JsonObject, JsonValue } from "../protocol"
import type { Page } from "./page"

/** JSON round-trip, falling back to the string form for anything unserialisable. */
function serialise(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch {
    return String(value)
  }
}

export function evaluate(params: JsonObject, _page: Page): JsonValue {
  const expression = params.expression
  if (!expression || typeof expression !== "string") {
    throw new Error("expression is required")
  }

  try {
    // the Function constructor keeps the local scope of this module out of reach
    const value: unknown = new Function(`return (${expression})`)()
    return { expression, result: serialise(value), type: typeof value }
  } catch (error) {
    // a failing expression is a successful reply, not an error
    return {
      expression,
      error: error instanceof Error ? error.message : String(error),
      type: "error",
    }
  }
}
