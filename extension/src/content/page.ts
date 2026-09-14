// The browser surface a content action is allowed to touch. Actions receive a
// `Page` and never read a global, so tests drive them over happy-dom with
// virtual timers; `realPage` is the single binding to the live page and is the
// only file under src/content exempt from the noRestrictedGlobals rule.

export type RafCallback = (time: number) => void

export type IdleCallback = () => void

export interface IdleOptions {
  timeout: number
}

/**
 * The content world's console. Console capture replaces these methods in place,
 * so they are plain writable properties rather than a readonly binding.
 */
export interface PageConsole {
  log: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

export interface Page {
  readonly document: Document
  readonly window: Window
  /** One animation frame; actions double it up to wait for a repaint. */
  raf(callback: RafCallback): void
  setTimeout(callback: () => void, ms: number): number
  clearTimeout(handle: number): void
  /** Milliseconds, monotonic enough for elapsed times. */
  now(): number
  /**
   * One idle slice, when the page has `requestIdleCallback`. Optional because
   * the readiness check must also run where it is missing, and tests leave it
   * out unless they are exercising it.
   */
  requestIdleCallback?(callback: IdleCallback, options: IdleOptions): void
  /** The content script's own console, the one capture can wrap. */
  readonly console: PageConsole
  cssEscape(value: string): string
  readonly InputEvent: new (type: string, init?: InputEventInit) => InputEvent
  readonly KeyboardEvent: new (type: string, init?: KeyboardEventInit) => KeyboardEvent
  readonly Event: new (type: string, init?: EventInit) => Event
  /**
   * The `value` setter from the element's prototype, or undefined when the
   * element is not an input or textarea. Frameworks such as React install their
   * own `value` property on the instance, so typing goes through the prototype
   * setter to reach the real value and let the framework observe the event.
   */
  inputValueSetter(element: Element): ((value: string) => void) | undefined
}

export function nativeValueSetter(element: Element): ((value: string) => void) | undefined {
  const tag = element.tagName
  if (tag !== "INPUT" && tag !== "TEXTAREA") {
    return undefined
  }
  // skip the instance itself: its own value property may be a framework's
  let prototype: object | null = Object.getPrototypeOf(element) as object | null
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value")
    if (descriptor?.set !== undefined) {
      const setter = descriptor.set
      return (value: string) => {
        setter.call(element, value)
      }
    }
    prototype = Object.getPrototypeOf(prototype) as object | null
  }
  return undefined
}

export function realPage(): Page {
  const page: Page = {
    document,
    window,
    raf(callback) {
      requestAnimationFrame(callback)
    },
    setTimeout(callback, ms) {
      return window.setTimeout(callback, ms)
    },
    clearTimeout(handle) {
      window.clearTimeout(handle)
    },
    now() {
      return Date.now()
    },
    console,
    cssEscape(value) {
      return CSS.escape(value)
    },
    InputEvent,
    KeyboardEvent,
    Event,
    inputValueSetter: nativeValueSetter,
  }
  if (typeof requestIdleCallback === "function") {
    page.requestIdleCallback = (callback, options) => {
      requestIdleCallback(callback, options)
    }
  }
  return page
}
