// Content script composition root: answers the background page's tab messages
// out of the action registry.

import type { Browser } from "./browser"
import { pageActions } from "./content/actions"
import type { Page } from "./content/page"
import type { ActionMap } from "./content/registry"
import { handleAction } from "./content/registry"
import { isActionMessage } from "./messages"

export { pageActions }

export function startPage(browser: Browser, page: Page, actions: ActionMap = pageActions): void {
  browser.runtime.onMessage.addListener((message) => {
    if (!isActionMessage(message)) {
      return undefined
    }
    // Firefox takes the returned promise as the reply
    return handleAction(actions, page, message)
  })
}
