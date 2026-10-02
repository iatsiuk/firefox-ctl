// The subset of the WebExtension API the extension uses. Everything except the
// entry points takes this interface, so tests inject fakes instead of globals.

export interface Event<F> {
  addListener(listener: F): void
  removeListener(listener: F): void
  hasListener(listener: F): boolean
}

export interface PortError {
  message: string
}

export interface Port {
  postMessage(message: unknown): void
  disconnect(): void
  readonly onMessage: Event<(message: unknown) => void>
  readonly onDisconnect: Event<(port: Port) => void>
  // Firefox sets error on the port it passes to onDisconnect listeners
  readonly error?: PortError
  // the name the connecting side passed to runtime.connect
  readonly name?: string
  // set by Firefox on the background side of a runtime port
  readonly sender?: MessageSender
}

export interface Manifest {
  version: string
}

export interface MessageSender {
  tab?: Tab
  id?: string
  url?: string
  // the frame the message came from; 0 is the top document
  frameId?: number
}

export type MessageListener = (
  message: unknown,
  sender: MessageSender,
) => unknown | Promise<unknown>

export interface ConnectInfo {
  name: string
}

export interface Runtime {
  connectNative(name: string): Port
  connect(info: ConnectInfo): Port
  getManifest(): Manifest
  readonly onMessage: Event<MessageListener>
  readonly onConnect: Event<(port: Port) => void>
}

export interface Tab {
  id?: number
  windowId?: number
  index?: number
  active?: boolean
  pinned?: boolean
  incognito?: boolean
  groupId?: number
  url?: string
  title?: string
  status?: string
  // firefox-default, firefox-private or a container store
  cookieStoreId?: string
}

export interface TabQuery {
  windowId?: number
  active?: boolean
  currentWindow?: boolean
  url?: string | string[]
}

export interface TabCreateProperties {
  windowId?: number
  url?: string
  active?: boolean
  index?: number
}

export interface TabUpdateProperties {
  url?: string
  active?: boolean
}

export interface CaptureOptions {
  format?: string
  quality?: number
}

export interface TabGroupOptions {
  tabIds: number[]
  groupId?: number
  createProperties?: { windowId?: number }
}

export interface TabChangeInfo {
  status?: string
  url?: string
  title?: string
}

export interface TabRemoveInfo {
  windowId: number
  isWindowClosing: boolean
}

export interface TabActiveInfo {
  tabId: number
  windowId: number
  previousTabId?: number
}

export interface SendMessageOptions {
  // which frame of the tab receives the message; 0 is the top document
  frameId: number
}

export interface ExecuteScriptDetails {
  frameId?: number
  file: string
  runAt?: "document_start" | "document_end" | "document_idle"
  // Firefox refuses to inject into about:blank and about:srcdoc frames unless
  // this is set; zoid-style provider frames stay on one of those permanently
  matchAboutBlank?: boolean
}

export interface Tabs {
  get(tabId: number): Promise<Tab>
  query(query: TabQuery): Promise<Tab[]>
  create(properties: TabCreateProperties): Promise<Tab>
  remove(tabId: number): Promise<void>
  update(tabId: number, properties: TabUpdateProperties): Promise<Tab>
  sendMessage(tabId: number, message: unknown, options?: SendMessageOptions): Promise<unknown>
  executeScript(tabId: number, details: ExecuteScriptDetails): Promise<unknown[]>
  // renders a tab without activating it and returns a data URL
  captureTab(tabId: number, options?: CaptureOptions): Promise<string>
  // tab groups landed in Firefox 138, so the method may be missing
  group?(options: TabGroupOptions): Promise<number>
  readonly onRemoved: Event<(tabId: number, removeInfo: TabRemoveInfo) => void>
  readonly onUpdated: Event<(tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void>
  readonly onActivated: Event<(activeInfo: TabActiveInfo) => void>
}

export interface TabGroup {
  id: number
  title?: string
  color?: string
  windowId?: number
}

export interface TabGroupQuery {
  title?: string
  windowId?: number
}

export interface TabGroupUpdateProperties {
  title?: string
  color?: string
}

export interface TabGroups {
  query(query: TabGroupQuery): Promise<TabGroup[]>
  update(groupId: number, properties: TabGroupUpdateProperties): Promise<TabGroup>
}

export interface Window {
  id?: number
  focused?: boolean
  state?: string
  type?: string
  incognito?: boolean
  width?: number
  height?: number
  left?: number
  top?: number
  tabs?: Tab[]
}

export interface WindowGetOptions {
  populate?: boolean
}

export interface WindowCreateData {
  incognito?: boolean
  focused?: boolean
  url?: string
}

export interface WindowUpdateInfo {
  width?: number
  height?: number
  left?: number
  top?: number
  focused?: boolean
}

export interface Windows {
  get(windowId: number, options?: WindowGetOptions): Promise<Window>
  getAll(options?: WindowGetOptions): Promise<Window[]>
  getLastFocused(options?: WindowGetOptions): Promise<Window>
  create(data: WindowCreateData): Promise<Window>
  update(windowId: number, info: WindowUpdateInfo): Promise<Window>
  remove(windowId: number): Promise<void>
  readonly onRemoved: Event<(windowId: number) => void>
}

export interface HttpHeader {
  name: string
  value?: string
  /** Firefox uses this instead of `value` when the header is not valid UTF-8. */
  binaryValue?: number[]
}

// a raw part carries bytes, or file with the placeholder "<file>"; truncated
// and originalSize appear when Firefox cut the body at its own raw cap
export interface UploadData {
  bytes?: ArrayBuffer
  file?: string
  truncated?: boolean
  originalSize?: number
}

// present only for a listener registered with "requestBody"
export interface RequestBody {
  formData?: Record<string, string[]>
  raw?: UploadData[]
  error?: string
}

export interface RequestDetails {
  requestId: string
  url: string
  method: string
  type: string
  tabId: number
  frameId: number
  timeStamp: number
  documentUrl?: string
  originUrl?: string
  requestBody?: RequestBody
}

// requestHeaders only for a listener registered with "requestHeaders"
export interface SendHeadersDetails extends RequestDetails {
  requestHeaders?: HttpHeader[]
}

// responseHeaders only for a listener registered with "responseHeaders"
export interface HeadersReceivedDetails extends RequestDetails {
  statusCode: number
  statusLine: string
  responseHeaders?: HttpHeader[]
  ip?: string
  fromCache?: boolean
}

export interface ResponseDetails extends HeadersReceivedDetails {
  fromCache: boolean
}

export interface RedirectDetails extends ResponseDetails {
  redirectUrl: string
}

export type CompletedDetails = ResponseDetails

export interface ErrorDetails extends RequestDetails {
  error: string
}

export interface RequestFilter {
  urls: string[]
  tabId?: number
}

export interface BlockingResponse {
  cancel?: boolean
  redirectUrl?: string
  requestHeaders?: HttpHeader[]
  responseHeaders?: HttpHeader[]
}

// Firefox waits for a returned promise only on a listener registered with
// "blocking"; a plain listener returns nothing
export type BlockingListener<D> =
  | ((details: D) => void)
  | ((details: D) => BlockingResponse | undefined | Promise<BlockingResponse | undefined>)

// onErrorOccurred takes the listener and the filter only
export interface WebRequestFilterEvent<F> {
  addListener(listener: F, filter: RequestFilter): void
  removeListener(listener: F): void
  hasListener(listener: F): boolean
}

// webRequest listeners take a filter and an optional extra info spec, so they
// do not fit the plain Event shape
export interface WebRequestEvent<F> extends WebRequestFilterEvent<F> {
  addListener(listener: F, filter: RequestFilter, extraInfoSpec?: string[]): void
}

export type StreamFilterStatus =
  | "uninitialized"
  | "transferringdata"
  | "finishedtransferringdata"
  | "suspended"
  | "closed"
  | "disconnected"
  | "failed"

export interface StreamFilterDataEvent {
  data: ArrayBuffer
}

// the response body as the page would receive it, content-decoded; the page
// gets only what is written until the filter closes or disconnects
export interface StreamFilter {
  readonly status: StreamFilterStatus
  readonly error: string
  onstart: (() => void) | null
  ondata: ((event: StreamFilterDataEvent) => void) | null
  onstop: (() => void) | null
  onerror: (() => void) | null
  write(data: ArrayBuffer | Uint8Array): void
  close(): void
  disconnect(): void
}

export interface SecurityInfoOptions {
  certificateChain?: boolean
  rawDER?: boolean
}

export interface CertificateInfo {
  subject: string
  issuer: string
  // milliseconds since the epoch
  validity: { start: number; end: number }
  fingerprint: { sha1?: string; sha256: string }
  serialNumber?: string
  isBuiltInRoot?: boolean
  subjectPublicKeyInfoDigest?: { sha256: string }
}

export interface SecurityInfo {
  state: "insecure" | "weak" | "broken" | "secure"
  errorMessage?: string
  protocolVersion?: string
  cipherSuite?: string
  keaGroupName?: string
  signatureSchemeName?: string
  secretKeyLength?: number
  isExtendedValidation?: boolean
  isDomainMismatch?: boolean
  isNotValidAtThisTime?: boolean
  isUntrusted?: boolean
  certificateTransparencyStatus?: string
  // the schema says string, Firefox answers a boolean
  hsts?: boolean
  hpkp?: boolean
  weaknessReasons?: string[]
  certificates: CertificateInfo[]
}

export interface WebRequest {
  readonly onBeforeRequest: WebRequestEvent<BlockingListener<RequestDetails>>
  readonly onSendHeaders: WebRequestEvent<(details: SendHeadersDetails) => void>
  readonly onHeadersReceived: WebRequestEvent<BlockingListener<HeadersReceivedDetails>>
  readonly onResponseStarted: WebRequestEvent<(details: ResponseDetails) => void>
  readonly onBeforeRedirect: WebRequestEvent<(details: RedirectDetails) => void>
  readonly onCompleted: WebRequestEvent<(details: CompletedDetails) => void>
  readonly onErrorOccurred: WebRequestFilterEvent<(details: ErrorDetails) => void>
  filterResponseData(requestId: string): StreamFilter
  // answers only inside a blocking onHeadersReceived that awaits it, and
  // undefined once the channel is no longer registered
  getSecurityInfo(
    requestId: string,
    options: SecurityInfoOptions,
  ): Promise<SecurityInfo | undefined>
}

// a child frame is a frame of a tab, not a native-messaging wire frame
export interface FrameNavigationDetails {
  tabId: number
  frameId: number
  parentFrameId: number
  url: string
  timeStamp: number
}

export interface WebNavigation {
  readonly onBeforeNavigate: Event<(details: FrameNavigationDetails) => void>
  readonly onCommitted: Event<(details: FrameNavigationDetails) => void>
  readonly onDOMContentLoaded: Event<(details: FrameNavigationDetails) => void>
  readonly onCompleted: Event<(details: FrameNavigationDetails) => void>
}

export interface Extension {
  isAllowedIncognitoAccess(): Promise<boolean>
}

export interface StorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
}

export interface Storage {
  readonly local: StorageArea
}

export type SameSiteStatus = "no_restriction" | "lax" | "strict" | "unspecified"

// an empty key (no topLevelSite) addresses unpartitioned cookies on set and
// every partition on getAll
export interface PartitionKey {
  topLevelSite?: string
  hasCrossSiteAncestor?: boolean
}

export interface Cookie {
  name: string
  value: string
  domain: string
  hostOnly: boolean
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: SameSiteStatus
  session: boolean
  // fractional seconds since the epoch, absent for a session cookie
  expirationDate?: number
  storeId: string
  firstPartyDomain: string
  partitionKey: PartitionKey | null
}

export interface CookieQuery {
  url?: string
  domain?: string
  name?: string
  storeId?: string
  // omitted: unpartitioned cookies only; {}: every partition
  partitionKey?: PartitionKey
  // null: every first-party domain
  firstPartyDomain?: string | null
}

export interface CookieSetDetails {
  url: string
  name?: string
  value?: string
  // omitted for a host-only cookie
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: SameSiteStatus
  // omitted for a session cookie
  expirationDate?: number
  storeId?: string
  firstPartyDomain?: string
  partitionKey?: PartitionKey
}

// no remove: it matches by url and name only, so it cannot address one cookie
export interface Cookies {
  getAll(query: CookieQuery): Promise<Cookie[]>
  // the answer is cookies.get(url, name), which may be a different cookie
  set(details: CookieSetDetails): Promise<Cookie | null>
}

export interface Browser {
  readonly runtime: Runtime
  readonly tabs: Tabs
  readonly windows: Windows
  readonly storage: Storage
  readonly extension: Extension
  readonly webRequest: WebRequest
  readonly webNavigation: WebNavigation
  readonly cookies: Cookies
  // absent before Firefox 138
  readonly tabGroups?: TabGroups
}

export function realBrowser(): Browser {
  return globalThis.browser as unknown as Browser
}
