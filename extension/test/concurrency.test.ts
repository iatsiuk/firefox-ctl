// The scoped state lock: only the five commands that mutate Session or
// AttachedTabs serialise, everything else runs while they wait, and a holder
// that already answered COMMAND_TIMEOUT still keeps the next owner out until it
// really settles.

import { describe, expect, test } from "bun:test"
import { start } from "../src/app"
import { ATTACHED_TABS_KEY, AttachedTabs } from "../src/attached"
import type { Tab, TabCreateProperties } from "../src/browser"
import { CaptureLocks } from "../src/capture-locks"
import { createDispatcher, Dispatcher } from "../src/dispatch"
import { NetworkTracker } from "../src/network"
import type { HostCommand, JsonObject } from "../src/protocol"
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

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const HUNG = () => new Promise<never>(() => undefined)

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

/** Makes the first `tabs.create` hang; the returned call lets it finish. */
function gateFirstCreate(browser: FakeBrowser): () => void {
  const create = browser.tabs.create.bind(browser.tabs)
  let release: () => void = () => undefined
  let calls = 0
  browser.tabs.create = (properties: TabCreateProperties): Promise<Tab> => {
    calls++
    if (calls > 1) {
      return create(properties)
    }
    return new Promise<Tab>((resolve) => {
      release = () => resolve(create(properties))
    })
  }
  return () => release()
}

describe("commands outside the lock", () => {
  test("a hanging page command does not delay getTabs or navigate", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: storedState() })
    browser.sendMessageHandler = HUNG
    const dispatcher = createDispatcher(browser, env)

    const hung = dispatcher.handle(frame("f1", "getContent", { tabId: 10 }))
    await settle()

    expect(await dispatcher.handle(frame("f2", "getTabs"))).toMatchObject({
      success: true,
      result: { windowId: 1, tabCount: 1 },
    })
    expect(
      await dispatcher.handle(frame("f3", "navigate", { tabId: 10, url: "https://iana.org/" })),
    ).toMatchObject({ success: true, result: { navigated: true } })
    void hung
  })

  test("a page command runs while createWindow holds the lock", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: storedState() })
    browser.sendMessageHandler = () => Promise.resolve({ success: true, result: { text: "hi" } })
    const dispatcher = createDispatcher(browser, env)
    dispatcher.register("createWindow", HUNG)

    const holder = dispatcher.handle(frame("f1", "createWindow"))
    await settle()

    expect(await dispatcher.handle(frame("f2", "getContent", { tabId: 10 }))).toMatchObject({
      success: true,
      result: { text: "hi" },
    })
    void holder
  })

  test("concurrent commands read each stored key once", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: storedState() })
    const reads: string[] = []
    const get = browser.storage.local.get.bind(browser.storage.local)
    browser.storage.local.get = (keys) => {
      reads.push(String(keys))
      return get(keys)
    }
    const dispatcher = createDispatcher(browser, env)

    await Promise.all([
      dispatcher.handle(frame("f1", "getTabs")),
      dispatcher.handle(frame("f2", "listAllTabs")),
      dispatcher.handle(frame("f3", "navigate", { tabId: 10, url: "https://iana.org/" })),
    ])

    expect(reads.filter((key) => key === WINDOW_STATE_KEY)).toHaveLength(1)
    expect(reads.filter((key) => key === ATTACHED_TABS_KEY)).toHaveLength(1)
  })
})

describe("commands under the lock", () => {
  test("two createWindow calls serialise and the second sees the first's tab", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: storedState() })
    const dispatcher = createDispatcher(browser, env)

    const [first, second] = await Promise.all([
      dispatcher.handle(frame("f1", "createWindow")),
      dispatcher.handle(frame("f2", "createWindow")),
    ])

    expect(first).toMatchObject({ success: true, result: { tabCount: 2 } })
    expect(second).toMatchObject({ success: true, result: { tabCount: 3 } })
    expect(dispatcher.deps.session.state?.tabs).toEqual([10, 11, 12])
  })

  test("a waiter that hits its deadline never enters the critical section", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    const dispatcher = new Dispatcher(services(browser, env))
    let entered = 0
    dispatcher.register("createWindow", HUNG)
    dispatcher.register("closeTab", () => {
      entered++
      return { closed: true }
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
    expect(entered).toBe(0)
    void holder
  })

  test("a timed-out holder keeps the lock until it settles and its reply is dropped", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: storedState() })
    const releaseCreate = gateFirstCreate(browser)
    const writes: number[][] = []
    const set = browser.storage.local.set.bind(browser.storage.local)
    browser.storage.local.set = (items) => {
      const state = items[WINDOW_STATE_KEY] as SessionState | null | undefined
      if (state) {
        writes.push([...state.tabs])
      }
      return set(items)
    }
    start(browser, env)
    const port = browser.lastPort() as FakePort

    port.emitMessage(frame("f1", "createWindow", { _timeout: 5000 }))
    await settle()
    env.advance(4000)
    await settle()
    port.emitMessage(frame("f2", "createWindow"))
    await settle()

    // the second command is parked on the lock: the holder still owns it
    expect(port.posted).toEqual([
      {
        id: "f1",
        success: false,
        error: "COMMAND_TIMEOUT: createWindow did not finish within 4000 ms.",
      },
    ])
    expect(writes.some((tabs) => tabs.includes(12))).toBe(false)

    releaseCreate()
    await settle()

    expect(port.posted).toHaveLength(2)
    expect(port.posted[1]).toMatchObject({ id: "f2", success: true, result: { tabCount: 3 } })
    // the late holder's writes all land before the next owner's
    const firstOwner = writes.findIndex((tabs) => tabs.includes(12))
    expect(writes.slice(firstOwner).every((tabs) => tabs.includes(11))).toBe(true)
    expect((await browser.storage.local.get(WINDOW_STATE_KEY))[WINDOW_STATE_KEY]).toMatchObject({
      tabs: [10, 11, 12],
    })
  })
})

describe("preamble fence", () => {
  test("a stale attempt neither adopts its late read nor writes it back", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    await browser.storage.local.set({
      [WINDOW_STATE_KEY]: storedState(),
      [ATTACHED_TABS_KEY]: [[10, { attachedAt: 1 }]],
    })
    const get = browser.storage.local.get.bind(browser.storage.local)
    let releaseAttached: (items: Record<string, unknown>) => void = () => undefined
    let attachedReads = 0
    browser.storage.local.get = (keys) => {
      if (keys === ATTACHED_TABS_KEY && attachedReads++ === 0) {
        return new Promise((resolve) => {
          releaseAttached = resolve
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

    expect(await dispatcher.handle(frame("f2", "getTabs"))).toMatchObject({ success: true })

    const writes: unknown[] = []
    const set = browser.storage.local.set.bind(browser.storage.local)
    browser.storage.local.set = (items) => {
      if (Object.hasOwn(items, ATTACHED_TABS_KEY)) {
        writes.push(items[ATTACHED_TABS_KEY])
      }
      return set(items)
    }
    // the abandoned attempt finally reads an attachment for a tab the pool owns
    releaseAttached({ [ATTACHED_TABS_KEY]: [[10, { attachedAt: 1 }]] })
    await settle()

    expect(dispatcher.deps.attached.has(10)).toBe(false)
    expect(writes).toEqual([])
  })

  test("a stale attempt does not rejoin the next attempt's later restore", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: storedState() })
    const get = browser.storage.local.get.bind(browser.storage.local)
    let releaseSession: (items: Record<string, unknown>) => void = () => undefined
    let sessionReads = 0
    let attachedReads = 0
    browser.storage.local.get = (keys) => {
      if (keys === WINDOW_STATE_KEY) {
        sessionReads++
        if (sessionReads === 1) {
          return new Promise((resolve) => {
            releaseSession = resolve
          })
        }
        return get(keys)
      }
      if (keys === ATTACHED_TABS_KEY) {
        attachedReads++
        // the first attached read never settles, standing in for a genuinely
        // stuck restore that only eviction, not time, can clear
        if (attachedReads === 1) {
          return new Promise<Record<string, unknown>>(() => undefined)
        }
        return get(keys)
      }
      return get(keys)
    }
    const dispatcher = createDispatcher(browser, env)

    // f1 gets stuck on the session restore and times out, abandoning it
    const f1 = dispatcher.handle(frame("f1", "getTabs", { _timeout: 5000 }))
    await settle()
    env.advance(4000)
    expect(await f1).toMatchObject({ success: false })

    // f2 restarts the preamble: its own session restore sails through, and it
    // gets stuck on the attached restore instead
    const f2 = dispatcher.handle(frame("f2", "getTabs", { _timeout: 5000 }))
    await settle()

    // f1's original session read finally answers; its stale preamble attempt
    // must stop there instead of going on to join f2's still-pending attached
    // restore, which would leave that restore's waiter count un-abandonable
    releaseSession({ [WINDOW_STATE_KEY]: storedState() })
    await settle()

    env.advance(4000)
    expect(await f2).toMatchObject({ success: false })
    await settle()

    // f2's abandon must fully evict the stuck attached restore so f3 retries
    // it instead of rejoining the same promise that will never settle
    const f3 = dispatcher.handle(frame("f3", "getTabs"))
    await settle()
    expect(attachedReads).toBe(2)
    void f3
  })

  test("a stale restore's late write does not overwrite a fresher session", async () => {
    const browser = new FakeBrowser()
    browser.addWindow({ id: 1 })
    browser.addTab({ id: 10, windowId: 1, url: "https://example.com/", title: "Example Domain" })
    const env = new FakeEnvironment({ now: 1000 })
    // the stored windowId no longer exists, so restore takes the
    // clear()-then-persist path, which is where this attempt gets stuck
    await browser.storage.local.set({
      [WINDOW_STATE_KEY]: {
        windowId: 99,
        tabs: [],
        createdAt: 5,
        groupId: null,
        isPrivate: false,
        adopted: true,
      },
    })
    const set = browser.storage.local.set.bind(browser.storage.local)
    let releaseFirstWrite: () => void = () => undefined
    let writes = 0
    browser.storage.local.set = (items) => {
      if (Object.hasOwn(items, WINDOW_STATE_KEY) && writes++ === 0) {
        return new Promise((resolve) => {
          releaseFirstWrite = () => resolve(set(items))
        })
      }
      return set(items)
    }
    const dispatcher = createDispatcher(browser, env)

    const stuck = dispatcher.handle(frame("f1", "getTabs", { _timeout: 5000 }))
    await settle()
    env.advance(4000)
    expect(await stuck).toMatchObject({ success: false })

    // a fresh command builds a brand new, correct session while the first
    // attempt's write of the stale `null` clear is still pending
    const created = await dispatcher.handle(
      frame("f2", "createWindow", { _timeout: 5000, private: false }),
    )
    expect(created).toMatchObject({ success: true })
    const freshWindowId = dispatcher.deps.session.state?.windowId

    releaseFirstWrite()
    await settle()

    expect((await browser.storage.local.get(WINDOW_STATE_KEY))[WINDOW_STATE_KEY]).toMatchObject({
      windowId: freshWindowId,
    })
  })

  test("a stale attached restore's late write does not overwrite a fresher drop", async () => {
    const browser = pageBrowser()
    const env = new FakeEnvironment({ now: 1000 })
    await browser.storage.local.set({
      [WINDOW_STATE_KEY]: storedState(),
      [ATTACHED_TABS_KEY]: [[10, { attachedAt: 1 }]],
    })
    const set = browser.storage.local.set.bind(browser.storage.local)
    let releaseFirstWrite: () => void = () => undefined
    let writes = 0
    browser.storage.local.set = (items) => {
      if (Object.hasOwn(items, ATTACHED_TABS_KEY) && writes++ === 0) {
        return new Promise((resolve) => {
          releaseFirstWrite = () => resolve(set(items))
        })
      }
      return set(items)
    }
    const dispatcher = createDispatcher(browser, env)

    const stuck = dispatcher.handle(frame("f1", "getTabs", { _timeout: 5000 }))
    await settle()
    env.advance(4000)
    expect(await stuck).toMatchObject({ success: false })

    // f2 restores cleanly and drops tab 10's attachment because the pool now
    // owns it, while f1's stale write of the old, pool-overlapping entries
    // is still pending
    expect(await dispatcher.handle(frame("f2", "getTabs"))).toMatchObject({ success: true })
    expect(dispatcher.deps.attached.has(10)).toBe(false)

    releaseFirstWrite()
    await settle()

    expect((await browser.storage.local.get(ATTACHED_TABS_KEY))[ATTACHED_TABS_KEY]).toEqual([])
  })
})
