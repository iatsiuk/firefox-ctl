// Tab targeting and the core tab commands: which tab a command runs in,
// navigation, the pool inventory and closing tabs or the managed window.

import type { Tab } from "../browser"
import type { HandlerDeps } from "../dispatch"
import type { JsonObject, JsonValue } from "../protocol"
import { ExtensionError } from "../protocol"
import { MAX_TABS, type Session, type SessionState } from "../session"

export type TabsDeps = HandlerDeps

export const INVALID_TAB_ID = "tabId must be a positive integer - use listAllTabs to find one."

const MISSING_TAB_ID = "tabId is required."

const NO_SESSION = "No firefox-ctl window active."

/**
 * The tab a command runs in. An explicit `tabId` names any existing tab - pool,
 * attached or plain user tab - and needs no session; a `windowId` alongside it
 * is accepted for CLI parity and ignored, since firefox-ctl manages one window.
 * Without a `tabId` the session's active tab is used.
 */
export async function resolveTargetTab(deps: TabsDeps, params: JsonObject): Promise<Tab> {
  const tabId = optionalTabId(params.tabId)
  if (tabId === undefined) {
    return (await deps.session.getSession()).tab
  }
  const tab = await deps.browser.tabs.get(tabId).catch(() => null)
  if (!tab) {
    // the caller's id is stale; an attachment for it is worthless too
    if (deps.attached.has(tabId)) {
      await deps.attached.forget(tabId)
    }
    throw new ExtensionError("TAB_CLOSED", `Tab ${tabId} no longer exists.`)
  }
  return tab
}

export async function navigate(params: JsonObject, deps: TabsDeps): Promise<JsonValue> {
  if (typeof params.url !== "string" || params.url === "") {
    throw new Error("url is required.")
  }
  const url = params.url
  const tabId = idOf(await resolveTargetTab(deps, params))
  await deps.browser.tabs.update(tabId, { url })
  const tab = await deps.browser.tabs.get(tabId)
  return { tabId, url: tab.url ?? url, title: tab.title ?? null, navigated: true }
}

export async function getActiveTab(_params: JsonObject, deps: TabsDeps): Promise<JsonValue> {
  const [tab] = await deps.browser.tabs.query({ active: true, currentWindow: true })
  if (!tab) {
    return null
  }
  return { tabId: tab.id ?? null, url: tab.url ?? null, title: tab.title ?? null }
}

export async function getTabs(_params: JsonObject, deps: TabsDeps): Promise<JsonValue> {
  const state = deps.session.state
  if (!state) {
    return { tabs: [], tabCount: 0, maxTabs: MAX_TABS, message: "No firefox-ctl window active" }
  }
  const tabIds = [...state.tabs]
  const tabs = await Promise.all(tabIds.map((tabId) => describePoolTab(deps, tabId)))
  return { windowId: state.windowId, tabs, tabCount: tabIds.length, maxTabs: MAX_TABS }
}

export async function closeTab(params: JsonObject, deps: TabsDeps): Promise<JsonValue> {
  const tabId = requireTabId(params.tabId)
  const { browser, session, attached } = deps
  if (attached.has(tabId)) {
    await attached.forget(tabId)
    await browser.tabs.remove(tabId).catch((error: unknown) => {
      console.warn(`[firefox-ctl] could not close attached tab ${tabId}:`, error)
    })
    return { closed: true, tabId, attached: true, message: "Attached user tab closed." }
  }
  const state = session.state
  if (!state) {
    throw new Error(NO_SESSION)
  }
  const index = state.tabs.indexOf(tabId)
  if (index < 0) {
    throw new Error(
      `Tab ${tabId} not found in the firefox-ctl window. Available tabs: ${state.tabs.join(", ")}`,
    )
  }
  state.tabs.splice(index, 1)
  await browser.tabs.remove(tabId).catch((error: unknown) => {
    console.warn(`[firefox-ctl] could not close tab ${tabId}:`, error)
  })
  repointActiveTab(session, state, tabId)
  return {
    closed: true,
    tabId,
    tabCount: state.tabs.length,
    maxTabs: MAX_TABS,
    message: `Tab closed. ${state.tabs.length}/${MAX_TABS} tabs remaining.`,
  }
}

export async function closeWindow(_params: JsonObject, deps: TabsDeps): Promise<JsonValue> {
  const { browser, session } = deps
  const state = session.state
  if (!state) {
    throw new Error("No firefox-ctl window to close.")
  }
  const { windowId, adopted } = state
  const tabIds = [...state.tabs]
  await session.clear()
  if (adopted) {
    // the window is the user's; only firefox-ctl's own tabs may go
    for (const tabId of tabIds) {
      await browser.tabs.remove(tabId).catch((error: unknown) => {
        console.warn(`[firefox-ctl] could not close tab ${tabId}:`, error)
      })
    }
    return {
      closed: true,
      windowId,
      tabsClosed: tabIds.length,
      adopted: true,
      message: "Adopted user window preserved; only firefox-ctl tabs were closed.",
    }
  }
  await browser.windows.remove(windowId).catch((error: unknown) => {
    console.warn(`[firefox-ctl] could not close window ${windowId}:`, error)
  })
  return { closed: true, windowId, tabsClosed: tabIds.length }
}

async function describePoolTab(deps: TabsDeps, tabId: number): Promise<JsonObject> {
  const tab = await deps.browser.tabs.get(tabId).catch(() => null)
  if (!tab) {
    return { tabId, error: "Tab not found" }
  }
  return {
    tabId,
    url: tab.url ?? null,
    title: tab.title ?? null,
    active: tab.active ?? false,
  }
}

function repointActiveTab(session: Session, state: SessionState, closedTabId: number): void {
  if (session.activeTabId !== closedTabId) {
    return
  }
  session.activeTabId = state.tabs.length > 0 ? (state.tabs[state.tabs.length - 1] as number) : null
}

export function requireTabId(value: JsonValue | undefined): number {
  if (value === undefined || value === null) {
    throw new Error(MISSING_TAB_ID)
  }
  return parseTabId(value)
}

function optionalTabId(value: JsonValue | undefined): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  return parseTabId(value)
}

/** A tab id straight from the CLI: anything but a positive integer is a typo. */
export function parseTabId(value: JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(INVALID_TAB_ID)
  }
  return value
}

function idOf(tab: Tab): number {
  if (tab.id === undefined) {
    throw new Error("Firefox returned a tab without an id.")
  }
  return tab.id
}
