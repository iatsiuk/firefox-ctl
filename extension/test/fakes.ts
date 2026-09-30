import type {
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
  Manifest,
  MessageListener,
  MessageSender,
  PartitionKey,
  Port,
  PortError,
  RequestDetails,
  RequestFilter,
  Runtime,
  SendMessageOptions,
  Storage,
  StorageArea,
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

export class FakeWebRequestEvent<F> implements WebRequestEvent<F> {
  readonly listeners: F[] = []
  readonly filters: RequestFilter[] = []
  readonly extraInfoSpecs: (string[] | undefined)[] = []

  addListener(listener: F, filter: RequestFilter, extraInfoSpec?: string[]): void {
    this.listeners.push(listener)
    this.filters.push(filter)
    this.extraInfoSpecs.push(extraInfoSpec)
  }

  removeListener(listener: F): void {
    const index = this.listeners.indexOf(listener)
    if (index >= 0) {
      this.listeners.splice(index, 1)
      this.filters.splice(index, 1)
      this.extraInfoSpecs.splice(index, 1)
    }
  }

  hasListener(listener: F): boolean {
    return this.listeners.includes(listener)
  }

  snapshot(): F[] {
    return [...this.listeners]
  }
}

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

function urlHost(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1")
}

// the directory of the url path, what Firefox takes when set gets no path
function defaultPath(url: URL): string {
  const last = url.pathname.lastIndexOf("/")
  return last <= 0 ? "/" : url.pathname.slice(0, last)
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
  const wanted = normalPartition(query.partitionKey)
  return wanted === null || samePartition(wanted, cookie.partitionKey)
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

function validationError(details: CookieSetDetails): string | undefined {
  const name = details.name ?? ""
  if (name === "" && (details.value ?? "") === "") {
    return "Cookie with an empty name and an empty value has been rejected."
  }
  if (details.sameSite === "no_restriction" && details.secure !== true) {
    return `Cookie “${name}” rejected because it has the “SameSite=None” attribute but is missing the “secure” attribute.`
  }
  if (details.firstPartyDomain && details.partitionKey?.topLevelSite) {
    return "Partitioned cookies cannot have a 'firstPartyDomain' attribute."
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
    const cookie: Cookie = {
      name: details.name ?? "",
      value: details.value ?? "",
      domain:
        details.domain === undefined
          ? urlHost(url)
          : `.${details.domain.replace(/^\./, "").toLowerCase()}`,
      hostOnly: details.domain === undefined,
      path: details.path ?? defaultPath(url),
      secure: details.secure ?? false,
      httpOnly: details.httpOnly ?? false,
      sameSite: details.sameSite ?? "unspecified",
      session: details.expirationDate === undefined,
      storeId,
      firstPartyDomain: details.firstPartyDomain ?? "",
      partitionKey: normalPartition(details.partitionKey),
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
  readonly framesLoaded = new FakeEvent<(details: FrameNavigationDetails) => void>()
  readonly tabsRemoved = new FakeEvent<(tabId: number, removeInfo: TabRemoveInfo) => void>()
  readonly tabsUpdated = new FakeEvent<
    (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void
  >()
  readonly tabsActivated = new FakeEvent<(activeInfo: TabActiveInfo) => void>()
  readonly windowsRemoved = new FakeEvent<(windowId: number) => void>()
  readonly requestsStarted = new FakeWebRequestEvent<(details: RequestDetails) => void>()
  readonly requestsCompleted = new FakeWebRequestEvent<(details: CompletedDetails) => void>()
  readonly requestsFailed = new FakeWebRequestEvent<(details: ErrorDetails) => void>()
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
      onCompleted: this.requestsCompleted,
      onErrorOccurred: this.requestsFailed,
    }
    this.webNavigation = { onDOMContentLoaded: this.framesLoaded }
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

  emitRequestStarted(details: RequestDetails): void {
    for (const listener of this.requestsStarted.snapshot()) {
      listener(details)
    }
  }

  emitRequestCompleted(
    details: Omit<CompletedDetails, "statusCode"> & { statusCode?: number },
  ): void {
    const completed: CompletedDetails = { statusCode: 200, ...details }
    for (const listener of this.requestsCompleted.snapshot()) {
      listener(completed)
    }
  }

  emitRequestFailed(details: ErrorDetails): void {
    for (const listener of this.requestsFailed.snapshot()) {
      listener(details)
    }
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

  emitFrameLoaded(
    details: Omit<FrameNavigationDetails, "parentFrameId" | "timeStamp"> &
      Partial<Pick<FrameNavigationDetails, "parentFrameId" | "timeStamp">>,
  ): void {
    const loaded: FrameNavigationDetails = { parentFrameId: 0, timeStamp: 0, ...details }
    for (const listener of this.framesLoaded.snapshot()) {
      listener(loaded)
    }
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
