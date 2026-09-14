import { describe, expect, test } from "bun:test"

import { ATTACHED_TABS_KEY, AttachedTabs } from "../src/attached"
import type { Browser, Tab } from "../src/browser"
import { CaptureLocks } from "../src/capture-locks"
import { attachTab, detachTab, listAllTabs } from "../src/handlers/attached"
import { NetworkTracker } from "../src/network"
import type { JsonObject } from "../src/protocol"
import { commandContext } from "../src/protocol"
import { waitForPageReady } from "../src/readiness"
import { Session, type SessionState } from "../src/session"
import { FakeBrowser, FakeEnvironment } from "./fakes"
import errors from "./fixtures/errors.json"
import attachFixture from "./fixtures/results/attachTab.json"
import listFixture from "./fixtures/results/listAllTabs.json"

interface Harness {
  browser: FakeBrowser
  session: Session
  attached: AttachedTabs
  attach(params?: JsonObject): Promise<JsonObject>
  detach(params?: JsonObject): Promise<JsonObject>
  list(): Promise<JsonObject>
}

function harness(browser = new FakeBrowser()): Harness {
  const env = new FakeEnvironment({ now: 1000 })
  const session = new Session(browser, env)
  const attached = new AttachedTabs(browser, env)
  attached.attach()
  const deps = {
    browser,
    env,
    session,
    attached,
    network: new NetworkTracker(env),
    captureLocks: new CaptureLocks(),
    readiness: waitForPageReady,
    ctx: commandContext({}, env),
  }
  return {
    browser,
    session,
    attached,
    attach: async (params: JsonObject = {}) => (await attachTab(params, deps)) as JsonObject,
    detach: async (params: JsonObject = {}) => (await detachTab(params, deps)) as JsonObject,
    list: async () => (await listAllTabs({}, deps)) as JsonObject,
  }
}

// a user window with `tabCount` tabs, none of them tracked by the session
async function userTabs(browser: FakeBrowser, tabCount: number): Promise<number[]> {
  const window = await browser.windows.create({ url: "https://example.com/0" })
  const windowId = window.id as number
  const ids = (window.tabs ?? []).map((tab) => tab.id as number)
  for (let i = ids.length; i < tabCount; i++) {
    const tab = await browser.tabs.create({
      windowId,
      url: `https://example.com/${i}`,
      active: false,
    })
    ids.push(tab.id as number)
  }
  return ids
}

function poolOf(session: Session, windowId: number, tabs: number[]): SessionState {
  const state: SessionState = {
    windowId,
    tabs,
    createdAt: 1000,
    groupId: null,
    isPrivate: false,
    adopted: false,
  }
  session.state = state
  session.activeTabId = tabs[tabs.length - 1] ?? null
  return state
}

async function stored(browser: Browser): Promise<unknown> {
  const items = await browser.storage.local.get(ATTACHED_TABS_KEY)
  return items[ATTACHED_TABS_KEY]
}

describe("attachTab", () => {
  test("attaches a user tab, persists it and reports the tab", async () => {
    const h = harness()
    const tabId = (await userTabs(h.browser, 1))[0] as number
    const tab = (await h.browser.tabs.get(tabId)) as Tab

    const result = await h.attach({ tabId })

    expect(result).toEqual({
      attached: true,
      tabId,
      windowId: tab.windowId as number,
      url: "https://example.com/0",
      title: null,
    })
    expect(Object.keys(result).sort()).toEqual(Object.keys(attachFixture).sort())
    expect(h.attached.has(tabId)).toBe(true)
    expect(await stored(h.browser)).toEqual([[tabId, { attachedAt: 1000, incognito: false }]])
  })

  test("rejects a tab that belongs to the managed pool", async () => {
    const h = harness()
    const ids = await userTabs(h.browser, 2)
    poolOf(h.session, 1, [ids[0] as number])

    expect(h.attach({ tabId: ids[0] as number })).rejects.toThrow(
      errors.attachPoolTab.replace("<id>", String(ids[0])),
    )
    expect(h.attached.has(ids[0] as number)).toBe(false)
  })

  test("rejects a tabId that is not a positive integer", async () => {
    const h = harness()
    for (const tabId of [0, -3, 1.5, "7", null]) {
      expect(h.attach({ tabId } as JsonObject)).rejects.toThrow(errors.attachInvalidTabId)
    }
    expect(h.attach({})).rejects.toThrow(errors.attachInvalidTabId)
  })

  test("rejects an unknown tab", async () => {
    const h = harness()
    expect(h.attach({ tabId: 404 })).rejects.toThrow(errors.attachNotFound.replace("<id>", "404"))
  })
})

describe("detachTab", () => {
  test("forgets an attached tab and persists the empty set", async () => {
    const h = harness()
    const tabId = (await userTabs(h.browser, 1))[0] as number
    await h.attach({ tabId })

    expect(await h.detach({ tabId })).toEqual({ detached: true, tabId })
    expect(h.attached.has(tabId)).toBe(false)
    expect(await stored(h.browser)).toEqual([])
  })

  test("reports detached false for a tab that was never attached", async () => {
    const h = harness()
    expect(await h.detach({ tabId: 42 })).toEqual({ detached: false, tabId: 42 })
  })

  test("requires tabId", async () => {
    const h = harness()
    expect(h.detach({})).rejects.toThrow(errors.detachMissingTabId)
    expect(h.detach({ tabId: null })).rejects.toThrow(errors.detachMissingTabId)
    expect(h.detach({ tabId: "9" } as JsonObject)).rejects.toThrow(errors.attachInvalidTabId)
  })
})

describe("attached tab bookkeeping", () => {
  test("restore keeps live tabs and drops closed ones", async () => {
    const browser = new FakeBrowser()
    const ids = await userTabs(browser, 2)
    await browser.storage.local.set({
      [ATTACHED_TABS_KEY]: [
        [ids[0], { attachedAt: 5 }],
        [ids[1], { attachedAt: 6 }],
        [999, { attachedAt: 7 }],
        ["bogus"],
      ],
    })
    browser.removeTab(ids[1] as number)

    const attached = new AttachedTabs(browser, new FakeEnvironment({ now: 1000 }))
    await attached.restore()

    expect([...attached.tabIds()]).toEqual([ids[0] as number])
    expect(await stored(browser)).toEqual([[ids[0], { attachedAt: 5, incognito: false }]])
  })

  test("a private tab is attached in memory but never persisted", async () => {
    const h = harness()
    const window = await h.browser.windows.create({
      url: "https://example.com/private",
      incognito: true,
    })
    const tabId = (window.tabs ?? [])[0]?.id as number

    await h.attach({ tabId })

    expect(h.attached.has(tabId)).toBe(true)
    expect([...h.attached.tabIds()]).toEqual([tabId])
    expect(await stored(h.browser)).toEqual([])
  })

  test("restore runs once but retries after a failure", async () => {
    const browser = new FakeBrowser()
    const tabId = (await userTabs(browser, 1))[0] as number
    let calls = 0
    let failure: string | undefined = "storage offline"
    const real = browser.storage.local.get.bind(browser.storage.local)
    const local = {
      get: (keys?: string | string[] | null) => {
        calls++
        return failure === undefined ? real(keys) : Promise.reject(new Error(failure))
      },
      set: browser.storage.local.set.bind(browser.storage.local),
      remove: browser.storage.local.remove.bind(browser.storage.local),
    }
    const wrapped = { ...browser, storage: { local } } as unknown as Browser
    await browser.storage.local.set({ [ATTACHED_TABS_KEY]: [[tabId, { attachedAt: 5 }]] })
    const attached = new AttachedTabs(wrapped, new FakeEnvironment({ now: 1000 }))

    expect(attached.restore()).rejects.toThrow("storage offline")
    await attached.restore().catch(() => {})
    failure = undefined
    await attached.restore()
    await attached.restore()

    expect(calls).toBe(3)
    expect(attached.has(tabId)).toBe(true)
  })

  test("dropPoolTabs forgets tabs that joined the pool", async () => {
    const h = harness()
    const ids = await userTabs(h.browser, 2)
    await h.attach({ tabId: ids[0] as number })
    await h.attach({ tabId: ids[1] as number })
    poolOf(h.session, 1, [ids[1] as number])

    await h.attached.dropPoolTabs(h.session, () => true)

    expect([...h.attached.tabIds()]).toEqual([ids[0] as number])
    expect(await stored(h.browser)).toEqual([[ids[0], { attachedAt: 1000, incognito: false }]])
  })

  test("dropPoolTabs is a no-op without a session", async () => {
    const h = harness()
    const tabId = (await userTabs(h.browser, 1))[0] as number
    await h.attach({ tabId })

    await h.attached.dropPoolTabs(h.session, () => true)

    expect(h.attached.has(tabId)).toBe(true)
  })

  test("dropPoolTabs persists again when the caller reports the attempt is stale", async () => {
    const h = harness()
    const ids = await userTabs(h.browser, 1)
    await h.attach({ tabId: ids[0] as number })
    poolOf(h.session, 1, [ids[0] as number])
    const writes: unknown[] = []
    const set = h.browser.storage.local.set.bind(h.browser.storage.local)
    h.browser.storage.local.set = (items) => {
      if (Object.hasOwn(items, ATTACHED_TABS_KEY)) {
        writes.push(items[ATTACHED_TABS_KEY])
      }
      return set(items)
    }

    await h.attached.dropPoolTabs(h.session, () => false)

    // the preamble that started this drop was abandoned while its own write
    // was in flight, so the corrective second write must still land
    expect(writes).toEqual([[], []])
  })

  test("a closed tab is forgotten through tabs.onRemoved", async () => {
    const h = harness()
    const ids = await userTabs(h.browser, 2)
    await h.attach({ tabId: ids[0] as number })

    h.browser.removeTab(ids[0] as number)
    await Promise.resolve()

    expect(h.attached.has(ids[0] as number)).toBe(false)
    expect(await stored(h.browser)).toEqual([])
  })

  test("closing an untracked tab leaves the set alone", async () => {
    const h = harness()
    const ids = await userTabs(h.browser, 2)
    await h.attach({ tabId: ids[0] as number })

    h.browser.removeTab(ids[1] as number)
    await Promise.resolve()

    expect(h.attached.has(ids[0] as number)).toBe(true)
  })
})

describe("listAllTabs", () => {
  test("flags pool and attached tabs and counts them", async () => {
    const h = harness()
    const ids = await userTabs(h.browser, 3)
    poolOf(h.session, 1, [ids[0] as number])
    await h.attach({ tabId: ids[1] as number })

    const result = await h.list()
    const tabs = result.tabs as JsonObject[]

    expect(result.count).toBe(3)
    expect(tabs).toHaveLength(3)
    expect(Object.keys(tabs[0] as JsonObject).sort()).toEqual(
      Object.keys((listFixture.tabs as JsonObject[])[0] as JsonObject).sort(),
    )
    expect(tabs.map((tab) => tab.pool)).toEqual([true, false, false])
    expect(tabs.map((tab) => tab.attached)).toEqual([false, true, false])
    expect(tabs[2]).toEqual({
      tabId: ids[2] as number,
      windowId: 1,
      url: "https://example.com/2",
      title: null,
      active: false,
      pinned: false,
      private: false,
      pool: false,
      attached: false,
    })
  })

  test("reports an empty list when no tab is open", async () => {
    const h = harness()
    expect(await h.list()).toEqual({ tabs: [], count: 0 })
  })
})
