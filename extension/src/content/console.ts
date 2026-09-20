// Console capture: a bounded log of what the content world printed, plus the
// page's uncaught errors and rejections. Opt-in: the first
// getConsoleLogs wraps the console, so nothing is recorded until a caller asks.
//
// Scope: the wrapper sits on the content script's own console. Firefox isolates
// that world from page scripts, so the site's own console calls are not seen;
// what does cross the boundary are uncaught errors and unhandled rejections,
// and anything `evaluate` prints, because it runs in this world. The result
// says so through `scope: "content-world"`.

import type { JsonObject, JsonValue } from "../protocol"
import type { Page, PageConsole } from "./page"

/** Ring size; the oldest entry is dropped when a new one does not fit. */
export const MAX_LOGS = 500

/** How many error messages `getPageState` reports. */
const PAGE_STATE_ERRORS = 10

const DEFAULT_LIMIT = 100

/** The world the wrapper lives in, reported with every result. */
export const CAPTURE_SCOPE = "content-world"

export type LogLevel = "log" | "warn" | "error" | "info" | "debug"

const LEVELS: readonly LogLevel[] = ["log", "warn", "error", "info", "debug"]

export interface LogEntry {
  level: LogLevel
  timestamp: number
  message: string
}

/** The parts of an `error` event the message is built from. */
interface ErrorEventLike {
  message?: string
  filename?: string
  lineno?: number
  colno?: number
}

interface RejectionEventLike {
  reason?: unknown
}

function describe(arg: unknown): string {
  try {
    return typeof arg === "object" && arg !== null ? JSON.stringify(arg, null, 2) : String(arg)
  } catch {
    return "[Unserializable]"
  }
}

class ConsoleCapture {
  private readonly logs: LogEntry[] = []
  private enabled = false
  private undo?: () => void

  /** Wraps the console and listens for page errors; a second call is a no-op. */
  enable(page: Page): void {
    if (this.enabled) {
      return
    }
    this.enabled = true
    const originals: PageConsole = { ...page.console }
    for (const level of LEVELS) {
      const original = originals[level]
      page.console[level] = (...args: unknown[]): void => {
        this.record(level, args, page)
        original(...args)
      }
    }
    const onError = (event: ErrorEventLike): void => {
      const where = `${event.filename}:${event.lineno}:${event.colno}`
      this.record("error", [`Uncaught Error: ${event.message} at ${where}`], page)
    }
    const onRejection = (event: RejectionEventLike): void => {
      this.record("error", [`Unhandled Promise Rejection: ${String(event.reason)}`], page)
    }
    page.window.addEventListener("error", onError as EventListener)
    page.window.addEventListener("unhandledrejection", onRejection as EventListener)
    this.undo = () => {
      Object.assign(page.console, originals)
      page.window.removeEventListener("error", onError as EventListener)
      page.window.removeEventListener("unhandledrejection", onRejection as EventListener)
    }
  }

  /**
   * `clear` semantics: the filtered list is built first and the
   * buffer emptied afterwards, so the reply carries the old logs with a `total`
   * of 0.
   */
  query(params: JsonObject, page: Page): JsonValue {
    this.enable(page)
    const level = typeof params.level === "string" ? params.level : undefined
    const limit = typeof params.limit === "number" ? params.limit : DEFAULT_LIMIT
    const matched = level === undefined ? this.logs : this.logs.filter((e) => e.level === level)
    const logs = (limit <= 0 ? [] : matched.slice(-limit)).map((entry) => ({ ...entry }))
    if (params.clear === true) {
      this.logs.length = 0
    }
    return {
      logs,
      total: this.logs.length,
      filtered: logs.length,
      captureEnabled: this.enabled,
      scope: CAPTURE_SCOPE,
    }
  }

  /** The messages of the newest error entries, for `getPageState`. */
  errors(limit: number): string[] {
    if (limit <= 0) {
      return []
    }
    return this.logs
      .filter((entry) => entry.level === "error")
      .slice(-limit)
      .map((entry) => entry.message)
  }

  /** Restores the console and drops every entry; tests start from silence. */
  reset(): void {
    this.undo?.()
    this.undo = undefined
    this.enabled = false
    this.logs.length = 0
  }

  private record(level: LogLevel, args: unknown[], page: Page): void {
    if (!this.enabled) {
      return
    }
    this.logs.push({
      level,
      timestamp: page.now(),
      message: args.map(describe).join(" "),
    })
    if (this.logs.length > MAX_LOGS) {
      this.logs.shift()
    }
  }
}

// one buffer per document: the top document and a watched child frame of the
// same tab each own their logs, and a second injection into one document finds
// the capture its predecessor installed rather than wrapping the console twice
const captures = new WeakMap<Window, ConsoleCapture>()

function captureFor(page: Page): ConsoleCapture {
  const existing = captures.get(page.window)
  if (existing) {
    return existing
  }
  const capture = new ConsoleCapture()
  captures.set(page.window, capture)
  return capture
}

export function getConsoleLogs(params: JsonObject, page: Page): JsonValue {
  return captureFor(page).query(params, page)
}

export function capturedErrors(page: Page, limit: number = PAGE_STATE_ERRORS): string[] {
  return captures.get(page.window)?.errors(limit) ?? []
}

/**
 * Restores this document's console and drops its entries. A frame the registry
 * deactivates leaves the page as it found it; tests start from silence.
 */
export function resetConsoleCapture(page: Page): void {
  captures.get(page.window)?.reset()
  captures.delete(page.window)
}
