import { describe, expect, test } from "bun:test"

import type { Browser } from "../src/browser"
import { createWindow } from "../src/handlers/window"
import type { JsonObject } from "../src/protocol"
import { MAX_TABS, Session, WINDOW_STATE_KEY } from "../src/session"
import { FakeBrowser, FakeEnvironment } from "./fakes"
import errors from "./fixtures/errors.json"
import fixture from "./fixtures/results/createWindow.json"
import fallbackFixture from "./fixtures/results/createWindow-fallback.json"

interface Harness {
  browser: FakeBrowser
  session: Session
  run(params?: JsonObject): Promise<JsonObject>
}

function harness(browser = new FakeBrowser()): Harness {
  const env = new FakeEnvironment({ now: 1000 })
  const session = new Session(browser, env)
  // the real background wires these once at startup, so the pool tracks events
  session.attach()
  return {
    browser,
    session,
    run: async (params: JsonObject = {}) =>
      (await createWindow(params, { browser, env, session })) as JsonObject,
  }
}

async function fillPool(h: Harness, count: number): Promise<number[]> {
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    const result = await h.run({ url: `https://example.com/${i}` })
    ids.push(result.tabId as number)
  }
  return ids
}

describe("createWindow mode resolution", () => {
  test("defaults to a private window and matches the fixture", async () => {
    const h = harness()

    const result = await h.run()

    expect(result).toEqual(fixture)
    const window = await h.browser.windows.get(result.windowId as number)
    expect(window.incognito).toBe(true)
    expect(h.session.state?.isPrivate).toBe(true)
    expect(h.session.activeTabId).toBe(result.tabId as number)
  })

  test("passes the url to the new window and keeps a private state in memory", async () => {
    const h = harness()

    const result = await h.run({ url: "https://example.com" })

    const tab = await h.browser.tabs.get(result.tabId as number)
    expect(tab.url).toBe("https://example.com")
    expect(h.session.state).toEqual({
      windowId: result.windowId as number,
      tabs: [result.tabId as number],
      createdAt: 1000,
      groupId: h.session.state?.groupId ?? null,
      isPrivate: true,
      adopted: false,
    })
    // the default window is private, so nothing is written to storage
    const items = await h.browser.storage.local.get(WINDOW_STATE_KEY)
    expect(Object.hasOwn(items, WINDOW_STATE_KEY)).toBe(false)
  })

  test("persists the state of a non-private window", async () => {
    const h = harness()

    const result = await h.run({ private: false, url: "https://example.com" })

    const items = await h.browser.storage.local.get(WINDOW_STATE_KEY)
    expect(items[WINDOW_STATE_KEY]).toEqual({
      windowId: result.windowId,
      tabs: [result.tabId],
      createdAt: 1000,
      groupId: h.session.state?.groupId ?? null,
      isPrivate: false,
      adopted: false,
    })
  })

  test("rejects a private request against a non-private session", async () => {
    const h = harness()
    await h.run({ private: false })

    await expect(h.run({ private: true })).rejects.toThrow(errors.modeMismatchPrivate)
  })

  test("rejects a non-private request against a private session", async () => {
    const h = harness()
    await h.run()

    await expect(h.run({ private: false })).rejects.toThrow(errors.modeMismatchNonPrivate)
  })

  test("reuses the session when private is omitted", async () => {
    const h = harness()
    const first = await h.run()

    const second = await h.run()

    expect(second.windowId).toBe(first.windowId)
    expect(second.isNewWindow).toBe(false)
    expect(second.tabCount).toBe(2)
    expect(second.message).toBe("Tab 2/12")
  })
})

describe("createWindow adoption", () => {
  test("adopts the last focused normal window for a non-private session", async () => {
    const browser = new FakeBrowser()
    browser.addWindow({ id: 7, focused: true })
    browser.addTab({ id: 70, windowId: 7, active: true, url: "https://user.example" })
    const h = harness(browser)

    const result = await h.run({ private: false })

    expect(result.windowId).toBe(7)
    expect(result.isNewWindow).toBe(false)
    expect(result.isPrivate).toBe(false)
    expect(h.session.state?.adopted).toBe(true)
    const created = await browser.tabs.get(result.tabId as number)
    expect(created.windowId).toBe(7)
    // the user's tab keeps the focus
    expect(created.active).toBe(false)
    expect((await browser.tabs.get(70)).active).toBe(true)
  })

  test("opens its own window when the last focused window is private", async () => {
    const browser = new FakeBrowser()
    browser.addWindow({ id: 7, focused: true, incognito: true })
    const h = harness(browser)

    const result = await h.run({ private: false })

    expect(result.windowId).not.toBe(7)
    expect(result.isNewWindow).toBe(true)
    expect(h.session.state?.adopted).toBe(false)
  })

  test("opens its own window when the last focused window is not a normal window", async () => {
    const browser = new FakeBrowser()
    browser.addWindow({ id: 7, focused: true, type: "popup" })
    const h = harness(browser)

    const result = await h.run({ private: false })

    expect(result.windowId).not.toBe(7)
    expect(result.isNewWindow).toBe(true)
  })

  test("opens its own window when there is nothing to adopt", async () => {
    const h = harness()

    const result = await h.run({ private: false })

    expect(result.isNewWindow).toBe(true)
    expect(result.isPrivate).toBe(false)
    expect(h.session.state?.adopted).toBe(false)
  })

  test("never adopts for a private session", async () => {
    const browser = new FakeBrowser()
    browser.addWindow({ id: 7, focused: true })
    const h = harness(browser)

    const result = await h.run({ private: true })

    expect(result.windowId).not.toBe(7)
    expect(result.isPrivate).toBe(true)
  })
})

describe("createWindow private fallback", () => {
  test("falls back to a normal window and warns", async () => {
    const browser = new FakeBrowser()
    browser.failPrivate = "Extension does not have permission for incognito mode"
    const h = harness(browser)

    const result = await h.run()

    expect(result).toEqual(fallbackFixture)
    const window = await browser.windows.get(result.windowId as number)
    expect(window.incognito).toBe(false)
    // recorded as non-private so a later --private=false does not trip MODE_MISMATCH
    expect(h.session.state?.isPrivate).toBe(false)
    await expect(h.run({ private: false })).resolves.toBeDefined()
  })

  test("propagates an unrelated windows.create rejection", async () => {
    const browser = new FakeBrowser()
    browser.failPrivate = "Something else went wrong"
    const h = harness(browser)

    await expect(h.run()).rejects.toThrow("Something else went wrong")
    expect(h.session.state).toBeNull()
  })
})

describe("createWindow pool", () => {
  test("evicts the oldest tab once the pool is full", async () => {
    const h = harness()
    const ids = await fillPool(h, MAX_TABS)

    const result = await h.run()

    expect(result.closedOldestTab).toBe(ids[0] as number)
    expect(result.tabCount).toBe(MAX_TABS)
    expect(result.message).toBe(`Tab ${MAX_TABS}/${MAX_TABS} (closed oldest)`)
    expect(h.session.state?.tabs).toEqual([...ids.slice(1), result.tabId as number])
    await expect(h.browser.tabs.get(ids[0] as number)).rejects.toThrow()
  })

  test("re-points the active tab when the evicted tab was active", async () => {
    const h = harness()
    const ids = await fillPool(h, MAX_TABS)
    // make the oldest tab the active one
    await h.browser.tabs.update(ids[0] as number, { active: true })
    expect(h.session.activeTabId).toBe(ids[0] as number)

    const result = await h.run()

    expect(h.session.activeTabId).toBe(result.tabId as number)
  })

  test("drops the evicted entry even when tabs.remove fails", async () => {
    const fake = new FakeBrowser()
    // a tab Firefox refuses to close, e.g. one running a beforeunload dialog
    const browser: Browser = {
      ...fake,
      tabs: { ...fake.tabs, remove: () => Promise.reject(new Error("Tab is busy")) },
    }
    const env = new FakeEnvironment({ now: 1000 })
    const session = new Session(browser, env)
    session.attach()
    const run = async () => (await createWindow({}, { browser, env, session })) as JsonObject
    const ids: number[] = []
    for (let i = 0; i < MAX_TABS; i++) {
      ids.push((await run()).tabId as number)
    }

    const result = await run()

    expect(result.closedOldestTab).toBe(ids[0] as number)
    expect(session.state?.tabs).not.toContain(ids[0] as number)
    expect(session.state?.tabs).toHaveLength(MAX_TABS)
    // the tab itself survived, but it is no longer firefox-ctl's concern
    expect((await fake.tabs.get(ids[0] as number)).id).toBe(ids[0] as number)
  })

  test("recreates the session when the tracked window is gone", async () => {
    const h = harness()
    const first = await h.run()
    await h.browser.windows.remove(first.windowId as number)
    h.session.state = {
      windowId: first.windowId as number,
      tabs: [first.tabId as number],
      createdAt: 1000,
      groupId: null,
      isPrivate: true,
      adopted: false,
    }

    const second = await h.run()

    expect(second.isNewWindow).toBe(true)
    expect(second.windowId).not.toBe(first.windowId)
    expect(second.tabCount).toBe(1)
  })
})

describe("createWindow tab groups", () => {
  test("groups every pool tab under firefox-ctl", async () => {
    const h = harness()
    const first = await h.run()
    const second = await h.run()

    const groupId = h.session.state?.groupId
    expect(typeof groupId).toBe("number")
    expect((await h.browser.tabs.get(first.tabId as number)).groupId).toBe(groupId as number)
    expect((await h.browser.tabs.get(second.tabId as number)).groupId).toBe(groupId as number)
    const groups = await h.browser.tabGroups?.query({ title: "firefox-ctl" })
    expect(groups?.map((group) => group.id)).toEqual([groupId as number])
  })

  test("works without tab group support", async () => {
    const h = harness(new FakeBrowser({ tabGroups: false }))

    const first = await h.run()
    const second = await h.run()

    expect(h.session.state?.groupId).toBeNull()
    expect((await h.browser.tabs.get(first.tabId as number)).groupId).toBeUndefined()
    expect((await h.browser.tabs.get(second.tabId as number)).groupId).toBeUndefined()
  })

  test("survives a rejection from tabs.group", async () => {
    const h = harness()
    h.browser.tabs.group = () => Promise.reject(new Error("grouping unavailable"))

    const result = await h.run()

    expect(result.tabId).toBeDefined()
    expect(h.session.state?.groupId).toBeNull()
    expect((await h.browser.tabs.get(result.tabId as number)).groupId).toBeUndefined()
  })

  test("keeps the group id when renaming the new group fails, and retries the rename later", async () => {
    const h = harness()
    const tabGroups = h.browser.tabGroups as NonNullable<Browser["tabGroups"]>
    const originalUpdate = tabGroups.update
    tabGroups.update = () => Promise.reject(new Error("rename unavailable"))

    const first = await h.run()
    const groupId = (await h.browser.tabs.get(first.tabId as number)).groupId
    expect(typeof groupId).toBe("number")
    expect(h.session.state?.groupId).toBe(groupId as number)
    expect(await tabGroups.query({ title: "firefox-ctl" })).toEqual([])

    // a later tab still joins the same group instead of starting a new one,
    // and the still-untitled group gets its firefox-ctl title on this next call
    tabGroups.update = originalUpdate
    const second = await h.run()
    expect((await h.browser.tabs.get(second.tabId as number)).groupId).toBe(groupId as number)
    const groups = await tabGroups.query({ title: "firefox-ctl" })
    expect(groups.map((group) => group.id)).toEqual([groupId as number])
  })
})
