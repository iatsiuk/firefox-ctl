import type {
  BlockingListener,
  BlockingResponse,
  Browser,
  CaptureOptions,
  CompletedDetails,
  ConnectInfo,
  Cookie,
  CookieQuery,
  CookieSetDetails,
  Cookies,
  ErrorDetails,
  Event,
  ExecuteScriptDetails,
  Extension,
  FrameNavigationDetails,
  HeadersReceivedDetails,
  Manifest,
  MessageListener,
  MessageSender,
  PartitionKey,
  Port,
  PortError,
  RedirectDetails,
  RequestDetails,
  RequestFilter,
  ResponseDetails,
  Runtime,
  SecurityInfo,
  SecurityInfoOptions,
  SendHeadersDetails,
  SendMessageOptions,
  Storage,
  StorageArea,
  StreamFilter,
  StreamFilterDataEvent,
  StreamFilterStatus,
  Tab,
  TabActiveInfo,
  TabChangeInfo,
  TabCreateProperties,
  TabGroup,
  TabGroupOptions,
  TabGroupQuery,
  TabGroups,
  TabGroupUpdateProperties,
  TabQuery,
  TabRemoveInfo,
  Tabs,
  TabUpdateProperties,
  WebNavigation,
  WebRequest,
  WebRequestEvent,
  Window,
  WindowCreateData,
  WindowGetOptions,
  Windows,
  WindowUpdateInfo,
} from "../src/browser"
import type { Environment } from "../src/env"

export class FakeEvent<F> implements Event<F> {
  readonly listeners: F[] = []

  addListener(listener: F): void {
    this.listeners.push(listener)
  }

  removeListener(listener: F): void {
    const index = this.listeners.indexOf(listener)
    if (index >= 0) {
      this.listeners.splice(index, 1)
    }
  }

  hasListener(listener: F): boolean {
    return this.listeners.includes(listener)
  }

  // a copy, so a listener removing itself does not disturb the current round
  snapshot(): F[] {
    return [...this.listeners]
  }
}

// the optional details Firefox adds only for a listener that asked for them
const OPTIONAL_DETAILS = ["requestBody", "requestHeaders", "responseHeaders"] as const

interface WebRequestRegistration<F> {
  listener: F
  filter: RequestFilter
  extraInfoSpec?: string[]
}

/**
 * A webRequest event with the Firefox listener contract: an extraInfoSpec
 * value the event does not accept throws (`accepted` null: no extraInfoSpec
 * at all), delivery honours the filter tabId, optional details reach only
 * listeners that asked for them (a bodyless request's requestBody as null),
 * and the promise of a "blocking" listener is awaited by the emitter.
 */
export class FakeWebRequestEvent<F extends (details: never) => unknown>
  implements WebRequestEvent<F>
{
  private readonly registrations: WebRequestRegistration<F>[] = []
  private readonly blocked = new Map<string, number>()

  constructor(
    private readonly name: string,
    private readonly accepted: readonly string[] | null,
  ) {}

  get listeners(): F[] {
    return this.registrations.map((registration) => registration.listener)
  }

  get filters(): RequestFilter[] {
    return this.registrations.map((registration) => registration.filter)
  }

  get extraInfoSpecs(): (string[] | undefined)[] {
    return this.registrations.map((registration) => registration.extraInfoSpec)
  }

  addListener(listener: F, filter: RequestFilter, extraInfoSpec?: string[]): void {
    this.validate(extraInfoSpec)
    this.registrations.push({ listener, filter, extraInfoSpec })
  }

  removeListener(listener: F): void {
    const index = this.registrations.findIndex((registration) => registration.listener === listener)
    if (index >= 0) {
      this.registrations.splice(index, 1)
    }
  }

  hasListener(listener: F): boolean {
    return this.registrations.some((registration) => registration.listener === listener)
  }

  snapshot(): F[] {
    return this.listeners
  }

  // true while a blocking listener runs or its promise is pending for the request
  isBlocking(requestId: string): boolean {
    return (this.blocked.get(requestId) ?? 0) > 0
  }

  // calls every matching listener synchronously; the promise settles once
  // every blocking listener's answer has
  deliver(details: RequestDetails): Promise<unknown[]> {
    const answers: unknown[] = []
    for (const registration of [...this.registrations]) {
      const tabId = registration.filter.tabId
      if (tabId !== undefined && tabId !== details.tabId) {
        continue
      }
      const blocking = registration.extraInfoSpec?.includes("blocking") ?? false
      const call = registration.listener as unknown as (details: unknown) => unknown
      if (!blocking) {
        call(this.visible(details, registration))
        continue
      }
      answers.push(this.block(details.requestId, () => call(this.visible(details, registration))))
    }
    return Promise.all(answers)
  }

  private block(requestId: string, call: () => unknown): Promise<unknown> {
    this.blocked.set(requestId, (this.blocked.get(requestId) ?? 0) + 1)
    const release = () => this.blocked.set(requestId, (this.blocked.get(requestId) ?? 1) - 1)
    let answer: unknown
    try {
      answer = call()
    } catch (error) {
      release()
      throw error
    }
    // a plain answer releases the request at once, as Firefox does
    if (!(answer instanceof Promise)) {
      release()
      return Promise.resolve(answer)
    }
    return answer.finally(release)
  }

  private visible(details: object, registration: WebRequestRegistration<F>): object {
    const copy: Record<string, unknown> = { ...details }
    for (const key of OPTIONAL_DETAILS) {
      if (this.accepted?.includes(key) && !registration.extraInfoSpec?.includes(key)) {
        delete copy[key]
      }
    }
    // Firefox answers "requestBody" with null for a request without an upload stream
    if (registration.extraInfoSpec?.includes("requestBody") && copy.requestBody === undefined) {
      copy.requestBody = null
    }
    return copy
  }

  // the messages of the Firefox schema validation
  private validate(extraInfoSpec: string[] | undefined): void {
    if (extraInfoSpec === undefined) {
      return
    }
    if (this.accepted === null) {
      throw new Error(`Incorrect argument types for webRequest.${this.name}.addListener.`)
    }
    extraInfoSpec.forEach((value, index) => {
      if (!this.accepted?.includes(value)) {
        throw new Error(
          `Type error for parameter extraInfoSpec (Error processing ${index}: Invalid enumeration value "${value}") for webRequest.${this.name}.addListener.`,
        )
      }
    })
  }
}

// what StreamFilterChild throws for a call its state does not allow
const STREAM_FILTER_FAILURE = "NS_ERROR_FAILURE"

const STREAM_FILTER_OPEN: readonly StreamFilterStatus[] = [
  "transferringdata",
  "finishedtransferringdata",
  "suspended",
]

function bytesOf(data: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof data === "string") {
    return new TextEncoder().encode(data)
  }
  return data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0))
}

/**
 * A response stream filter with the states of StreamFilterChild.cpp. The test
 * drives the channel side with push*; the recorder uses the StreamFilter side.
 * `pageData` is what the page receives: every write, and once disconnected,
 * the data that bypasses the filter.
 */
export class FakeStreamFilter implements StreamFilter {
  status: StreamFilterStatus = "uninitialized"
  error = ""
  onstart: (() => void) | null = null
  ondata: ((event: StreamFilterDataEvent) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly written: Uint8Array[] = []
  private readonly page: Uint8Array[] = []

  constructor(readonly requestId: string) {}

  write(data: ArrayBuffer | Uint8Array): void {
    if (!STREAM_FILTER_OPEN.includes(this.status)) {
      throw new Error(STREAM_FILTER_FAILURE)
    }
    const chunk = bytesOf(data)
    this.written.push(chunk)
    this.page.push(chunk)
  }

  close(): void {
    if (this.status === "closed") {
      return
    }
    if (!STREAM_FILTER_OPEN.includes(this.status)) {
      throw new Error(STREAM_FILTER_FAILURE)
    }
    this.status = "closed"
  }

  disconnect(): void {
    if (this.status === "disconnected") {
      return
    }
    if (!STREAM_FILTER_OPEN.includes(this.status)) {
      throw new Error(STREAM_FILTER_FAILURE)
    }
    this.status = "disconnected"
  }

  pushStart(): void {
    if (this.status !== "uninitialized") {
      throw new Error(`fake stream filter: start in ${this.status}`)
    }
    this.status = "transferringdata"
    this.onstart?.()
  }

  pushData(data: ArrayBuffer | Uint8Array | string): void {
    if (this.status === "uninitialized") {
      throw new Error("fake stream filter: data before start")
    }
    if (this.status === "disconnected") {
      this.page.push(bytesOf(data))
      return
    }
    if (this.status !== "transferringdata") {
      return
    }
    const chunk = bytesOf(data)
    this.ondata?.({ data: chunk.buffer as ArrayBuffer })
  }

  pushStop(): void {
    if (this.status !== "transferringdata") {
      return
    }
    this.status = "finishedtransferringdata"
    this.onstop?.()
  }

  pushError(message: string): void {
    if (this.status === "closed" || this.status === "disconnected" || this.status === "failed") {
      return
    }
    this.status = "failed"
    this.error = message
    this.onerror?.()
  }

  pageData(): Uint8Array {
    const total = this.page.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const joined = new Uint8Array(total)
    let offset = 0
    for (const chunk of this.page) {
      joined.set(chunk, offset)
      offset += chunk.byteLength
    }
    return joined
  }
}

// an emitter fills in what the test does not care about
type Emitted<D> = Omit<D, "timeStamp" | "frameId"> &
  Partial<Pick<RequestDetails, "timeStamp" | "frameId">>
type EmittedResponse<D> = Omit<Emitted<D>, "statusCode" | "statusLine" | "fromCache"> &
  Partial<Pick<ResponseDetails, "statusCode" | "statusLine" | "fromCache">>
type EmittedNavigation = Omit<FrameNavigationDetails, "parentFrameId" | "timeStamp"> &
  Partial<Pick<FrameNavigationDetails, "parentFrameId" | "timeStamp">>

export interface FakePortOptions {
  name?: string
  sender?: MessageSender
}

export class FakePort implements Port {
  readonly posted: unknown[] = []
  readonly onMessage = new FakeEvent<(message: unknown) => void>()
  readonly onDisconnect = new FakeEvent<(port: Port) => void>()
  readonly name: string
  readonly sender?: MessageSender
  error?: PortError
  disconnected = false

  constructor(options: FakePortOptions = {}) {
    this.name = options.name ?? ""
    this.sender = options.sender
  }

  postMessage(message: unknown): void {
    if (this.disconnected) {
      throw new Error("Attempt to postMessage on disconnected port")
    }
    this.posted.push(message)
  }

  disconnect(reason?: string): void {
    if (this.disconnected) {
      return
    }
    this.disconnected = true
    if (reason !== undefined) {
      this.error = { message: reason }
    }
    for (const listener of this.onDisconnect.snapshot()) {
      listener(this)
    }
  }

  emitMessage(message: unknown): void {
    if (this.disconnected) {
      return
    }
    for (const listener of this.onMessage.snapshot()) {
      listener(message)
    }
  }
}

export interface FakeBrowserOptions {
  manifestVersion?: string
  tabs?: Tab[]
  windows?: Window[]
  // Firefox below 138 has neither tabs.group nor tabGroups
  tabGroups?: boolean
  allowedIncognitoAccess?: boolean
  // the clock event emitters default timeStamp to
  now?: () => number
}

const DEFAULT_GEOMETRY = { width: 1280, height: 800, left: 0, top: 0 }

const DEFAULT_STORE = "firefox-default"
const PRIVATE_STORE = "firefox-private"

function storeOf(incognito: boolean | undefined): string {
  return incognito ? PRIVATE_STORE : DEFAULT_STORE
}

interface StoredCookie {
  cookie: Cookie
  created: number
}

// the host as cookies answer it: an IPv6 host in brackets
function urlHost(url: URL): string {
  return url.hostname
}

// what ext-cookies.js stores for set details: the url host without domain;
// an IP domain stays host-only, any other domain gains a leading dot
function cookieHost(url: URL, domain: string | undefined): { domain: string; hostOnly: boolean } {
  if (domain === undefined) {
    return { domain: urlHost(url), hostOnly: true }
  }
  const host = domain
    .replace(/^\./, "")
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
  if (host.includes(":")) {
    return { domain: `[${host}]`, hostOnly: true }
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return { domain: host, hostOnly: true }
  }
  return { domain: `.${host}`, hostOnly: false }
}

// what ext-cookies.js takes when set gets no path: nsIURL.directory, the url
// path up to and including its last slash
function defaultPath(url: URL): string {
  return url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) || "/"
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) {
    return true
  }
  return (
    requestPath.startsWith(cookiePath) &&
    (cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/")
  )
}

function hostMatches(host: string, cookie: Cookie): boolean {
  if (cookie.hostOnly) {
    return host === cookie.domain
  }
  const domain = cookie.domain.replace(/^\./, "")
  return host === domain || host.endsWith(`.${domain}`)
}

function urlMatches(url: URL, cookie: Cookie): boolean {
  if (cookie.secure && url.protocol !== "https:") {
    return false
  }
  return hostMatches(urlHost(url), cookie) && pathMatches(url.pathname, cookie.path)
}

function normalPartition(key: PartitionKey | undefined | null): PartitionKey | null {
  if (!key?.topLevelSite) {
    return null
  }
  return { topLevelSite: key.topLevelSite, hasCrossSiteAncestor: key.hasCrossSiteAncestor ?? false }
}

// the site getPartitionKeyFromURL keeps of a top-level url: scheme and
// registrable domain, here simply the last two labels, or the whole host when
// it has no registrable domain (an IP, localhost); never a port
function topSite(topLevelSite: string): URL {
  const url = new URL(topLevelSite)
  const labels = url.hostname.split(".")
  if (url.hostname.startsWith("[") || /^[\d.]+$/.test(url.hostname) || labels.length < 2) {
    return new URL(`${url.protocol}//${url.hostname}`)
  }
  return new URL(`${url.protocol}//${labels.slice(-2).join(".")}`)
}

function sameSite(host: string, site: URL): boolean {
  return host === site.hostname || host.endsWith(`.${site.hostname}`)
}

// the key ext-cookies.js answers: a cookie outside the top-level site always
// has a cross-site ancestor, and the cookie host of an IP has no brackets, so
// an IPv6 cookie is never inside its own site
function storedPartition(key: PartitionKey | undefined, domain: string): PartitionKey | null {
  const normal = normalPartition(key)
  if (normal === null) {
    return null
  }
  const site = topSite(normal.topLevelSite as string)
  const host = domain.replace(/^\./, "").replace(/^\[(.*)\]$/, "$1")
  return {
    topLevelSite: site.origin,
    hasCrossSiteAncestor: normal.hasCrossSiteAncestor || !sameSite(host, site),
  }
}

// getPartitionKeyFromURL throws for a topLevelSite that does not parse and
// for hasCrossSiteAncestor false on a url of another site
function partitionError(details: CookieSetDetails): string | undefined {
  const top = details.partitionKey?.topLevelSite
  if (!top) {
    return undefined
  }
  if (!URL.canParse(top)) {
    return "Invalid value for 'partitionKey' attribute"
  }
  const url = new URL(details.url)
  const crossSite = topSite(url.origin).hostname !== topSite(top).hostname
  if (details.partitionKey?.hasCrossSiteAncestor === false && crossSite) {
    return "Invalid value for 'partitionKey' attribute"
  }
  return undefined
}

function samePartition(a: PartitionKey | null, b: PartitionKey | null): boolean {
  return a?.topLevelSite === b?.topLevelSite && a?.hasCrossSiteAncestor === b?.hasCrossSiteAncestor
}

function sameIdentity(a: Cookie, b: Cookie): boolean {
  return (
    a.domain === b.domain &&
    a.hostOnly === b.hostOnly &&
    a.path === b.path &&
    a.name === b.name &&
    a.firstPartyDomain === b.firstPartyDomain &&
    samePartition(a.partitionKey, b.partitionKey)
  )
}

function partitionWanted(query: CookieQuery, cookie: Cookie): boolean {
  if (query.partitionKey === undefined) {
    return cookie.partitionKey === null
  }
  // a hasCrossSiteAncestor left out matches both values, like the
  // topLevelSiteFilter of ext-cookies.js
  const wanted = query.partitionKey
  if (!wanted?.topLevelSite) {
    return true
  }
  // like a getAll without url, the filter is the site of topLevelSite
  return (
    topSite(wanted.topLevelSite).origin === cookie.partitionKey?.topLevelSite &&
    (wanted.hasCrossSiteAncestor === undefined ||
      wanted.hasCrossSiteAncestor === cookie.partitionKey.hasCrossSiteAncestor)
  )
}

function queryMatches(query: CookieQuery, cookie: Cookie): boolean {
  if (query.name !== undefined && cookie.name !== query.name) {
    return false
  }
  if (
    query.firstPartyDomain !== null &&
    cookie.firstPartyDomain !== (query.firstPartyDomain ?? "")
  ) {
    return false
  }
  if (!partitionWanted(query, cookie)) {
    return false
  }
  if (query.domain !== undefined) {
    const wanted = query.domain.replace(/^\./, "").toLowerCase()
    const domain = cookie.domain.replace(/^\./, "")
    if (domain !== wanted && !domain.endsWith(`.${wanted}`)) {
      return false
    }
  }
  return query.url === undefined || urlMatches(new URL(query.url), cookie)
}

// in the order ext-cookies.js checks: before the write, then the cookie
// service validation
function validationError(details: CookieSetDetails): string | undefined {
  if (details.firstPartyDomain && details.partitionKey?.topLevelSite) {
    return "Partitioned cookies cannot have a 'firstPartyDomain' attribute."
  }
  const partition = partitionError(details)
  if (partition !== undefined) {
    return partition
  }
  const name = details.name ?? ""
  if (name === "" && (details.value ?? "") === "") {
    return "Cookie with an empty name and an empty value has been rejected."
  }
  if (details.sameSite === "no_restriction" && details.secure !== true) {
    return `Cookie “${name}” rejected because it has the “SameSite=None” attribute but is missing the “secure” attribute.`
  }
  return undefined
}

/**
 * An in-memory cookie store with the Firefox semantics handlers rely on:
 * identity by domain, host-only, path, name and origin attributes; partitioned
 * and first-party cookies hidden unless asked for; an expired set deleting;
 * and a set answer that is `cookies.get(url, name)`, not the written cookie.
 */
export class FakeCookieJar implements Cookies {
  readonly queries: CookieQuery[] = []
  readonly sets: CookieSetDetails[] = []
  // replaces the jar's own set; the jar stays reachable through write
  setHandler?: (details: CookieSetDetails) => Promise<Cookie | null>
  now: () => number = () => Date.now() / 1000

  private readonly stores = new Map<string, StoredCookie[]>()
  private created = 0

  constructor(private readonly privateAllowed: () => boolean) {}

  getAll(query: CookieQuery): Promise<Cookie[]> {
    this.queries.push(query)
    const storeId = query.storeId ?? DEFAULT_STORE
    const refused = this.storeError(storeId)
    if (refused) {
      return Promise.reject(new Error(refused))
    }
    const found = this.storeCookies(storeId)
      .filter((stored) => queryMatches(query, stored.cookie))
      .map((stored) => this.copy(stored.cookie))
    return Promise.resolve(found)
  }

  set(details: CookieSetDetails): Promise<Cookie | null> {
    this.sets.push(details)
    if (this.setHandler) {
      return this.setHandler(details)
    }
    return this.write(details)
  }

  write(details: CookieSetDetails): Promise<Cookie | null> {
    if (typeof details.url !== "string") {
      return Promise.reject(
        new Error('Type error for parameter details (Property "url" is required) for cookies.set.'),
      )
    }
    const storeId = details.storeId ?? DEFAULT_STORE
    const refused = this.storeError(storeId) ?? validationError(details)
    if (refused) {
      return Promise.reject(new Error(refused))
    }
    const url = new URL(details.url)
    const cookie = this.build(url, details, storeId)
    const cookies = this.storeCookies(storeId).filter(
      (stored) => !sameIdentity(stored.cookie, cookie),
    )
    const expired = cookie.expirationDate !== undefined && cookie.expirationDate <= this.now()
    if (!expired) {
      cookies.push({ cookie, created: this.created++ })
    }
    this.stores.set(storeId, cookies)
    return Promise.resolve(this.lookup(url, cookie))
  }

  // stores a cookie without validation, like a legacy cookie Firefox kept
  // from before a rule it now enforces on set
  insert(cookie: Cookie): void {
    const cookies = this.storeCookies(cookie.storeId).filter(
      (stored) => !sameIdentity(stored.cookie, cookie),
    )
    cookies.push({ cookie: this.copy(cookie), created: this.created++ })
    this.stores.set(cookie.storeId, cookies)
  }

  private build(url: URL, details: CookieSetDetails, storeId: string): Cookie {
    const { domain, hostOnly } = cookieHost(url, details.domain)
    const cookie: Cookie = {
      name: details.name ?? "",
      value: details.value ?? "",
      domain,
      hostOnly,
      path: details.path ?? defaultPath(url),
      secure: details.secure ?? false,
      httpOnly: details.httpOnly ?? false,
      sameSite: details.sameSite ?? "unspecified",
      session: details.expirationDate === undefined,
      storeId,
      firstPartyDomain: details.firstPartyDomain ?? "",
      partitionKey: storedPartition(details.partitionKey, domain),
    }
    if (details.expirationDate !== undefined) {
      cookie.expirationDate = details.expirationDate
    }
    return cookie
  }

  // what ext-cookies.js answers set with: cookies.get(url, name), the match
  // with the longest path, then the earliest creation
  private lookup(url: URL, written: Cookie): Cookie | null {
    const candidates = this.storeCookies(written.storeId)
      .filter(
        (stored) =>
          stored.cookie.name === written.name &&
          stored.cookie.firstPartyDomain === written.firstPartyDomain &&
          samePartition(stored.cookie.partitionKey, written.partitionKey) &&
          urlMatches(url, stored.cookie),
      )
      .sort((a, b) => b.cookie.path.length - a.cookie.path.length || a.created - b.created)
    const found = candidates[0]
    return found ? this.copy(found.cookie) : null
  }

  private storeError(storeId: string): string | undefined {
    if (storeId === PRIVATE_STORE) {
      return this.privateAllowed()
        ? undefined
        : "Extension disallowed access to the private cookies storeId."
    }
    if (storeId === DEFAULT_STORE || /^firefox-container-\d+$/.test(storeId)) {
      return undefined
    }
    return `Invalid cookie store id: "${storeId}"`
  }

  private storeCookies(storeId: string): StoredCookie[] {
    return this.stores.get(storeId) ?? []
  }

  private copy(cookie: Cookie): Cookie {
    return {
      ...cookie,
      partitionKey: cookie.partitionKey === null ? null : { ...cookie.partitionKey },
    }
  }
}

export class FakeBrowser implements Browser {
  readonly runtime: Runtime
  readonly tabs: Tabs
  readonly windows: Windows
  readonly storage: Storage
  readonly extension: Extension
  readonly webRequest: WebRequest
  readonly webNavigation: WebNavigation
  readonly cookies: Cookies
  readonly tabGroups?: TabGroups

  readonly cookieJar = new FakeCookieJar(() => this.allowedIncognitoAccess)
  readonly ports: FakePort[] = []
  readonly connectedPorts: FakePort[] = []
  readonly connectedHosts: string[] = []
  readonly sentMessages: {
    tabId: number
    message: unknown
    options?: SendMessageOptions
  }[] = []
  readonly executeScriptCalls: { tabId: number; details: ExecuteScriptDetails }[] = []
  readonly runtimeMessages = new FakeEvent<MessageListener>()
  readonly runtimeConnections = new FakeEvent<(port: Port) => void>()
  readonly navigationsStarted = new FakeEvent<(details: FrameNavigationDetails) => void>()
  readonly navigationsCommitted = new FakeEvent<(details: FrameNavigationDetails) => void>()
  readonly framesLoaded = new FakeEvent<(details: FrameNavigationDetails) => void>()
  readonly navigationsCompleted = new FakeEvent<(details: FrameNavigationDetails) => void>()
  readonly tabsRemoved = new FakeEvent<(tabId: number, removeInfo: TabRemoveInfo) => void>()
  readonly tabsUpdated = new FakeEvent<
    (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void
  >()
  readonly tabsActivated = new FakeEvent<(activeInfo: TabActiveInfo) => void>()
  readonly windowsRemoved = new FakeEvent<(windowId: number) => void>()
  readonly requestsStarted = new FakeWebRequestEvent<BlockingListener<RequestDetails>>(
    "onBeforeRequest",
    ["blocking", "requestBody"],
  )
  readonly headersSent = new FakeWebRequestEvent<(details: SendHeadersDetails) => void>(
    "onSendHeaders",
    ["requestHeaders"],
  )
  readonly headersReceived = new FakeWebRequestEvent<BlockingListener<HeadersReceivedDetails>>(
    "onHeadersReceived",
    ["blocking", "responseHeaders"],
  )
  readonly responsesStarted = new FakeWebRequestEvent<(details: ResponseDetails) => void>(
    "onResponseStarted",
    ["responseHeaders"],
  )
  readonly requestsRedirected = new FakeWebRequestEvent<(details: RedirectDetails) => void>(
    "onBeforeRedirect",
    ["responseHeaders"],
  )
  readonly requestsCompleted = new FakeWebRequestEvent<(details: CompletedDetails) => void>(
    "onCompleted",
    ["responseHeaders"],
  )
  readonly requestsFailed = new FakeWebRequestEvent<(details: ErrorDetails) => void>(
    "onErrorOccurred",
    null,
  )
  readonly streamFilters: { requestId: string; filter: FakeStreamFilter }[] = []
  readonly securityInfoCalls: {
    requestId: string
    options: SecurityInfoOptions
    blocking: boolean
  }[] = []
  readonly captures: { tabId: number; options?: CaptureOptions }[] = []

  // set to make connectNative throw the way Firefox does for a missing manifest
  failConnect?: string
  // set to make windows.create({incognito: true}) reject the way Firefox does
  // without the "Run in Private Windows" permission
  failPrivate?: string
  sendMessageHandler?: (
    tabId: number,
    message: unknown,
    options?: SendMessageOptions,
  ) => Promise<unknown>
  executeScriptHandler?: (tabId: number, details: ExecuteScriptDetails) => Promise<unknown[]>
  // Firefox fills the sender in on the receiving end of a runtime port; a fake
  // content side sets it so the background can admit the port it opens
  connectSender?: MessageSender
  captureHandler?: (tabId: number, options?: CaptureOptions) => Promise<string>
  // set to make filterResponseData throw
  failFilterResponseData?: string
  // what getSecurityInfo answers inside a blocking onHeadersReceived; an
  // Error rejects
  securityInfo: SecurityInfo | Error = { state: "insecure" }
  now: () => number
  currentWindowId = 1
  allowedIncognitoAccess: boolean

  private readonly manifest: Manifest
  private readonly tabsById = new Map<number, Tab>()
  private readonly windowsById = new Map<number, Window>()
  private readonly groupsById = new Map<number, TabGroup>()
  private readonly storageItems = new Map<string, unknown>()
  private lastFocusedWindowId?: number
  private nextTabId = 1
  private nextWindowId = 1
  private nextGroupId = 1

  constructor(options: FakeBrowserOptions = {}) {
    this.manifest = { version: options.manifestVersion ?? "0.1.0" }
    this.allowedIncognitoAccess = options.allowedIncognitoAccess ?? true
    this.now = options.now ?? (() => 0)
    for (const tab of options.tabs ?? []) {
      this.addTab(tab)
    }
    for (const window of options.windows ?? []) {
      this.addWindow(window)
    }

    this.runtime = {
      connectNative: (name) => this.connectNative(name),
      connect: (info) => this.connect(info),
      getManifest: () => this.manifest,
      onMessage: this.runtimeMessages,
      onConnect: this.runtimeConnections,
    }
    this.tabs = {
      get: (tabId) => this.getTab(tabId),
      query: (query) => this.queryTabs(query),
      create: (properties) => this.createTab(properties),
      remove: (tabId) => this.removeTabApi(tabId),
      update: (tabId, properties) => this.updateTab(tabId, properties),
      sendMessage: (tabId, message, sendOptions) =>
        this.sendTabMessage(tabId, message, sendOptions),
      executeScript: (tabId, details) => this.executeScript(tabId, details),
      captureTab: (tabId, captureOptions) => this.captureTab(tabId, captureOptions),
      group:
        options.tabGroups === false ? undefined : (groupOptions) => this.groupTabs(groupOptions),
      onRemoved: this.tabsRemoved,
      onUpdated: this.tabsUpdated,
      onActivated: this.tabsActivated,
    }
    this.windows = {
      get: (windowId, getOptions) => this.getWindow(windowId, getOptions),
      getAll: (getOptions) => this.getAllWindows(getOptions),
      getLastFocused: (getOptions) => this.getLastFocusedWindow(getOptions),
      create: (data) => this.createWindow(data),
      update: (windowId, info) => this.updateWindow(windowId, info),
      remove: (windowId) => this.removeWindow(windowId),
      onRemoved: this.windowsRemoved,
    }
    this.storage = { local: this.localStorageArea() }
    this.webRequest = {
      onBeforeRequest: this.requestsStarted,
      onSendHeaders: this.headersSent,
      onHeadersReceived: this.headersReceived,
      onResponseStarted: this.responsesStarted,
      onBeforeRedirect: this.requestsRedirected,
      onCompleted: this.requestsCompleted,
      onErrorOccurred: this.requestsFailed,
      filterResponseData: (requestId) => this.filterResponseData(requestId),
      getSecurityInfo: (requestId, securityOptions) =>
        this.getSecurityInfo(requestId, securityOptions),
    }
    this.webNavigation = {
      onBeforeNavigate: this.navigationsStarted,
      onCommitted: this.navigationsCommitted,
      onDOMContentLoaded: this.framesLoaded,
      onCompleted: this.navigationsCompleted,
    }
    this.cookies = {
      getAll: (query) => this.cookieJar.getAll(query),
      set: (details) => this.cookieJar.set(details),
    }
    this.extension = {
      isAllowedIncognitoAccess: () => Promise.resolve(this.allowedIncognitoAccess),
    }
    if (options.tabGroups !== false) {
      this.tabGroups = {
        query: (query) => this.queryGroups(query),
        update: (groupId, properties) => this.updateGroup(groupId, properties),
      }
    }
  }

  get cookieQueries(): CookieQuery[] {
    return this.cookieJar.queries
  }

  get cookieSets(): CookieSetDetails[] {
    return this.cookieJar.sets
  }

  set cookieSetHandler(handler:
    | ((details: CookieSetDetails) => Promise<Cookie | null>)
    | undefined) {
    this.cookieJar.setHandler = handler
  }

  // the jar's own set, for a cookieSetHandler that fails only some cookies
  writeCookie(details: CookieSetDetails): Promise<Cookie | null> {
    return this.cookieJar.write(details)
  }

  lastPort(): FakePort | undefined {
    return this.ports.at(-1)
  }

  addTab(tab: Tab): void {
    if (tab.id === undefined) {
      throw new Error("fake tab needs an id")
    }
    this.tabsById.set(tab.id, tab)
    this.nextTabId = Math.max(this.nextTabId, tab.id + 1)
  }

  removeTab(tabId: number, removeInfo?: Partial<TabRemoveInfo>): void {
    const tab = this.tabsById.get(tabId)
    const windowId = removeInfo?.windowId ?? tab?.windowId ?? this.currentWindowId
    this.tabsById.delete(tabId)
    const emptied = this.windowsById.has(windowId) && this.tabsOf(windowId).length === 0
    const info: TabRemoveInfo = {
      windowId,
      isWindowClosing: removeInfo?.isWindowClosing ?? emptied,
    }
    for (const listener of this.tabsRemoved.snapshot()) {
      listener(tabId, info)
    }
    if (emptied) {
      this.dropWindow(windowId)
    }
  }

  emitTabUpdated(tabId: number, changeInfo: TabChangeInfo): void {
    const tab = this.tabsById.get(tabId) ?? { id: tabId }
    Object.assign(tab, changeInfo)
    for (const listener of this.tabsUpdated.snapshot()) {
      listener(tabId, changeInfo, tab)
    }
  }

  // the promise resolves to the answers of the blocking listeners
  emitRequestStarted(details: Emitted<RequestDetails>): Promise<(BlockingResponse | undefined)[]> {
    return this.requestsStarted.deliver(this.stamped(details)) as Promise<
      (BlockingResponse | undefined)[]
    >
  }

  emitSendHeaders(details: Emitted<SendHeadersDetails>): void {
    void this.headersSent.deliver(this.stamped(details))
  }

  emitHeadersReceived(
    details: EmittedResponse<HeadersReceivedDetails>,
  ): Promise<(BlockingResponse | undefined)[]> {
    const { fromCache, ...rest } = details
    const received: HeadersReceivedDetails = this.response(rest, 200)
    if (fromCache !== undefined) {
      received.fromCache = fromCache
    }
    return this.headersReceived.deliver(received) as Promise<(BlockingResponse | undefined)[]>
  }

  emitResponseStarted(details: EmittedResponse<ResponseDetails>): void {
    void this.responsesStarted.deliver({ fromCache: false, ...this.response(details, 200) })
  }

  emitRedirect(details: EmittedResponse<RedirectDetails>): void {
    void this.requestsRedirected.deliver({ fromCache: false, ...this.response(details, 302) })
  }

  emitRequestCompleted(details: EmittedResponse<CompletedDetails>): void {
    void this.requestsCompleted.deliver({ fromCache: false, ...this.response(details, 200) })
  }

  emitRequestFailed(details: Emitted<ErrorDetails>): void {
    void this.requestsFailed.deliver(this.stamped(details))
  }

  // the last filter created for the request
  streamFilterFor(requestId: string): FakeStreamFilter | undefined {
    return this.streamFilters.filter((entry) => entry.requestId === requestId).at(-1)?.filter
  }

  addWindow(window: Window): void {
    if (window.id === undefined) {
      throw new Error("fake window needs an id")
    }
    const stored: Window = {
      type: "normal",
      incognito: false,
      focused: false,
      ...DEFAULT_GEOMETRY,
      ...window,
    }
    this.windowsById.set(window.id, stored)
    this.nextWindowId = Math.max(this.nextWindowId, window.id + 1)
    if (stored.focused) {
      this.lastFocusedWindowId = window.id
    }
  }

  focusWindow(windowId: number): void {
    for (const window of this.windowsById.values()) {
      window.focused = window.id === windowId
    }
    this.lastFocusedWindowId = windowId
  }

  async emitRuntimeMessage(message: unknown, sender: MessageSender = {}): Promise<unknown> {
    for (const listener of this.runtimeMessages.snapshot()) {
      const result = await listener(message, sender)
      if (result !== undefined) {
        return result
      }
    }
    return undefined
  }

  emitConnect(port: FakePort): void {
    for (const listener of this.runtimeConnections.snapshot()) {
      listener(port)
    }
  }

  emitBeforeNavigate(details: EmittedNavigation): void {
    this.navigate(this.navigationsStarted, details)
  }

  emitCommitted(details: EmittedNavigation): void {
    this.navigate(this.navigationsCommitted, details)
  }

  emitFrameLoaded(details: EmittedNavigation): void {
    this.navigate(this.framesLoaded, details)
  }

  emitNavigationCompleted(details: EmittedNavigation): void {
    this.navigate(this.navigationsCompleted, details)
  }

  private navigate(
    event: FakeEvent<(details: FrameNavigationDetails) => void>,
    details: EmittedNavigation,
  ): void {
    const stamped: FrameNavigationDetails = { parentFrameId: 0, timeStamp: this.now(), ...details }
    for (const listener of event.snapshot()) {
      listener(stamped)
    }
  }

  private stamped<D extends object>(details: D): D & Pick<RequestDetails, "timeStamp" | "frameId"> {
    return { frameId: 0, timeStamp: this.now(), ...details }
  }

  private response<D extends EmittedResponse<HeadersReceivedDetails>>(
    details: D,
    statusCode: number,
  ): D & Pick<HeadersReceivedDetails, "statusCode" | "statusLine" | "timeStamp" | "frameId"> {
    const code = details.statusCode ?? statusCode
    return this.stamped({
      ...details,
      statusCode: code,
      statusLine: details.statusLine ?? `HTTP/1.1 ${code}`,
    })
  }

  private filterResponseData(requestId: string): StreamFilter {
    if (this.failFilterResponseData !== undefined) {
      throw new Error(this.failFilterResponseData)
    }
    const filter = new FakeStreamFilter(requestId)
    this.streamFilters.push({ requestId, filter })
    return filter
  }

  // Firefox finds the channel only while a blocking onHeadersReceived holds
  // it and answers undefined otherwise
  private getSecurityInfo(
    requestId: string,
    options: SecurityInfoOptions,
  ): Promise<SecurityInfo | undefined> {
    const blocking = this.headersReceived.isBlocking(requestId)
    this.securityInfoCalls.push({ requestId, options, blocking })
    if (!blocking) {
      return Promise.resolve(undefined)
    }
    if (this.securityInfo instanceof Error) {
      return Promise.reject(this.securityInfo)
    }
    return Promise.resolve(this.securityInfo)
  }

  private connect(info: ConnectInfo): Port {
    const port = new FakePort({ name: info.name, sender: this.connectSender })
    this.connectedPorts.push(port)
    return port
  }

  private connectNative(name: string): Port {
    this.connectedHosts.push(name)
    if (this.failConnect !== undefined) {
      throw new Error(this.failConnect)
    }
    const port = new FakePort()
    this.ports.push(port)
    return port
  }

  private getTab(tabId: number): Promise<Tab> {
    const tab = this.tabsById.get(tabId)
    if (!tab) {
      return Promise.reject(new Error(`Invalid tab ID: ${tabId}`))
    }
    return Promise.resolve(tab)
  }

  private queryTabs(query: TabQuery): Promise<Tab[]> {
    const windowId = query.currentWindow ? this.currentWindowId : query.windowId
    const tabs = [...this.tabsById.values()].filter((tab) => {
      if (windowId !== undefined && tab.windowId !== windowId) {
        return false
      }
      if (query.active !== undefined && tab.active !== query.active) {
        return false
      }
      return true
    })
    return Promise.resolve(tabs)
  }

  private createTab(properties: TabCreateProperties): Promise<Tab> {
    const windowId = properties.windowId ?? this.currentWindowId
    const window = this.windowsById.get(windowId)
    if (properties.windowId !== undefined && !window) {
      return Promise.reject(new Error(`Invalid window ID: ${windowId}`))
    }
    const active = properties.active ?? true
    const tab: Tab = {
      id: this.nextTabId++,
      windowId,
      index: this.tabsOf(windowId).length,
      active,
      pinned: false,
      incognito: window?.incognito ?? false,
      cookieStoreId: storeOf(window?.incognito),
      url: properties.url ?? "about:blank",
    }
    if (active) {
      this.deactivateSiblings(windowId)
    }
    this.tabsById.set(tab.id as number, tab)
    return Promise.resolve(tab)
  }

  private removeTabApi(tabId: number): Promise<void> {
    if (!this.tabsById.has(tabId)) {
      return Promise.reject(new Error(`Invalid tab ID: ${tabId}`))
    }
    this.removeTab(tabId)
    return Promise.resolve()
  }

  private updateTab(tabId: number, properties: TabUpdateProperties): Promise<Tab> {
    const tab = this.tabsById.get(tabId)
    if (!tab) {
      return Promise.reject(new Error(`Invalid tab ID: ${tabId}`))
    }
    if (properties.url !== undefined) {
      tab.url = properties.url
    }
    if (properties.active === true) {
      const windowId = tab.windowId ?? this.currentWindowId
      this.deactivateSiblings(windowId)
      tab.active = true
      for (const listener of this.tabsActivated.snapshot()) {
        listener({ tabId, windowId })
      }
    }
    return Promise.resolve(tab)
  }

  private sendTabMessage(
    tabId: number,
    message: unknown,
    options?: SendMessageOptions,
  ): Promise<unknown> {
    this.sentMessages.push({ tabId, message, options })
    if (this.sendMessageHandler) {
      return this.sendMessageHandler(tabId, message, options)
    }
    return Promise.reject(
      new Error("Could not establish connection. Receiving end does not exist."),
    )
  }

  private executeScript(tabId: number, details: ExecuteScriptDetails): Promise<unknown[]> {
    this.executeScriptCalls.push({ tabId, details })
    if (this.executeScriptHandler) {
      return this.executeScriptHandler(tabId, details)
    }
    return Promise.resolve([])
  }

  private captureTab(tabId: number, options?: CaptureOptions): Promise<string> {
    this.captures.push({ tabId, options })
    if (this.captureHandler) {
      return this.captureHandler(tabId, options)
    }
    if (!this.tabsById.has(tabId)) {
      return Promise.reject(new Error(`Invalid tab ID: ${tabId}`))
    }
    const format = options?.format ?? "jpeg"
    return Promise.resolve(`data:image/${format};base64,Zm94Y3Rs`)
  }

  private groupTabs(options: TabGroupOptions): Promise<number> {
    const windowId = options.createProperties?.windowId
    const groupId = options.groupId ?? this.nextGroupId++
    if (!this.groupsById.has(groupId)) {
      this.groupsById.set(groupId, { id: groupId, windowId })
    }
    for (const tabId of options.tabIds) {
      const tab = this.tabsById.get(tabId)
      if (!tab) {
        return Promise.reject(new Error(`Invalid tab ID: ${tabId}`))
      }
      tab.groupId = groupId
      const group = this.groupsById.get(groupId) as TabGroup
      group.windowId = group.windowId ?? tab.windowId
    }
    return Promise.resolve(groupId)
  }

  private queryGroups(query: TabGroupQuery): Promise<TabGroup[]> {
    const groups = [...this.groupsById.values()].filter((group) => {
      if (query.title !== undefined && group.title !== query.title) {
        return false
      }
      if (query.windowId !== undefined && group.windowId !== query.windowId) {
        return false
      }
      return true
    })
    return Promise.resolve(groups.map((group) => ({ ...group })))
  }

  private updateGroup(groupId: number, properties: TabGroupUpdateProperties): Promise<TabGroup> {
    const group = this.groupsById.get(groupId)
    if (!group) {
      return Promise.reject(new Error(`No group with id: ${groupId}`))
    }
    Object.assign(group, properties)
    return Promise.resolve({ ...group })
  }

  private getWindow(windowId: number, options?: WindowGetOptions): Promise<Window> {
    const window = this.windowsById.get(windowId)
    if (!window) {
      return Promise.reject(new Error(`Invalid window ID: ${windowId}`))
    }
    return Promise.resolve(this.snapshotWindow(window, options))
  }

  private getAllWindows(options?: WindowGetOptions): Promise<Window[]> {
    const windows = [...this.windowsById.values()].map((window) =>
      this.snapshotWindow(window, options),
    )
    return Promise.resolve(windows)
  }

  private getLastFocusedWindow(options?: WindowGetOptions): Promise<Window> {
    const last =
      (this.lastFocusedWindowId === undefined
        ? undefined
        : this.windowsById.get(this.lastFocusedWindowId)) ?? [...this.windowsById.values()].at(-1)
    if (!last) {
      return Promise.reject(new Error("No window found"))
    }
    return Promise.resolve(this.snapshotWindow(last, options))
  }

  private createWindow(data: WindowCreateData): Promise<Window> {
    const incognito = data.incognito ?? false
    if (incognito && this.failPrivate !== undefined) {
      return Promise.reject(new Error(this.failPrivate))
    }
    const windowId = this.nextWindowId++
    const window: Window = {
      id: windowId,
      type: "normal",
      incognito,
      focused: data.focused ?? true,
      ...DEFAULT_GEOMETRY,
    }
    this.windowsById.set(windowId, window)
    if (window.focused) {
      this.focusWindow(windowId)
    }
    const tab: Tab = {
      id: this.nextTabId++,
      windowId,
      index: 0,
      active: true,
      pinned: false,
      incognito,
      cookieStoreId: storeOf(incognito),
      url: data.url ?? "about:blank",
    }
    this.tabsById.set(tab.id as number, tab)
    return Promise.resolve(this.snapshotWindow(window, { populate: true }))
  }

  private updateWindow(windowId: number, info: WindowUpdateInfo): Promise<Window> {
    const window = this.windowsById.get(windowId)
    if (!window) {
      return Promise.reject(new Error(`Invalid window ID: ${windowId}`))
    }
    for (const [key, value] of Object.entries(info)) {
      if (value !== undefined) {
        Object.assign(window, { [key]: value })
      }
    }
    if (info.focused === true) {
      this.focusWindow(windowId)
    }
    return Promise.resolve(this.snapshotWindow(window))
  }

  private removeWindow(windowId: number): Promise<void> {
    if (!this.windowsById.has(windowId)) {
      return Promise.reject(new Error(`Invalid window ID: ${windowId}`))
    }
    for (const tab of this.tabsOf(windowId)) {
      this.tabsById.delete(tab.id as number)
      for (const listener of this.tabsRemoved.snapshot()) {
        listener(tab.id as number, { windowId, isWindowClosing: true })
      }
    }
    this.dropWindow(windowId)
    return Promise.resolve()
  }

  private dropWindow(windowId: number): void {
    this.windowsById.delete(windowId)
    if (this.lastFocusedWindowId === windowId) {
      this.lastFocusedWindowId = undefined
    }
    for (const listener of this.windowsRemoved.snapshot()) {
      listener(windowId)
    }
  }

  private snapshotWindow(window: Window, options?: WindowGetOptions): Window {
    const copy: Window = { ...window }
    if (options?.populate) {
      copy.tabs = this.tabsOf(window.id as number)
    }
    return copy
  }

  private tabsOf(windowId: number): Tab[] {
    return [...this.tabsById.values()].filter((tab) => tab.windowId === windowId)
  }

  private deactivateSiblings(windowId: number): void {
    for (const tab of this.tabsOf(windowId)) {
      tab.active = false
    }
  }

  private localStorageArea(): StorageArea {
    return {
      get: (keys) => {
        const wanted =
          keys === undefined || keys === null
            ? [...this.storageItems.keys()]
            : typeof keys === "string"
              ? [keys]
              : keys
        const items: Record<string, unknown> = {}
        for (const key of wanted) {
          if (this.storageItems.has(key)) {
            items[key] = this.storageItems.get(key)
          }
        }
        return Promise.resolve(items)
      },
      set: (items) => {
        for (const [key, value] of Object.entries(items)) {
          this.storageItems.set(key, value)
        }
        return Promise.resolve()
      },
      remove: (keys) => {
        for (const key of typeof keys === "string" ? [keys] : keys) {
          this.storageItems.delete(key)
        }
        return Promise.resolve()
      },
    }
  }
}

export interface FakeEnvironmentOptions {
  now?: number
}

interface VirtualTimer {
  due: number
  seq: number
  handler: () => void
}

export class FakeEnvironment implements Environment {
  private clock: number
  private uuidCount = 0
  private nextTimerId = 1
  private seq = 0
  private readonly timers = new Map<number, VirtualTimer>()

  constructor(options: FakeEnvironmentOptions = {}) {
    this.clock = options.now ?? 0
  }

  randomUUID(): string {
    this.uuidCount++
    return `uuid-${this.uuidCount}`
  }

  now(): number {
    return this.clock
  }

  setTimeout(handler: () => void, timeoutMs: number): number {
    const id = this.nextTimerId++
    this.seq++
    this.timers.set(id, { due: this.clock + timeoutMs, seq: this.seq, handler })
    return id
  }

  clearTimeout(timerId: number): void {
    this.timers.delete(timerId)
  }

  pendingTimers(): number {
    return this.timers.size
  }

  // runs every timer due within the window, including ones scheduled by the
  // handlers themselves, moving the clock to each deadline in turn
  advance(ms: number): void {
    const target = this.clock + ms
    for (;;) {
      const next = this.nextDue(target)
      if (!next) {
        break
      }
      const [id, timer] = next
      this.timers.delete(id)
      this.clock = timer.due
      timer.handler()
    }
    this.clock = target
  }

  private nextDue(target: number): [number, VirtualTimer] | undefined {
    let found: [number, VirtualTimer] | undefined
    for (const entry of this.timers.entries()) {
      const timer = entry[1]
      if (timer.due > target) {
        continue
      }
      if (
        !found ||
        timer.due < found[1].due ||
        (timer.due === found[1].due && timer.seq < found[1].seq)
      ) {
        found = entry
      }
    }
    return found
  }
}
