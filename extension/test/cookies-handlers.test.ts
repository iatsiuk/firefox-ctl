import { describe, expect, test } from "bun:test"

import { AttachedTabs } from "../src/attached"
import type { Cookie, Tab } from "../src/browser"
import { CaptureLocks } from "../src/capture-locks"
import type { HandlerDeps } from "../src/dispatch"
import { FrameRegistry } from "../src/frames"
import { exportCookies, resolveCookieStore } from "../src/handlers/cookies"
import { NetworkTracker } from "../src/network"
import type { JsonObject } from "../src/protocol"
import { commandContext } from "../src/protocol"
import { waitForPageReady } from "../src/readiness"
import { Session } from "../src/session"
import { FakeBrowser, FakeEnvironment } from "./fakes"

interface Harness {
  browser: FakeBrowser
  deps: HandlerDeps
  session: Session
  run(params?: JsonObject): Promise<JsonObject>
}

/** A managed window whose active tab 1 is in `store`, plus a plain tab 2. */
function harness(tab: Partial<Tab> = { cookieStoreId: "firefox-default" }): Harness {
  const browser = new FakeBrowser()
  const env = new FakeEnvironment({ now: 1000 })
  const session = new Session(browser, env)
  const deps: HandlerDeps = {
    browser,
    env,
    session,
    attached: new AttachedTabs(browser, env),
    network: new NetworkTracker(env),
    captureLocks: new CaptureLocks(),
    frames: new FrameRegistry(env),
    readiness: waitForPageReady,
    ctx: commandContext({}, env),
  }
  browser.addWindow({ id: 1, focused: true })
  browser.currentWindowId = 1
  browser.addTab({
    id: 1,
    windowId: 1,
    index: 0,
    url: "https://example.com/",
    active: true,
    ...tab,
  })
  browser.addTab({
    id: 2,
    windowId: 1,
    index: 1,
    url: "https://other.test/",
    cookieStoreId: "firefox-container-2",
  })
  session.state = {
    windowId: 1,
    tabs: [1],
    createdAt: 1000,
    groupId: null,
    isPrivate: false,
    adopted: false,
  }
  session.activeTabId = 1
  return {
    browser,
    deps,
    session,
    run: async (params = {}) => (await exportCookies(params, deps)) as JsonObject,
  }
}

function cookies(result: JsonObject): Cookie[] {
  return result.cookies as unknown as Cookie[]
}

function names(result: JsonObject): string[] {
  return cookies(result).map((cookie) => cookie.name)
}

describe("resolveCookieStore", () => {
  test("uses the session active tab's store without a storeId", async () => {
    const { deps } = harness({ cookieStoreId: "firefox-container-1" })
    expect(await resolveCookieStore(deps, {})).toBe("firefox-container-1")
  })

  test("uses the store of the tab named by tabId", async () => {
    const { deps } = harness()
    expect(await resolveCookieStore(deps, { tabId: 2 })).toBe("firefox-container-2")
  })

  test("a closed tabId is TAB_CLOSED", async () => {
    const { deps } = harness()
    await expect(resolveCookieStore(deps, { tabId: 9 })).rejects.toThrow(
      "TAB_CLOSED: Tab 9 no longer exists.",
    )
  })

  test("storeId wins over the tab and needs no session", async () => {
    const { deps, session } = harness()
    session.state = null
    session.activeTabId = null
    expect(await resolveCookieStore(deps, { storeId: "firefox-private", tabId: 2 })).toBe(
      "firefox-private",
    )
  })

  test("without a session and a storeId the session error surfaces", async () => {
    const { deps, session } = harness()
    session.state = null
    await expect(resolveCookieStore(deps, {})).rejects.toThrow("Tab session lost")
  })

  test("a tab without cookieStoreId falls back by incognito", async () => {
    const privateTab = harness({ cookieStoreId: undefined, incognito: true })
    expect(await resolveCookieStore(privateTab.deps, {})).toBe("firefox-private")
    const normalTab = harness({ cookieStoreId: undefined, incognito: false })
    expect(await resolveCookieStore(normalTab.deps, {})).toBe("firefox-default")
  })

  test("a storeId that is not a non-empty string is refused", async () => {
    const { deps } = harness()
    for (const storeId of [7, "", true]) {
      await expect(resolveCookieStore(deps, { storeId })).rejects.toThrow(
        "storeId must be a non-empty string.",
      )
    }
  })
})

describe("exportCookies", () => {
  async function seed(browser: FakeBrowser): Promise<void> {
    const jar = browser.cookieJar
    await jar.write({
      url: "https://example.com/",
      name: "sid",
      value: "s1",
      domain: "example.com",
      secure: true,
      httpOnly: true,
      sameSite: "strict",
      expirationDate: 4_000_000_000.25,
    })
    await jar.write({ url: "https://example.com/", name: "b", value: "2", path: "/app" })
    await jar.write({ url: "https://example.com/", name: "a", value: "1", path: "/app" })
    await jar.write({ url: "https://other.test/", name: "o", value: "3" })
    await jar.write({
      url: "https://widget.test/",
      name: "part",
      value: "4",
      secure: true,
      sameSite: "no_restriction",
      partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: false },
    })
    await jar.write({
      url: "https://example.com/",
      name: "elsewhere",
      value: "5",
      storeId: "firefox-container-2",
    })
  }

  test("returns the store, the total and every cookie with its full fields, sorted", async () => {
    const { browser, run } = harness()
    await seed(browser)
    const result = await run()
    expect(result.store).toBe("firefox-default")
    expect(result.total).toBe(5)
    expect(
      cookies(result).map((cookie) => `${cookie.domain} ${cookie.path} ${cookie.name}`),
    ).toEqual([
      ".example.com / sid",
      "example.com /app a",
      "example.com /app b",
      "other.test / o",
      "widget.test / part",
    ])
    expect(cookies(result)[0]).toEqual({
      name: "sid",
      value: "s1",
      domain: ".example.com",
      hostOnly: false,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "strict",
      session: false,
      expirationDate: 4_000_000_000.25,
      storeId: "firefox-default",
      firstPartyDomain: "",
      partitionKey: null,
    })
  })

  test("asks for every partition and first-party domain in the resolved store", async () => {
    const { browser, run } = harness()
    await run({ url: "https://example.com/app", domain: "example.com", name: "a" })
    expect(browser.cookieJar.queries).toEqual([
      {
        url: "https://example.com/app",
        domain: "example.com",
        name: "a",
        storeId: "firefox-default",
        partitionKey: {},
        firstPartyDomain: null,
      },
    ])
  })

  test("filters narrow the result", async () => {
    const { browser, run } = harness()
    await seed(browser)
    expect(names(await run({ domain: "other.test" }))).toEqual(["o"])
    expect(names(await run({ name: "a" }))).toEqual(["a"])
    expect(names(await run({ url: "https://example.com/app/x" }))).toEqual(["sid", "a", "b"])
    const none = await run({ name: "missing" })
    expect(none.total).toBe(0)
    expect(none.cookies).toEqual([])
  })

  test("includes partitioned cookies with their partition key", async () => {
    const { browser, run } = harness()
    await seed(browser)
    const [part] = cookies(await run({ name: "part" }))
    expect(part?.partitionKey).toEqual({
      topLevelSite: "https://example.com",
      hasCrossSiteAncestor: false,
    })
  })

  test("reads the store of another tab or an explicit storeId", async () => {
    const { browser, run } = harness()
    await seed(browser)
    const byTab = await run({ tabId: 2 })
    expect(byTab.store).toBe("firefox-container-2")
    expect(names(byTab)).toEqual(["elsewhere"])
    const byStore = await run({ storeId: "firefox-container-2" })
    expect(names(byStore)).toEqual(["elsewhere"])
  })

  test("a private store without incognito access surfaces Firefox's error", async () => {
    const { browser, run } = harness({ cookieStoreId: "firefox-private", incognito: true })
    browser.allowedIncognitoAccess = false
    await expect(run()).rejects.toThrow(
      "Extension disallowed access to the private cookies storeId.",
    )
  })

  test("a filter of the wrong type is refused before Firefox is asked", async () => {
    const { browser, run } = harness()
    await expect(run({ domain: 7 })).rejects.toThrow("domain must be a string.")
    expect(browser.cookieJar.queries).toEqual([])
  })
})
