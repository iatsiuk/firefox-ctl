// Scheduling helpers over the injected Page, so polling actions are driven by
// the test scheduler instead of real time.

import type { Page } from "./page"

// hidden and background tabs throttle or fully suspend requestAnimationFrame
// (https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame),
// so a poll loop built on it alone could wait forever; this bounds one frame.
const frameFallbackMs = 100

/** Waits for the next repaint; a single frame still runs before layout. */
export function nextFrame(page: Page): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      page.clearTimeout(fallback)
      resolve()
    }
    page.raf(() => {
      page.raf(() => finish())
    })
    const fallback = page.setTimeout(finish, frameFallbackMs)
  })
}

export function sleep(page: Page, ms: number): Promise<void> {
  return new Promise((resolve) => {
    page.setTimeout(resolve, ms)
  })
}
