// webRequest activity tracker: a bounded log of the requests Firefox made, used
// by getNetworkRequests and by the readiness pipeline that gates screenshots.

import type { Browser, CompletedDetails, ErrorDetails, HttpHeader, RequestDetails } from "./browser"
import type { Environment } from "./env"

/** Ring size; the oldest entry is dropped when a new one does not fit. */
export const MAX_NETWORK_ENTRIES = 200

/** Only requests this recent count towards a tab's activity. */
export const RECENT_WINDOW_MS = 2000

/** Query keys whose values are replaced before an url is stored. */
export const SENSITIVE_PARAMS = [
  "password",
  "passwd",
  "pwd",
  "token",
  "api_key",
  "apikey",
  "secret",
  "auth",
  "key",
  "credential",
]

/** Response header names whose values are replaced unless the user opts out. */
export const SENSITIVE_HEADERS = [
  "set-cookie",
  "cookie",
  "authorization",
  "proxy-authorization",
  "www-authenticate",
  "proxy-authenticate",
]

/** Stands in for a credential header value. */
const REDACTED_HEADER = "[redacted]"

/** Request types that block rendering. */
const CRITICAL_TYPES = [
  "script",
  "stylesheet",
  "xmlhttprequest",
  "fetch",
  "main_frame",
  "sub_frame",
]

/** Request types that only change how the page looks. */
const VISUAL_TYPES = ["image", "font", "media"]

const ALL_URLS = { urls: ["<all_urls>"] }

export type RequestStatus = "pending" | "completed" | "error"

export interface NetworkEntry {
  requestId: string
  url: string
  method: string
  type: string
  tabId: number
  timestamp: number
  status: RequestStatus
  statusCode?: number
  responseHeaders?: HttpHeader[]
  duration?: number
  error?: string
}

export interface NetworkQuery {
  tabId?: number
  type?: string
  status?: string
  clear?: boolean
  limit?: number
  includeHeaders?: boolean
  redact?: boolean
}

export interface NetworkQueryResult {
  requests: NetworkEntry[]
  total: number
  filtered: number
}

export interface TabNetworkStatus {
  pending: number
  pendingByType: Record<string, number>
  criticalPending: number
  visualPending: number
  lastActivity: number
  isIdle: boolean
  isCriticalIdle: boolean
}

export class NetworkTracker {
  private readonly env: Environment
  private readonly entries: NetworkEntry[] = []

  constructor(env: Environment) {
    this.env = env
  }

  attach(browser: Browser): void {
    browser.webRequest.onBeforeRequest.addListener((details) => this.onStarted(details), ALL_URLS)
    browser.webRequest.onCompleted.addListener((details) => this.onCompleted(details), ALL_URLS, [
      "responseHeaders",
    ])
    browser.webRequest.onErrorOccurred.addListener((details) => this.onFailed(details), ALL_URLS)
  }

  /**
   * `clear` semantics: the filtered list is built first and the
   * buffer emptied afterwards, so the reply carries the old requests with a
   * `total` of 0.
   */
  query(query: NetworkQuery = {}): NetworkQueryResult {
    const {
      tabId,
      type,
      status,
      clear = false,
      limit = 50,
      includeHeaders = false,
      redact = false,
    } = query
    const matched = this.entries.filter((entry) => {
      if (tabId !== undefined && entry.tabId !== tabId) {
        return false
      }
      if (type && entry.type !== type) {
        return false
      }
      return !(status && entry.status !== status)
    })
    const requests = (limit <= 0 ? [] : matched.slice(-limit)).map((entry) =>
      copy(entry, includeHeaders, redact),
    )
    if (clear) {
      this.entries.length = 0
    }
    return { requests, total: this.entries.length, filtered: requests.length }
  }

  /** Pending activity of one tab within the recent window, for readiness. */
  tabStatus(tabId: number): TabNetworkStatus {
    const since = this.env.now() - RECENT_WINDOW_MS
    const recent = this.entries.filter((entry) => entry.tabId === tabId && entry.timestamp > since)
    const pending = recent.filter((entry) => entry.status === "pending")
    const pendingByType: Record<string, number> = {}
    for (const entry of pending) {
      pendingByType[entry.type] = (pendingByType[entry.type] ?? 0) + 1
    }
    const criticalPending = pending.filter((entry) => CRITICAL_TYPES.includes(entry.type)).length
    return {
      pending: pending.length,
      pendingByType,
      criticalPending,
      visualPending: pending.filter((entry) => VISUAL_TYPES.includes(entry.type)).length,
      lastActivity: recent.reduce((latest, entry) => Math.max(latest, entry.timestamp), 0),
      isIdle: pending.length === 0,
      isCriticalIdle: criticalPending === 0,
    }
  }

  private onStarted(details: RequestDetails): void {
    // the request body may carry passwords or tokens, so only metadata is kept
    this.entries.push({
      requestId: details.requestId,
      url: redactSensitiveUrl(details.url),
      method: details.method,
      type: details.type,
      tabId: details.tabId,
      timestamp: this.env.now(),
      status: "pending",
    })
    if (this.entries.length > MAX_NETWORK_ENTRIES) {
      this.entries.shift()
    }
  }

  private onCompleted(details: CompletedDetails): void {
    const entry = this.find(details.requestId)
    if (!entry) {
      return
    }
    entry.status = "completed"
    entry.statusCode = details.statusCode
    entry.responseHeaders = details.responseHeaders
    entry.duration = this.env.now() - entry.timestamp
  }

  private onFailed(details: ErrorDetails): void {
    const entry = this.find(details.requestId)
    if (!entry) {
      return
    }
    entry.status = "error"
    entry.error = details.error
    entry.duration = this.env.now() - entry.timestamp
  }

  private find(requestId: string): NetworkEntry | undefined {
    return this.entries.find((entry) => entry.requestId === requestId)
  }
}

/** Replaces the values of query keys that look like credentials. */
export function redactSensitiveUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  let redacted = false
  for (const [key] of parsed.searchParams) {
    if (SENSITIVE_PARAMS.some((param) => key.toLowerCase().includes(param))) {
      parsed.searchParams.set(key, "[REDACTED]")
      redacted = true
    }
  }
  return redacted ? parsed.toString() : url
}

function copy(entry: NetworkEntry, includeHeaders: boolean, redact: boolean): NetworkEntry {
  const { responseHeaders, ...rest } = entry
  if (!(includeHeaders && responseHeaders)) {
    return rest
  }
  // the stored entry keeps the raw values; redaction happens on the way out
  return { ...rest, responseHeaders: redact ? responseHeaders.map(redactHeader) : responseHeaders }
}

function redactHeader(header: HttpHeader): HttpHeader {
  // a fresh object, not a spread: `binaryValue` carries the raw bytes Firefox
  // uses instead of `value` for headers that are not valid UTF-8, and must not
  // survive redaction either
  return SENSITIVE_HEADERS.includes(header.name.toLowerCase())
    ? { name: header.name, value: REDACTED_HEADER }
    : header
}
