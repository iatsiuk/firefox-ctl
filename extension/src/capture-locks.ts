// The per-tab rendezvous every screenshot of a tab passes through, and the
// registry that keeps one per live tab. Entries are dropped when the tab
// closes, so a background page that runs for days does not keep one lock per
// tab it ever captured.

import type { Browser } from "./browser"
import { StateLock } from "./lock"

/**
 * One tab's capture lock. `staleAnnotations` is the handoff between holders:
 * a holder freed early by its own deadline may still be mid-`annotate`, so the
 * next holder inherits the duty of clearing whatever badges show up. Both live
 * in this object rather than in the registry, so a holder that keeps its own
 * reference finishes exactly as before once the entry is dropped.
 */
export interface TabLock {
  lock: StateLock
  staleAnnotations: boolean
}

export class CaptureLocks {
  private readonly entries = new Map<number, TabLock>()

  private listening = false

  /** The entry of this tab, created on first use. */
  get(tabId: number): TabLock {
    let entry = this.entries.get(tabId)
    if (!entry) {
      entry = { lock: new StateLock(), staleAnnotations: false }
      this.entries.set(tabId, entry)
    }
    return entry
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * Forgets one entry outright, the way `attach`'s listener would once the
   * tab closes. Used to correct the one case that listener cannot: a caller
   * whose `tabs.get` raced a removal it fired before and won, so `get` above
   * recreated an entry for a tab id that will never fire `onRemoved` again.
   */
  delete(tabId: number): void {
    this.entries.delete(tabId)
  }

  /**
   * Forgets the entry of every tab the user closes. Idempotent, and installed
   * once at startup rather than from a handler: a tab may well be removed
   * while its lock is held, and the holder keeps working through its own
   * reference. Firefox never reuses a tab id within a browser session, so an
   * entry created for that id afterwards can never belong to a different tab.
   */
  attach(browser: Browser): void {
    if (this.listening) {
      return
    }
    this.listening = true
    browser.tabs.onRemoved.addListener((tabId) => {
      this.entries.delete(tabId)
    })
  }
}
