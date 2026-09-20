// The wire contract with the native host: the frames exchanged over native
// messaging and the command table the dispatcher is keyed on. Mirrors
// `cli/internal/protocol/protocol.go` and changes together with it.

import commandTable from "./commands.json"
import type { Environment } from "./env"

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }

// marks a host->extension frame carrying a CLI command
export const TYPE_COMMAND = "command"

/** A command frame from the host. Go: protocol.HostCommand. */
export interface HostCommand {
  id: string
  type: typeof TYPE_COMMAND
  command: string
  params: JsonObject
}

/**
 * A reply to a host command. `success` is always a real boolean: the host
 * tells replies from extension-initiated requests by its presence.
 */
export type ExtensionResponse =
  | { id: string; success: true; result: JsonValue }
  | { id: string; success: false; error: string }

/** Commands the host answers itself when the extension asks. */
export type HostRequestName = "ping" | "version"

/** An extension-initiated request. The host ignores params, so none are sent. */
export interface ExtensionRequest {
  id: string
  command: HostRequestName
}

/** The host's answer to an ExtensionRequest; the host never replies with a failure. */
export interface HostReply {
  id: string
  success: true
  result: JsonValue
}

/** Every command name the dispatcher may see, in `commands.json` order. */
export type CommandName =
  | "ping"
  | "version"
  | "createWindow"
  | "navigate"
  | "canNavigate"
  | "getWindowMode"
  | "getActiveTab"
  | "getTabs"
  | "listAllTabs"
  | "attachTab"
  | "detachTab"
  | "closeTab"
  | "closeWindow"
  | "getWindows"
  | "resizeWindow"
  | "setViewport"
  | "getContent"
  | "click"
  | "type"
  | "pressKey"
  | "scroll"
  | "waitFor"
  | "screenshot"
  | "handleConsent"
  | "getPageState"
  | "getAccessibilitySnapshot"
  | "getElementInfo"
  | "evaluate"
  | "getConsoleLogs"
  | "getNetworkRequests"
  | "watchFrames"
  | "unwatchFrames"
  | "listFrames"

export const COMMANDS: readonly CommandName[] = commandTable.map((spec) => spec.name as CommandName)

const commandSet: ReadonlySet<string> = new Set<string>(COMMANDS)

export function isCommandName(value: unknown): value is CommandName {
  return typeof value === "string" && commandSet.has(value)
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isHostCommand(frame: unknown): frame is HostCommand {
  if (!isJsonObject(frame)) {
    return false
  }
  return (
    frame.type === TYPE_COMMAND &&
    typeof frame.id === "string" &&
    typeof frame.command === "string" &&
    isJsonObject(frame.params)
  )
}

/** Stable error prefixes; see docs/commands.md. */
export const ERROR_CODES = [
  "TAB_CLOSED",
  "TAB_UNAVAILABLE",
  "NO_TABS",
  "MODE_MISMATCH",
  "RESTRICTED_PAGE",
  "PAGE_LOAD_FAILED",
  "CONTENT_SCRIPT_UNAVAILABLE",
  "CONTENT_SCRIPT_ERROR",
  "UNKNOWN_COMMAND",
  "COMMAND_TIMEOUT",
  "SCREENSHOT_TOO_LARGE",
  "EVALUATE_DISABLED",
  "AMBIGUOUS_TEXT",
  "FRAME_NOT_OBSERVED",
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/**
 * An error whose message reaches the CLI verbatim. The host forwards only the
 * text, so the code travels as the `<CODE>: <text>` prefix.
 */
export class ExtensionError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, text: string) {
    super(`${code}: ${text}`)
    this.name = "ExtensionError"
    this.code = code
  }
}

/** Per-request timeout the host sends; Go: protocol.TimeoutParam. */
export const TIMEOUT_PARAM = "_timeout"

/** The host's own bounds, mirrored so both sides agree on the budget. */
export const MIN_TIMEOUT_MS = 5000
export const MAX_TIMEOUT_MS = 300000
export const DEFAULT_TIMEOUT_MS = 150000

/** How much earlier than the host the extension gives up, so its reply wins. */
export const TIMEOUT_MARGIN_MS = 1000

/** The deadline one command runs under, fixed when its frame arrives. */
export interface CommandContext {
  readonly budgetMs: number
  readonly deadlineAt: number
}

/**
 * The time the extension has to answer one command. `_timeout` is read exactly
 * as the host reads it - a JSON number, truncated towards zero, out-of-range or
 * non-numeric values falling back to the default - minus the reply margin.
 */
export function requestBudgetMs(params: JsonObject): number {
  const raw = params[TIMEOUT_PARAM]
  const ms = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : Number.NaN
  const timeout = ms >= MIN_TIMEOUT_MS && ms <= MAX_TIMEOUT_MS ? ms : DEFAULT_TIMEOUT_MS
  return timeout - TIMEOUT_MARGIN_MS
}

/** The budget turned into an absolute deadline on the injected clock. */
export function commandContext(params: JsonObject, env: Environment): CommandContext {
  const budgetMs = requestBudgetMs(params)
  return { budgetMs, deadlineAt: env.now() + budgetMs }
}

/** The params a handler sees: the transport's own timeout is not one of them. */
export function withoutRequestTimeout(params: JsonObject): JsonObject {
  if (!Object.hasOwn(params, TIMEOUT_PARAM)) {
    return params
  }
  const stripped: JsonObject = { ...params }
  delete stripped[TIMEOUT_PARAM]
  return stripped
}
