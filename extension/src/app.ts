// Composition root of the background page: builds the dispatcher and the native
// link, wires one to the other and connects. The entry point injects the real
// browser and environment, tests inject fakes.

import type { Browser } from "./browser"
import type { Dispatcher } from "./dispatch"
import { createDispatcher } from "./dispatch"
import type { Environment } from "./env"
import { CONNECTION_STATUS, hasAction } from "./messages"
import { NativeLink } from "./port"

export interface AppHandle {
  readonly link: NativeLink
  readonly dispatcher: Dispatcher
}

export function start(browser: Browser, env: Environment): AppHandle {
  const dispatcher = createDispatcher(browser, env)
  const { session, attached, network, captureLocks, frames } = dispatcher.deps
  session.attach()
  attached.attach()
  // the per-tab capture locks are pruned from the same lifecycle event, so a
  // long-lived background page keeps one only per tab that still exists
  captureLocks.attach(browser)
  // the readiness pipeline only sees what the tracker recorded, so it listens
  // from load rather than from the first screenshot
  network.attach(browser)
  // a watched tab must see the very next child frame load, so the navigation
  // and connect listeners are in place before the first watchFrames arrives
  frames.attach(browser)
  // kicked off eagerly, untracked, so a background restart sweeps a leftover
  // window even before the first command arrives; no command waits on it -
  // every command's own deadline starts inside handle() below, and prepare()
  // reattaches to this same restore if it is still running
  session.restore(false).catch((error: unknown) => {
    console.warn("[firefox-ctl] session restore failed:", error)
  })
  const link = new NativeLink(browser, env, (command, reply) => {
    dispatcher.handle(command).then(reply, (error: unknown) => {
      reply({ id: command.id, success: false, error: describe(error) })
    })
  })
  browser.runtime.onMessage.addListener((message) => {
    if (!hasAction(message, CONNECTION_STATUS)) {
      return undefined
    }
    // Firefox takes the returned promise as the reply
    return Promise.resolve(link.status())
  })
  link.connect()
  return { link, dispatcher }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
