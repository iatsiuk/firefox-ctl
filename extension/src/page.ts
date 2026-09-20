// Content script composition root: answers the background page's tab messages
// out of the action registry. A watched child frame runs the same bundle, so
// this is also where the frame side opens its port to the background and goes
// silent once the registry deactivates it.

import type { Browser } from "./browser"
import { pageActions } from "./content/actions"
import { resetConsoleCapture } from "./content/console"
import { deactivatePage, isPageActive, type Page } from "./content/page"
import type { ActionMap } from "./content/registry"
import { handleAction } from "./content/registry"
import { FRAME_DEACTIVATED, FRAME_PORT_NAME, isDeactivateMessage } from "./frame-port"
import type { ActionMessage, ActionResponse } from "./messages"
import { isActionMessage } from "./messages"

export { pageActions }

// Firefox keeps one content-script global per frame per extension, so a second
// executeScript into the same document re-runs this bundle with a fresh module
// scope. The guard therefore lives on the page window, which both runs share.
const STARTED = "__firefoxCtlStarted"

/** Whether the frame may still act; the top document always may. */
type ActiveCheck = () => boolean

export function startPage(browser: Browser, page: Page, actions: ActionMap = pageActions): void {
  if (Reflect.get(page.window, STARTED) === true) {
    return
  }
  Object.defineProperty(page.window, STARTED, { configurable: true, value: true })
  const active = page.window === page.window.top ? () => true : connectFrame(browser, page)
  browser.runtime.onMessage.addListener((message) => {
    if (!isActionMessage(message)) {
      return undefined
    }
    // Firefox takes the returned promise as the reply
    return respond(actions, page, message, active)
  })
}

/**
 * Announces this frame to the registry and reports whether it is still
 * observed. Both ends of the port mean the same thing: an unwatch posts the
 * deactivation before disconnecting, and a disconnect on its own - the
 * background restarted, the registry refused the port - is just as final.
 */
function connectFrame(browser: Browser, page: Page): ActiveCheck {
  const stop = (): void => {
    // the same flag a poller checks before its next probe and before a DOM
    // mutation, so an action already in flight stops touching the document
    // rather than merely losing its reply
    deactivatePage(page)
    // console capture belongs to the watch: a frame nobody observes leaves the
    // document's console and its error listeners as it found them
    resetConsoleCapture(page)
  }
  const port = browser.runtime.connect({ name: FRAME_PORT_NAME })
  port.onMessage.addListener((message) => {
    if (isDeactivateMessage(message)) {
      stop()
    }
  })
  port.onDisconnect.addListener(stop)
  return () => isPageActive(page)
}

// checked twice: an action never starts in a deactivated frame, and one that
// was already running has its answer replaced rather than reported as a result
async function respond(
  actions: ActionMap,
  page: Page,
  message: ActionMessage,
  active: ActiveCheck,
): Promise<ActionResponse> {
  if (!active()) {
    return deactivated()
  }
  const response = await handleAction(actions, page, message)
  return active() ? response : deactivated()
}

function deactivated(): ActionResponse {
  return { success: false, error: FRAME_DEACTIVATED }
}
