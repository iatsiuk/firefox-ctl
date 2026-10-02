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
  SecurityInfo,
  SendHeadersDetails,
  StreamFilter,
  UploadData,
  WebRequestEvent,
  WebRequestFilterEvent,
} from "./browser"
import type { Environment } from "./env"
import type {
  Har,
  HarRecording,
  HarSecurityInfo,
  HopRecord,
  PageRecord,
  RequestBodyShape,
  ResponseBodyRecord,
} from "./har"
import { contentType, postData } from "./har"
import { ExtensionError } from "./protocol"
import { utf8Length } from "./reply"

/** Bytes kept of one request or response body unless startHar says otherwise. */
export const MAX_BODY_DEFAULT = 10 * 1024 * 1024

/** Stored body bytes, request and response alike, one recording may hold. */
export const BODY_BUDGET = 160 * 1024 * 1024

/** How long a stopped tab's HAR, or its failure, is answered again once built. */
export const HAR_KEEP_MS = 5 * 60 * 1000

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
 * page that has not seen it yet, whatever came first, as long as its url is
 * one the page's navigation already went through.
 */
interface Page extends Record<NavigationSide, boolean> {
  record: PageRecord
  /** The navigation's urls without fragments: onBeforeNavigate's, every hop's, onCommitted's. */
  urls: Set<string>
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
  browser: Browser
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
  /** Every stream filter opened, released by status at stop. */
  filters: StreamFilter[]
  /** Set by stop: late filter callbacks no longer touch the data. */
  stopped: boolean
}

const ALL_URLS = ["<all_urls>"]

export class HarRecorder {
  private readonly recordings = new Map<number, Recording>()

  // stopped HARs, built or still building, for a stopHar whose reply was lost
  private readonly stopped = new Map<number, Promise<Har>>()

  // the expiry timer of each kept HAR, cancelled when the HAR is released early
  private readonly expiries = new Map<number, number>()

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

  /**
   * Holds a stopped tab's HAR while it is built and HAR_KEEP_MS after. No
   * reply is ever known to have reached the client, so the HAR is never
   * released on answering. A HAR released before it is built sets no expiry,
   * so no timer holds on to a HAR the map let go.
   */
  keep(tabId: number, har: Promise<Har>): void {
    this.forget(tabId)
    this.stopped.set(tabId, har)
    const expire = (): void => {
      if (this.stopped.get(tabId) !== har) {
        return
      }
      const timerId = this.env.setTimeout(() => this.forget(tabId), HAR_KEEP_MS)
      this.expiries.set(tabId, timerId)
    }
    har.then(expire, expire)
  }

  kept(tabId: number): Promise<Har> | undefined {
    return this.stopped.get(tabId)
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
      browser,
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
          urls: new Set(),
        },
      ],
      hops: [],
      current: new Map(),
      navigations: new Map(),
      release: [],
      filters: [],
      stopped: false,
    }
    listen(browser, recording, this.hopListeners(recording))
    this.recordings.set(tabId, recording)
    this.forget(tabId)
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
    releaseFilters(recording)
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

  // drops the tab's kept HAR and cancels its expiry
  private forget(tabId: number): void {
    const timerId = this.expiries.get(tabId)
    if (timerId !== undefined) {
      this.env.clearTimeout(timerId)
      this.expiries.delete(tabId)
    }
    this.stopped.delete(tabId)
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

  // the old document may still fire once the next navigation began
  private timePage(details: FrameNavigationDetails, field: "domContentLoaded" | "load"): void {
    const pages = this.recordingOf(details)?.pages ?? []
    const page = [...pages].reverse().find((p) => p.committed)
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
      headersReceived: (d) => headersReceived(recording, d),
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
  headersReceived: (details: HeadersReceivedDetails) => Promise<undefined> | undefined
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
    urls: new Set(),
  }
  recording.pages.push(page)
  return page
}

function withoutFragment(url: string): string {
  const hash = url.indexOf("#")
  return hash < 0 ? url : url.slice(0, hash)
}

/**
 * The latest page if it still waits for this side and knows the url, else a
 * new one: a navigation that never reaches one side, as about:blank never
 * reaches webRequest, must not take the next navigation's events.
 */
function bindPage(recording: Recording, side: NavigationSide, stamp: number, url: string): Page {
  const last = recording.pages.at(-1)
  const key = withoutFragment(url)
  const page =
    last !== undefined && !last[side] && (last.urls.size === 0 || last.urls.has(key))
      ? last
      : openPage(recording, stamp, url)
  page[side] = true
  page.urls.add(key)
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
    known.urls.add(withoutFragment(details.url))
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
  // Firefox gives null, not undefined, for a request without a body
  if (capture && details.requestBody != null) {
    storeBody(recording, hop, details.requestBody)
  }
  if (capture) {
    captureResponse(recording, hop.record)
  }
  recording.hops.push(hop)
  recording.current.set(details.requestId, hop)
}

/**
 * Opens a stream filter on the hop's response unless the budget is spent. Its
 * callbacks close over the hop, so a late error of a redirected hop ends that
 * hop's body only. Every chunk is written through before anything else.
 */
function captureResponse(recording: Recording, hop: HopRecord): void {
  if (recording.budget <= 0) {
    hop.bodyDropped = true
    return
  }
  const body: ResponseBodyRecord = { chunks: [], complete: false }
  hop.body = body
  let filter: StreamFilter
  try {
    filter = recording.browser.webRequest.filterResponseData(hop.requestId)
  } catch (error) {
    body.error = error instanceof Error ? error.message : String(error)
    return
  }
  recording.filters.push(filter)
  let stored = 0
  let seen = 0
  filter.ondata = (event) => {
    filter.write(event.data)
    if (recording.stopped) {
      return
    }
    seen += event.data.byteLength
    const length = Math.min(recording.maxBodySize - stored, recording.budget, event.data.byteLength)
    if (length > 0) {
      body.chunks.push(new Uint8Array(event.data.slice(0, length)))
      stored += length
      recording.budget -= length
    }
    // past the cap the page gets the rest straight from the channel
    if (length < event.data.byteLength) {
      filter.disconnect()
      // nothing stored means the budget was spent before the first byte
      if (stored === 0) {
        hop.body = undefined
        hop.bodyDropped = true
        return
      }
      body.truncated = true
      body.size = seen
    }
  }
  filter.onstop = () => {
    filter.close()
    if (!recording.stopped) {
      body.complete = true
    }
  }
  filter.onerror = () => {
    if (!recording.stopped) {
      body.error = filter.error
    }
  }
}

/**
 * Lets the page have every filter's data without the recorder: a started
 * filter disconnects now, one before onstart on its onstart, a terminal one
 * needs nothing and would throw.
 */
function releaseFilters(recording: Recording): void {
  recording.stopped = true
  for (const filter of recording.filters.splice(0)) {
    switch (filter.status) {
      case "transferringdata":
      case "suspended":
      case "finishedtransferringdata":
        filter.disconnect()
        break
      case "uninitialized":
        filter.onstart = () => filter.disconnect()
        filter.ondata = null
        filter.onstop = null
        filter.onerror = null
        break
      default:
        break
    }
  }
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
  if (details.ip != null) {
    hop.ip = details.ip
  }
  if (details.fromCache !== undefined) {
    hop.fromCache = details.fromCache
  }
}

// a TLS request blocks until getSecurityInfo answers: the channel is known
// only while the listener holds it; the response is never modified
function headersReceived(
  recording: Recording,
  details: HeadersReceivedDetails,
): Promise<undefined> | undefined {
  const hop = openHop(recording, details)
  if (hop === undefined) {
    return undefined
  }
  hop.headersReceived = details.timeStamp
  response(hop, details)
  if (!TLS_URL.test(details.url)) {
    return undefined
  }
  return recording.browser.webRequest.getSecurityInfo(details.requestId, {}).then(
    (info) => {
      if (info !== undefined && !recording.stopped) {
        hop.securityInfo = securitySummary(info)
      }
      return undefined
    },
    () => undefined,
  )
}

const TLS_URL = /^(https|wss):/i

/** What a HAR keeps of the security info: the connection and the leaf certificate. */
function securitySummary(info: SecurityInfo): HarSecurityInfo {
  const summary: HarSecurityInfo = defined({
    state: info.state,
    errorMessage: info.errorMessage,
    protocolVersion: info.protocolVersion,
    cipherSuite: info.cipherSuite,
    keaGroupName: info.keaGroupName,
    signatureSchemeName: info.signatureSchemeName,
    isExtendedValidation: info.isExtendedValidation,
    hsts: info.hsts,
    hpkp: info.hpkp,
  })
  const leaf = info.certificates?.[0]
  if (leaf !== undefined) {
    summary.certificate = {
      subject: leaf.subject,
      issuer: leaf.issuer,
      validity: {
        start: new Date(leaf.validity.start).toISOString(),
        end: new Date(leaf.validity.end).toISOString(),
      },
      fingerprint: { sha256: leaf.fingerprint.sha256 },
    }
  }
  return summary
}

// drops the fields Firefox left out, so they stay out of the HAR
function defined<T extends object>(fields: T): T {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T
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
