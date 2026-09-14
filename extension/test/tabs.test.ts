import { describe, expect, test } from "bun:test"

import { AttachedTabs } from "../src/attached"
import type { Tab } from "../src/browser"
import { CaptureLocks } from "../src/capture-locks"
import type { HandlerDeps } from "../src/dispatch"
import {
  closeTab,
  closeWindow,
  getActiveTab,
  getTabs,
  navigate,
  resolveTargetTab,
} from "../src/handlers/tabs"
import { NetworkTracker } from "../src/network"
import type { JsonObject } from "../src/protocol"
import { commandContext } from "../src/protocol"
import { waitForPageReady } from "../src/readiness"
import { Session } from "../src/session"
import { FakeBrowser, FakeEnvironment } from "./fakes"
import errors from "./fixtures/errors.json"
import closeTabFixture from "./fixtures/results/closeTab.json"
import closeTabAttachedFixture from "./fixtures/results/closeTab-attached.json"
import closeWindowFixture from "./fixtures/results/closeWindow.json"
import closeWindowAdoptedFixture from "./fixtures/results/closeWindow-adopted.json"
import getActiveTabFixture from "./fixtures/results/getActiveTab.json"
import getTabsFixture from "./fixtures/results/getTabs.json"
import getTabsEmptyFixture from "./fixtures/results/getTabs-empty.json"
import navigateFixture from "./fixtures/results/navigate.json"

interface Page {
  url: string
  title: string
}

interface Harness {
  browser: FakeBrowser
  session: Session
  attached: AttachedTabs
  deps: HandlerDeps
  navigate(params?: JsonObject): Promise<JsonObject>
  activeTab(): Promise<JsonObject | null>
  tabs(): Promise<JsonObject>
  closeTab(params?: JsonObject): Promise<JsonObject>
  closeWindow(): Promise<JsonObject>
}

function harness(browser = new FakeBrowser()): Harness {
  const env = new FakeEnvironment({ now: 1000 })
  const session = new Session(browser, env)
  const attached = new AttachedTabs(browser, env)
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
    deps,
    navigate: async (params: JsonObject = {}) => (await navigate(params, deps)) as JsonObject,
    activeTab: async () => (await getActiveTab({}, deps)) as JsonObject | null,
    tabs: async () => (await getTabs({}, deps)) as JsonObject,
    closeTab: async (params: JsonObject = {}) => (await closeTab(params, deps)) as JsonObject,
    closeWindow: async () => (await closeWindow({}, deps)) as JsonObject,
  }
}

/** A managed window whose pool holds one tab per page, the last one active. */
function pool(h: Harness, pages: Page[], options: { adopted?: boolean } = {}): number[] {
  const windowId = 1
  h.browser.addWindow({ id: windowId, focused: true })
  h.browser.currentWindowId = windowId
  const tabs = pages.map((page, index) => {
    const tabId = index + 1
    h.browser.addTab({
      id: tabId,
      windowId,
      index,
      url: page.url,
      title: page.title,
      active: index === pages.length - 1,
      pinned: false,
      incognito: false,
    })
    return tabId
  })
  h.session.state = {
    windowId,
    tabs: [...tabs],
    createdAt: 1000,
    groupId: null,
    isPrivate: false,
    adopted: options.adopted ?? false,
  }
  h.session.activeTabId = tabs[tabs.length - 1] ?? null
  return tabs
}

/** A tab in a window firefox-ctl does not manage. */
async function userTab(h: Harness, page: Page): Promise<number> {
  const window = await h.browser.windows.create({ url: page.url })
  const tab = window.tabs?.[0] as Tab
  tab.title = page.title
  return tab.id as number
}

describe("resolveTargetTab", () => {
  test("returns a pool tab named by an explicit tabId", async () => {
    const h = harness()
    const ids = pool(h, [{ url: "https://example.com/", title: "Example Domain" }])

    const tab = await resolveTargetTab(h.deps, { tabId: ids[0] as number })

    expect(tab.id).toBe(ids[0] as number)
  })

  test("returns a plain user tab without requiring a session", async () => {
    const h = harness()
    const tabId = await userTab(h, { url: "https://mozilla.org/", title: "Mozilla" })

    const tab = await resolveTargetTab(h.deps, { tabId })

    expect(tab.id).toBe(tabId)
    expect(h.session.state).toBeNull()
  })

  test("returns an attached tab", async () => {
    const h = harness()
    const tabId = await userTab(h, { url: "https://mozilla.org/", title: "Mozilla" })
    await h.attached.add(tabId, false)

    const tab = await resolveTargetTab(h.deps, { tabId })

    expect(tab.id).toBe(tabId)
  })

  test("reports a closed tab and forgets it when it was attached", async () => {
    const h = harness()
    const tabId = await userTab(h, { url: "https://mozilla.org/", title: "Mozilla" })
    await h.attached.add(tabId, false)
    await h.browser.tabs.remove(tabId)

    await expect(resolveTargetTab(h.deps, { tabId })).rejects.toThrow(
      errors.tabClosed.replace("<id>", String(tabId)),
    )
    expect(h.attached.has(tabId)).toBe(false)
  })

  test("reports a tabId that never existed", async () => {
    const h = harness()

    await expect(resolveTargetTab(h.deps, { tabId: 404 })).rejects.toThrow(
      errors.tabClosed.replace("<id>", "404"),
    )
  })

  test("rejects a tabId that is not a positive integer", async () => {
    const h = harness()

    for (const tabId of [0, -1, 1.5, "2"]) {
      await expect(resolveTargetTab(h.deps, { tabId } as JsonObject)).rejects.toThrow(
        errors.attachInvalidTabId,
      )
    }
  })

  test("falls back to the session's active tab", async () => {
    const h = harness()
    const ids = pool(h, [
      { url: "https://example.com/", title: "Example Domain" },
      { url: "https://example.org/", title: "Example Org" },
    ])

    const tab = await resolveTargetTab(h.deps, {})

    expect(tab.id).toBe(ids[1] as number)
  })

  test("reports the lost session when no tabId is given", async () => {
    const h = harness()

    await expect(resolveTargetTab(h.deps, {})).rejects.toThrow(errors.sessionLost)
  })
})

describe("navigate", () => {
  test("navigates the tab named by tabId and matches the fixture", async () => {
    const h = harness()
    const ids = pool(h, [
      { url: "https://example.org/", title: "Example Org" },
      { url: "https://example.com/", title: "Example Domain" },
    ])

    const result = await h.navigate({ tabId: ids[1] as number, url: "https://example.com/about" })

    expect(result).toEqual(navigateFixture)
    expect((await h.browser.tabs.get(ids[1] as number)).url).toBe("https://example.com/about")
  })

  test("navigates the session's active tab without a tabId", async () => {
    const h = harness()
    const ids = pool(h, [
      { url: "https://example.com/", title: "Example Domain" },
      { url: "https://example.org/", title: "Example Org" },
    ])

    const result = await h.navigate({ url: "https://mozilla.org/" })

    expect(result.tabId).toBe(ids[1] as number)
    expect(result.navigated).toBe(true)
    expect((await h.browser.tabs.get(ids[0] as number)).url).toBe("https://example.com/")
  })

  test("requires a url", async () => {
    const h = harness()
    pool(h, [{ url: "https://example.com/", title: "Example Domain" }])

    await expect(h.navigate({})).rejects.toThrow(errors.navigateMissingUrl)
    await expect(h.navigate({ url: "" })).rejects.toThrow(errors.navigateMissingUrl)
  })
})

describe("getActiveTab", () => {
  test("reports the active tab of the current window", async () => {
    const h = harness()
    pool(h, [
      { url: "https://example.org/", title: "Example Org" },
      { url: "https://example.com/", title: "Example Domain" },
    ])

    expect(await h.activeTab()).toEqual(getActiveTabFixture)
  })

  test("returns null when no window has an active tab", async () => {
    const h = harness()
    h.browser.currentWindowId = 99

    expect(await h.activeTab()).toBeNull()
  })

  test("hands an adopted window's user tab to navigate without touching the pool", async () => {
    const h = harness()
    const ids = pool(h, [{ url: "https://example.com/", title: "Example Domain" }], {
      adopted: true,
    })
    const user = await h.browser.tabs.create({
      windowId: 1,
      url: "https://mozilla.org/",
      active: true,
    })
    user.title = "Mozilla"

    const active = (await h.activeTab()) as JsonObject
    expect(active.tabId).toBe(user.id as number)

    const result = await h.navigate({
      tabId: user.id as number,
      url: "https://mozilla.org/about/",
    })

    expect(result.tabId).toBe(user.id as number)
    expect(h.session.state?.tabs).toEqual(ids)
  })
})

describe("getTabs", () => {
  test("lists the pool and flags a tab that vanished", async () => {
    const h = harness()
    const ids = pool(h, [
      { url: "https://example.com/", title: "Example Domain" },
      { url: "https://example.org/", title: "Example Org" },
    ])
    // dropped behind the session's back, so the pool entry outlives the tab
    h.browser.removeTab(ids[1] as number)
    h.session.state = {
      windowId: 1,
      tabs: ids,
      createdAt: 1000,
      groupId: null,
      isPrivate: false,
      adopted: false,
    }

    expect(await h.tabs()).toEqual(getTabsFixture as unknown as JsonObject)
  })

  test("reports an empty pool when there is no session", async () => {
    const h = harness()

    expect(await h.tabs()).toEqual(getTabsEmptyFixture)
  })

  test("keeps tabCount consistent with tabs when the pool changes mid-describe", async () => {
    const h = harness()
    const ids = pool(h, [
      { url: "https://example.com/", title: "Example Domain" },
      { url: "https://example.org/", title: "Example Org" },
    ])
    const originalGet = h.browser.tabs.get
    let releaseFirst: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    h.browser.tabs.get = async (tabId: number) => {
      if (tabId === ids[0]) {
        await gate
      }
      return originalGet(tabId)
    }

    const pending = h.tabs()
    // a concurrent closeTab mutates the pool while describePoolTab(ids[0]) is still in flight
    h.session.state?.tabs.splice(0, 1)
    releaseFirst()
    const result = await pending

    expect(result.tabCount).toBe(2)
    expect((result.tabs as unknown[]).length).toBe(2)
  })
})

describe("closeTab", () => {
  test("closes a pool tab, re-points the active tab and matches the fixture", async () => {
    const h = harness()
    const ids = pool(h, [
      { url: "https://example.com/", title: "Example Domain" },
      { url: "https://example.org/", title: "Example Org" },
    ])
    h.session.activeTabId = ids[0] as number

    const result = await h.closeTab({ tabId: ids[0] as number })

    expect(result).toEqual(closeTabFixture)
    expect(h.session.state?.tabs).toEqual([ids[1] as number])
    expect(h.session.activeTabId).toBe(ids[1] as number)
    await expect(h.browser.tabs.get(ids[0] as number)).rejects.toThrow("Invalid tab ID")
  })

  test("clears the active tab when the pool empties", async () => {
    const h = harness()
    const ids = pool(h, [{ url: "https://example.com/", title: "Example Domain" }])

    const result = await h.closeTab({ tabId: ids[0] as number })

    expect(result.tabCount).toBe(0)
    expect(h.session.activeTabId).toBeNull()
  })

  test("closes an attached user tab and forgets it", async () => {
    const h = harness()
    pool(h, [
      { url: "https://example.com/", title: "Example Domain" },
      { url: "https://example.org/", title: "Example Org" },
    ])
    const tabId = await userTab(h, { url: "https://mozilla.org/", title: "Mozilla" })
    await h.attached.add(tabId, false)

    const result = await h.closeTab({ tabId })

    expect(result).toEqual(closeTabAttachedFixture)
    expect(h.attached.has(tabId)).toBe(false)
    await expect(h.browser.tabs.get(tabId)).rejects.toThrow("Invalid tab ID")
  })

  test("lists the available ids for a tab outside the pool", async () => {
    const h = harness()
    const ids = pool(h, [
      { url: "https://example.com/", title: "Example Domain" },
      { url: "https://example.org/", title: "Example Org" },
    ])
    const tabId = await userTab(h, { url: "https://mozilla.org/", title: "Mozilla" })

    await expect(h.closeTab({ tabId })).rejects.toThrow(
      errors.closeTabUnknown.replace("<id>", String(tabId)).replace("<ids>", ids.join(", ")),
    )
  })

  test("requires a tabId and a session", async () => {
    const h = harness()

    await expect(h.closeTab({})).rejects.toThrow(errors.detachMissingTabId)
    await expect(h.closeTab({ tabId: null })).rejects.toThrow(errors.detachMissingTabId)
    await expect(h.closeTab({ tabId: "3" } as JsonObject)).rejects.toThrow(
      errors.attachInvalidTabId,
    )
    await expect(h.closeTab({ tabId: 3 })).rejects.toThrow(errors.closeTabNoSession)
  })
})

describe("closeWindow", () => {
  test("removes a dedicated window and clears the session", async () => {
    const h = harness()
    pool(h, [
      { url: "https://example.com/", title: "Example Domain" },
      { url: "https://example.org/", title: "Example Org" },
    ])

    const result = await h.closeWindow()

    expect(result).toEqual(closeWindowFixture)
    expect(h.session.state).toBeNull()
    expect(h.session.activeTabId).toBeNull()
    await expect(h.browser.windows.get(1)).rejects.toThrow("Invalid window ID")
  })

  test("keeps an adopted window and closes only the pool tabs", async () => {
    const h = harness()
    const ids = pool(
      h,
      [
        { url: "https://example.com/", title: "Example Domain" },
        { url: "https://example.org/", title: "Example Org" },
      ],
      { adopted: true },
    )
    h.browser.addTab({
      id: 9,
      windowId: 1,
      index: 2,
      url: "https://mozilla.org/",
      title: "Mozilla",
      active: false,
      pinned: false,
      incognito: false,
    })

    const result = await h.closeWindow()

    expect(result).toEqual(closeWindowAdoptedFixture)
    expect(h.session.state).toBeNull()
    expect((await h.browser.windows.get(1)).id).toBe(1)
    expect((await h.browser.tabs.get(9)).id).toBe(9)
    for (const tabId of ids) {
      await expect(h.browser.tabs.get(tabId)).rejects.toThrow("Invalid tab ID")
    }
  })

  test("survives a tab that is already gone in an adopted window", async () => {
    const h = harness()
    const ids = pool(h, [{ url: "https://example.com/", title: "Example Domain" }], {
      adopted: true,
    })
    h.browser.addTab({ id: 9, windowId: 1, index: 1, url: "https://mozilla.org/", active: false })
    h.browser.removeTab(ids[0] as number)

    const result = await h.closeWindow()

    expect(result.closed).toBe(true)
    expect(result.adopted).toBe(true)
  })

  test("reports that there is no window to close", async () => {
    const h = harness()

    await expect(h.closeWindow()).rejects.toThrow(errors.closeWindowNoSession)
  })
})
