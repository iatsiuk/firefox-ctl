import { describe, expect, test } from "bun:test"

import type { Browser, StorageArea } from "../src/browser"
import type { SessionState } from "../src/session"
import { GROUP_TITLE, MAX_TABS, Session, WINDOW_STATE_KEY } from "../src/session"
import { FakeBrowser, FakeEnvironment } from "./fakes"
import errors from "./fixtures/errors.json"

function makeSession(browser: Browser, env = new FakeEnvironment({ now: 1000 })): Session {
  return new Session(browser, env)
}

// a window with `tabCount` tabs, returned with the session state that tracks them
async function seedWindow(
  browser: FakeBrowser,
  tabCount: number,
  overrides: Partial<SessionState> = {},
): Promise<SessionState> {
  const window = await browser.windows.create({ url: "https://example.com" })
  const windowId = window.id as number
  const tabs = (window.tabs ?? []).map((tab) => tab.id as number)
  for (let i = 1; i < tabCount; i++) {
    const tab = await browser.tabs.create({ windowId, url: `https://example.com/${i}` })
    tabs.push(tab.id as number)
  }
  return {
    windowId,
    tabs,
    createdAt: 1000,
    groupId: null,
    isPrivate: false,
    adopted: false,
    ...overrides,
  }
}

async function storedState(browser: Browser): Promise<unknown> {
  const items = await browser.storage.local.get(WINDOW_STATE_KEY)
  return items[WINDOW_STATE_KEY]
}

// a browser whose storage.local.get can be made to fail and counts its calls
function flakyStorage(browser: FakeBrowser): {
  browser: Browser
  calls: () => number
  fail: (message: string | undefined) => void
} {
  let failure: string | undefined
  let calls = 0
  const local: StorageArea = {
    get: (keys) => {
      calls++
      if (failure !== undefined) {
        return Promise.reject(new Error(failure))
      }
      return browser.storage.local.get(keys)
    },
    set: (items) => browser.storage.local.set(items),
    remove: (keys) => browser.storage.local.remove(keys),
  }
  return {
    browser: { ...browser, storage: { local } },
    calls: () => calls,
    fail: (message) => {
      failure = message
    },
  }
}

describe("Session persistence", () => {
  test("persists state and restores it into a fresh session", async () => {
    const browser = new FakeBrowser()
    const state = await seedWindow(browser, 2)
    const first = makeSession(browser)
    first.state = state
    first.activeTabId = state.tabs[1] as number
    await first.persist()

    expect(await storedState(browser)).toEqual(state)

    const second = makeSession(browser)
    await second.restore()
    expect(second.state).toEqual(state)
    expect(second.activeTabId).toBe(state.tabs[1] as number)
  })

  test("clear() drops the state and the stored payload", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    session.state = await seedWindow(browser, 1)
    session.activeTabId = session.state.tabs[0] as number
    await session.persist()

    await session.clear()

    expect(session.state).toBeNull()
    expect(session.activeTabId).toBeNull()
    expect(await storedState(browser)).toBeNull()
  })

  test("persist drops the stored payload for a private session", async () => {
    const browser = new FakeBrowser()
    const state = await seedWindow(browser, 1)
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: state })
    const session = makeSession(browser)
    session.state = { ...state, isPrivate: true }
    session.activeTabId = state.tabs[0] as number

    await session.persist()

    const items = await browser.storage.local.get(WINDOW_STATE_KEY)
    expect(Object.hasOwn(items, WINDOW_STATE_KEY)).toBe(false)
  })

  test("persist writes the state of a non-private session", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    session.state = await seedWindow(browser, 1)

    await session.persist()

    expect(await storedState(browser)).toEqual(session.state)
  })

  test("restore without stored state leaves the session empty", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    await session.restore()
    expect(session.state).toBeNull()
    expect(session.activeTabId).toBeNull()
  })

  test("restore drops stored state whose window is gone", async () => {
    const browser = new FakeBrowser()
    const state = await seedWindow(browser, 1)
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: state })
    await browser.windows.remove(state.windowId)

    const session = makeSession(browser)
    await session.restore()

    expect(session.state).toBeNull()
    expect(await storedState(browser)).toBeNull()
  })

  test("restore keeps only tabs that are still open", async () => {
    const browser = new FakeBrowser()
    const state = await seedWindow(browser, 3)
    const closed = state.tabs[1] as number
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: state })
    await browser.tabs.remove(closed)

    const session = makeSession(browser)
    await session.restore()

    expect(session.state?.tabs).toEqual([state.tabs[0] as number, state.tabs[2] as number])
    expect(session.activeTabId).toBe(state.tabs[2] as number)
  })

  test("restore absorbs untracked tabs of a dedicated window", async () => {
    const browser = new FakeBrowser()
    const state = await seedWindow(browser, 1)
    const orphan = await browser.tabs.create({ windowId: state.windowId, url: "https://orphan" })
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: state })

    const session = makeSession(browser)
    await session.restore()

    expect(session.state?.tabs).toEqual([state.tabs[0] as number, orphan.id as number])
    expect(session.activeTabId).toBe(orphan.id as number)
  })

  test("restore trims a dedicated window's pool back down to MAX_TABS", async () => {
    const browser = new FakeBrowser()
    const state = await seedWindow(browser, MAX_TABS - 2)
    const orphans: number[] = []
    for (let i = 0; i < 4; i++) {
      const tab = await browser.tabs.create({
        windowId: state.windowId,
        url: `https://orphan/${i}`,
      })
      orphans.push(tab.id as number)
    }
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: state })

    const session = makeSession(browser)
    await session.restore()

    expect(session.state?.tabs).toHaveLength(MAX_TABS)
    // the two oldest tracked tabs are evicted first, keeping the newest MAX_TABS
    expect(session.state?.tabs).toEqual([...state.tabs.slice(2), ...orphans])
    for (const tabId of state.tabs.slice(0, 2)) {
      await expect(browser.tabs.get(tabId)).rejects.toThrow()
    }
  })

  test("restore leaves user tabs of an adopted window alone", async () => {
    const browser = new FakeBrowser()
    const state = await seedWindow(browser, 1, { adopted: true })
    await browser.tabs.create({ windowId: state.windowId, url: "https://user-tab" })
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: state })

    const session = makeSession(browser)
    await session.restore()

    expect(session.state?.tabs).toEqual(state.tabs)
    expect(session.state?.adopted).toBe(true)
    expect(session.state?.isPrivate).toBe(false)
  })

  test("restore ignores a stored payload that is not session state", async () => {
    const browser = new FakeBrowser()
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: { windowId: "nope" } })

    const session = makeSession(browser)
    await session.restore()

    expect(session.state).toBeNull()
  })

  test("restore runs once per session", async () => {
    const browser = new FakeBrowser()
    const state = await seedWindow(browser, 1)
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: state })
    const flaky = flakyStorage(browser)

    const session = makeSession(flaky.browser)
    await session.restore()
    await session.restore()

    expect(flaky.calls()).toBe(1)
  })

  test("a failed restore is retried on the next call", async () => {
    const browser = new FakeBrowser()
    const state = await seedWindow(browser, 1)
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: state })
    const flaky = flakyStorage(browser)
    flaky.fail("storage is busy")

    const session = makeSession(flaky.browser)
    await expect(session.restore()).rejects.toThrow("storage is busy")

    flaky.fail(undefined)
    await session.restore()
    expect(session.state?.windowId).toBe(state.windowId)
    expect(flaky.calls()).toBe(2)
  })

  test("a retried restore after a transient failure still runs the sweep", async () => {
    const browser = new FakeBrowser()
    const state = await seedWindow(browser, 1)
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: state })
    const leftover = await browser.windows.create({ url: "https://example.com" })
    const leftoverTabs = (leftover.tabs ?? []).map((tab) => tab.id as number)
    const group = browser.tabs.group as NonNullable<typeof browser.tabs.group>
    const groupId = await group({
      tabIds: leftoverTabs,
      createProperties: { windowId: leftover.id as number },
    })
    await browser.tabGroups?.update(groupId, { title: GROUP_TITLE })
    const flaky = flakyStorage(browser)
    flaky.fail("storage is busy")

    const session = makeSession(flaky.browser)
    await expect(session.restore()).rejects.toThrow("storage is busy")

    flaky.fail(undefined)
    await session.restore()

    expect(session.state?.windowId).toBe(state.windowId)
    await expect(browser.windows.get(leftover.id as number)).rejects.toThrow()
  })
})

describe("Session.sweepDuplicateWindows", () => {
  // a window whose tabs all sit in a group titled `firefox-ctl`
  async function seedGroupedWindow(browser: FakeBrowser): Promise<{
    windowId: number
    groupId: number
  }> {
    const window = await browser.windows.create({ url: "https://example.com" })
    const windowId = window.id as number
    const tabIds = (window.tabs ?? []).map((tab) => tab.id as number)
    const group = browser.tabs.group as NonNullable<typeof browser.tabs.group>
    const groupId = await group({ tabIds, createProperties: { windowId } })
    await browser.tabGroups?.update(groupId, { title: GROUP_TITLE })
    return { windowId, groupId }
  }

  test("closes a leftover window whose tabs are all firefox-ctl tabs", async () => {
    const browser = new FakeBrowser()
    const leftover = await seedGroupedWindow(browser)
    const session = makeSession(browser)

    await session.sweepDuplicateWindows()

    await expect(browser.windows.get(leftover.windowId)).rejects.toThrow()
  })

  test("spares the current session window", async () => {
    const browser = new FakeBrowser()
    const current = await seedGroupedWindow(browser)
    const session = makeSession(browser)
    session.state = {
      windowId: current.windowId,
      tabs: [],
      createdAt: 1000,
      groupId: current.groupId,
      isPrivate: false,
      adopted: false,
    }

    await session.sweepDuplicateWindows()

    expect((await browser.windows.get(current.windowId)).id).toBe(current.windowId)
  })

  test("spares the current session window even when state clears mid-sweep", async () => {
    const browser = new FakeBrowser()
    // enumerated before `current`, so its removal completes first and gives a
    // concurrent closeWindow a chance to clear state before the loop reaches it
    const leftover = await seedGroupedWindow(browser)
    const current = await seedGroupedWindow(browser)
    const session = makeSession(browser)
    session.state = {
      windowId: current.windowId,
      tabs: [],
      createdAt: 1000,
      groupId: current.groupId,
      isPrivate: false,
      adopted: false,
    }
    const originalGet = browser.windows.get.bind(browser.windows)
    browser.windows.get = async (windowId, options) => {
      const window = await originalGet(windowId, options)
      if (windowId === leftover.windowId) {
        // a concurrent closeWindow clearing state partway through the sweep
        session.state = null
      }
      return window
    }

    await session.sweepDuplicateWindows()

    expect((await browser.windows.get(current.windowId)).id).toBe(current.windowId)
  })

  test("spares a window holding an ungrouped tab", async () => {
    const browser = new FakeBrowser()
    const leftover = await seedGroupedWindow(browser)
    await browser.tabs.create({ windowId: leftover.windowId, url: "https://user-tab" })
    const session = makeSession(browser)

    await session.sweepDuplicateWindows()

    expect((await browser.windows.get(leftover.windowId)).id).toBe(leftover.windowId)
  })

  test("spares a window whose tabs belong to a different group", async () => {
    const browser = new FakeBrowser()
    const leftover = await seedGroupedWindow(browser)
    const other = await browser.tabs.create({ windowId: leftover.windowId })
    const group = browser.tabs.group as NonNullable<typeof browser.tabs.group>
    await group({ tabIds: [other.id as number], createProperties: { windowId: leftover.windowId } })
    const session = makeSession(browser)

    await session.sweepDuplicateWindows()

    expect((await browser.windows.get(leftover.windowId)).id).toBe(leftover.windowId)
  })

  test("is a no-op without tab group support", async () => {
    const browser = new FakeBrowser({ tabGroups: false })
    const window = await browser.windows.create({ url: "https://example.com" })
    const session = makeSession(browser)

    await session.sweepDuplicateWindows()

    expect((await browser.windows.get(window.id as number)).id).toBe(window.id)
  })

  test("skips a group whose window vanished mid-sweep", async () => {
    const browser = new FakeBrowser()
    const leftover = await seedGroupedWindow(browser)
    const realGet = browser.windows.get.bind(browser.windows)
    browser.windows.get = (windowId, options) =>
      windowId === leftover.windowId
        ? Promise.reject(new Error("window vanished"))
        : realGet(windowId, options)
    const session = makeSession(browser)

    await expect(session.sweepDuplicateWindows()).resolves.toBeUndefined()
  })
})

describe("Session events", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  test("window removal clears the session and its stored state", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    session.state = await seedWindow(browser, 1)
    session.activeTabId = session.state.tabs[0] as number
    await session.persist()
    session.attach()

    await browser.windows.remove(session.state.windowId)
    await flush()

    expect(session.state).toBeNull()
    expect(session.activeTabId).toBeNull()
    expect(await storedState(browser)).toBeNull()
  })

  test("another window's removal leaves the session alone", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    session.state = await seedWindow(browser, 1)
    const other = await browser.windows.create({})
    session.attach()

    await browser.windows.remove(other.id as number)
    await flush()

    expect(session.state).not.toBeNull()
  })

  test("tab removal drops the tab and persists", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    const state = await seedWindow(browser, 3)
    const [first, second, third] = state.tabs as [number, number, number]
    session.state = state
    session.activeTabId = first
    await session.persist()
    session.attach()

    await browser.tabs.remove(second)
    await flush()

    expect(session.state?.tabs).toEqual([first, third])
    expect(session.activeTabId).toBe(first)
    expect(await storedState(browser)).toMatchObject({ tabs: [first, third] })
  })

  test("removing the active tab re-points to the last remaining tab", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    const state = await seedWindow(browser, 3)
    const [first, , third] = state.tabs as [number, number, number]
    session.state = state
    session.activeTabId = first
    session.attach()

    await browser.tabs.remove(first)
    await flush()

    expect(session.activeTabId).toBe(third)
  })

  test("closing the last tab cascades into window removal", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    const state = await seedWindow(browser, 1)
    session.state = state
    session.activeTabId = state.tabs[0] as number
    await session.persist()
    session.attach()

    await browser.tabs.remove(state.tabs[0] as number)
    await flush()

    expect(session.state).toBeNull()
    expect(session.activeTabId).toBeNull()
    expect(await storedState(browser)).toBeNull()
  })

  test("removal of an untracked tab changes nothing", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    const state = await seedWindow(browser, 2)
    const tracked = [...state.tabs]
    session.state = state
    session.activeTabId = tracked[1] as number
    const other = await browser.windows.create({})
    session.attach()

    await browser.tabs.remove((other.tabs ?? [])[0]?.id as number)
    await flush()

    expect(session.state?.tabs).toEqual(tracked)
    expect(session.activeTabId).toBe(tracked[1] as number)
  })

  test("activation tracks the active pool tab", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    const state = await seedWindow(browser, 2)
    session.state = state
    session.activeTabId = state.tabs[1] as number
    session.attach()

    await browser.tabs.update(state.tabs[0] as number, { active: true })
    await flush()

    expect(session.activeTabId).toBe(state.tabs[0] as number)
  })

  test("activation of a tab outside the pool is ignored", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    const state = await seedWindow(browser, 1)
    session.state = state
    session.activeTabId = state.tabs[0] as number
    const user = await browser.tabs.create({ windowId: state.windowId, active: false })
    session.attach()

    await browser.tabs.update(user.id as number, { active: true })
    await flush()

    expect(session.activeTabId).toBe(state.tabs[0] as number)
  })

  test("a private session's tab removal never writes storage", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    const state = await seedWindow(browser, 2, { isPrivate: true })
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: { ...state, isPrivate: false } })
    session.state = state
    session.activeTabId = state.tabs[1] as number
    session.attach()

    await browser.tabs.remove(state.tabs[0] as number)
    await flush()

    const items = await browser.storage.local.get(WINDOW_STATE_KEY)
    expect(Object.hasOwn(items, WINDOW_STATE_KEY)).toBe(false)
  })

  test("a private session's tab activation never writes storage", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    const state = await seedWindow(browser, 2, { isPrivate: true })
    await browser.storage.local.set({ [WINDOW_STATE_KEY]: { ...state, isPrivate: false } })
    session.state = state
    session.activeTabId = state.tabs[1] as number
    session.attach()

    await browser.tabs.update(state.tabs[0] as number, { active: true })
    await flush()

    const items = await browser.storage.local.get(WINDOW_STATE_KEY)
    expect(Object.hasOwn(items, WINDOW_STATE_KEY)).toBe(false)
  })
})

describe("Session.getSession", () => {
  test("returns the window, the active tab id and the tab", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    const state = await seedWindow(browser, 2)
    session.state = state
    session.activeTabId = state.tabs[1] as number

    const info = await session.getSession()

    expect(info.windowId).toBe(state.windowId)
    expect(info.tabId).toBe(state.tabs[1] as number)
    expect(info.tab.id).toBe(state.tabs[1] as number)
  })

  test("falls back to the last pool tab when the active tab is unknown", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    const state = await seedWindow(browser, 2)
    session.state = state
    session.activeTabId = null

    const info = await session.getSession()

    expect(info.tabId).toBe(state.tabs[1] as number)
    expect(session.activeTabId as number | null).toBe(state.tabs[1] as number)
  })

  test("without a session", async () => {
    const session = makeSession(new FakeBrowser())
    await expect(session.getSession()).rejects.toThrow(errors.sessionLost)
  })

  test("with a window that is gone, clearing the state", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    const state = await seedWindow(browser, 1)
    session.state = state
    session.activeTabId = state.tabs[0] as number
    await session.persist()
    await browser.windows.remove(state.windowId)

    await expect(session.getSession()).rejects.toThrow(errors.windowExpired)
    expect(session.state).toBeNull()
    expect(await storedState(browser)).toBeNull()
  })

  test("with an empty tab pool, keeping the state", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    const state = await seedWindow(browser, 1)
    session.state = { ...state, tabs: [] }
    session.activeTabId = state.tabs[0] as number

    await expect(session.getSession()).rejects.toThrow(errors.noTabs)
    expect(session.state).not.toBeNull()
    expect(session.activeTabId).toBeNull()
  })

  test("with an active tab that no longer exists", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    const state = await seedWindow(browser, 2)
    // the tracked tab is gone while the window and the pool entry survive
    session.state = { ...state, tabs: [...state.tabs, 9999] }
    session.activeTabId = 9999

    await expect(session.getSession()).rejects.toThrow(errors.tabUnavailable)
    expect(session.state).not.toBeNull()
    expect(session.activeTabId).toBeNull()
  })

  test("does not clear a session a concurrent createWindow already replaced", async () => {
    const browser = new FakeBrowser()
    const session = makeSession(browser)
    const state = await seedWindow(browser, 1)
    session.state = state
    session.activeTabId = state.tabs[0] as number
    await session.persist()

    const originalGet = browser.windows.get.bind(browser.windows)
    let releaseGet: () => void = () => undefined
    browser.windows.get = (windowId, options) => {
      if (windowId !== state.windowId) {
        return originalGet(windowId, options)
      }
      return new Promise((_resolve, reject) => {
        releaseGet = () => reject(new Error("window closed"))
      })
    }

    const pending = session.getSession()
    await Promise.resolve()

    // a concurrent createWindow already replaced the session while the check
    // on the old (now closed) window was still in flight
    const replacement: SessionState = { ...state, windowId: state.windowId + 100, tabs: [4242] }
    session.state = replacement
    session.activeTabId = 4242
    await session.persist()

    releaseGet()

    await expect(pending).rejects.toThrow(errors.windowExpired)
    expect(session.state).toEqual(replacement)
    expect(session.activeTabId).toBe(4242)
    expect(await storedState(browser)).toMatchObject({ windowId: replacement.windowId })
  })
})

describe("session constants", () => {
  test("pins the pool size and the storage key", () => {
    expect(MAX_TABS).toBe(12)
    expect(WINDOW_STATE_KEY).toBe("firefoxCtlWindowState")
    expect(GROUP_TITLE).toBe("firefox-ctl")
  })
})
