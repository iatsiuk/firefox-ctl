import { describe, expect, test } from "bun:test"

import { AttachedTabs } from "../src/attached"
import type { Cookie, CookieSetDetails, Tab } from "../src/browser"
import { CaptureLocks } from "../src/capture-locks"
import { sortCookies } from "../src/cookies"
import type { HandlerDeps } from "../src/dispatch"
import { FrameRegistry } from "../src/frames"
import {
  deleteCookies,
  exportCookies,
  importCookies,
  resolveCookieStore,
  setCookie,
} from "../src/handlers/cookies"
import { HarRecorder } from "../src/har-recorder"
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
  set(params: JsonObject): Promise<JsonObject>
  del(params: JsonObject): Promise<JsonObject>
  imp(params: JsonObject): Promise<JsonObject>
}

/** A managed window whose active tab 1 is in `store`, plus a plain tab 2. */
function harness(tab: Partial<Tab> = { cookieStoreId: "firefox-default" }): Harness {
  const browser = new FakeBrowser()
  const env = new FakeEnvironment({ now: 1000 })
  // the jar expires cookies on the same clock the handlers read
  browser.cookieJar.now = () => env.now() / 1000
  const session = new Session(browser, env)
  const deps: HandlerDeps = {
    browser,
    env,
    session,
    attached: new AttachedTabs(browser, env),
    network: new NetworkTracker(env),
    captureLocks: new CaptureLocks(),
    frames: new FrameRegistry(env),
    har: new HarRecorder(env),
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
    set: async (params) => (await setCookie(params, deps)) as JsonObject,
    del: async (params) => (await deleteCookies(params, deps)) as JsonObject,
    imp: async (params) => (await importCookies(params, deps)) as JsonObject,
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
      partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: true },
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
      hasCrossSiteAncestor: true,
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

describe("setCookie", () => {
  function stored(result: JsonObject): Cookie {
    return result.cookie as unknown as Cookie
  }

  test("sets a cookie from url, name and value in the resolved store", async () => {
    const { browser, set } = harness()
    const result = await set({ url: "https://example.com/", name: "sid", value: "s1" })
    expect(result.store).toBe("firefox-default")
    expect(browser.cookieSets).toEqual([
      {
        url: "https://example.com/",
        name: "sid",
        value: "s1",
        path: "/",
        storeId: "firefox-default",
      },
    ])
    expect(stored(result)).toEqual({
      name: "sid",
      value: "s1",
      domain: "example.com",
      hostOnly: true,
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "unspecified",
      session: true,
      storeId: "firefox-default",
      firstPartyDomain: "",
      partitionKey: null,
    })
  })

  test("the cookie comes from a re-query, never from the set answer", async () => {
    const { browser, set } = harness()
    browser.cookieSetHandler = async (details) => {
      await browser.writeCookie(details)
      return null
    }
    const result = await set({ url: "https://example.com/", name: "sid", value: "s1" })
    expect(stored(result).value).toBe("s1")
    expect(browser.cookieQueries).toEqual([
      { name: "sid", storeId: "firefox-default", partitionKey: {}, firstPartyDomain: null },
    ])
  })

  test("writes into the store of another tab or an explicit storeId", async () => {
    const { set } = harness()
    const byTab = await set({ url: "https://example.com/", name: "a", value: "1", tabId: 2 })
    expect(byTab.store).toBe("firefox-container-2")
    expect(stored(byTab).storeId).toBe("firefox-container-2")
    const byStore = await set({
      url: "https://example.com/",
      name: "a",
      value: "1",
      storeId: "firefox-container-3",
    })
    expect(stored(byStore).storeId).toBe("firefox-container-3")
  })

  test("without --path the path is the url directory with its trailing slash", async () => {
    const { browser, set } = harness()
    for (const [url, path] of [
      ["https://example.com/app/login", "/app/"],
      ["https://example.com/app/", "/app/"],
      ["https://example.com/app", "/"],
    ] as const) {
      const result = await set({ url, name: "sid", value: "1" })
      expect(browser.cookieSets.at(-1)?.path).toBe(path)
      expect(stored(result)).toMatchObject({ path, value: "1" })
    }
  })

  test("an empty --domain with --url sets a host-only cookie", async () => {
    const { browser, set } = harness()
    const result = await set({ url: "https://example.com/", name: "sid", value: "1", domain: "" })
    expect(browser.cookieSets[0]?.domain).toBeUndefined()
    expect(stored(result)).toMatchObject({ domain: "example.com", hostOnly: true })
    await expect(set({ domain: "", name: "sid", value: "1" })).rejects.toThrow(
      "setCookie needs --url or --domain.",
    )
  })

  test("a set that leaves an older value in place is an error", async () => {
    const { browser, set } = harness()
    await browser.cookieJar.write({ url: "https://example.com/", name: "sid", value: "old" })
    browser.cookieSetHandler = () => Promise.resolve(null)
    await expect(set({ url: "https://example.com/", name: "sid", value: "new" })).rejects.toThrow(
      "Firefox did not store cookie sid.",
    )
  })

  test("a set over an existing cookie returns the new value", async () => {
    const { set } = harness()
    await set({ url: "https://example.com/", name: "sid", value: "old" })
    const result = await set({ url: "https://example.com/", name: "sid", value: "new" })
    expect(stored(result).value).toBe("new")
  })

  test("an expirationDate of exactly now deletes, one just after keeps", async () => {
    const { set } = harness()
    const url = "https://example.com/"
    expect(await set({ url, name: "sid", value: "1", expirationDate: 1 })).toEqual({
      store: "firefox-default",
      cookie: null,
    })
    const kept = await set({ url, name: "sid", value: "1", expirationDate: 1.001 })
    expect(stored(kept).expirationDate).toBe(1.001)
  })

  test("domain without url derives the url, https when secure", async () => {
    const { browser, set } = harness()
    const plain = await set({ domain: "example.com", name: "a", value: "1" })
    expect(browser.cookieSets[0]?.url).toBe("http://example.com/")
    expect(browser.cookieSets[0]?.domain).toBe("example.com")
    expect(stored(plain).domain).toBe(".example.com")
    expect(stored(plain).hostOnly).toBe(false)
    await set({ domain: ".example.com", name: "b", value: "2", secure: true })
    expect(browser.cookieSets[1]?.url).toBe("https://example.com/")
  })

  test("path, secure, httpOnly, sameSite and a fractional expirationDate pass through", async () => {
    const { browser, set } = harness()
    const result = await set({
      url: "https://example.com/",
      name: "sid",
      value: "s1",
      path: "/app",
      secure: true,
      httpOnly: true,
      sameSite: "unspecified",
      expirationDate: 4_000_000_000.75,
    })
    expect(browser.cookieSets[0]).toEqual({
      url: "https://example.com/",
      name: "sid",
      value: "s1",
      path: "/app",
      secure: true,
      httpOnly: true,
      sameSite: "unspecified",
      expirationDate: 4_000_000_000.75,
      storeId: "firefox-default",
    })
    expect(stored(result)).toMatchObject({
      path: "/app",
      secure: true,
      httpOnly: true,
      sameSite: "unspecified",
      session: false,
      expirationDate: 4_000_000_000.75,
    })
    for (const sameSite of ["lax", "strict", "no_restriction"] as const) {
      const other = await set({ url: "https://example.com/", name: "s", secure: true, sameSite })
      expect(stored(other).sameSite).toBe(sameSite)
    }
  })

  test("no expirationDate makes a session cookie", async () => {
    const { browser, set } = harness()
    const result = await set({ url: "https://example.com/", name: "sid", value: "s1" })
    expect("expirationDate" in (browser.cookieSets[0] ?? {})).toBe(false)
    expect(stored(result).session).toBe(true)
  })

  test("an empty name sets an unnamed cookie", async () => {
    const { set } = harness()
    const result = await set({ url: "https://example.com/", name: "", value: "v" })
    expect(stored(result).name).toBe("")
    expect(stored(result).value).toBe("v")
  })

  test("firstPartyDomain and partitionKey pass through unchanged", async () => {
    const { browser, set } = harness()
    const fpi = await set({
      url: "https://example.com/",
      name: "f",
      value: "1",
      firstPartyDomain: "example.com",
    })
    expect(browser.cookieSets[0]?.firstPartyDomain).toBe("example.com")
    expect(stored(fpi).firstPartyDomain).toBe("example.com")
    const partitionKey = { topLevelSite: "https://top.test", hasCrossSiteAncestor: true }
    const part = await set({
      url: "https://widget.test/",
      name: "p",
      value: "1",
      secure: true,
      partitionKey,
    })
    expect(browser.cookieSets[1]?.partitionKey).toEqual(partitionKey)
    expect(stored(part).partitionKey).toEqual(partitionKey)
    await set({ url: "https://widget.test/", name: "q", value: "1", partitionKey: null })
    expect("partitionKey" in (browser.cookieSets[2] ?? {})).toBe(false)
  })

  test("malformed params are refused before Firefox is asked", async () => {
    const { browser, set } = harness()
    const cases: [JsonObject, string][] = [
      [{ url: "https://example.com/" }, "name is required."],
      [{ url: "https://example.com/", name: 7 }, "name must be a string."],
      [{ name: "sid", value: "1" }, "setCookie needs --url or --domain."],
      [
        { url: "https://example.com/", name: "sid", sameSite: "none" },
        "sameSite must be one of no_restriction, lax, strict, unspecified.",
      ],
      [{ url: "https://example.com/", name: "sid", value: 1 }, "value must be a string."],
      [{ url: "https://example.com/", name: "sid", secure: "yes" }, "secure must be a boolean."],
      [
        { url: "https://example.com/", name: "sid", expirationDate: "soon" },
        "expirationDate must be a number.",
      ],
      [
        { url: "https://example.com/", name: "sid", partitionKey: "top" },
        "partitionKey must be an object or null.",
      ],
    ]
    for (const [params, message] of cases) {
      await expect(set(params)).rejects.toThrow(message)
    }
    expect(browser.cookieSets).toEqual([])
    expect(browser.cookieQueries).toEqual([])
  })

  test("a Firefox rejection is a plain error naming the cookie", async () => {
    const { set } = harness()
    await expect(
      set({ url: "http://example.com/", name: "sid", value: "1", sameSite: "no_restriction" }),
    ).rejects.toThrow(
      "Cannot set cookie sid: Cookie “sid” rejected because it has the “SameSite=None” attribute",
    )
  })

  test("a cookie missing from the re-query is an error", async () => {
    const { browser, set } = harness()
    browser.cookieSetHandler = () => Promise.resolve(null)
    await expect(set({ url: "https://example.com/", name: "sid", value: "1" })).rejects.toThrow(
      "Firefox did not store cookie sid.",
    )
    await expect(
      set({ url: "https://example.com/", name: "sid", value: "1", expirationDate: 4_000_000_000 }),
    ).rejects.toThrow("Firefox did not store cookie sid.")
  })

  test("a past expirationDate deletes the cookie and returns null", async () => {
    const { browser, set } = harness()
    await browser.cookieJar.write({ url: "https://example.com/", name: "sid", value: "old" })
    const result = await set({
      url: "https://example.com/",
      name: "sid",
      value: "",
      expirationDate: 0.5,
    })
    expect(result).toEqual({ store: "firefox-default", cookie: null })
    expect(await browser.cookieJar.getAll({ storeId: "firefox-default" })).toEqual([])
  })

  test("a host-only cookie under an older parent-domain one is returned, not the parent", async () => {
    const { browser, set } = harness()
    await browser.cookieJar.write({
      url: "https://example.com/",
      name: "sid",
      value: "parent",
      domain: "example.com",
    })
    const result = await set({ url: "https://sub.example.com/", name: "sid", value: "child" })
    expect(stored(result)).toMatchObject({
      domain: "sub.example.com",
      hostOnly: true,
      value: "child",
    })
  })

  test("a path other than the url path returns the stored cookie, not null", async () => {
    const { set } = harness()
    const result = await set({ url: "https://example.com/", name: "sid", value: "1", path: "/app" })
    expect(stored(result)).toMatchObject({ path: "/app", value: "1" })
  })

  test("an IP host is stored host-only and returned", async () => {
    const { set } = harness()
    const cases: [JsonObject, string][] = [
      [{ url: "http://[::1]/" }, "[::1]"],
      [{ domain: "::1" }, "[::1]"],
      [{ domain: "127.0.0.1" }, "127.0.0.1"],
      [{ url: "http://127.0.0.1/", domain: "127.0.0.1" }, "127.0.0.1"],
    ]
    for (const [params, domain] of cases) {
      const result = await set({ ...params, name: "ip", value: "1" })
      expect(stored(result)).toMatchObject({ domain, hostOnly: true, value: "1" })
    }
  })

  test("a subdomain top-level site is stored and returned as its site", async () => {
    const { set } = harness()
    const result = await set({
      url: "https://widget.example.com/",
      name: "p",
      value: "1",
      secure: true,
      partitionKey: { topLevelSite: "https://shop.example.com", hasCrossSiteAncestor: false },
    })
    expect(stored(result).partitionKey).toEqual({
      topLevelSite: "https://example.com",
      hasCrossSiteAncestor: false,
    })
  })

  test("a partition key of another site is returned with a cross-site ancestor", async () => {
    const { set } = harness()
    const result = await set({
      url: "https://widget.test/",
      name: "p",
      value: "1",
      secure: true,
      partitionKey: { topLevelSite: "https://example.com" },
    })
    expect(stored(result).partitionKey).toEqual({
      topLevelSite: "https://example.com",
      hasCrossSiteAncestor: true,
    })
  })

  test("a partition key of another site without a cross-site ancestor is rejected", async () => {
    const { browser, set } = harness()
    const params = {
      url: "https://widget.test/",
      name: "p",
      value: "1",
      secure: true,
      partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: false },
    }
    await expect(set(params)).rejects.toThrow(
      "Cannot set cookie p: Invalid value for 'partitionKey' attribute",
    )
    expect(browser.cookieQueries).toEqual([])
  })

  test("re-queries the site of the top-level url and returns the cookie written", async () => {
    const { browser, set } = harness()
    // a site of its own, so the ancestor bit is inferred: the host is inside it
    const partitionKey = { topLevelSite: "https://com" }
    await browser.cookieJar.write({
      url: "https://widget.example.com/",
      name: "p",
      value: "1",
      partitionKey,
    })
    const result = await set({
      url: "https://widget.example.com/",
      name: "p",
      value: "1",
      partitionKey: { topLevelSite: "https://shop.example.com", hasCrossSiteAncestor: false },
    })
    expect(stored(result).partitionKey).toEqual({
      topLevelSite: "https://example.com",
      hasCrossSiteAncestor: false,
    })
    expect(browser.cookieQueries).toEqual([
      {
        name: "p",
        storeId: "firefox-default",
        partitionKey: { topLevelSite: "https://shop.example.com" },
        firstPartyDomain: null,
      },
    ])
  })
})

describe("deleteCookies", () => {
  const future = 4_000_000_000

  async function seed(browser: FakeBrowser): Promise<void> {
    const jar = browser.cookieJar
    await jar.write({ url: "https://example.com/", name: "sid", value: "1", domain: "example.com" })
    await jar.write({ url: "https://example.com/", name: "pref", value: "2", path: "/app" })
    await jar.write({
      url: "https://example.com/",
      name: "part",
      value: "3",
      secure: true,
      partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: true },
    })
    await jar.write({
      url: "https://example.com/",
      name: "fpi",
      value: "4",
      firstPartyDomain: "example.com",
      expirationDate: future,
    })
    await jar.write({ url: "https://other.test/", name: "o", value: "5" })
    await jar.write({
      url: "https://example.com/",
      name: "elsewhere",
      value: "6",
      storeId: "firefox-container-2",
    })
  }

  async function left(browser: FakeBrowser, storeId = "firefox-default"): Promise<string[]> {
    const found = await browser.cookieJar.getAll({
      storeId,
      partitionKey: {},
      firstPartyDomain: null,
    })
    return found.map((cookie) => `${cookie.domain} ${cookie.name}`).sort()
  }

  test("removes every match in the resolved store, partitioned and first-party ones too", async () => {
    const { browser, del } = harness()
    await seed(browser)
    const result = await del({ domain: "example.com" })
    expect(result).toEqual({
      store: "firefox-default",
      deleted: 4,
      cookies: [
        { name: "sid", domain: ".example.com", path: "/" },
        { name: "fpi", domain: "example.com", path: "/" },
        { name: "part", domain: "example.com", path: "/" },
        { name: "pref", domain: "example.com", path: "/app" },
      ],
      failed: [],
    })
    expect(await left(browser)).toEqual(["other.test o"])
    expect(await left(browser, "firefox-container-2")).toEqual(["example.com elsewhere"])
  })

  test("queries the filter, expires each match by identity, then re-queries", async () => {
    const { browser, del } = harness()
    await seed(browser)
    await del({ url: "https://example.com/app/x", name: "pref" })
    const query = {
      url: "https://example.com/app/x",
      name: "pref",
      storeId: "firefox-default",
      partitionKey: {},
      firstPartyDomain: null,
    }
    expect(browser.cookieQueries).toEqual([query, query])
    expect(browser.cookieSets.at(-1)).toEqual({
      url: "http://example.com/",
      name: "pref",
      value: "",
      path: "/app",
      secure: false,
      httpOnly: false,
      sameSite: "unspecified",
      expirationDate: 0,
      storeId: "firefox-default",
      firstPartyDomain: "",
    })
  })

  test("all empties the store and leaves other stores alone", async () => {
    const { browser, del } = harness()
    await seed(browser)
    const result = await del({ all: true })
    expect(result.deleted).toBe(5)
    expect(result.failed).toEqual([])
    expect(await left(browser)).toEqual([])
    expect(await left(browser, "firefox-container-2")).toEqual(["example.com elsewhere"])
  })

  test("works on the store of another tab or an explicit storeId", async () => {
    const { browser, del } = harness()
    await seed(browser)
    const byTab = await del({ name: "elsewhere", tabId: 2 })
    expect(byTab.store).toBe("firefox-container-2")
    expect(byTab.deleted).toBe(1)
    expect(await left(browser, "firefox-container-2")).toEqual([])
    const byStore = await del({ all: true, storeId: "firefox-container-2" })
    expect(byStore).toMatchObject({ store: "firefox-container-2", deleted: 0 })
    expect((await left(browser)).length).toBe(5)
  })

  test("a host-only cookie goes, the parent-domain one with the same name stays", async () => {
    const { browser, del } = harness()
    const jar = browser.cookieJar
    await jar.write({ url: "https://example.com/", name: "sid", value: "p", domain: "example.com" })
    await jar.write({ url: "https://sub.example.com/", name: "sid", value: "c" })
    const result = await del({ domain: "sub.example.com" })
    expect(result.cookies).toEqual([{ name: "sid", domain: "sub.example.com", path: "/" }])
    expect(await left(browser)).toEqual([".example.com sid"])
  })

  test("the parent-domain collision holds under firstPartyDomain and partitionKey", async () => {
    const origins: Partial<CookieSetDetails>[] = [
      { firstPartyDomain: "example.com" },
      { partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: false } },
      { partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: true } },
      { partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: true } },
    ]
    for (const origin of origins) {
      const { browser, del } = harness()
      const jar = browser.cookieJar
      const base = { name: "sid", secure: true, ...origin }
      await jar.write({ ...base, url: "https://example.com/", value: "p", domain: "example.com" })
      await jar.write({ ...base, url: "https://sub.example.com/", value: "c" })
      await jar.write({
        url: "https://example.com/",
        name: "sid",
        value: "plain",
        domain: "example.com",
      })
      const result = await del({ domain: "sub.example.com" })
      expect(result.cookies).toEqual([{ name: "sid", domain: "sub.example.com", path: "/" }])
      expect(browser.cookieSets.at(-1)).toMatchObject(origin)
      const kept = await jar.getAll({ partitionKey: {}, firstPartyDomain: null })
      expect(kept.map((cookie) => cookie.value).sort()).toEqual(["p", "plain"])
    }
  })

  test("an unnamed, an insecure SameSite=None and a secure httpOnly __Host- cookie are deleted", async () => {
    const { browser, del } = harness()
    const jar = browser.cookieJar
    await jar.write({ url: "https://example.com/", name: "", value: "anon" })
    jar.insert({
      name: "legacy",
      value: "1",
      domain: "example.com",
      hostOnly: true,
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "no_restriction",
      session: true,
      storeId: "firefox-default",
      firstPartyDomain: "",
      partitionKey: null,
    })
    await jar.write({
      url: "https://example.com/",
      name: "__Host-sid",
      value: "s",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "strict",
    })
    const result = await del({ domain: "example.com" })
    expect(result.deleted).toBe(3)
    expect(result.failed).toEqual([])
    expect(await left(browser)).toEqual([])
    const unnamed = browser.cookieSets.find((details) => details.name === "")
    expect(unnamed?.value).toBe("x")
    const host = browser.cookieSets.find((details) => details.name === "__Host-sid")
    expect(host).toMatchObject({ url: "https://example.com/", secure: true, httpOnly: true })
    expect("domain" in (host ?? {})).toBe(false)
  })

  test("without a filter or all nothing is removed", async () => {
    const { browser, del } = harness()
    await seed(browser)
    for (const params of [{}, { all: false }, { tabId: 2 }] as JsonObject[]) {
      await expect(del(params)).rejects.toThrow(
        "deleteCookies needs --url, --domain, --name or --all.",
      )
    }
    expect(browser.cookieQueries).toEqual([])
    expect(browser.cookieSets).toEqual([])
  })

  test("malformed params are refused before Firefox is asked", async () => {
    const { browser, del } = harness()
    await expect(del({ all: "yes" })).rejects.toThrow("all must be a boolean.")
    await expect(del({ domain: 7 })).rejects.toThrow("domain must be a string.")
    expect(browser.cookieQueries).toEqual([])
  })

  test("a set rejection lands in failed and the rest are still deleted", async () => {
    const { browser, del } = harness()
    await seed(browser)
    browser.cookieSetHandler = (details) =>
      details.name === "sid" ? Promise.reject(new Error("boom")) : browser.writeCookie(details)
    const result = await del({ domain: "example.com" })
    expect(result.deleted).toBe(3)
    expect(result.failed).toEqual([
      { name: "sid", domain: ".example.com", path: "/", error: "boom" },
    ])
    expect(await left(browser)).toEqual([".example.com sid", "other.test o"])
  })

  test("a cookie still present on the re-query lands in failed even when set resolved", async () => {
    const { browser, del } = harness()
    await seed(browser)
    browser.cookieSetHandler = (details) =>
      details.name === "pref" ? Promise.resolve(null) : browser.writeCookie(details)
    const result = await del({ domain: "example.com" })
    expect(result.deleted).toBe(3)
    expect(result.failed).toEqual([
      {
        name: "pref",
        domain: "example.com",
        path: "/app",
        error: "Firefox kept the cookie.",
      },
    ])
  })

  test("a private store without incognito access surfaces Firefox's error", async () => {
    const { browser, del } = harness({ cookieStoreId: "firefox-private", incognito: true })
    browser.allowedIncognitoAccess = false
    await expect(del({ all: true })).rejects.toThrow(
      "Extension disallowed access to the private cookies storeId.",
    )
  })
})

describe("importCookies", () => {
  const every = { partitionKey: {}, firstPartyDomain: null }

  function entry(fields: Partial<Cookie>): Cookie {
    return {
      name: "sid",
      value: "1",
      domain: "example.com",
      hostOnly: true,
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "unspecified",
      session: true,
      storeId: "firefox-container-2",
      firstPartyDomain: "",
      partitionKey: null,
      ...fields,
    }
  }

  // an export of another store: every field an import must keep
  const exported: Cookie[] = [
    entry({ name: "", value: "anon" }),
    entry({
      name: "sid",
      value: "s1",
      domain: ".example.com",
      hostOnly: false,
      secure: true,
      httpOnly: true,
      sameSite: "strict",
      session: false,
      expirationDate: 4_000_000_000.25,
    }),
    entry({ name: "fpi", firstPartyDomain: "example.com", path: "/app" }),
    entry({
      name: "part",
      domain: "widget.test",
      secure: true,
      sameSite: "no_restriction",
      partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: true },
    }),
  ]

  function withoutStore(cookie: Cookie): Omit<Cookie, "storeId"> {
    const { storeId: _storeId, ...rest } = cookie
    return rest
  }

  async function stored(browser: FakeBrowser, storeId = "firefox-default"): Promise<Cookie[]> {
    return await browser.cookieJar.getAll({ storeId, ...every })
  }

  function exportFile(cookies: Cookie[]): JsonObject {
    return {
      store: "firefox-container-2",
      total: cookies.length,
      cookies: cookies as unknown as JsonObject[],
    }
  }

  test("writes an export into the resolved store and keeps every field", async () => {
    const { browser, imp } = harness()
    const result = await imp(exportFile(exported))
    expect(result).toEqual({ store: "firefox-default", imported: 4, failed: [] })
    const found = await stored(browser)
    expect(found.every((cookie) => cookie.storeId === "firefox-default")).toBe(true)
    expect(sortCookies(found).map(withoutStore)).toEqual(sortCookies(exported).map(withoutStore))
    expect(await stored(browser, "firefox-container-2")).toEqual([])
  })

  test("an IP cookie and a cross-site partition key without its ancestor bit are imported", async () => {
    const { imp } = harness()
    const entries = [
      entry({ name: "v6", domain: "[::1]" }),
      entry({ name: "v4", domain: "127.0.0.1" }),
      entry({
        name: "part",
        domain: "widget.test",
        secure: true,
        partitionKey: { topLevelSite: "https://example.com" },
      }),
    ]
    const result = await imp({ cookies: entries as unknown as JsonObject[] })
    expect(result).toEqual({ store: "firefox-default", imported: 3, failed: [] })
  })

  test("a cross-site partition key without a cross-site ancestor lands in failed", async () => {
    const { imp } = harness()
    const entries = [
      entry({
        name: "part",
        domain: "widget.test",
        secure: true,
        partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: false },
      }),
    ]
    const result = await imp({ cookies: entries as unknown as JsonObject[] })
    expect(result).toEqual({
      store: "firefox-default",
      imported: 0,
      failed: [
        {
          name: "part",
          domain: "widget.test",
          error: "Invalid value for 'partitionKey' attribute",
        },
      ],
    })
  })

  test("entries under two hosts of one site are one cookie, the later wins", async () => {
    const { browser, imp } = harness()
    const part = (top: string) =>
      entry({
        name: "part",
        domain: "widget.example.com",
        secure: true,
        partitionKey: { topLevelSite: top, hasCrossSiteAncestor: false },
      })
    const entries = [part("https://shop.example.com"), part("https://news.example.com")]
    const result = await imp({ cookies: entries as unknown as JsonObject[] })
    expect(result).toEqual({
      store: "firefox-default",
      imported: 1,
      failed: [
        { name: "part", domain: "widget.example.com", error: "overwritten by a later entry." },
      ],
    })
    expect((await stored(browser)).length).toBe(1)
  })

  test("an older cookie under a parent of the site does not count as imported", async () => {
    const { browser, imp } = harness()
    const url = "https://widget.example.com/"
    // a site of its own, so the ancestor bit is inferred: the host is inside it
    const partitionKey = { topLevelSite: "https://com" }
    await browser.cookieJar.write({ url, name: "part", value: "1", secure: true, partitionKey })
    browser.cookieSetHandler = async () => null
    const entries = [
      entry({
        name: "part",
        domain: "widget.example.com",
        secure: true,
        partitionKey: { topLevelSite: "https://shop.example.com", hasCrossSiteAncestor: false },
      }),
    ]
    const result = await imp({ cookies: entries as unknown as JsonObject[] })
    expect(result).toMatchObject({
      imported: 0,
      failed: [{ name: "part", error: "Firefox did not store the cookie." }],
    })
  })

  test("a legacy cookie under the top-level site as given does not count as imported", async () => {
    const { browser, imp } = harness()
    // kept from before the site rule, so the site re-query does not answer it
    const partitionKey = { topLevelSite: "https://shop.example.com", hasCrossSiteAncestor: false }
    const part = entry({ name: "part", domain: "shop.example.com", secure: true, partitionKey })
    browser.cookieJar.insert({ ...part, storeId: "firefox-default" })
    browser.cookieSetHandler = async () => null
    const result = await imp({ cookies: [part] as unknown as JsonObject[] })
    expect(result).toMatchObject({
      imported: 0,
      failed: [{ name: "part", error: "Firefox did not store the cookie." }],
    })
  })

  test("an entry with a subdomain top-level site is imported under its site", async () => {
    const { browser, imp } = harness()
    const entries = [
      entry({
        name: "part",
        domain: "widget.example.com",
        secure: true,
        partitionKey: { topLevelSite: "https://shop.example.com", hasCrossSiteAncestor: false },
      }),
    ]
    const result = await imp({ cookies: entries as unknown as JsonObject[] })
    expect(result).toEqual({ store: "firefox-default", imported: 1, failed: [] })
    const [cookie] = await stored(browser)
    expect(cookie?.partitionKey).toEqual({
      topLevelSite: "https://example.com",
      hasCrossSiteAncestor: false,
    })
  })

  test("sets every entry, then verifies them with one re-query of the store and site", async () => {
    const { browser, imp } = harness()
    const queriesAtSet: number[] = []
    browser.cookieSetHandler = async (details) => {
      queriesAtSet.push(browser.cookieQueries.length)
      await browser.writeCookie(details)
      return null
    }
    const result = await imp({ cookies: exported as unknown as JsonObject[] })
    expect(result.imported).toBe(4)
    expect(queriesAtSet).toEqual([0, 0, 0, 0])
    expect(browser.cookieQueries).toEqual([
      { storeId: "firefox-default", ...every },
      {
        storeId: "firefox-default",
        partitionKey: { topLevelSite: "https://example.com" },
        firstPartyDomain: null,
      },
    ])
    expect(browser.cookieSets.map((details) => details.storeId)).toEqual(
      Array(4).fill("firefox-default"),
    )
  })

  test("a typed storeId moves an export into that store", async () => {
    const { browser, run, imp } = harness()
    const jar = browser.cookieJar
    await jar.write({ url: "https://example.com/", name: "a", value: "1" })
    await jar.write({ url: "https://example.com/", name: "b", value: "2", domain: "example.com" })
    const source = await run()
    const result = await imp({ ...source, storeId: "firefox-private" })
    expect(result).toEqual({ store: "firefox-private", imported: 2, failed: [] })
    const moved = await stored(browser, "firefox-private")
    expect(sortCookies(moved).map(withoutStore)).toEqual(cookies(source).map(withoutStore))
    expect((await stored(browser)).length).toBe(2)
  })

  test("writes into the store of another tab", async () => {
    const { browser, imp } = harness()
    const result = await imp({ cookies: [exported[0]] as unknown as JsonObject[], tabId: 2 })
    expect(result).toMatchObject({ store: "firefox-container-2", imported: 1 })
    expect((await stored(browser, "firefox-container-2")).length).toBe(1)
  })

  test("an empty array imports nothing", async () => {
    const { browser, imp } = harness()
    expect(await imp({ cookies: [] })).toEqual({
      store: "firefox-default",
      imported: 0,
      failed: [],
    })
    expect(browser.cookieSets).toEqual([])
  })

  test("cookies missing or not an array is refused before Firefox is asked", async () => {
    const { browser, imp } = harness()
    await expect(imp({})).rejects.toThrow("cookies is required.")
    for (const value of [{}, "c.json", 3]) {
      await expect(imp({ cookies: value })).rejects.toThrow("cookies must be an array.")
    }
    expect(browser.cookieQueries).toEqual([])
    expect(browser.cookieSets).toEqual([])
  })

  test("bad entries land in failed and the rest are imported", async () => {
    const { browser, imp } = harness({ cookieStoreId: "firefox-default" })
    browser.cookieSetHandler = (details) =>
      details.name === "lost" ? Promise.resolve(null) : browser.writeCookie(details)
    const entries = [
      entry({ name: "ok" }),
      { name: 7, domain: "example.com" },
      "not a cookie",
      entry({ name: "none", sameSite: "no_restriction", secure: false }),
      entry({
        name: "both",
        secure: true,
        firstPartyDomain: "example.com",
        partitionKey: { topLevelSite: "https://top.test" },
      }),
      entry({ name: "lost" }),
      entry({ name: "old", session: false, expirationDate: 0.5 }),
      entry({ name: "ok2", domain: "other.test" }),
    ]
    const result = await imp({ cookies: entries as unknown as JsonObject[] })
    expect(result.imported).toBe(2)
    expect(result.failed).toEqual([
      { name: "", domain: "example.com", error: "name must be a string." },
      { name: "", domain: "", error: "cookie must be an object." },
      {
        name: "none",
        domain: "example.com",
        error:
          "Cookie “none” rejected because it has the “SameSite=None” attribute but is missing the “secure” attribute.",
      },
      {
        name: "both",
        domain: "example.com",
        error: "Partitioned cookies cannot have a 'firstPartyDomain' attribute.",
      },
      { name: "old", domain: "example.com", error: "expired" },
      { name: "lost", domain: "example.com", error: "Firefox did not store the cookie." },
    ])
    expect(browser.cookieSets.some((details) => details.name === "old")).toBe(false)
    expect((await stored(browser)).map((cookie) => cookie.name).sort()).toEqual(["ok", "ok2"])
  })

  test("an entry that leaves an older value in place lands in failed", async () => {
    const { browser, imp } = harness()
    await browser.cookieJar.write({ url: "http://example.com/", name: "sid", value: "old" })
    browser.cookieSetHandler = () => Promise.resolve(null)
    const result = await imp({ cookies: [entry({ value: "new" })] as unknown as JsonObject[] })
    expect(result).toMatchObject({
      imported: 0,
      failed: [{ name: "sid", domain: "example.com", error: "Firefox did not store the cookie." }],
    })
  })

  test("of two entries for one cookie the later is imported, the earlier fails", async () => {
    const { browser, imp } = harness()
    const cookies = [entry({ value: "first" }), entry({ value: "second" })]
    const result = await imp({ cookies: cookies as unknown as JsonObject[] })
    expect(result).toMatchObject({
      imported: 1,
      failed: [{ name: "sid", domain: "example.com", error: "overwritten by a later entry." }],
    })
    expect((await stored(browser)).map((cookie) => cookie.value)).toEqual(["second"])
  })

  test("an expirationDate of exactly now is expired, one just after is imported", async () => {
    const { imp } = harness()
    const cookies = [
      entry({ name: "now", session: false, expirationDate: 1 }),
      entry({ name: "later", session: false, expirationDate: 1.001 }),
    ]
    const result = await imp({ cookies: cookies as unknown as JsonObject[] })
    expect(result).toMatchObject({
      imported: 1,
      failed: [{ name: "now", domain: "example.com", error: "expired" }],
    })
  })

  test("a session entry with a stale expirationDate is still imported", async () => {
    const { browser, imp } = harness()
    const result = await imp({
      cookies: [entry({ session: true, expirationDate: 0.5 })] as unknown as JsonObject[],
    })
    expect(result).toMatchObject({ imported: 1, failed: [] })
    expect((await stored(browser))[0]?.session).toBe(true)
  })

  test("a private store without incognito access surfaces Firefox's error", async () => {
    const { browser, imp } = harness({ cookieStoreId: "firefox-private", incognito: true })
    browser.allowedIncognitoAccess = false
    await expect(imp({ cookies: [] })).rejects.toThrow(
      "Extension disallowed access to the private cookies storeId.",
    )
  })
})
