// In-browser messaging, the channel that carries `browser.runtime.sendMessage`
// and `browser.tabs.sendMessage` payloads. Unrelated to the native wire
// contract in protocol.ts: these frames never leave Firefox.

import type { JsonObject, JsonValue } from "./protocol"

/** Action the background page answers about the native link. */
export const CONNECTION_STATUS = "getConnectionStatus"

export interface ActionMessage {
  action: string
  params?: JsonObject
}

/** A content script answer; shaped like ExtensionResponse without the frame id. */
export type ActionResponse =
  | { success: true; result: JsonValue }
  | { success: false; error: string }

export function isActionMessage(message: unknown): message is ActionMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    typeof (message as { action?: unknown }).action === "string"
  )
}

export function hasAction(message: unknown, action: string): boolean {
  return isActionMessage(message) && message.action === action
}
