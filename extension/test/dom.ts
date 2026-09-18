// Test doubles for the content-script `Page`: happy-dom plus a virtual
// scheduler, so polling actions run without real time. Everything an action
// may observe about the page (rects, computed styles, scroll position,
// location, frame nesting) is stubbed here, because happy-dom has no layout.

import type { Page, PageConsole, RafCallback } from "../src/content/page"
import { nativeValueSetter } from "../src/content/page"

interface Timer {
  id: number
  due: number
  callback: () => void
}

export interface ConsoleCall {
  level: string
  args: unknown[]
}

export interface FakePage extends Page {
  /** What reached the console underneath any capture wrapper. */
  readonly consoleCalls: ConsoleCall[]
  /**
   * Installs `requestIdleCallback`, which a page has only sometimes; the slice
   * arrives after `delayMs`, or at the caller's timeout when that comes first.
   */
  enableIdleCallback(delayMs?: number): void
  /** Runs raf rounds and timers due within `ms`, draining microtasks between. */
  advance(ms: number): Promise<void>
  /** Drains pending microtasks and jobs queued by the real event loop. */
  flush(): Promise<void>
  /** Timers still waiting plus raf callbacks still queued. */
  pending(): number
}

// a runaway poll loop would otherwise hang the test runner
const maxSteps = 100000

function flushJobs(): Promise<void> {
  // a real macrotask: every pending microtask has run by the time it fires
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, 0)
  })
}

export function fakePage(doc: Document = document, win: Window = window): FakePage {
  let time = 0
  let nextId = 1
  let timers: Timer[] = []
  let frames: RafCallback[] = []
  const consoleCalls: ConsoleCall[] = []

  function recorder(level: string): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      consoleCalls.push({ level, args })
    }
  }

  const pageConsole: PageConsole = {
    log: recorder("log"),
    warn: recorder("warn"),
    error: recorder("error"),
    info: recorder("info"),
    debug: recorder("debug"),
  }

  function runFrames(): boolean {
    if (frames.length === 0) {
      return false
    }
    const round = frames
    frames = []
    for (const callback of round) {
      callback(time)
    }
    return true
  }

  function dueTimer(limit: number): Timer | undefined {
    let found: Timer | undefined
    for (const timer of timers) {
      if (timer.due <= limit && (found === undefined || timer.due < found.due)) {
        found = timer
      }
    }
    return found
  }

  const page: FakePage = {
    document: doc,
    window: win,
    raf(callback) {
      frames.push(callback)
    },
    setTimeout(callback, ms) {
      const id = nextId++
      timers.push({ id, due: time + ms, callback })
      return id
    },
    clearTimeout(handle) {
      timers = timers.filter((timer) => timer.id !== handle)
    },
    now() {
      return time
    },
    console: pageConsole,
    consoleCalls,
    cssEscape(value) {
      return CSS.escape(value)
    },
    InputEvent,
    KeyboardEvent,
    Event,
    inputValueSetter: nativeValueSetter,

    async advance(ms) {
      const target = time + ms
      for (let step = 0; step < maxSteps; step++) {
        await flushJobs()
        if (runFrames()) {
          continue
        }
        const timer = dueTimer(target)
        if (timer === undefined) {
          break
        }
        time = Math.max(time, timer.due)
        timers = timers.filter((candidate) => candidate !== timer)
        timer.callback()
      }
      time = Math.max(time, target)
      await flushJobs()
    },

    enableIdleCallback(delayMs = 0) {
      page.requestIdleCallback = (callback, options) => {
        page.setTimeout(callback, Math.min(delayMs, options.timeout))
      }
    },

    flush: flushJobs,

    pending() {
      return timers.length + frames.length
    },
  }
  return page
}

export interface Rect {
  top?: number
  left?: number
  width?: number
  height?: number
}

/** happy-dom has no layout, so geometry is pinned per element. */
export function stubRect(element: Element, rect: Rect): void {
  const top = rect.top ?? 0
  const left = rect.left ?? 0
  const width = rect.width ?? 0
  const height = rect.height ?? 0
  const value: DOMRect = {
    x: left,
    y: top,
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({ x: left, y: top, width, height }),
  }
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => value,
  })
}

const styles = new WeakMap<Element, Record<string, string>>()
const patched = new WeakSet<Window>()

/** Overrides computed styles for one element; happy-dom resolves few of them. */
export function stubStyle(element: Element, values: Record<string, string>): void {
  const win = element.ownerDocument.defaultView
  if (win === null) {
    throw new Error("stubStyle: element is not attached to a window")
  }
  styles.set(element, { ...styles.get(element), ...values })
  if (patched.has(win)) {
    return
  }
  patched.add(win)
  const original = win.getComputedStyle.bind(win)
  Object.defineProperty(win, "getComputedStyle", {
    configurable: true,
    value: (target: Element, pseudo?: string | null): CSSStyleDeclaration => {
      const computed = original(target, pseudo)
      const overrides = styles.get(target)
      if (overrides === undefined) {
        return computed
      }
      return new Proxy(computed, {
        get(source, key: string | symbol): unknown {
          if (typeof key === "string" && key in overrides) {
            return overrides[key]
          }
          if (typeof key === "string" && key === "getPropertyValue") {
            return (name: string): string => overrides[name] ?? source.getPropertyValue(name)
          }
          const value = Reflect.get(source, key) as unknown
          return typeof value === "function" ? value.bind(source) : value
        },
      })
    },
  })
}

export interface ScrollRecorder {
  readonly calls: { x: number; y: number; behavior?: string }[]
}

/** happy-dom accepts `scrollTo` but never moves `scrollX/scrollY`. */
export function stubScroll(win: Window, x = 0, y = 0): ScrollRecorder {
  const recorder: ScrollRecorder = { calls: [] }
  let currentX = x
  let currentY = y
  Object.defineProperty(win, "scrollX", { configurable: true, get: () => currentX })
  Object.defineProperty(win, "scrollY", { configurable: true, get: () => currentY })
  Object.defineProperty(win, "scrollTo", {
    configurable: true,
    value: (options: ScrollToOptions | number, maybeY?: number): void => {
      const next =
        typeof options === "number"
          ? { left: options, top: maybeY, behavior: undefined }
          : { left: options.left, top: options.top, behavior: options.behavior }
      currentX = next.left ?? currentX
      currentY = next.top ?? currentY
      recorder.calls.push({ x: currentX, y: currentY, behavior: next.behavior })
    },
  })
  return recorder
}

export function stubViewport(win: Window, width: number, height: number): void {
  Object.defineProperty(win, "innerWidth", { configurable: true, value: width })
  Object.defineProperty(win, "innerHeight", { configurable: true, value: height })
}

export function stubLocation(win: Window, href: string): void {
  const url = new URL(href)
  Object.defineProperty(win, "location", {
    configurable: true,
    value: {
      href: url.href,
      origin: url.origin,
      protocol: url.protocol,
      host: url.host,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      toString: () => url.href,
    } as unknown as Location,
  })
}

/** `isTop: false` makes an action believe it runs inside an iframe. */
export function stubTop(win: Window, isTop: boolean): void {
  Object.defineProperty(win, "top", {
    configurable: true,
    value: isTop ? win : ({ name: "outer" } as unknown as Window),
  })
}

/** happy-dom reports `interactive` for ever; the readiness check reads it. */
export function stubReadyState(doc: Document, value: DocumentReadyState): void {
  Object.defineProperty(doc, "readyState", { configurable: true, get: () => value })
}

export interface AnimationStub {
  playState: string
}

/** happy-dom has no web animations, so `getAnimations` is pinned per test. */
export function stubAnimations(doc: Document, animations: AnimationStub[]): void {
  Object.defineProperty(doc, "getAnimations", {
    configurable: true,
    value: () => animations,
  })
}

/** Removes a `getAnimations` installed by `stubAnimations`. */
export function clearAnimations(doc: Document): void {
  Reflect.deleteProperty(doc, "getAnimations")
}

/**
 * Fails unless the selector matches exactly one element and that element is the
 * one asked about, the contract every generated selector must satisfy.
 */
export function assertResolves(page: Page, selector: string, element: Element): void {
  const matches = Array.from(page.document.querySelectorAll(selector))
  const tag = element.tagName.toLowerCase()
  if (matches.length !== 1) {
    throw new Error(`selector ${selector} matched ${matches.length} elements, expected <${tag}>`)
  }
  if (matches[0] !== element) {
    throw new Error(`selector ${selector} matched another element, expected <${tag}>`)
  }
}

export interface SeamPage extends Page {
  /** Every selector string handed to `querySelectorAll`, in order. */
  readonly queries: string[]
}

/**
 * A page that records every `querySelectorAll` and may answer it instead of
 * happy-dom. happy-dom's selector parser rejects strings a browser accepts
 * (escaped quotes inside attribute values, `\31 ` identifiers), so the
 * serialised selector and the verification decision are asserted here;
 * `respond` returns the matches, or undefined to let the real document answer.
 */
export function seamPage(
  base: Page,
  respond: (selector: string) => Element[] | undefined = () => undefined,
): SeamPage {
  const queries: string[] = []
  const document = new Proxy(base.document, {
    get(target, key: string | symbol): unknown {
      if (key === "querySelectorAll") {
        return (selector: string): unknown => {
          queries.push(selector)
          return respond(selector) ?? target.querySelectorAll(selector)
        }
      }
      const value = Reflect.get(target, key) as unknown
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as Document
  return { ...base, document, queries }
}
