// The HAR recorder: while a tab records, webRequest listeners filtered to that
// tab collect every request hop, and webNavigation events group the hops into
// pages. The recorder holds raw data only; src/har.ts turns a stopped
// recording into the HAR log.

import type {
  Browser,
  CompletedDetails,
  ErrorDetails,
  FrameNavigationDetails,
  HeadersReceivedDetails,
  RedirectDetails,
  RequestBody,
  RequestDetails,
  RequestFilter,
  ResponseDetails,
  SendHeadersDetails,
  UploadData,
  WebRequestEvent,
  WebRequestFilterEvent,
} from "./browser"
import type { Environment } from "./env"
import type { HarRecording, HopRecord, PageRecord, RequestBodyShape } from "./har"
import { contentType, postData } from "./har"
import { ExtensionError } from "./protocol"
import { utf8Length } from "./reply"

/** Bytes kept of one request or response body unless startHar says otherwise. */
export const MAX_BODY_DEFAULT = 10 * 1024 * 1024

/** Stored body bytes, request and response alike, one recording may hold. */
export const BODY_BUDGET = 160 * 1024 * 1024

export interface StartOptions {
  /** Bytes kept per body; 0 records metadata only. */
  maxBodySize: number
  /** The url of the document already loaded, the title of the first page. */
  url: string
  /** Overrides BODY_BUDGET, so tests need not allocate it. */
  bodyBudget?: number
}

type NavigationSide = "request" | "before" | "committed"

/**
 * A page and which of its navigation's events arrived. webRequest and
 * webNavigation are separate event streams, so each side binds to the latest
 * page that has not seen it yet, whatever came first.
 */
interface Page extends Record<NavigationSide, boolean> {
  record: PageRecord
}

interface Hop {
  record: HopRecord
  /** Ended by onBeforeRedirect, onCompleted or onErrorOccurred. */
  closed: boolean
  /** The stored prefix of the request body, until stop builds postData. */
  stored?: RequestBody
  cut: boolean
  dropped: boolean
}

interface Recording {
  tabId: number
  start: number
  maxBodySize: number
  /** Body bytes the recording may still store. */
  budget: number
  tabClosed: boolean
  pages: Page[]
  hops: Hop[]
  /** The hop each request is on; a redirect replaces it. */
  current: Map<string, Hop>
  /** The page each top-level navigation request opened or bound to. */
  navigations: Map<string, Page>
  release: (() => void)[]
}

const ALL_URLS = ["<all_urls>"]

export class HarRecorder {
  private readonly recordings = new Map<number, Recording>()

  private browser?: Browser

  constructor(private readonly env: Environment) {}

  /**
   * Installs the tab-close and navigation listeners every recording shares.
   * Once only, like the capture locks: the webRequest listeners, which block,
   * exist only while a tab records.
   */
  attach(browser: Browser): void {
    if (this.browser !== undefined) {
      return
    }
    this.browser = browser
    browser.tabs.onRemoved.addListener((tabId) => {
      this.tabRemoved(tabId)
    })
    const nav = browser.webNavigation
    nav.onBeforeNavigate.addListener((d) => this.navigated(d, "before"))
    nav.onCommitted.addListener((d) => this.navigated(d, "committed"))
    nav.onDOMContentLoaded.addListener((d) => this.timePage(d, "domContentLoaded"))
    nav.onCompleted.addListener((d) => this.timePage(d, "load"))
  }

  isRecording(tabId: number): boolean {
    return this.recordings.has(tabId)
  }

  /** Starts recording the tab and answers the start time. */
  start(tabId: number, options: StartOptions): number {
    const browser = this.browser
    if (browser === undefined) {
      throw new Error("HAR recorder is not attached")
    }
    if (this.recordings.has(tabId)) {
      throw new ExtensionError(
        "HAR_ALREADY_RECORDING",
        `tab ${tabId} is already recording; call stopHar first`,
      )
    }
    const start = this.env.now()
    const recording: Recording = {
      tabId,
      start,
      maxBodySize: options.maxBodySize,
      budget: options.bodyBudget ?? BODY_BUDGET,
      tabClosed: false,
      // the document already loaded: requests before any navigation land here
      pages: [
        {
          record: { id: "page_1", start, title: options.url },
          request: true,
          before: true,
          committed: true,
        },
      ],
      hops: [],
      current: new Map(),
      navigations: new Map(),
      release: [],
    }
    listen(browser, recording, this.hopListeners(recording))
    this.recordings.set(tabId, recording)
    return start
  }

  /** Ends the tab's recording, releases its listeners and hands its data over. */
  stop(tabId: number): HarRecording {
    const recording = this.recordings.get(tabId)
    if (recording === undefined) {
      throw new ExtensionError("HAR_NOT_RECORDING", `no HAR recording on tab ${tabId}`)
    }
    this.recordings.delete(tabId)
    release(recording)
    return {
      tabId,
      start: recording.start,
      maxBodySize: recording.maxBodySize,
      creatorVersion: this.browser?.runtime.getManifest().version ?? "",
      tabClosed: recording.tabClosed,
      pages: recording.pages.map((page) => page.record),
      hops: recording.hops.map(finish),
    }
  }

  // the data stays until stopHar asks for it
  private tabRemoved(tabId: number): void {
    const recording = this.recordings.get(tabId)
    if (recording !== undefined) {
      recording.tabClosed = true
      release(recording)
    }
  }

  private recordingOf(details: FrameNavigationDetails): Recording | undefined {
    if (details.frameId !== 0) {
      return undefined
    }
    return this.recordings.get(details.tabId)
  }

  private navigated(details: FrameNavigationDetails, side: "before" | "committed"): void {
    const recording = this.recordingOf(details)
    if (recording !== undefined) {
      bindPage(recording, side, details.timeStamp, details.url)
    }
  }

  private timePage(details: FrameNavigationDetails, field: "domContentLoaded" | "load"): void {
    const page = this.recordingOf(details)?.pages.at(-1)
    if (page !== undefined) {
      page.record[field] ??= details.timeStamp
    }
  }

  private hopListeners(recording: Recording): HopListeners {
    return {
      beforeRequest: (d) => {
        beforeRequest(recording, d)
        return undefined
      },
      sendHeaders: (d) => sendHeaders(recording, d),
      headersReceived: (d) => {
        headersReceived(recording, d)
        return undefined
      },
      responseStarted: (d) => responseStarted(recording, d),
      beforeRedirect: (d) => ended(recording, d, d.redirectUrl),
      completed: (d) => ended(recording, d),
      errorOccurred: (d) => failed(recording, d),
    }
  }
}

interface HopListeners {
  beforeRequest: (details: RequestDetails) => undefined
  sendHeaders: (details: SendHeadersDetails) => void
  headersReceived: (details: HeadersReceivedDetails) => undefined
  responseStarted: (details: ResponseDetails) => void
  beforeRedirect: (details: RedirectDetails) => void
  completed: (details: CompletedDetails) => void
  errorOccurred: (details: ErrorDetails) => void
}

/** Adds every webRequest listener, or none: a failure removes the ones added. */
function listen(browser: Browser, recording: Recording, listeners: HopListeners): void {
  const filter: RequestFilter = { urls: ALL_URLS, tabId: recording.tabId }
  const add = <F>(event: WebRequestFilterEvent<F>, listener: F, spec?: string[]): void => {
    if (spec === undefined) {
      event.addListener(listener, filter)
    } else {
      ;(event as WebRequestEvent<F>).addListener(listener, filter, spec)
    }
    recording.release.push(() => event.removeListener(listener))
  }
  const web = browser.webRequest
  try {
    // without bodies neither the request body nor a stream filter is needed
    add(
      web.onBeforeRequest,
      listeners.beforeRequest,
      recording.maxBodySize > 0 ? ["blocking", "requestBody"] : undefined,
    )
    add(web.onSendHeaders, listeners.sendHeaders, ["requestHeaders"])
    add(web.onHeadersReceived, listeners.headersReceived, ["blocking", "responseHeaders"])
    add(web.onResponseStarted, listeners.responseStarted, ["responseHeaders"])
    add(web.onBeforeRedirect, listeners.beforeRedirect, ["responseHeaders"])
    add(web.onCompleted, listeners.completed, ["responseHeaders"])
    add(web.onErrorOccurred, listeners.errorOccurred)
  } catch (error) {
    release(recording)
    throw error
  }
}

function release(recording: Recording): void {
  for (const remove of recording.release.splice(0)) {
    remove()
  }
}

function openPage(recording: Recording, start: number, url: string): Page {
  const page: Page = {
    record: { id: `page_${recording.pages.length + 1}`, start, title: url },
    request: false,
    before: false,
    committed: false,
  }
  recording.pages.push(page)
  return page
}

/** The latest page if it still waits for this side, else a new one. */
function bindPage(recording: Recording, side: NavigationSide, stamp: number, url: string): Page {
  const last = recording.pages.at(-1)
  const page = last !== undefined && !last[side] ? last : openPage(recording, stamp, url)
  page[side] = true
  page.record.start = Math.min(page.record.start, stamp)
  // the committed url is final; until then the latest request hop names it
  if (side === "committed" || (side === "request" && !page.committed)) {
    page.record.title = url
  }
  return page
}

function navigationPage(recording: Recording, details: RequestDetails): Page {
  const known = recording.navigations.get(details.requestId)
  if (known !== undefined) {
    if (!known.committed) {
      known.record.title = details.url
    }
    return known
  }
  const page = bindPage(recording, "request", details.timeStamp, details.url)
  recording.navigations.set(details.requestId, page)
  return page
}

function pageref(recording: Recording, details: RequestDetails, previous?: Hop): string {
  if (details.type === "main_frame" && details.frameId === 0) {
    return navigationPage(recording, details).record.id
  }
  return previous?.record.pageref ?? recording.pages.at(-1)?.record.id ?? ""
}

// every onBeforeRequest opens a hop: a redirect fires it again for the same id
function beforeRequest(recording: Recording, details: RequestDetails): void {
  const capture = recording.maxBodySize > 0
  const hop: Hop = {
    record: {
      requestId: details.requestId,
      pageref: pageref(recording, details, recording.current.get(details.requestId)),
      method: details.method,
      url: details.url,
      type: details.type,
      frameId: details.frameId,
      start: details.timeStamp,
      bodyCaptured: capture,
    },
    closed: false,
    cut: false,
    dropped: false,
  }
  if (capture && details.requestBody !== undefined) {
    storeBody(recording, hop, details.requestBody)
  }
  recording.hops.push(hop)
  recording.current.set(details.requestId, hop)
}

/**
 * The open hop an event belongs to. The url tells a late event of a hop that
 * redirected from the hop that replaced it.
 */
function openHop(recording: Recording, details: RequestDetails): HopRecord | undefined {
  const hop = recording.current.get(details.requestId)
  if (hop === undefined || hop.closed || hop.record.url !== details.url) {
    return undefined
  }
  return hop.record
}

function sendHeaders(recording: Recording, details: SendHeadersDetails): void {
  const hop = openHop(recording, details)
  if (hop === undefined) {
    return
  }
  hop.sendHeaders = details.timeStamp
  if (details.requestHeaders !== undefined) {
    hop.requestHeaders = details.requestHeaders
  }
}

function response(hop: HopRecord, details: HeadersReceivedDetails): void {
  hop.statusCode = details.statusCode
  hop.statusLine = details.statusLine
  if (details.responseHeaders !== undefined) {
    hop.responseHeaders = details.responseHeaders
  }
  if (details.ip !== undefined) {
    hop.ip = details.ip
  }
  if (details.fromCache !== undefined) {
    hop.fromCache = details.fromCache
  }
}

function headersReceived(recording: Recording, details: HeadersReceivedDetails): void {
  const hop = openHop(recording, details)
  if (hop !== undefined) {
    hop.headersReceived = details.timeStamp
    response(hop, details)
  }
}

function responseStarted(recording: Recording, details: ResponseDetails): void {
  const hop = openHop(recording, details)
  if (hop !== undefined) {
    response(hop, details)
  }
}

/** onBeforeRedirect, with the redirect target, or onCompleted. */
function ended(recording: Recording, details: CompletedDetails, redirectUrl?: string): void {
  const hop = openHop(recording, details)
  if (hop === undefined) {
    return
  }
  response(hop, details)
  hop.end = details.timeStamp
  if (redirectUrl !== undefined) {
    hop.redirectUrl = redirectUrl
  }
  close(recording, details.requestId, redirectUrl === undefined)
}

function failed(recording: Recording, details: ErrorDetails): void {
  const hop = openHop(recording, details)
  if (hop === undefined) {
    return
  }
  hop.end = details.timeStamp
  hop.error = details.error
  close(recording, details.requestId, true)
}

// a redirected hop stays current until the next hop of its request replaces it
function close(recording: Recording, requestId: string, last: boolean): void {
  const hop = recording.current.get(requestId)
  if (hop !== undefined) {
    hop.closed = true
  }
  if (last) {
    recording.current.delete(requestId)
  }
}

/** Keeps at most the body cap and the budget left; Firefox's buffers are copied. */
function storeBody(recording: Recording, hop: Hop, body: RequestBody): void {
  hop.record.requestBody = shape(body)
  if (recording.budget <= 0 && hasPayload(body)) {
    hop.dropped = true
    return
  }
  const limit = Math.min(recording.maxBodySize, recording.budget)
  const kept = cutBody(body, limit)
  recording.budget -= kept.used
  hop.stored = kept.body
  hop.cut = kept.cut
}

function hasPayload(body: RequestBody): boolean {
  if (body.formData !== undefined) {
    return Object.keys(body.formData).length > 0
  }
  return (body.raw ?? []).some((part) => (part.bytes?.byteLength ?? 0) > 0)
}

// only the sizes and flags matter for bodySize
function shape(body: RequestBody): RequestBodyShape {
  const result: RequestBodyShape = {}
  if (body.error !== undefined) {
    result.error = body.error
  }
  if (body.formData !== undefined) {
    // its presence alone makes the size unknown
    result.formData = {}
  }
  if (body.raw !== undefined) {
    result.raw = body.raw.map((part) => {
      const copy: NonNullable<RequestBodyShape["raw"]>[number] = {}
      if (part.bytes !== undefined) {
        copy.bytes = { byteLength: part.bytes.byteLength }
      }
      if (part.file !== undefined) {
        copy.file = part.file
      }
      if (part.truncated !== undefined) {
        copy.truncated = part.truncated
      }
      return copy
    })
  }
  return result
}

interface Kept {
  body: RequestBody
  used: number
  cut: boolean
}

function cutBody(body: RequestBody, limit: number): Kept {
  if (body.error !== undefined) {
    return { body: { error: body.error }, used: 0, cut: false }
  }
  if (body.formData !== undefined) {
    return cutForm(body.formData, limit)
  }
  return cutRaw(body.raw ?? [], limit)
}

// names and values count as UTF-8, as postData measures them
function cutForm(formData: Record<string, string[]>, limit: number): Kept {
  const kept: Record<string, string[]> = {}
  let used = 0
  for (const [name, values] of Object.entries(formData)) {
    for (const value of values) {
      const size = utf8Length(name) + utf8Length(value)
      if (used + size > limit) {
        return { body: { formData: kept }, used, cut: true }
      }
      used += size
      kept[name] = [...(kept[name] ?? []), value]
    }
  }
  return { body: { formData: kept }, used, cut: false }
}

function cutRaw(raw: UploadData[], limit: number): Kept {
  const parts: UploadData[] = []
  let used = 0
  let cut = false
  for (const part of raw) {
    const copy: UploadData = {}
    if (part.file !== undefined) {
      copy.file = part.file
    }
    if (part.truncated !== undefined) {
      copy.truncated = part.truncated
    }
    if (part.originalSize !== undefined) {
      copy.originalSize = part.originalSize
    }
    if (part.bytes !== undefined) {
      const length = Math.min(limit - used, part.bytes.byteLength)
      cut ||= length < part.bytes.byteLength
      copy.bytes = part.bytes.slice(0, length)
      used += length
    }
    parts.push(copy)
  }
  return { body: { raw: parts }, used, cut }
}

/** The hop as buildLog takes it: postData built, the stored prefix released. */
function finish(hop: Hop): HopRecord {
  const record = hop.record
  if (record.end === undefined) {
    record.pending = true
  }
  const mimeType = contentType(record.requestHeaders)
  if (hop.dropped) {
    record.postData = { mimeType, _bodyDropped: true }
  } else if (hop.stored !== undefined) {
    // the prefix is already cut, so postData keeps all of it
    record.postData = postData(hop.stored, mimeType, Number.POSITIVE_INFINITY)
    if (hop.cut) {
      record.postData._truncated = true
    }
    hop.stored = undefined
  }
  return record
}
