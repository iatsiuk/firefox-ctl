// The managed window session: one firefox-ctl window, an ordered tab pool and the
// active tab. State mirrors to storage.local so a background restart adopts the
// surviving window instead of spawning a sibling.

import type { Browser, Tab, TabActiveInfo } from "./browser"
import type { Environment } from "./env"
import { RestoreMemo } from "./memo"
import { ExtensionError } from "./protocol"

/** Pool size; the oldest tab is evicted when a new one does not fit. */
export const MAX_TABS = 12

/** storage.local key holding the serialised session state. */
export const WINDOW_STATE_KEY = "firefoxCtlWindowState"

/** Tab group title marking firefox-ctl's tabs, used by the duplicate-window sweep. */
export const GROUP_TITLE = "firefox-ctl"

export interface SessionState {
  windowId: number
  // ordered by creation; index 0 is evicted first
  tabs: number[]
  createdAt: number
  groupId: number | null
  isPrivate: boolean
  adopted: boolean
}

export interface SessionInfo {
  windowId: number
  tabId: number
  tab: Tab
}

export class Session {
  state: SessionState | null = null
  activeTabId: number | null = null

  private readonly browser: Browser
  private readonly env: Environment
  private readonly memo = new RestoreMemo()
  private swept = false

  constructor(browser: Browser, env: Environment) {
    this.browser = browser
    this.env = env
  }

  /**
   * Private-session state never reaches storage: the key is removed instead of
   * written, so a private window leaves nothing behind for the next start.
   */
  async persist(): Promise<void> {
    const state = this.state
    if (state?.isPrivate) {
      await this.browser.storage.local.remove(WINDOW_STATE_KEY)
      return
    }
    await this.browser.storage.local.set({ [WINDOW_STATE_KEY]: state })
  }

  async clear(): Promise<void> {
    this.state = null
    this.activeTabId = null
    await this.persist()
  }

  /**
   * Reads the stored state once per background lifetime. A rejection drops the
   * memo so the next command retries instead of inheriting the failure. The
   * duplicate-window sweep rides along on whichever call first succeeds, so a
   * retried restore still triggers it. `tracked` is false for the startup
   * warm-up call, which has no deadline and so must never keep a genuinely
   * stuck attempt from being abandoned by a command that does.
   */
  restore(tracked = true): Promise<void> {
    return this.memo.run((epoch) => this.restoreOnce(epoch), tracked)
  }

  /**
   * Drops a restore the caller gave up on, so the next command starts a fresh
   * one; the abandoned attempt writes nothing once it finally settles.
   */
  abandonRestore(attempt: Promise<void>): void {
    this.memo.abandon(attempt)
  }

  private async restoreOnce(epoch: number): Promise<void> {
    await this.readStoredState(epoch)
    if (!this.memo.isCurrent(epoch)) {
      return
    }
    await this.sweepOnce()
  }

  private async sweepOnce(): Promise<void> {
    if (this.swept) {
      return
    }
    this.swept = true
    await this.sweepDuplicateWindows()
  }

  /**
   * Closes windows left behind by earlier background restarts: a window is
   * removed only when every one of its tabs sits in a `firefox-ctl` group. Best
   * effort, never touches a user window.
   */
  async sweepDuplicateWindows(): Promise<void> {
    const tabGroups = this.browser.tabGroups
    if (!tabGroups) {
      return
    }
    // snapshot once: the current window must never be swept even if a
    // concurrent command clears or replaces state partway through the loop
    const currentWindowId = this.state?.windowId
    try {
      const groups = await tabGroups.query({ title: GROUP_TITLE })
      for (const group of groups) {
        const windowId = group.windowId
        if (windowId === undefined || windowId === currentWindowId) {
          continue
        }
        const window = await this.browser.windows
          .get(windowId, { populate: true })
          .catch(() => null)
        const tabs = window?.tabs
        if (!tabs || tabs.length === 0 || tabs.some((tab) => tab.groupId !== group.id)) {
          continue
        }
        await this.browser.windows.remove(windowId).catch(() => {})
      }
    } catch (error) {
      console.warn("[firefox-ctl] duplicate-window sweep failed:", error)
    }
  }

  /** Subscribes to the window and tab events that keep the pool in sync. */
  attach(): void {
    this.browser.windows.onRemoved.addListener((windowId) => this.onWindowRemoved(windowId))
    this.browser.tabs.onRemoved.addListener((tabId) => this.onTabRemoved(tabId))
    this.browser.tabs.onActivated.addListener((info) => this.onTabActivated(info))
  }

  /** The window and active tab every tab-bound command falls back to. */
  async getSession(): Promise<SessionInfo> {
    const state = this.state
    if (!state) {
      throw new Error("Tab session lost: call createWindow to start a new tab.")
    }
    try {
      await this.browser.windows.get(state.windowId)
    } catch {
      // a concurrent createWindow may already have replaced the session while
      // this check was in flight; only clear the one this call actually saw
      if (this.state === state) {
        await this.clear()
      }
      throw new Error("Window expired. Call createWindow.")
    }
    if (this.state !== state) {
      // same race on the success path: this call's view of the session is
      // stale, but the session a concurrent command built is not ours to touch
      throw new Error("Window expired. Call createWindow.")
    }
    if (state.tabs.length === 0) {
      this.activeTabId = null
      throw new ExtensionError(
        "NO_TABS",
        "All tabs have been closed. Call createWindow to open a new tab.",
      )
    }
    if (this.activeTabId === null || !state.tabs.includes(this.activeTabId)) {
      this.activeTabId = state.tabs[state.tabs.length - 1] as number
    }
    const tabId = this.activeTabId
    try {
      const tab = await this.browser.tabs.get(tabId)
      return { windowId: state.windowId, tabId, tab }
    } catch {
      this.activeTabId = null
      throw new ExtensionError(
        "TAB_UNAVAILABLE",
        "Could not retrieve active tab. Call createWindow to open a new tab.",
      )
    }
  }

  private async readStoredState(epoch: number): Promise<void> {
    if (this.state) {
      return
    }
    const items = await this.browser.storage.local.get(WINDOW_STATE_KEY)
    const saved = this.memo.isCurrent(epoch) ? parseState(items[WINDOW_STATE_KEY]) : null
    if (!saved) {
      return
    }
    const window = await this.browser.windows
      .get(saved.windowId, { populate: true })
      .catch(() => null)
    if (!this.memo.isCurrent(epoch)) {
      return
    }
    if (!window) {
      // the window really is gone, so the stored payload is stale
      await this.clear()
      if (!this.memo.isCurrent(epoch)) {
        // this attempt was abandoned while its own write was in flight; write
        // again so storage reflects the live state, not this stale snapshot
        await this.persist()
      }
      return
    }
    const live = window.tabs ?? []
    const liveIds = new Set(live.map((tab) => tab.id))
    const tabs = saved.tabs.filter((tabId) => liveIds.has(tabId))
    if (!saved.adopted) {
      // only a dedicated window may absorb strays; in an adopted window every
      // untracked tab belongs to the user
      for (const tab of live) {
        if (tab.id !== undefined && !tabs.includes(tab.id)) {
          tabs.push(tab.id)
        }
      }
    }
    // absorption may have pushed the pool over MAX_TABS; re-apply the same
    // oldest-first eviction createWindow uses so the invariant holds after a
    // restart too
    while (tabs.length > MAX_TABS && this.memo.isCurrent(epoch)) {
      const evicted = tabs.shift() as number
      await this.browser.tabs.remove(evicted).catch(() => {})
    }
    if (!this.memo.isCurrent(epoch)) {
      return
    }
    this.state = {
      windowId: saved.windowId,
      tabs,
      createdAt: saved.createdAt || this.env.now(),
      groupId: saved.groupId,
      // a private window never gets this far, so a restored session is public
      isPrivate: false,
      adopted: saved.adopted,
    }
    this.activeTabId = tabs.length > 0 ? (tabs[tabs.length - 1] as number) : null
    await this.persist()
    if (!this.memo.isCurrent(epoch)) {
      // same as above: the write outlived the attempt that started it
      await this.persist()
    }
  }

  private onWindowRemoved(windowId: number): void {
    if (this.state?.windowId !== windowId) {
      return
    }
    this.state = null
    this.activeTabId = null
    this.persistQuietly()
  }

  private onTabRemoved(tabId: number): void {
    const state = this.state
    if (!state) {
      return
    }
    const index = state.tabs.indexOf(tabId)
    if (index < 0) {
      return
    }
    state.tabs.splice(index, 1)
    if (this.activeTabId === tabId) {
      this.activeTabId =
        state.tabs.length > 0 ? (state.tabs[state.tabs.length - 1] as number) : null
    }
    this.persistQuietly()
  }

  private onTabActivated(info: TabActiveInfo): void {
    const state = this.state
    if (!state || info.windowId !== state.windowId || !state.tabs.includes(info.tabId)) {
      return
    }
    this.activeTabId = info.tabId
    this.persistQuietly()
  }

  private persistQuietly(): void {
    this.persist().catch((error: unknown) => {
      console.warn("[firefox-ctl] session persist failed:", error)
    })
  }
}

function parseState(value: unknown): SessionState | null {
  if (typeof value !== "object" || value === null) {
    return null
  }
  const saved = value as Record<string, unknown>
  if (typeof saved.windowId !== "number") {
    return null
  }
  const tabs = Array.isArray(saved.tabs)
    ? saved.tabs.filter((tabId): tabId is number => typeof tabId === "number")
    : []
  return {
    windowId: saved.windowId,
    tabs,
    createdAt: typeof saved.createdAt === "number" ? saved.createdAt : 0,
    groupId: typeof saved.groupId === "number" ? saved.groupId : null,
    isPrivate: saved.isPrivate === true,
    adopted: saved.adopted === true,
  }
}
