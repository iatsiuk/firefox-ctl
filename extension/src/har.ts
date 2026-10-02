// Pure HAR 1.2 building: the recorder collects webRequest events per hop, and
// everything that turns them into a HAR log lives here, without browser
// globals. Field names starting with `_` are HAR's sanctioned extensions.

import type { HttpHeader, RequestBody } from "./browser"
import { REDACTED_HEADER, SENSITIVE_HEADERS } from "./network"
import { ExtensionError } from "./protocol"
import { replyBytes, utf8Length } from "./reply"

export interface HarHeader {
  name: string
  value: string
}

export interface HarCookie {
  name: string
  value: string
  path?: string
  domain?: string
  expires?: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
}

export interface HarParam {
  name: string
  value: string
}

export interface HarPostData {
  mimeType: string
  text?: string
  params?: HarParam[]
  comment?: string
  _encoding?: "base64"
  _fileParts?: number
  _formData?: true
  _truncated?: true
  _truncatedByBrowser?: true
  _originalSize?: number
  _bodyDropped?: true
  _error?: string
}

export interface HarContent {
  size: number
  mimeType: string
  text?: string
  encoding?: "base64"
  _complete?: false
  _truncated?: true
  _bodyDropped?: true
  _bodyError?: string
}

export interface HarTimings {
  blocked: number
  dns: number
  connect: number
  ssl: number
  send: number
  wait: number
  receive: number
}

export interface HarSecurityInfo {
  state: string
  protocolVersion?: string
  cipherSuite?: string
  keaGroupName?: string
  signatureSchemeName?: string
  isExtendedValidation?: boolean
  hsts?: boolean
  hpkp?: boolean
  errorMessage?: string
  certificate?: {
    subject: string
    issuer: string
    validity: { start: string; end: string }
    fingerprint: { sha256: string }
  }
}

export interface HarRequest {
  method: string
  url: string
  httpVersion: string
  cookies: HarCookie[]
  headers: HarHeader[]
  queryString: HarParam[]
  postData?: HarPostData
  headersSize: number
  bodySize: number
}

export interface HarResponse {
  status: number
  statusText: string
  httpVersion: string
  cookies: HarCookie[]
  headers: HarHeader[]
  content: HarContent
  redirectURL: string
  headersSize: number
  bodySize: number
}

export interface HarEntry {
  pageref?: string
  startedDateTime: string
  time: number
  request: HarRequest
  response: HarResponse
  cache: Record<string, never>
  timings: HarTimings
  serverIPAddress?: string
  _resourceType: string
  _frameId: number
  _fromCache?: boolean
  _error?: string
  _pending?: true
  _securityInfo?: HarSecurityInfo
}

export interface HarPage {
  id: string
  startedDateTime: string
  title: string
  pageTimings: { onContentLoad: number; onLoad: number }
}

export interface HarRecordingSummary {
  tabId: number
  startedDateTime: string
  maxBodySize: number
  truncatedBodies: number
  droppedBodies: number
  pendingEntries: number
  tabClosed: boolean
}

export interface Har {
  log: {
    version: "1.2"
    creator: { name: string; version: string }
    pages: HarPage[]
    entries: HarEntry[]
    _recording: HarRecordingSummary
  }
}

// only the sizes of raw parts matter for bodySize, so the recorder may keep
// `{byteLength}` in place of Firefox's buffers
export interface RequestBodyShape {
  formData?: Record<string, string[]>
  raw?: { bytes?: { readonly byteLength: number }; file?: string; truncated?: boolean }[]
  error?: string
}

/** How a captured response body ended. */
export interface BodyState {
  complete: boolean
  truncated?: boolean
  dropped?: boolean
  error?: string
  /** Bytes seen, when more than the ones stored. */
  size?: number
}

export interface ResponseBodyRecord {
  chunks: Uint8Array[]
  complete: boolean
  truncated?: boolean
  error?: string
}

/** Times are `timeStamp` milliseconds since the epoch. */
export interface PageRecord {
  id: string
  start: number
  title: string
  domContentLoaded?: number
  load?: number
}

/** One request hop as the recorder saw it; a redirect starts a new hop. */
export interface HopRecord {
  requestId: string
  pageref?: string
  method: string
  url: string
  type: string
  frameId: number
  start: number
  sendHeaders?: number
  headersReceived?: number
  end?: number
  requestHeaders?: HttpHeader[]
  requestBody?: RequestBodyShape
  /** Whether "requestBody" was asked for, i.e. maxBodySize was above 0. */
  bodyCaptured: boolean
  postData?: HarPostData
  statusCode?: number
  statusLine?: string
  responseHeaders?: HttpHeader[]
  ip?: string
  fromCache?: boolean
  redirectUrl?: string
  error?: string
  pending?: boolean
  body?: ResponseBodyRecord
  /** The response body was not stored because the budget was spent. */
  bodyDropped?: boolean
  securityInfo?: HarSecurityInfo
}

export interface HarRecording {
  tabId: number
  start: number
  maxBodySize: number
  creatorVersion: string
  tabClosed: boolean
  pages: PageRecord[]
  hops: HopRecord[]
}

const CREATOR = "firefox-ctl"

const MULTIPART_COMMENT =
  "multipart/form-data: Firefox reports field values and file names alike, so a value may be a file name; file contents are not captured"

// btoa works on a binary string; a multiple of 3 keeps the pieces joinable
const BASE64_CHUNK = 3 * 8192

const TEXT_MIME = [/^text\//, /json/, /javascript/, /xml/, /^application\/x-www-form-urlencoded/]

export function harHeaders(headers: HttpHeader[] | undefined): HarHeader[] {
  return (headers ?? []).map((h) => ({ name: h.name, value: headerValue(h) }))
}

function headerValue(header: HttpHeader): string {
  if (header.value !== undefined) {
    return header.value
  }
  return String.fromCharCode(...(header.binaryValue ?? []))
}

export function requestCookies(cookieHeader: string): HarCookie[] {
  const cookies: HarCookie[] = []
  for (const part of cookieHeader.split(";")) {
    const pair = nameValue(part)
    if (pair !== null) {
      cookies.push(pair)
    }
  }
  return cookies
}

// a part without "=" is a nameless cookie, as RFC 6265bis reads it
function nameValue(part: string): HarCookie | null {
  const trimmed = part.trim()
  if (trimmed === "") {
    return null
  }
  const eq = trimmed.indexOf("=")
  if (eq < 0) {
    return { name: "", value: trimmed }
  }
  return { name: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1).trim() }
}

// Firefox joins repeated Set-Cookie headers into one value, one per line
export function responseCookies(setCookieHeaders: string[]): HarCookie[] {
  const cookies: HarCookie[] = []
  for (const header of setCookieHeaders) {
    for (const line of header.split("\n")) {
      const cookie = setCookie(line)
      if (cookie !== null) {
        cookies.push(cookie)
      }
    }
  }
  return cookies
}

function setCookie(line: string): HarCookie | null {
  const [first = "", ...attributes] = line.split(";")
  const cookie = nameValue(first)
  if (cookie === null) {
    return null
  }
  for (const attribute of attributes) {
    applyAttribute(cookie, attribute)
  }
  return cookie
}

function applyAttribute(cookie: HarCookie, attribute: string): void {
  const eq = attribute.indexOf("=")
  const name = (eq < 0 ? attribute : attribute.slice(0, eq)).trim().toLowerCase()
  const value = eq < 0 ? "" : attribute.slice(eq + 1).trim()
  switch (name) {
    case "path":
      cookie.path = value
      break
    case "domain":
      cookie.domain = value
      break
    case "expires": {
      const time = Date.parse(value)
      if (!Number.isNaN(time)) {
        cookie.expires = new Date(time).toISOString()
      }
      break
    }
    case "httponly":
      cookie.httpOnly = true
      break
    case "secure":
      cookie.secure = true
      break
    case "samesite":
      cookie.sameSite = value
      break
  }
}

export function queryString(url: string): HarParam[] {
  const hash = url.indexOf("#")
  const bare = hash < 0 ? url : url.slice(0, hash)
  const question = bare.indexOf("?")
  if (question < 0) {
    return []
  }
  const params: HarParam[] = []
  for (const part of bare.slice(question + 1).split("&")) {
    if (part === "") {
      continue
    }
    const eq = part.indexOf("=")
    const name = eq < 0 ? part : part.slice(0, eq)
    const value = eq < 0 ? "" : part.slice(eq + 1)
    params.push({ name: decodeComponent(name), value: decodeComponent(value) })
  }
  return params
}

function decodeComponent(raw: string): string {
  try {
    return decodeURIComponent(raw.replaceAll("+", " "))
  } catch {
    return raw
  }
}

const STATUS_LINE = /^(HTTP\/[0-9.]+) +[0-9]{3}(?: (.*))?$/

export function httpVersion(statusLine: string | undefined): string {
  return STATUS_LINE.exec(statusLine ?? "")?.[1] ?? ""
}

export function statusText(statusLine: string | undefined): string {
  return STATUS_LINE.exec(statusLine ?? "")?.[2]?.trim() ?? ""
}

function contentType(headers: HttpHeader[] | undefined): string {
  const header = (headers ?? []).find((h) => h.name.toLowerCase() === "content-type")
  return header === undefined ? "" : headerValue(header)
}

function charset(mimeType: string): string {
  return /charset\s*=\s*"?([^";\s]+)/i.exec(mimeType)?.[1] ?? "utf-8"
}

/** The text of the bytes in the charset of the mime type, or null. */
function decodeText(data: Uint8Array, mimeType: string): string | null {
  try {
    return new TextDecoder(charset(mimeType), { fatal: true }).decode(data)
  } catch {
    return null
  }
}

function base64(data: Uint8Array): string {
  const pieces: string[] = []
  for (let i = 0; i < data.length; i += BASE64_CHUNK) {
    pieces.push(btoa(String.fromCharCode(...data.subarray(i, i + BASE64_CHUNK))))
  }
  return pieces.join("")
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1 && parts[0] !== undefined) {
    return parts[0]
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * `postData` of a request body. A raw body becomes text when it decodes in the
 * Content-Type charset and base64 otherwise; form data becomes params only.
 * At most `maxBytes` are kept, past that the body carries `_truncated`.
 */
export function postData(
  requestBody: RequestBody,
  mimeType: string,
  maxBytes: number,
): HarPostData {
  if (requestBody.error !== undefined) {
    return { mimeType, text: "", _error: requestBody.error }
  }
  if (requestBody.formData !== undefined) {
    return formPostData(requestBody.formData, mimeType, maxBytes)
  }
  return rawPostData(requestBody.raw ?? [], mimeType, maxBytes)
}

function formPostData(
  formData: Record<string, string[]>,
  mimeType: string,
  maxBytes: number,
): HarPostData {
  const result: HarPostData = { mimeType, params: [], _formData: true }
  if (/^multipart\/form-data/i.test(mimeType)) {
    result.comment = MULTIPART_COMMENT
  }
  let used = 0
  for (const [name, values] of Object.entries(formData)) {
    for (const value of values) {
      used += utf8Length(name) + utf8Length(value)
      if (used > maxBytes) {
        result._truncated = true
        return result
      }
      result.params?.push({ name, value })
    }
  }
  return result
}

function rawPostData(
  raw: NonNullable<RequestBody["raw"]>,
  mimeType: string,
  maxBytes: number,
): HarPostData {
  const result: HarPostData = { mimeType }
  const parts: Uint8Array[] = []
  let used = 0
  for (const part of raw) {
    if (part.file !== undefined) {
      result._fileParts = (result._fileParts ?? 0) + 1
    }
    if (part.truncated === true) {
      result._truncatedByBrowser = true
      result._originalSize ??= part.originalSize
    }
    if (part.bytes === undefined) {
      continue
    }
    const room = maxBytes - used
    if (part.bytes.byteLength > room) {
      result._truncated = true
    }
    const kept = new Uint8Array(part.bytes, 0, Math.min(room, part.bytes.byteLength))
    parts.push(kept)
    used += kept.length
  }
  const data = concat(parts, used)
  const text = decodeText(data, mimeType)
  return text === null
    ? { ...result, text: base64(data), _encoding: "base64" }
    : { ...result, text }
}

function isTextual(mimeType: string): boolean {
  const type = mimeType.split(";")[0]?.trim().toLowerCase() ?? ""
  return TEXT_MIME.some((pattern) => pattern.test(type))
}

/** `content` of a response; `body` is undefined when nothing was captured. */
export function responseContent(
  body: Uint8Array | undefined,
  headers: HttpHeader[] | undefined,
  state: BodyState,
): HarContent {
  const mimeType = contentType(headers)
  const content: HarContent = { size: state.size ?? body?.length ?? 0, mimeType }
  if (body !== undefined) {
    const text = isTextual(mimeType) ? decodeText(body, mimeType) : null
    if (text === null) {
      content.text = base64(body)
      content.encoding = "base64"
    } else {
      content.text = text
    }
    if (!state.complete) {
      content._complete = false
    }
  }
  if (state.truncated === true) {
    content._truncated = true
  }
  if (state.dropped === true) {
    content._bodyDropped = true
  }
  if (state.error !== undefined) {
    content._bodyError = state.error
  }
  return content
}

function headerValues(headers: HttpHeader[] | undefined, name: string): string[] {
  return (headers ?? []).filter((h) => h.name.toLowerCase() === name).map(headerValue)
}

/** A Content-Length every copy agrees on, or null. */
function contentLength(headers: HttpHeader[] | undefined): number | null {
  const values = new Set(headerValues(headers, "content-length").map((v) => v.trim()))
  if (values.size !== 1) {
    return null
  }
  const [value = ""] = values
  if (!/^[0-9]+$/.test(value)) {
    return null
  }
  const length = Number(value)
  return Number.isSafeInteger(length) ? length : null
}

/**
 * `request.bodySize`: a valid Content-Length, else the full raw length Firefox
 * gave, 0 for a captured request with nothing to send, else -1 (unknown).
 * `originalSize` measures one substream where Firefox stopped, not the body.
 */
export function requestBodySize(
  requestBody: RequestBodyShape | undefined,
  headers: HttpHeader[] | undefined,
  captured: boolean,
): number {
  const length = contentLength(headers)
  if (length !== null) {
    return length
  }
  if (!captured) {
    return -1
  }
  if (requestBody === undefined) {
    return headerValues(headers, "transfer-encoding").length === 0 ? 0 : -1
  }
  return rawLength(requestBody)
}

function rawLength(requestBody: RequestBodyShape): number {
  if (requestBody.error !== undefined || requestBody.formData !== undefined) {
    return -1
  }
  let total = 0
  for (const part of requestBody.raw ?? []) {
    if (part.file !== undefined || part.truncated === true || part.bytes === undefined) {
      return -1
    }
    total += part.bytes.byteLength
  }
  return total
}

export interface ResponseSizeInput {
  method: string
  status: number
  headers: HttpHeader[] | undefined
  complete: boolean
  truncated: boolean
}

/** `response.bodySize` and `headersSize`, which webRequest never knows. */
export function responseSizes(input: ResponseSizeInput): { bodySize: number; headersSize: number } {
  const { method, status } = input
  if (
    method.toUpperCase() === "HEAD" ||
    (status >= 100 && status < 200) ||
    status === 204 ||
    status === 304
  ) {
    return { bodySize: 0, headersSize: -1 }
  }
  const length = input.complete && !input.truncated ? contentLength(input.headers) : null
  return { bodySize: length ?? -1, headersSize: -1 }
}

export interface Stamps {
  start: number
  sendHeaders?: number
  headersReceived?: number
  end?: number
}

/**
 * HAR phases from the webRequest stamps. A missing stamp makes its phase 0
 * and the next phase counts from the stamp before it.
 */
export function timings(stamps: Stamps): { time: number; timings: HarTimings } {
  const send = stamps.sendHeaders ?? stamps.start
  const received = stamps.headersReceived ?? send
  const end = stamps.end ?? received
  const blocked = Math.max(0, send - stamps.start)
  const wait = Math.max(0, received - send)
  const receive = Math.max(0, end - received)
  return {
    time: blocked + wait + receive,
    timings: { blocked, dns: -1, connect: -1, ssl: -1, send: 0, wait, receive },
  }
}

function redactHeaders(headers: HarHeader[]): HarHeader[] {
  return headers.map((h) =>
    SENSITIVE_HEADERS.includes(h.name.toLowerCase()) ? { name: h.name, value: REDACTED_HEADER } : h,
  )
}

function redactCookies(cookies: HarCookie[]): HarCookie[] {
  return cookies.map((c) => ({ ...c, value: REDACTED_HEADER }))
}

/** The entry with credential headers and cookie values replaced. */
export function redactEntry(entry: HarEntry): HarEntry {
  return {
    ...entry,
    request: {
      ...entry.request,
      headers: redactHeaders(entry.request.headers),
      cookies: redactCookies(entry.request.cookies),
    },
    response: {
      ...entry.response,
      headers: redactHeaders(entry.response.headers),
      cookies: redactCookies(entry.response.cookies),
    },
  }
}

function iso(timeStamp: number): string {
  return new Date(timeStamp).toISOString()
}

function page(record: PageRecord): HarPage {
  const since = (stamp: number | undefined): number =>
    stamp === undefined ? -1 : Math.max(0, stamp - record.start)
  return {
    id: record.id,
    startedDateTime: iso(record.start),
    title: record.title,
    pageTimings: { onContentLoad: since(record.domContentLoaded), onLoad: since(record.load) },
  }
}

// the chunks are dropped as soon as the text or base64 form exists
function content(hop: HopRecord): HarContent {
  const body = hop.body
  if (body === undefined) {
    return responseContent(undefined, hop.responseHeaders, {
      complete: true,
      dropped: hop.bodyDropped,
    })
  }
  const total = body.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const data = concat(body.chunks, total)
  body.chunks = []
  return responseContent(data, hop.responseHeaders, {
    complete: body.complete,
    truncated: body.truncated,
    dropped: hop.bodyDropped,
    error: body.error,
  })
}

function request(hop: HopRecord): HarRequest {
  const request: HarRequest = {
    method: hop.method,
    url: hop.url,
    httpVersion: httpVersion(hop.statusLine),
    cookies: requestCookies(headerValues(hop.requestHeaders, "cookie").join("; ")),
    headers: harHeaders(hop.requestHeaders),
    queryString: queryString(hop.url),
    headersSize: -1,
    bodySize: requestBodySize(hop.requestBody, hop.requestHeaders, hop.bodyCaptured),
  }
  if (hop.postData !== undefined) {
    request.postData = hop.postData
  }
  return request
}

function response(hop: HopRecord): HarResponse {
  const status = hop.statusCode ?? 0
  const finished = hop.end !== undefined && hop.error === undefined && hop.pending !== true
  const complete = finished && (hop.body === undefined || hop.body.complete)
  const truncated = hop.body?.truncated === true
  return {
    status,
    statusText: statusText(hop.statusLine),
    httpVersion: httpVersion(hop.statusLine),
    cookies: responseCookies(headerValues(hop.responseHeaders, "set-cookie")),
    headers: harHeaders(hop.responseHeaders),
    content: content(hop),
    redirectURL: hop.redirectUrl ?? "",
    ...responseSizes({
      method: hop.method,
      status,
      headers: hop.responseHeaders,
      complete,
      truncated,
    }),
  }
}

function entry(hop: HopRecord, pageIds: Set<string>): HarEntry {
  const { time, timings: phases } = timings(hop)
  const result: HarEntry = {
    startedDateTime: iso(hop.start),
    time,
    request: request(hop),
    response: response(hop),
    cache: {},
    timings: phases,
    _resourceType: hop.type,
    _frameId: hop.frameId,
  }
  if (hop.pageref !== undefined && pageIds.has(hop.pageref)) {
    result.pageref = hop.pageref
  }
  if (hop.ip !== undefined) {
    result.serverIPAddress = hop.ip
  }
  if (hop.fromCache !== undefined) {
    result._fromCache = hop.fromCache
  }
  if (hop.error !== undefined) {
    result._error = hop.error
  }
  if (hop.pending === true) {
    result._pending = true
  }
  if (hop.securityInfo !== undefined) {
    result._securityInfo = hop.securityInfo
  }
  return result
}

function countBodies(entries: HarEntry[], flag: "_truncated" | "_bodyDropped"): number {
  let count = 0
  for (const e of entries) {
    count +=
      (e.response.content[flag] === true ? 1 : 0) + (e.request.postData?.[flag] === true ? 1 : 0)
  }
  return count
}

/**
 * The HAR log of a recording. Converting a hop releases its body chunks, so a
 * recording is built once.
 */
export function buildLog(recording: HarRecording): Har {
  const pages = [...recording.pages].sort((a, b) => a.start - b.start).map(page)
  const pageIds = new Set(pages.map((p) => p.id))
  const entries = [...recording.hops]
    .sort((a, b) => a.start - b.start)
    .map((hop) => entry(hop, pageIds))
  return {
    log: {
      version: "1.2",
      creator: { name: CREATOR, version: recording.creatorVersion },
      pages,
      entries,
      _recording: {
        tabId: recording.tabId,
        startedDateTime: iso(recording.start),
        maxBodySize: recording.maxBodySize,
        truncatedBodies: countBodies(entries, "_truncated"),
        droppedBodies: countBodies(entries, "_bodyDropped"),
        pendingEntries: entries.filter((e) => e._pending === true).length,
        tabClosed: recording.tabClosed,
      },
    },
  }
}

function hasPayload(e: HarEntry): boolean {
  const post = e.request.postData
  return (
    e.response.content.text !== undefined || post?.text !== undefined || post?.params !== undefined
  )
}

/** The entry without body payloads, and how many bodies that removed. */
function shell(e: HarEntry): { entry: HarEntry; bodies: number } {
  let bodies = 0
  const response = { ...e.response }
  const { text, encoding: _encoding, ...content } = e.response.content
  if (text !== undefined) {
    response.content = { ...content, _bodyDropped: true }
    bodies++
  }
  const request = { ...e.request }
  const post = e.request.postData
  if (post !== undefined && (post.text !== undefined || post.params !== undefined)) {
    const { text: _text, params: _params, ...rest } = post
    request.postData = { ...rest, _bodyDropped: true }
    bodies++
  }
  return { entry: { ...e, request, response }, bodies }
}

interface Candidate {
  index: number
  shell: HarEntry
  bodies: number
  saving: number
}

function candidates(entries: HarEntry[]): Candidate[] {
  const found: Candidate[] = []
  for (const [index, e] of entries.entries()) {
    if (!hasPayload(e)) {
      continue
    }
    const dropped = shell(e)
    const saving = utf8Length(JSON.stringify(e)) - utf8Length(JSON.stringify(dropped.entry))
    if (saving > 0) {
      found.push({ index, shell: dropped.entry, bodies: dropped.bodies, saving })
    }
  }
  return found.sort((a, b) => b.saving - a.saving)
}

/**
 * The log, or a copy with the largest bodies dropped, so that its reply fits
 * `limitBytes`. Each body entry is measured once; the whole reply is measured
 * again only to confirm a fit, since the counters may grow a digit.
 */
export function fitLog(har: Har, limitBytes: number): Har {
  let size = replyBytes(har)
  if (size <= limitBytes) {
    return har
  }
  const entries = [...har.log.entries]
  const recording = { ...har.log._recording }
  const fitted: Har = { log: { ...har.log, entries, _recording: recording } }
  const queue = candidates(entries)
  while (size > limitBytes) {
    const next = queue.shift()
    if (next === undefined) {
      throw new ExtensionError(
        "HAR_TOO_LARGE",
        `HAR is ${replyBytes(fitted)} bytes without bodies, the limit is ${limitBytes}`,
      )
    }
    entries[next.index] = next.shell
    recording.droppedBodies += next.bodies
    size -= next.saving
    if (size <= limitBytes) {
      size = replyBytes(fitted)
    }
  }
  return fitted
}
