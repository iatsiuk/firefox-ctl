import { describe, expect, test } from "bun:test"

import type { Cookie } from "../src/browser"
import {
  type CookieEntry,
  cookieFilter,
  cookieUrl,
  expireDetails,
  identityKey,
  isSameSite,
  parseCookieEntry,
  requestedIdentity,
  setDetails,
  sortCookies,
} from "../src/cookies"

function cookie(overrides: Partial<Cookie> = {}): Cookie {
  return {
    name: "sid",
    value: "v",
    domain: ".example.com",
    hostOnly: false,
    path: "/",
    secure: false,
    httpOnly: false,
    sameSite: "lax",
    session: false,
    expirationDate: 4_000_000_000.5,
    storeId: "firefox-default",
    firstPartyDomain: "",
    partitionKey: null,
    ...overrides,
  }
}

function entry(value: Record<string, unknown>): CookieEntry {
  const parsed = parseCookieEntry(value)
  if ("error" in parsed) {
    throw new Error(parsed.error)
  }
  return parsed.entry
}

describe("cookieFilter", () => {
  test("always spans every partition and first-party domain", () => {
    expect(cookieFilter({})).toEqual({ partitionKey: {}, firstPartyDomain: null })
  })

  test("passes url, domain and name through", () => {
    expect(cookieFilter({ url: "https://a.test/", domain: "a.test", name: "", tabId: 3 })).toEqual({
      url: "https://a.test/",
      domain: "a.test",
      name: "",
      partitionKey: {},
      firstPartyDomain: null,
    })
  })

  test.each(["url", "domain", "name"])("rejects a non-string %s", (key) => {
    expect(() => cookieFilter({ [key]: 5 })).toThrow(`${key} must be a string.`)
  })
})

describe("cookieUrl", () => {
  test.each([
    [{ domain: "example.com", secure: false }, "http://example.com/"],
    [{ domain: ".example.com", secure: true }, "https://example.com/"],
    [{ domain: "::1", secure: false }, "http://[::1]/"],
    [{ domain: "[::1]", secure: true }, "https://[::1]/"],
    [{ domain: "a.test" }, "http://a.test/"],
  ])("%o -> %s", (input, url) => {
    expect(cookieUrl(input)).toBe(url)
  })

  test("never carries the cookie path", () => {
    expect(cookieUrl(cookie({ path: "/a?b#c/../d" }))).toBe("http://example.com/")
  })
})

describe("isSameSite", () => {
  test.each(["no_restriction", "lax", "strict", "unspecified"])("accepts %s", (value) => {
    expect(isSameSite(value)).toBe(true)
  })

  test.each(["none", "Lax", "", 1, null])("rejects %p", (value) => {
    expect(isSameSite(value)).toBe(false)
  })
})

describe("parseCookieEntry", () => {
  test("accepts an exported cookie and ignores its storeId", () => {
    const parsed = entry({ ...cookie(), storeId: "firefox-container-4" })
    expect(parsed).toEqual({
      name: "sid",
      value: "v",
      domain: ".example.com",
      hostOnly: false,
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "lax",
      session: false,
      expirationDate: 4_000_000_000.5,
      firstPartyDomain: "",
      partitionKey: null,
    })
  })

  test("fills defaults for a minimal entry", () => {
    expect(entry({ name: "", domain: "a.test" })).toEqual({
      name: "",
      value: "",
      domain: "a.test",
      hostOnly: false,
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "unspecified",
      session: true,
      firstPartyDomain: "",
      partitionKey: null,
    })
  })

  test("keeps a partition key with hasCrossSiteAncestor", () => {
    const key = { topLevelSite: "https://top.test", hasCrossSiteAncestor: true }
    expect(entry({ name: "n", domain: "a.test", partitionKey: key }).partitionKey).toEqual(key)
  })

  test.each([
    ["not an object", "x", "cookie must be an object."],
    ["an array", [], "cookie must be an object."],
    ["null", null, "cookie must be an object."],
    ["name missing", { domain: "a.test" }, "name must be a string."],
    ["name a number", { name: 1, domain: "a.test" }, "name must be a string."],
    ["domain missing", { name: "n" }, "domain must be a non-empty string."],
    ["domain empty", { name: "n", domain: "" }, "domain must be a non-empty string."],
    ["value a number", { name: "n", domain: "d", value: 1 }, "value must be a string."],
    ["path a number", { name: "n", domain: "d", path: 1 }, "path must be a string."],
    [
      "hostOnly a string",
      { name: "n", domain: "d", hostOnly: "yes" },
      "hostOnly must be a boolean.",
    ],
    ["secure a string", { name: "n", domain: "d", secure: "1" }, "secure must be a boolean."],
    ["httpOnly a number", { name: "n", domain: "d", httpOnly: 1 }, "httpOnly must be a boolean."],
    ["session a string", { name: "n", domain: "d", session: "no" }, "session must be a boolean."],
    [
      "sameSite unknown",
      { name: "n", domain: "d", sameSite: "none" },
      "sameSite must be one of no_restriction, lax, strict, unspecified.",
    ],
    [
      "expirationDate a string",
      { name: "n", domain: "d", expirationDate: "1" },
      "expirationDate must be a number.",
    ],
    [
      "firstPartyDomain a number",
      { name: "n", domain: "d", firstPartyDomain: 1 },
      "firstPartyDomain must be a string.",
    ],
    [
      "partitionKey a string",
      { name: "n", domain: "d", partitionKey: "x" },
      "partitionKey must be an object or null.",
    ],
    [
      "topLevelSite a number",
      { name: "n", domain: "d", partitionKey: { topLevelSite: 1 } },
      "partitionKey.topLevelSite must be a string.",
    ],
    [
      "hasCrossSiteAncestor a string",
      { name: "n", domain: "d", partitionKey: { hasCrossSiteAncestor: "1" } },
      "partitionKey.hasCrossSiteAncestor must be a boolean.",
    ],
  ])("reports %s", (_label, value, error) => {
    expect(parseCookieEntry(value)).toEqual({ error })
  })
})

describe("setDetails", () => {
  test("builds a domain cookie into the target store", () => {
    const details = setDetails(
      entry({ ...cookie(), storeId: "firefox-private" }),
      "firefox-default",
    )
    expect(details).toEqual({
      url: "http://example.com/",
      name: "sid",
      value: "v",
      domain: ".example.com",
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "lax",
      expirationDate: 4_000_000_000.5,
      storeId: "firefox-default",
      firstPartyDomain: "",
    })
  })

  test("omits domain for a host-only cookie and expirationDate for a session one", () => {
    const details = setDetails(
      entry({
        ...cookie({ domain: "sub.example.com", hostOnly: true, secure: true, path: "/app" }),
        session: true,
        name: "",
      }),
      "firefox-private",
    )
    expect(details).toEqual({
      url: "https://sub.example.com/",
      name: "",
      value: "v",
      path: "/app",
      secure: true,
      httpOnly: false,
      sameSite: "lax",
      storeId: "firefox-private",
      firstPartyDomain: "",
    })
  })

  test("keeps firstPartyDomain and a partition key object", () => {
    const key = { topLevelSite: "https://top.test", hasCrossSiteAncestor: false }
    const partitioned = setDetails(entry({ ...cookie(), partitionKey: key }), "firefox-default")
    const isolated = setDetails(entry({ ...cookie(), firstPartyDomain: "a.test" }), "s")
    expect(partitioned.partitionKey).toEqual(key)
    expect(isolated.firstPartyDomain).toBe("a.test")
    expect("partitionKey" in isolated).toBe(false)
  })
})

describe("expireDetails", () => {
  test("addresses the exact identity with a minimal tombstone", () => {
    const key = { topLevelSite: "https://top.test", hasCrossSiteAncestor: true }
    const details = expireDetails(
      cookie({
        secure: true,
        httpOnly: true,
        sameSite: "no_restriction",
        path: "/app",
        firstPartyDomain: "a.test",
        partitionKey: key,
      }),
      "firefox-private",
    )
    expect(details).toEqual({
      url: "https://example.com/",
      name: "sid",
      value: "",
      domain: ".example.com",
      path: "/app",
      secure: true,
      httpOnly: true,
      sameSite: "unspecified",
      expirationDate: 0,
      storeId: "firefox-private",
      firstPartyDomain: "a.test",
      partitionKey: key,
    })
  })

  test("sends no domain for a host-only cookie and a value for an unnamed one", () => {
    const details = expireDetails(
      cookie({ name: "", domain: "sub.example.com", hostOnly: true }),
      "firefox-default",
    )
    expect(details.value).toBe("x")
    expect("domain" in details).toBe(false)
    expect("partitionKey" in details).toBe(false)
    expect(details.url).toBe("http://sub.example.com/")
  })
})

describe("identityKey", () => {
  test("differs on every identity field", () => {
    const base = cookie()
    const variants = [
      cookie({ domain: "example.com" }),
      cookie({ hostOnly: true }),
      cookie({ path: "/a" }),
      cookie({ name: "other" }),
      cookie({ firstPartyDomain: "a.test" }),
      cookie({ partitionKey: { topLevelSite: "https://top.test" } }),
      cookie({ partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: true } }),
    ]
    const keys = new Set([base, ...variants].map(identityKey))
    expect(keys.size).toBe(variants.length + 1)
  })

  test("ignores value, flags and store", () => {
    const other = cookie({
      value: "w",
      secure: true,
      httpOnly: true,
      sameSite: "strict",
      storeId: "firefox-private",
      expirationDate: 1,
    })
    expect(identityKey(other)).toBe(identityKey(cookie()))
  })

  test("treats an absent hasCrossSiteAncestor as false and an empty key as none", () => {
    const top = "https://top.test"
    expect(identityKey(cookie({ partitionKey: { topLevelSite: top } }))).toBe(
      identityKey(cookie({ partitionKey: { topLevelSite: top, hasCrossSiteAncestor: false } })),
    )
    expect(identityKey(cookie({ partitionKey: {} }))).toBe(identityKey(cookie()))
  })
})

describe("requestedIdentity", () => {
  test("a host-only set takes the url host", () => {
    expect(requestedIdentity({ url: "https://Sub.Example.com/x", name: "sid", path: "/" })).toBe(
      identityKey(cookie({ domain: "sub.example.com", hostOnly: true })),
    )
  })

  test("an explicit domain gains a leading dot", () => {
    expect(
      requestedIdentity({ url: "https://example.com/", name: "sid", domain: "Example.com" }),
    ).toBe(identityKey(cookie()))
    expect(
      requestedIdentity({ url: "https://example.com/", name: "sid", domain: ".example.com" }),
    ).toBe(identityKey(cookie()))
  })

  test("takes the path given, else the url directory", () => {
    const url = "https://example.com/"
    expect(requestedIdentity({ url, name: "sid", domain: "example.com", path: "/app" })).toBe(
      identityKey(cookie({ path: "/app" })),
    )
    expect(
      requestedIdentity({ url: "https://example.com/a/b", name: "sid", domain: "example.com" }),
    ).toBe(identityKey(cookie({ path: "/a/" })))
  })

  test("carries origin attributes and an IPv6 host without brackets", () => {
    const key = { topLevelSite: "https://top.test", hasCrossSiteAncestor: true }
    expect(
      requestedIdentity({ url: "http://[::1]/", name: "", path: "/", partitionKey: key }),
    ).toBe(identityKey(cookie({ domain: "::1", hostOnly: true, name: "", partitionKey: key })))
    expect(
      requestedIdentity({
        url: "http://a.test/",
        name: "n",
        path: "/",
        firstPartyDomain: "a.test",
      }),
    ).toBe(
      identityKey(
        cookie({ domain: "a.test", hostOnly: true, name: "n", firstPartyDomain: "a.test" }),
      ),
    )
  })

  test("matches what setDetails asks Firefox to store", () => {
    for (const source of [cookie(), cookie({ domain: "sub.example.com", hostOnly: true })]) {
      expect(requestedIdentity(setDetails(entry({ ...source }), "s"))).toBe(identityKey(source))
    }
  })
})

describe("sortCookies", () => {
  test("orders by domain, path, name and keeps ties stable", () => {
    const input = [
      cookie({ domain: "b.test", name: "a" }),
      cookie({ domain: "a.test", path: "/z", name: "a" }),
      cookie({ domain: "a.test", path: "/", name: "b" }),
      cookie({ domain: "a.test", path: "/", name: "a", value: "first" }),
      cookie({ domain: "a.test", path: "/", name: "a", value: "second" }),
    ]
    const sorted = sortCookies(input)
    expect(sorted.map((c) => [c.domain, c.path, c.name, c.value])).toEqual([
      ["a.test", "/", "a", "first"],
      ["a.test", "/", "a", "second"],
      ["a.test", "/", "b", "v"],
      ["a.test", "/z", "a", "v"],
      ["b.test", "/", "a", "v"],
    ])
    expect(input[0]?.domain).toBe("b.test")
  })
})
