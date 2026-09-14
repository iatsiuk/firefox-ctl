// attachTab, detachTab and listAllTabs: bringing a user's own tab under control
// without moving it, and the inventory that tells pool, attached and plain tabs
// apart.

import type { AttachedTabs } from "../attached"
import type { Tab } from "../browser"
import type { HandlerDeps } from "../dispatch"
import type { JsonObject, JsonValue } from "../protocol"
import { parseTabId, requireTabId } from "./tabs"

export type AttachedDeps = HandlerDeps

export async function attachTab(params: JsonObject, deps: AttachedDeps): Promise<JsonValue> {
  const { browser, session, attached } = deps
  const tabId = parseTabId(params.tabId)
  if (session.state?.tabs.includes(tabId)) {
    throw new Error(
      `Tab ${tabId} already belongs to the managed firefox-ctl pool and cannot be attached as a user tab.`,
    )
  }
  const tab = await browser.tabs.get(tabId).catch(() => null)
  if (!tab) {
    throw new Error(`Tab ${tabId} not found. Use listAllTabs to refresh the list.`)
  }
  await attached.add(tabId, tab.incognito === true)
  return {
    attached: true,
    tabId,
    windowId: tab.windowId ?? null,
    url: tab.url ?? null,
    title: tab.title ?? null,
  }
}

export async function detachTab(params: JsonObject, deps: AttachedDeps): Promise<JsonValue> {
  const tabId = requireTabId(params.tabId)
  return { detached: await deps.attached.forget(tabId), tabId }
}

export async function listAllTabs(_params: JsonObject, deps: AttachedDeps): Promise<JsonValue> {
  const { browser, session, attached } = deps
  const tabs = await browser.tabs.query({})
  const pool = new Set(session.state?.tabs ?? [])
  return {
    tabs: tabs.map((tab) => describe(tab, pool, attached)),
    count: tabs.length,
  }
}

function describe(tab: Tab, pool: Set<number>, attached: AttachedTabs): JsonObject {
  const tabId = tab.id ?? null
  return {
    tabId,
    windowId: tab.windowId ?? null,
    url: tab.url ?? null,
    title: tab.title ?? null,
    active: tab.active ?? false,
    pinned: tab.pinned ?? false,
    private: tab.incognito ?? false,
    pool: tabId !== null && pool.has(tabId),
    attached: tabId !== null && attached.has(tabId),
  }
}
