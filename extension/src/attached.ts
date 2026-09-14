// User tabs explicitly attached for in-place automation. They are separate from
// the managed pool: attaching never creates, moves or closes a tab, it only
// remembers that the caller may drive it.

import type { Browser } from "./browser"
import type { Environment } from "./env"
import { RestoreMemo } from "./memo"
import type { Session } from "./session"

/** storage.local key holding the serialised attachments. */
export const ATTACHED_TABS_KEY = "firefoxCtlAttachedTabs"

export interface AttachedEntry {
  attachedAt: number
  // private tabs are served from memory only; they never reach storage
  incognito: boolean
}

export class AttachedTabs {
  private readonly browser: Browser
  private readonly env: Environment
  private readonly entries = new Map<number, AttachedEntry>()
  private readonly memo = new RestoreMemo()

  constructor(browser: Browser, env: Environment) {
    this.browser = browser
    this.env = env
  }

  has(tabId: number): boolean {
    return this.entries.has(tabId)
  }

  tabIds(): number[] {
    return [...this.entries.keys()]
  }

  async add(tabId: number, incognito: boolean): Promise<void> {
    this.entries.set(tabId, { attachedAt: this.env.now(), incognito })
    await this.persist()
  }

  async forget(tabId: number): Promise<boolean> {
    const removed = this.entries.delete(tabId)
    await this.persist()
    return removed
  }

  /** Writes the public entries only; a private tab leaves nothing behind. */
  async persist(): Promise<void> {
    const entries = [...this.entries.entries()].filter(([, entry]) => !entry.incognito)
    await this.browser.storage.local.set({ [ATTACHED_TABS_KEY]: entries })
  }

  /**
   * Reads the stored attachments once per background lifetime, keeping only
   * tabs that still exist. A rejection drops the memo so
   * the next command retries instead of inheriting the failure.
   */
  restore(): Promise<void> {
    return this.memo.run((epoch) => this.readStored(epoch))
  }

  /**
   * Drops a restore the caller gave up on, so the next command starts a fresh
   * one; the abandoned attempt writes nothing once it finally settles.
   */
  abandonRestore(attempt: Promise<void>): void {
    this.memo.abandon(attempt)
  }

  /**
   * Drops tabs the pool has taken over, so a tab is never both. `isCurrent`
   * lets a caller with its own epoch fence (the dispatcher's preamble) detect
   * that this attempt was abandoned while the persist below was in flight.
   */
  async dropPoolTabs(session: Session, isCurrent: () => boolean): Promise<void> {
    const tabs = session.state?.tabs
    if (!tabs) {
      return
    }
    let changed = false
    for (const tabId of tabs) {
      changed = this.entries.delete(tabId) || changed
    }
    if (!changed) {
      return
    }
    await this.persist()
    if (!isCurrent()) {
      // the preamble that started this drop was abandoned while the write
      // was in flight; write again so storage reflects the live entries
      await this.persist()
    }
  }

  /** Forgets attachments whose tab the user closed. */
  attach(): void {
    this.browser.tabs.onRemoved.addListener((tabId) => {
      if (!this.entries.delete(tabId)) {
        return
      }
      this.persist().catch((error: unknown) => {
        console.warn("[firefox-ctl] attached-tab persist failed:", error)
      })
    })
  }

  private async readStored(epoch: number): Promise<void> {
    const items = await this.browser.storage.local.get(ATTACHED_TABS_KEY)
    for (const [tabId, attachedAt] of parseEntries(items[ATTACHED_TABS_KEY])) {
      const tab = await this.browser.tabs.get(tabId).catch(() => null)
      if (!this.memo.isCurrent(epoch)) {
        return
      }
      // only public entries are ever written, so a stored one is public
      if (tab) {
        this.entries.set(tabId, { attachedAt, incognito: false })
      }
    }
    if (!this.memo.isCurrent(epoch)) {
      return
    }
    await this.persist()
    if (!this.memo.isCurrent(epoch)) {
      // this attempt was abandoned while its own write was in flight; write
      // again so storage reflects the live entries, not this stale snapshot
      await this.persist()
    }
  }
}

function parseEntries(value: unknown): [number, number][] {
  if (!Array.isArray(value)) {
    return []
  }
  const entries: [number, number][] = []
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "number") {
      continue
    }
    const saved = item[1] as Record<string, unknown> | null
    entries.push([item[0], typeof saved?.attachedAt === "number" ? saved.attachedAt : 0])
  }
  return entries
}
