// Per-tab child-frame observation. A watch is opt-in and covers one tab: every
// child frame of that tab whose document url matches gets the content script
// injected, and the frame side connects back over a runtime port. The registry
// is the only place that knows which child frames can answer a command.
//
// "Frame" is overloaded in this codebase: these are child frames of a tab, not
// the native-messaging wire frames of protocol.ts.

import type { Browser, FrameNavigationDetails, Port } from "./browser"
import type { Environment } from "./env"
import { DEACTIVATE_MESSAGE, FRAME_PORT_NAME } from "./frame-port"
import { globToRegExp } from "./glob"

export { DEACTIVATE_MESSAGE, FRAME_PORT_NAME }

/** The script injected into a watched child frame. */
export const FRAME_SCRIPT_FILE = "/dist/content.js"

/** One observed child frame, as reported by listFrames. */
export interface FrameInfo {
  frameId: number
  url: string
  parentFrameId: number
}

/** Which frames a waiter is after; an empty criterion takes the first one. */
export interface FrameCriterion {
  frameId?: number
  match?: RegExp
}

export type FrameWaitOutcome = "found" | "timeout" | "unwatched" | "closed"

export interface FrameWaitResult {
  outcome: FrameWaitOutcome
  frames: FrameInfo[]
}

/**
 * An injection that has been requested but has not connected back yet. The
 * generation pins it to the watch that asked for it, so a document injected
 * before an unwatch cannot be admitted by the watch that follows.
 */
interface PendingInjection extends FrameInfo {
  generation: number
}

interface ObservedFrame extends FrameInfo {
  port: Port
  generation: number
}

interface FrameWait {
  criterion: FrameCriterion
  timerId?: number
  settle(result: FrameWaitResult): void
}

interface Watch {
  generation: number
  pattern?: RegExp
  pending: Map<number, PendingInjection>
  frames: Map<number, ObservedFrame>
  waits: Set<FrameWait>
  errors: Map<number, string>
}

export class FrameRegistry {
  private readonly env: Environment
  private readonly watches = new Map<number, Watch>()

  private browser?: Browser
  private listening = false
  private generation = 0

  constructor(env: Environment) {
    this.env = env
  }

  /**
   * Installs the three listeners the registry lives on. Guarded like the
   * capture locks: startup calls it once, and a second call from a test
   * harness must not double every event.
   */
  attach(browser: Browser): void {
    if (this.listening) {
      return
    }
    this.listening = true
    this.browser = browser
    browser.webNavigation.onDOMContentLoaded.addListener((details) => {
      void this.frameLoaded(details)
    })
    browser.runtime.onConnect.addListener((port) => {
      this.connected(port)
    })
    browser.tabs.onRemoved.addListener((tabId) => {
      this.tabRemoved(tabId)
    })
  }

  /** Opens a new watch generation for this tab. */
  watch(tabId: number, match?: string): void {
    if (this.watches.has(tabId)) {
      throw new Error(`tab ${tabId} is already watched; call unwatchFrames first`)
    }
    this.generation++
    this.watches.set(tabId, {
      generation: this.generation,
      pattern: match === undefined ? undefined : globToRegExp(match),
      pending: new Map(),
      frames: new Map(),
      waits: new Set(),
      errors: new Map(),
    })
  }

  /**
   * Stops observing this tab and returns how many live frames were released.
   * Every frame script is told to stop answering before its port goes, so a
   * frame stays silent even if Firefox delivers the disconnect late.
   */
  unwatch(tabId: number): number {
    const watch = this.watches.get(tabId)
    if (!watch) {
      return 0
    }
    this.watches.delete(tabId)
    const released = watch.frames.size
    for (const frame of watch.frames.values()) {
      silence(() => frame.port.postMessage(DEACTIVATE_MESSAGE))
      silence(() => frame.port.disconnect())
    }
    watch.frames.clear()
    watch.pending.clear()
    this.generation++
    this.endWaits(watch, "unwatched")
    return released
  }

  isWatched(tabId: number): boolean {
    return this.watches.has(tabId)
  }

  /** Whether a command may be sent to this child frame. Frame 0 never is. */
  isObserved(tabId: number, frameId: number): boolean {
    return frameId !== 0 && this.watches.get(tabId)?.frames.has(frameId) === true
  }

  list(tabId: number): FrameInfo[] {
    const watch = this.watches.get(tabId)
    return watch ? sorted(watch) : []
  }

  /** Drops one entry, for a send that met a receiver already gone. */
  forget(tabId: number, frameId: number): void {
    this.watches.get(tabId)?.frames.delete(frameId)
  }

  /** The last injection failure of this frame, cleared once it connects. */
  injectionError(tabId: number, frameId: number): string | undefined {
    return this.watches.get(tabId)?.errors.get(frameId)
  }

  /**
   * Resolves with the frames matching `criterion`, as soon as one of them is
   * admitted. Wait-for-first: an empty criterion takes whatever child frame
   * connects next. The wait owns its timer and is settled exactly once, so a
   * handler that gave up leaves nothing behind.
   */
  awaitFrame(tabId: number, criterion: FrameCriterion, deadline: number): Promise<FrameWaitResult> {
    const watch = this.watches.get(tabId)
    if (!watch) {
      return Promise.resolve({ outcome: "unwatched", frames: [] })
    }
    const found = matching(watch, criterion)
    if (found.length > 0) {
      return Promise.resolve({ outcome: "found", frames: found })
    }
    const remaining = deadline - this.env.now()
    if (remaining <= 0) {
      return Promise.resolve({ outcome: "timeout", frames: [] })
    }
    return new Promise((resolve) => {
      const settle = (result: FrameWaitResult): void => {
        if (wait.timerId !== undefined) {
          this.env.clearTimeout(wait.timerId)
          wait.timerId = undefined
        }
        watch.waits.delete(wait)
        resolve(result)
      }
      const wait: FrameWait = { criterion, settle }
      wait.timerId = this.env.setTimeout(() => {
        settle({ outcome: "timeout", frames: [] })
      }, remaining)
      watch.waits.add(wait)
    })
  }

  /**
   * A child frame of a watched tab finished parsing its document. The pending
   * record is written before the injection so a script that connects while
   * `executeScript` is still in flight is admitted.
   */
  frameLoaded(details: FrameNavigationDetails): Promise<void> {
    const { tabId, frameId, parentFrameId, url } = details
    const watch = this.watches.get(tabId)
    if (!watch || frameId === 0) {
      return Promise.resolve()
    }
    if (watch.pattern && !watch.pattern.test(url)) {
      // the frame navigated away from a matching document: whatever was
      // injected there must not be admitted once it connects
      watch.pending.delete(frameId)
      return Promise.resolve()
    }
    const pending = watch.pending.get(frameId)
    if (pending && pending.url === url && pending.generation === watch.generation) {
      return Promise.resolve()
    }
    watch.pending.set(frameId, { frameId, url, parentFrameId, generation: watch.generation })
    watch.errors.delete(frameId)
    return this.inject(tabId, frameId, url, watch.generation)
  }

  private async inject(
    tabId: number,
    frameId: number,
    url: string,
    generation: number,
  ): Promise<void> {
    const browser = this.browser
    if (!browser) {
      return
    }
    try {
      await browser.tabs.executeScript(tabId, {
        frameId,
        file: FRAME_SCRIPT_FILE,
        runAt: "document_idle",
      })
    } catch (error) {
      const watch = this.watches.get(tabId)
      if (!watch) {
        return
      }
      watch.errors.set(frameId, errorText(error))
      const pending = watch.pending.get(frameId)
      // only the record this injection was made for; a newer navigation or a
      // new watch may have replaced it while executeScript was in flight
      if (pending && pending.url === url && pending.generation === generation) {
        watch.pending.delete(frameId)
      }
    }
  }

  private connected(port: Port): void {
    if (!this.admit(port)) {
      silence(() => port.disconnect())
    }
  }

  private admit(port: Port): boolean {
    const sender = port.sender
    const tabId = sender?.tab?.id
    const frameId = sender?.frameId
    if (port.name !== FRAME_PORT_NAME || tabId === undefined || frameId === undefined) {
      return false
    }
    if (frameId === 0) {
      return false
    }
    const watch = this.watches.get(tabId)
    const pending = watch?.pending.get(frameId)
    if (!watch || !pending || pending.generation !== watch.generation) {
      return false
    }
    if (pending.url !== sender?.url) {
      return false
    }
    watch.pending.delete(frameId)
    watch.errors.delete(frameId)
    watch.frames.set(frameId, {
      frameId,
      url: pending.url,
      parentFrameId: pending.parentFrameId,
      port,
      generation: watch.generation,
    })
    port.onDisconnect.addListener(() => {
      this.frameDisconnected(tabId, frameId, port)
    })
    this.notifyWaits(watch)
    return true
  }

  // a disconnect only counts for the port still on record: an old document may
  // report its end long after its replacement was admitted
  private frameDisconnected(tabId: number, frameId: number, port: Port): void {
    const watch = this.watches.get(tabId)
    if (watch?.frames.get(frameId)?.port === port) {
      watch.frames.delete(frameId)
    }
  }

  private tabRemoved(tabId: number): void {
    const watch = this.watches.get(tabId)
    if (!watch) {
      return
    }
    this.watches.delete(tabId)
    watch.frames.clear()
    watch.pending.clear()
    this.endWaits(watch, "closed")
  }

  private notifyWaits(watch: Watch): void {
    for (const wait of [...watch.waits]) {
      const frames = matching(watch, wait.criterion)
      if (frames.length > 0) {
        wait.settle({ outcome: "found", frames })
      }
    }
  }

  private endWaits(watch: Watch, outcome: FrameWaitOutcome): void {
    for (const wait of [...watch.waits]) {
      wait.settle({ outcome, frames: [] })
    }
  }
}

function matching(watch: Watch, criterion: FrameCriterion): FrameInfo[] {
  return sorted(watch).filter(
    (frame) =>
      (criterion.frameId === undefined || frame.frameId === criterion.frameId) &&
      (criterion.match === undefined || criterion.match.test(frame.url)),
  )
}

function sorted(watch: Watch): FrameInfo[] {
  return [...watch.frames.values()]
    .map(({ frameId, url, parentFrameId }) => ({ frameId, url, parentFrameId }))
    .sort((a, b) => a.frameId - b.frameId)
}

// a port the frame side already closed throws on both postMessage and
// disconnect; the registry is dropping it either way
function silence(action: () => void): void {
  try {
    action()
  } catch {
    return
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
