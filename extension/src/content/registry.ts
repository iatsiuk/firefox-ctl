// The content script's action table: the name the background page sends maps to
// a function over the injected Page, and every outcome becomes an ActionResponse.

import type { ActionMessage, ActionResponse } from "../messages"
import type { JsonObject, JsonValue } from "../protocol"
import type { Page } from "./page"

export type Action = (params: JsonObject, page: Page) => JsonValue | Promise<JsonValue>

export type ActionMap = Record<string, Action>

function normaliseParams(params: unknown): JsonObject {
  if (params === undefined) {
    return {}
  }
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("params must be an object")
  }
  return params as JsonObject
}

export async function handleAction(
  actions: ActionMap,
  page: Page,
  message: ActionMessage,
): Promise<ActionResponse> {
  try {
    const params = normaliseParams(message.params)
    const action = actions[message.action]
    if (action === undefined || !Object.hasOwn(actions, message.action)) {
      throw new Error(`Unknown action: ${message.action}`)
    }
    return { success: true, result: await action(params, page) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
