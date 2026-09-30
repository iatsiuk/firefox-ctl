// Pure cookie logic for the cookie commands: the getAll filter, the details
// handed to cookies.set, entry validation and the identity Firefox keys a
// cookie by. No browser globals; handlers pass the results to browser.cookies.

import type { Cookie, CookieQuery, CookieSetDetails, PartitionKey, SameSiteStatus } from "./browser"
import type { JsonObject } from "./protocol"

const SAME_SITE: readonly SameSiteStatus[] = ["no_restriction", "lax", "strict", "unspecified"]

/** A cookie to write: an exported `Cookie` without its `storeId`. */
export type CookieEntry = Omit<Cookie, "storeId">

export type ParsedEntry = { entry: CookieEntry } | { error: string }

/** The fields Firefox keys a cookie by within one store. */
export type CookieIdentity = Pick<
  Cookie,
  "domain" | "hostOnly" | "path" | "name" | "firstPartyDomain" | "partitionKey"
>

export function isSameSite(value: unknown): value is SameSiteStatus {
  return SAME_SITE.includes(value as SameSiteStatus)
}

interface FieldTypes {
  string: string
  boolean: boolean
  number: number
}

export function optional<K extends keyof FieldTypes>(
  params: Record<string, unknown>,
  key: string,
  type: K,
): FieldTypes[K] | undefined {
  const value = params[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== type) {
    throw new Error(`${key} must be a ${type}.`)
  }
  return value as FieldTypes[K]
}

export function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  return optional(params, key, "string")
}

/**
 * The getAll query for the filter params. Without `partitionKey: {}` Firefox
 * returns only unpartitioned cookies, and without `firstPartyDomain: null` it
 * skips first-party-isolated ones.
 */
export function cookieFilter(params: JsonObject): CookieQuery {
  const query: CookieQuery = {}
  for (const key of ["url", "domain", "name"] as const) {
    const value = optionalString(params, key)
    if (value !== undefined) {
      query[key] = value
    }
  }
  return { ...query, partitionKey: {}, firstPartyDomain: null }
}

/**
 * The origin a cookie belongs to. The path stays `/`: set gets `path`
 * explicitly, so a cookie path never has to survive url parsing.
 */
export function cookieUrl(cookie: { domain: string; secure?: boolean }): string {
  let host = cookie.domain.replace(/^\./, "")
  if (host.includes(":") && !host.startsWith("[")) {
    host = `[${host}]`
  }
  return `${cookie.secure ? "https" : "http"}://${host}/`
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Whether an expirationDate in seconds is at or before `nowMs`. */
export function isPast(expirationDate: number | undefined, nowMs: number): boolean {
  return expirationDate !== undefined && expirationDate * 1000 <= nowMs
}

function optionalSameSite(params: Record<string, unknown>): SameSiteStatus | undefined {
  const value = params.sameSite
  if (value === undefined || value === null) {
    return undefined
  }
  if (!isSameSite(value)) {
    throw new Error(`sameSite must be one of ${SAME_SITE.join(", ")}.`)
  }
  return value
}

function parsePartitionKey(value: unknown): PartitionKey | null {
  if (value === undefined || value === null) {
    return null
  }
  if (!isObject(value)) {
    throw new Error("partitionKey must be an object or null.")
  }
  const key: PartitionKey = {}
  if (value.topLevelSite !== undefined) {
    if (typeof value.topLevelSite !== "string") {
      throw new Error("partitionKey.topLevelSite must be a string.")
    }
    key.topLevelSite = value.topLevelSite
  }
  if (value.hasCrossSiteAncestor !== undefined) {
    if (typeof value.hasCrossSiteAncestor !== "boolean") {
      throw new Error("partitionKey.hasCrossSiteAncestor must be a boolean.")
    }
    key.hasCrossSiteAncestor = value.hasCrossSiteAncestor
  }
  return key
}

function cookieEntry(raw: Record<string, unknown>): CookieEntry {
  if (typeof raw.name !== "string") {
    throw new Error("name must be a string.")
  }
  if (typeof raw.domain !== "string" || raw.domain === "") {
    throw new Error("domain must be a non-empty string.")
  }
  const expirationDate = optional(raw, "expirationDate", "number")
  const entry: CookieEntry = {
    name: raw.name,
    value: optionalString(raw, "value") ?? "",
    domain: raw.domain,
    hostOnly: optional(raw, "hostOnly", "boolean") ?? false,
    path: optionalString(raw, "path") ?? "/",
    secure: optional(raw, "secure", "boolean") ?? false,
    httpOnly: optional(raw, "httpOnly", "boolean") ?? false,
    sameSite: optionalSameSite(raw) ?? "unspecified",
    session: optional(raw, "session", "boolean") ?? expirationDate === undefined,
    firstPartyDomain: optionalString(raw, "firstPartyDomain") ?? "",
    partitionKey: parsePartitionKey(raw.partitionKey),
  }
  if (expirationDate !== undefined) {
    entry.expirationDate = expirationDate
  }
  return entry
}

/**
 * Validates one cookie of an import, typically an exported `Cookie`. A
 * malformed entry is reported, not thrown, so the rest of a batch goes on.
 * The entry's own `storeId` is dropped: an import writes to the target store.
 */
export function parseCookieEntry(value: unknown): ParsedEntry {
  if (!isObject(value)) {
    return { error: "cookie must be an object." }
  }
  try {
    return { entry: cookieEntry(value) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The cookies.set details that recreate an entry in `storeId`. A host-only
 * cookie goes without `domain`, a session cookie without `expirationDate`.
 * `firstPartyDomain` always goes along: Firefox requires it under first-party
 * isolation.
 */
export function setDetails(entry: CookieEntry, storeId: string): CookieSetDetails {
  const details: CookieSetDetails = {
    url: cookieUrl(entry),
    name: entry.name,
    value: entry.value,
    path: entry.path,
    secure: entry.secure,
    httpOnly: entry.httpOnly,
    sameSite: entry.sameSite,
    storeId,
    firstPartyDomain: entry.firstPartyDomain,
  }
  if (!entry.hostOnly) {
    details.domain = entry.domain
  }
  if (!entry.session && entry.expirationDate !== undefined) {
    details.expirationDate = entry.expirationDate
  }
  if (entry.partitionKey !== null) {
    details.partitionKey = { ...entry.partitionKey }
  }
  return details
}

function requiredName(params: JsonObject): string {
  if (params.name === undefined || params.name === null) {
    throw new Error("name is required.")
  }
  return optionalString(params, "name") as string
}

// the directory of the url path with its trailing slash, what Firefox takes
// (nsIURL.directory) when set gets no path
function defaultPath(pathname: string): string {
  return pathname.slice(0, pathname.lastIndexOf("/") + 1) || "/"
}

/**
 * The cookies.set details for setCookie params, without the store. Without
 * `url` the url is the origin of `domain`. The path always goes along, the url
 * directory unless given, so the stored identity never depends on Firefox's
 * default; every other field only when given, so Firefox applies its own
 * defaults. An empty `domain` is no domain: the cookie is host-only.
 */
export function setCookieDetails(params: JsonObject): CookieSetDetails {
  const name = requiredName(params)
  const url = optionalString(params, "url")
  const domain = optionalString(params, "domain") || undefined
  const secure = optional(params, "secure", "boolean")
  if (!url && !domain) {
    throw new Error("setCookie needs --url or --domain.")
  }
  const target = url || cookieUrl({ domain: domain as string, secure })
  const given = optionalString(params, "path")
  const fields: Partial<CookieSetDetails> = {
    domain,
    path: given ?? (URL.canParse(target) ? defaultPath(new URL(target).pathname) : undefined),
    secure,
    httpOnly: optional(params, "httpOnly", "boolean"),
    sameSite: optionalSameSite(params),
    expirationDate: optional(params, "expirationDate", "number"),
    firstPartyDomain: optionalString(params, "firstPartyDomain"),
    partitionKey: parsePartitionKey(params.partitionKey) ?? undefined,
  }
  const details: CookieSetDetails = {
    url: target,
    name,
    value: optionalString(params, "value") ?? "",
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      Object.assign(details, { [key]: value })
    }
  }
  return details
}

/**
 * A set that overwrites exactly this cookie with an expired one. The rest is
 * the minimum Firefox still validates: a value for an unnamed cookie (empty
 * name plus empty value is rejected) and `unspecified` sameSite
 * (`no_restriction` without `secure` is rejected even when expired).
 */
export function expireDetails(cookie: Cookie, storeId: string): CookieSetDetails {
  const details: CookieSetDetails = {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.name === "" ? "x" : "",
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: "unspecified",
    expirationDate: 0,
    storeId,
    firstPartyDomain: cookie.firstPartyDomain,
  }
  if (!cookie.hostOnly) {
    details.domain = cookie.domain
  }
  if (cookie.partitionKey !== null) {
    details.partitionKey = { ...cookie.partitionKey }
  }
  return details
}

/** A string equal for two cookies exactly when Firefox treats them as one. */
export function identityKey(cookie: CookieIdentity): string {
  const site = cookie.partitionKey?.topLevelSite ?? ""
  const ancestor = site === "" ? false : (cookie.partitionKey?.hasCrossSiteAncestor ?? false)
  return JSON.stringify([
    cookie.domain.toLowerCase(),
    cookie.hostOnly,
    cookie.path,
    cookie.name,
    cookie.firstPartyDomain,
    site,
    ancestor,
  ])
}

function isIPv4(host: string): boolean {
  const octets = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  return octets?.slice(1).every((octet) => Number(octet) < 256) === true
}

function isSubdomain(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`)
}

// the host ext-cookies.js stores for a set: the url host for a host-only
// cookie, an explicit IP as is (an IP only takes host-only cookies), any
// other domain with a leading dot; an IPv6 host without its brackets
function storedHost(url: URL, domain: string | undefined): string {
  if (domain === undefined) {
    return url.hostname.replace(/^\[(.*)\]$/, "$1")
  }
  const host = (domain.length > 1 ? domain.replace(/^\./, "") : domain)
    .toLowerCase()
    .replace(/^\[(.*:.*)\]$/, "$1")
  return host.includes(":") || isIPv4(host) ? host : `.${host}`
}

// the hostname of the site Firefox answers, "" for one that does not parse
function siteHost(site: string): string {
  return URL.canParse(site) ? new URL(site).hostname : ""
}

/** The cookie Firefox stores for a set, as far as the details tell it. */
export type RequestedCookie = {
  /** the topLevelSite asked for, whose site only Firefox knows */
  topLevelSite?: string
  /** the identity key of the stored cookie under the site Firefox answers */
  key: (site?: string) => string
}

// ext-cookies.js stores a partitioned set under the site of topLevelSite, its
// scheme and registrable domain, which needs the public suffix list, so the
// site comes from Firefox; a set without it falls back to topLevelSite as
// given. The answer has a cross-site ancestor when the set asked for one or
// the cookie host is outside the site (getExtPartitionKey)
export function requestedCookie(details: CookieSetDetails): RequestedCookie {
  const url = new URL(details.url)
  const host = storedHost(url, details.domain)
  const identity = {
    domain: host.includes(":") ? `[${host}]` : host,
    hostOnly: !host.startsWith("."),
    path: details.path ?? defaultPath(url.pathname),
    name: details.name ?? "",
    firstPartyDomain: details.firstPartyDomain ?? "",
    partitionKey: null,
  }
  const requested = details.partitionKey
  if (!requested?.topLevelSite) {
    return { key: () => identityKey(identity) }
  }
  const topLevelSite = requested.topLevelSite
  return {
    topLevelSite,
    key: (site = topLevelSite) => {
      const ancestor = requested.hasCrossSiteAncestor ?? false
      const partitionKey = {
        topLevelSite: site,
        hasCrossSiteAncestor: ancestor || !isSubdomain(host, siteHost(site)),
      }
      return identityKey({ ...identity, partitionKey })
    },
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** A sorted copy by domain, path and name; equal cookies keep their order. */
export function sortCookies<T extends Pick<Cookie, "domain" | "path" | "name">>(cookies: T[]): T[] {
  return [...cookies].sort(
    (a, b) => compare(a.domain, b.domain) || compare(a.path, b.path) || compare(a.name, b.name),
  )
}
