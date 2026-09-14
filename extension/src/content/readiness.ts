// Render settlement, the last gate before a capture: the background page runs
// this inside the tab once the network has gone quiet. It never fails on its
// own - a page without web animations or idle callbacks simply reports less.

import type { JsonObject, JsonValue } from "../protocol"
import type { Page } from "./page"
import { nextFrame } from "./timing"

// long enough for a short main-thread task to finish, short enough that a busy
// page still answers; a hidden tab may never go idle at all
const IDLE_TIMEOUT_MS = 100

interface AnimationLike {
  playState: string
}

/** The slice of the web animations API the check uses, absent in older pages. */
interface Animatable {
  getAnimations?: () => AnimationLike[]
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100
}

function idleSlice(page: Page): Promise<void> {
  return new Promise((resolve) => {
    page.requestIdleCallback?.(() => resolve(), { timeout: IDLE_TIMEOUT_MS })
  })
}

/**
 * Waits for the paint cycle to complete and reports what the page was doing
 * while it did: a double animation frame for the repaint, the animations still
 * running, and one idle slice so a busy main thread is not caught mid-task.
 */
export async function checkPageReadiness(_params: JsonObject, page: Page): Promise<JsonValue> {
  const result: JsonObject = {
    readyState: page.document.readyState,
    timestamp: page.now(),
    viewport: {
      width: page.window.innerWidth,
      height: page.window.innerHeight,
      scrollY: page.window.scrollY,
    },
  }
  const rafStart = page.now()
  await nextFrame(page)
  result.rafWaitMs = round(page.now() - rafStart)

  const animated = page.document as unknown as Animatable
  if (typeof animated.getAnimations === "function") {
    const animations = animated.getAnimations()
    result.runningAnimations = animations.filter((one) => one.playState === "running").length
  }

  if (page.requestIdleCallback !== undefined) {
    const idleStart = page.now()
    await idleSlice(page)
    result.idleWaitMs = round(page.now() - idleStart)
  }
  return result
}
