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
}

export interface Manifest {
  version: string
}

export interface MessageSender {
  tab?: Tab
  id?: string
  url?: string
}

export type MessageListener = (
  message: unknown,
  sender: MessageSender,
) => unknown | Promise<unknown>

export interface Runtime {
  connectNative(name: string): Port
  getManifest(): Manifest
  readonly onMessage: Event<MessageListener>
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

export interface Tabs {
  get(tabId: number): Promise<Tab>
  query(query: TabQuery): Promise<Tab[]>
  create(properties: TabCreateProperties): Promise<Tab>
  remove(tabId: number): Promise<void>
  update(tabId: number, properties: TabUpdateProperties): Promise<Tab>
  sendMessage(tabId: number, message: unknown): Promise<unknown>
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

export interface RequestDetails {
  requestId: string
  url: string
  method: string
  type: string
  tabId: number
}

export interface CompletedDetails extends RequestDetails {
  statusCode: number
  responseHeaders?: HttpHeader[]
}

export interface ErrorDetails extends RequestDetails {
  error: string
}

export interface RequestFilter {
  urls: string[]
}

// webRequest listeners take a filter and an optional extra info spec, so they
// do not fit the plain Event shape
export interface WebRequestEvent<F> {
  addListener(listener: F, filter: RequestFilter, extraInfoSpec?: string[]): void
  removeListener(listener: F): void
  hasListener(listener: F): boolean
}

export interface WebRequest {
  readonly onBeforeRequest: WebRequestEvent<(details: RequestDetails) => void>
  readonly onCompleted: WebRequestEvent<(details: CompletedDetails) => void>
  readonly onErrorOccurred: WebRequestEvent<(details: ErrorDetails) => void>
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

export interface Browser {
  readonly runtime: Runtime
  readonly tabs: Tabs
  readonly windows: Windows
  readonly storage: Storage
  readonly extension: Extension
  readonly webRequest: WebRequest
  // absent before Firefox 138
  readonly tabGroups?: TabGroups
}

export function realBrowser(): Browser {
  return globalThis.browser as unknown as Browser
}
