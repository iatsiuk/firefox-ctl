// The per-command deadline: every command answers within the budget derived
// from the host's `_timeout`, whatever hangs behind it.

import { describe, expect, test } from "bun:test"
import { start } from "../src/app"
import { AttachedTabs } from "../src/attached"
import { CaptureLocks } from "../src/capture-locks"
import { createDispatcher, Dispatcher } from "../src/dispatch"
import { NetworkTracker } from "../src/network"
import type { HostCommand, JsonObject } from "../src/protocol"
import { commandContext } from "../src/protocol"
import { waitForPageReady } from "../src/readiness"
import { Session, type SessionState, WINDOW_STATE_KEY } from "../src/session"
import { FakeBrowser, FakeEnvironment, type FakePort } from "./fakes"

function frame(id: string, command: string, params: JsonObject = {}): HostCommand {
  return { id, type: "command", command, params }
}

function services(browser: FakeBrowser, env: FakeEnvironment) {
  return {
    browser,
    env,
    session: new Session(browser, env),
    attached: new AttachedTabs(browser, env),
    network: new NetworkTracker(env),
    captureLocks: new CaptureLocks(),
    readiness: waitForPageReady,
  }
}

// the fake clock only moves on demand, so give the pending microtasks a turn
// before and after each advance
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function pageBrowser(): FakeBrowser {
  const browser = new FakeBrowser()
  browser.addWindow({ id: 1 })
  browser.addTab({ id: 10, windowId: 1, url: "https://example.com/", title: "Example Domain" })
  return browser
}

function storedState(): SessionState {
  return {
    windowId: 1,
    tabs: [10],
    createdAt: 5,
    groupId: null,
    isPrivate: false,
    adopted: true,
  }
}

const HUNG = () => new Promise<never>(() => undefined)

describe("command deadline", () => {
  test("a never-settling page command times out and later commands still answer", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    browser.sendMessageHandler = HUNG
    const dispatcher = createDispatcher(browser, env)

    const hung = dispatcher.handle(frame("f1", "getContent", { tabId: 10, _timeout: 5000 }))
    await settle()
    env.advance(4000)

    expect(await hung).toEqual({
      id: "f1",
      success: false,
      error: "COMMAND_TIMEOUT: getContent did not finish within 4000 ms.",
    })
    expect(await dispatcher.handle(frame("f2", "getTabs"))).toMatchObject({ success: true })
    expect(await dispatcher.handle(frame("f3", "ping"))).toMatchObject({ success: true })
  })

  test("a deadline that fires under the lock answers without running the handler", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    const dispatcher = new Dispatcher(services(browser, env))
    let started = 0
    let releaseHolder: () => void = () => undefined
    dispatcher.register("createWindow", async () => {
      started++
      await new Promise<void>((resolve) => {
        releaseHolder = resolve
      })
      return { ok: true }
    })
    dispatcher.register("closeTab", () => {
      started++
      return { ok: true }
    })

    const holder = dispatcher.handle(frame("f1", "createWindow", { _timeout: 300000 }))
    await settle()
    const waiter = dispatcher.handle(frame("f2", "closeTab", { tabId: 10, _timeout: 5000 }))
    await settle()
    env.advance(4000)

    expect(await waiter).toEqual({
      id: "f2",
      success: false,
      error: "COMMAND_TIMEOUT: closeTab did not finish within 4000 ms.",
    })
    expect(started).toBe(1)

    // the holder finishing does not revive a command that was already answered
    releaseHolder()
    expect(await holder).toMatchObject({ success: true })
    await settle()
    expect(started).toBe(1)
  })

  test("a hung persist still ends the command at the deadline", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    const set = browser.storage.local.set.bind(browser.storage.local)
    browser.storage.local.set = (items) =>
      Object.hasOwn(items, WINDOW_STATE_KEY) ? HUNG() : set(items)
    const dispatcher = new Dispatcher(services(browser, env))
    dispatcher.register("navigate", () => ({ navigated: true }))

    const pending = dispatcher.handle(frame("f1", "navigate", { _timeout: 5000 }))
    await settle()
    env.advance(4000)

    expect(await pending).toMatchObject({
      success: false,
      error: "COMMAND_TIMEOUT: navigate did not finish within 4000 ms.",
    })
  })

  test("the forwarded content params carry no _timeout", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    const seen: unknown[] = []
    browser.sendMessageHandler = (_tabId, message) => {
      seen.push(message)
      return Promise.resolve({ success: true, result: { text: "hi" } })
    }
    const dispatcher = createDispatcher(browser, env)

    const response = await dispatcher.handle(
      frame("f1", "getContent", { tabId: 10, _timeout: 5000, format: "text" }),
    )

    expect(response).toMatchObject({ success: true })
    expect(seen).toEqual([{ action: "getContent", params: { format: "text" } }])
  })
})

describe("liveness probes", () => {
  test("ping answers while the stored state never arrives", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1234 })
    browser.storage.local.get = HUNG
    const dispatcher = createDispatcher(browser, env)

    expect(await dispatcher.handle(frame("f1", "ping"))).toEqual({
      id: "f1",
      success: true,
      result: { pong: true, timestamp: 1234 },
    })
    expect(await dispatcher.handle(frame("f2", "version"))).toMatchObject({ success: true })
  })

  test("ping answers over the port while the startup restore hangs", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1234 })
    browser.storage.local.get = HUNG
    start(browser, env)
    const port = browser.lastPort() as FakePort

    port.emitMessage(frame("f1", "ping"))
    await settle()

    expect(port.posted).toEqual([
      { id: "f1", success: true, result: { pong: true, timestamp: 1234 } },
    ])
  })

  test("a non-probe command still times out over the port when the startup restore hangs", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    browser.storage.local.get = HUNG
    start(browser, env)
    const port = browser.lastPort() as FakePort

    port.emitMessage(frame("f1", "getTabs", { _timeout: 5000 }))
    await settle()
    env.advance(4000)
    await settle()

    expect(port.posted).toEqual([
      {
        id: "f1",
        success: false,
        error: "COMMAND_TIMEOUT: getTabs did not finish within 4000 ms.",
      },
    ])
  })
})

describe("stuck restore", () => {
  test("is retried by the next command and its late result is discarded", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: storedState() })
    const get = browser.storage.local.get.bind(browser.storage.local)
    let releaseFirst: (items: Record<string, unknown>) => void = () => undefined
    let reads = 0
    browser.storage.local.get = (keys) => {
      reads++
      if (reads === 1) {
        return new Promise((resolve) => {
          releaseFirst = resolve
        })
      }
      return get(keys)
    }
    const dispatcher = createDispatcher(browser, env)

    const stuck = dispatcher.handle(frame("f1", "getTabs", { _timeout: 5000 }))
    await settle()
    env.advance(4000)
    expect(await stuck).toMatchObject({
      success: false,
      error: "COMMAND_TIMEOUT: getTabs did not finish within 4000 ms.",
    })

    const retried = await dispatcher.handle(frame("f2", "getTabs"))
    expect(retried).toMatchObject({ success: true, result: { windowId: 1, tabCount: 1 } })

    // the abandoned attempt finally answers with a payload from before the
    // retry: it must neither adopt it nor write it back
    const writes: unknown[] = []
    const set = browser.storage.local.set.bind(browser.storage.local)
    browser.storage.local.set = (items) => {
      if (Object.hasOwn(items, WINDOW_STATE_KEY)) {
        writes.push(items[WINDOW_STATE_KEY])
      }
      return set(items)
    }
    releaseFirst({ [WINDOW_STATE_KEY]: { ...storedState(), windowId: 99, tabs: [] } })
    await settle()

    expect(dispatcher.deps.session.state).toMatchObject({ windowId: 1, tabs: [10] })
    expect(writes.filter((state) => (state as SessionState).windowId !== 1)).toEqual([])
    expect((await browser.storage.local.get(WINDOW_STATE_KEY))[WINDOW_STATE_KEY]).toMatchObject({
      windowId: 1,
      tabs: [10],
    })
  })

  test("a sibling still waiting on the same stuck restore is not poisoned by another's timeout", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: storedState() })
    const get = browser.storage.local.get.bind(browser.storage.local)
    let releaseFirst: (items: Record<string, unknown>) => void = () => undefined
    let reads = 0
    browser.storage.local.get = (keys) => {
      reads++
      if (reads === 1) {
        return new Promise((resolve) => {
          releaseFirst = resolve
        })
      }
      return get(keys)
    }
    const dispatcher = createDispatcher(browser, env)

    // both commands share the same in-flight first restore
    const short = dispatcher.handle(frame("f1", "getTabs", { _timeout: 5000 }))
    const long = dispatcher.handle(frame("f2", "getTabs", { _timeout: 300000 }))
    await settle()
    env.advance(4000)

    expect(await short).toMatchObject({
      success: false,
      error: "COMMAND_TIMEOUT: getTabs did not finish within 4000 ms.",
    })

    releaseFirst({ [WINDOW_STATE_KEY]: storedState() })
    await settle()

    // the long-budget command never timed out itself: it must see the real,
    // restored session, not an empty one caused by the sibling's abandonment
    expect(await long).toMatchObject({ success: true, result: { windowId: 1, tabCount: 1 } })
  })
})

describe("late results", () => {
  test("a handler that finishes after the deadline is not posted to the port", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    let release: (reply: unknown) => void = () => undefined
    browser.sendMessageHandler = () =>
      new Promise((resolve) => {
        release = resolve
      })
    start(browser, env)
    const port = browser.lastPort() as FakePort

    port.emitMessage(frame("f1", "getContent", { tabId: 10, _timeout: 5000 }))
    await settle()
    env.advance(4000)
    await settle()

    expect(port.posted).toEqual([
      {
        id: "f1",
        success: false,
        error: "COMMAND_TIMEOUT: getContent did not finish within 4000 ms.",
      },
    ])

    release({ success: true, result: { text: "late" } })
    await settle()

    expect(port.posted).toHaveLength(1)
  })
})

describe("commandContext", () => {
  test("starts the deadline at the arrival time plus the budget", () => {
    const env = new FakeEnvironment({ now: 1000 })

    expect(commandContext({ _timeout: 5000 }, env)).toEqual({ budgetMs: 4000, deadlineAt: 5000 })
    expect(commandContext({}, env)).toEqual({ budgetMs: 149000, deadlineAt: 150000 })
  })
})
