// createWindow: opens or reuses the managed window. One window at a time, a
// pool of MAX_TABS tabs with oldest-first eviction, private by default with a
// fallback to a normal window, and adoption of the user's window when the
// caller asks for a non-private session.

import type { Browser, Tab, Window, WindowUpdateInfo } from "../browser"
import { DEVICE_NAMES, resolveViewport } from "../devices"
import type { Environment } from "../env"
import type { JsonObject, JsonValue } from "../protocol"
import { ExtensionError } from "../protocol"
import { GROUP_TITLE, MAX_TABS, type Session, type SessionState } from "../session"

export interface WindowDeps {
  readonly browser: Browser
  readonly env: Environment
  readonly session: Session
}

export const INVALID_WINDOW_ID = "windowId must be a positive integer - use getWindows to find one."

const BLANK_URL = "about:blank"

/** Window chrome above the content area, added to a viewport height. */
const CHROME_HEIGHT = 80

const GEOMETRY_KEYS = ["width", "height", "left", "top"] as const

/** Colour of the firefox-ctl tab group; purely cosmetic. */
const GROUP_COLOR = "orange"

// Firefox words the missing "Run in Private Windows" permission differently per
// version, so the fallback triggers on any of these
const PRIVATE_DENIED = /incognito|private|permission/i

const MODE_WARNING =
  "Private window unavailable (permission not granted in Firefox settings). " +
  "Fell back to non-private mode. Browsing data will persist."

interface Outcome {
  tabId: number
  isNewWindow: boolean
  privateFallback: boolean
  closedOldestTab: number | null
}

export async function createWindow(params: JsonObject, deps: WindowDeps): Promise<JsonValue> {
  const url = typeof params.url === "string" ? params.url : undefined
  const requestedPrivate = typeof params.private === "boolean" ? params.private : undefined
  const { session } = deps
  await dropStaleState(deps)
  const state = session.state
  const outcome = state
    ? await addPoolTab(deps, state, url, requestedPrivate)
    : await openSession(deps, url, requestedPrivate ?? true)
  await session.persist()
  return describe(session.state as SessionState, outcome)
}

/** Forgets a session whose window the user closed, so a new one is opened. */
async function dropStaleState({ browser, session }: WindowDeps): Promise<void> {
  const state = session.state
  if (!state) {
    return
  }
  try {
    await browser.windows.get(state.windowId)
  } catch {
    await session.clear()
  }
}

async function addPoolTab(
  deps: WindowDeps,
  state: SessionState,
  url: string | undefined,
  requestedPrivate: boolean | undefined,
): Promise<Outcome> {
  const { browser, session } = deps
  if (requestedPrivate !== undefined && requestedPrivate !== state.isPrivate) {
    throw new ExtensionError(
      "MODE_MISMATCH",
      `Requested ${modeName(requestedPrivate)} mode, but existing window is ${modeName(state.isPrivate)}.`,
    )
  }
  const closedOldestTab = state.tabs.length >= MAX_TABS ? await evictOldest(browser, state) : null
  const tab = await browser.tabs.create({
    windowId: state.windowId,
    url: url ?? BLANK_URL,
    active: true,
  })
  const tabId = idOf(tab)
  state.tabs.push(tabId)
  session.activeTabId = tabId
  await group(browser, state, tabId)
  return { tabId, isNewWindow: false, privateFallback: false, closedOldestTab }
}

// the pool entry goes even when the tab refuses to close: it is either already
// gone or beyond our reach, and keeping it would wedge the pool at MAX_TABS
async function evictOldest(browser: Browser, state: SessionState): Promise<number> {
  const tabId = state.tabs.shift() as number
  await browser.tabs.remove(tabId).catch((error: unknown) => {
    console.warn(`[firefox-ctl] could not close evicted tab ${tabId}:`, error)
  })
  return tabId
}

async function openSession(
  deps: WindowDeps,
  url: string | undefined,
  usePrivate: boolean,
): Promise<Outcome> {
  const { browser, env, session } = deps
  const host = usePrivate ? null : await adoptable(browser)
  let privateFallback = false
  let window: Window
  let tabId: number
  if (host) {
    window = host
    tabId = idOf(
      await browser.tabs.create({ windowId: idOf(host), url: url ?? BLANK_URL, active: false }),
    )
  } else {
    const opened = await openWindow(browser, url, usePrivate)
    window = opened.window
    privateFallback = opened.privateFallback
    tabId = firstTabId(window)
  }
  const state: SessionState = {
    windowId: idOf(window),
    tabs: [tabId],
    createdAt: env.now(),
    groupId: null,
    // an adopted window is the user's normal window by definition
    isPrivate: host ? false : (window.incognito ?? false),
    adopted: host !== null,
  }
  session.state = state
  session.activeTabId = tabId
  await group(browser, state, tabId)
  return { tabId, isNewWindow: host === null, privateFallback, closedOldestTab: null }
}

/** The user's last focused window, when a firefox-ctl tab may join it. */
async function adoptable(browser: Browser): Promise<Window | null> {
  try {
    // the windowTypes filter is deprecated in Firefox, so check the type here
    const window = await browser.windows.getLastFocused()
    if (window.id !== undefined && window.type === "normal" && window.incognito !== true) {
      return window
    }
  } catch (error) {
    console.warn("[firefox-ctl] window adoption unavailable:", error)
  }
  return null
}

async function openWindow(
  browser: Browser,
  url: string | undefined,
  usePrivate: boolean,
): Promise<{ window: Window; privateFallback: boolean }> {
  const data = { focused: false, url: url ?? BLANK_URL }
  try {
    const window = await browser.windows.create({ ...data, incognito: usePrivate })
    return { window, privateFallback: false }
  } catch (error) {
    if (!usePrivate || !PRIVATE_DENIED.test(messageOf(error))) {
      throw error
    }
    console.warn("[firefox-ctl] private window unavailable, falling back to non-private:", error)
    return {
      window: await browser.windows.create({ ...data, incognito: false }),
      privateFallback: true,
    }
  }
}

/** Puts the tab in the session's `firefox-ctl` group, creating it on first use. */
async function group(browser: Browser, state: SessionState, tabId: number): Promise<void> {
  try {
    const options =
      state.groupId === null
        ? { tabIds: [tabId], createProperties: { windowId: state.windowId } }
        : { tabIds: [tabId], groupId: state.groupId }
    const groupId = await browser.tabs.group?.(options)
    if (groupId === undefined) {
      return
    }
    state.groupId = groupId
    // retried on every call rather than gated on first creation, so a rename
    // that failed once is not stuck untitled for the rest of the session
    await browser.tabGroups?.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR })
  } catch (error) {
    console.warn("[firefox-ctl] tab grouping unavailable:", error)
  }
}

function describe(state: SessionState, outcome: Outcome): JsonObject {
  const result: JsonObject = {
    windowId: state.windowId,
    tabId: outcome.tabId,
    tabCount: state.tabs.length,
    maxTabs: MAX_TABS,
    isNewWindow: outcome.isNewWindow,
    isPrivate: state.isPrivate,
    privateFallback: outcome.privateFallback,
    closedOldestTab: outcome.closedOldestTab,
    message: `Tab ${state.tabs.length}/${MAX_TABS}${outcome.closedOldestTab === null ? "" : " (closed oldest)"}`,
  }
  if (outcome.privateFallback) {
    result.modeWarning = MODE_WARNING
  }
  return result
}

function modeName(isPrivate: boolean): string {
  return isPrivate ? "private" : "non-private"
}

function idOf(item: Tab | Window): number {
  if (item.id === undefined) {
    throw new Error("createWindow: Firefox returned a tab or window without an id.")
  }
  return item.id
}

function firstTabId(window: Window): number {
  const tab = window.tabs?.[0]
  if (!tab) {
    throw new Error("createWindow: the new window reported no tabs.")
  }
  return idOf(tab)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function getWindows(_params: JsonObject, deps: WindowDeps): Promise<JsonValue> {
  const windows = await deps.browser.windows.getAll({ populate: true })
  return windows.map((window) => ({
    windowId: window.id ?? null,
    private: window.incognito ?? false,
    focused: window.focused ?? false,
    tabCount: window.tabs?.length ?? 0,
  }))
}

export async function resizeWindow(params: JsonObject, deps: WindowDeps): Promise<JsonValue> {
  const windowId = await targetWindowId(deps, params)
  const info: WindowUpdateInfo = {}
  for (const key of GEOMETRY_KEYS) {
    const value = params[key]
    if (typeof value === "number") {
      info[key] = value
    }
  }
  return geometry(await deps.browser.windows.update(windowId, info))
}

export async function setViewport(params: JsonObject, deps: WindowDeps): Promise<JsonValue> {
  const viewport = resolveViewport(params)
  const windowId = await targetWindowId(deps, params)
  const window = await deps.browser.windows.update(windowId, {
    width: viewport.width,
    height: viewport.height + CHROME_HEIGHT,
  })
  return {
    device: viewport.device,
    viewport: { width: viewport.width, height: viewport.height },
    window: { width: window.width ?? null, height: window.height ?? null },
    type: viewport.type,
    availableDevices: DEVICE_NAMES,
  }
}

/** Legacy probe kept for CLI parity: the private-window permission. */
export async function canNavigate(_params: JsonObject, deps: WindowDeps): Promise<JsonValue> {
  return { canNavigate: await deps.browser.extension.isAllowedIncognitoAccess() }
}

export async function getWindowMode(_params: JsonObject, deps: WindowDeps): Promise<JsonValue> {
  const state = deps.session.state
  return {
    privateWindowsAvailable: await deps.browser.extension.isAllowedIncognitoAccess(),
    currentWindowMode: state === null ? null : state.isPrivate ? "private" : "normal",
    windowExists: state !== null,
  }
}

/** The window a geometry command acts on: the named one, else the session's. */
async function targetWindowId(deps: WindowDeps, params: JsonObject): Promise<number> {
  const windowId = params.windowId
  if (windowId === undefined || windowId === null) {
    return (await deps.session.getSession()).windowId
  }
  if (typeof windowId !== "number" || !Number.isInteger(windowId) || windowId <= 0) {
    throw new Error(INVALID_WINDOW_ID)
  }
  return windowId
}

function geometry(window: Window): JsonObject {
  return {
    windowId: window.id ?? null,
    width: window.width ?? null,
    height: window.height ?? null,
    left: window.left ?? null,
    top: window.top ?? null,
  }
}
