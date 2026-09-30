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

function optional<K extends keyof FieldTypes>(
  params: JsonObject,
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

function optionalString(params: JsonObject, key: string): string | undefined {
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

type FieldCheck = [key: string, type: "string" | "boolean" | "number"]

const ENTRY_FIELDS: readonly FieldCheck[] = [
  ["name", "string"],
  ["value", "string"],
  ["path", "string"],
  ["hostOnly", "boolean"],
  ["secure", "boolean"],
  ["httpOnly", "boolean"],
  ["session", "boolean"],
  ["expirationDate", "number"],
  ["firstPartyDomain", "string"],
]

function fieldError(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.name !== "string") {
    return "name must be a string."
  }
  if (typeof raw.domain !== "string" || raw.domain === "") {
    return "domain must be a non-empty string."
  }
  for (const [key, type] of ENTRY_FIELDS) {
    if (raw[key] !== undefined && typeof raw[key] !== type) {
      return `${key} must be a ${type}.`
    }
  }
  if (raw.sameSite !== undefined && !isSameSite(raw.sameSite)) {
    return `sameSite must be one of ${SAME_SITE.join(", ")}.`
  }
  return undefined
}

function parsePartitionKey(value: unknown): PartitionKey | null | string {
  if (value === undefined || value === null) {
    return null
  }
  if (!isObject(value)) {
    return "partitionKey must be an object or null."
  }
  const key: PartitionKey = {}
  if (value.topLevelSite !== undefined) {
    if (typeof value.topLevelSite !== "string") {
      return "partitionKey.topLevelSite must be a string."
    }
    key.topLevelSite = value.topLevelSite
  }
  if (value.hasCrossSiteAncestor !== undefined) {
    if (typeof value.hasCrossSiteAncestor !== "boolean") {
      return "partitionKey.hasCrossSiteAncestor must be a boolean."
    }
    key.hasCrossSiteAncestor = value.hasCrossSiteAncestor
  }
  return key
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
  const error = fieldError(value)
  if (error) {
    return { error }
  }
  const partitionKey = parsePartitionKey(value.partitionKey)
  if (typeof partitionKey === "string") {
    return { error: partitionKey }
  }
  const expirationDate = value.expirationDate as number | undefined
  const entry: CookieEntry = {
    name: value.name as string,
    value: (value.value as string | undefined) ?? "",
    domain: value.domain as string,
    hostOnly: (value.hostOnly as boolean | undefined) ?? false,
    path: (value.path as string | undefined) ?? "/",
    secure: (value.secure as boolean | undefined) ?? false,
    httpOnly: (value.httpOnly as boolean | undefined) ?? false,
    sameSite: (value.sameSite as SameSiteStatus | undefined) ?? "unspecified",
    session: (value.session as boolean | undefined) ?? expirationDate === undefined,
    firstPartyDomain: (value.firstPartyDomain as string | undefined) ?? "",
    partitionKey,
  }
  if (expirationDate !== undefined) {
    entry.expirationDate = expirationDate
  }
  return { entry }
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

function optionalSameSite(params: JsonObject): SameSiteStatus | undefined {
  const value = params.sameSite
  if (value === undefined || value === null) {
    return undefined
  }
  if (!isSameSite(value)) {
    throw new Error(`sameSite must be one of ${SAME_SITE.join(", ")}.`)
  }
  return value
}

/**
 * The cookies.set details for setCookie params, without the store. Without
 * `url` the url is the origin of `domain`; every other field goes along only
 * when given, so Firefox applies its own defaults.
 */
export function setCookieDetails(params: JsonObject): CookieSetDetails {
  const name = requiredName(params)
  const url = optionalString(params, "url")
  const domain = optionalString(params, "domain")
  const secure = optional(params, "secure", "boolean")
  if (!url && !domain) {
    throw new Error("setCookie needs --url or --domain.")
  }
  const partitionKey = parsePartitionKey(params.partitionKey)
  if (typeof partitionKey === "string") {
    throw new Error(partitionKey)
  }
  const fields: Partial<CookieSetDetails> = {
    domain,
    path: optionalString(params, "path"),
    secure,
    httpOnly: optional(params, "httpOnly", "boolean"),
    sameSite: optionalSameSite(params),
    expirationDate: optional(params, "expirationDate", "number"),
    firstPartyDomain: optionalString(params, "firstPartyDomain"),
    partitionKey: partitionKey ?? undefined,
  }
  const details: CookieSetDetails = {
    url: url || cookieUrl({ domain: domain as string, secure }),
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

// the directory of the url path, what Firefox takes when set gets no path
function defaultPath(pathname: string): string {
  const last = pathname.lastIndexOf("/")
  return last <= 0 ? "/" : pathname.slice(0, last)
}

/** The identity key of the cookie Firefox stores for these set details. */
export function requestedIdentity(details: CookieSetDetails): string {
  const url = new URL(details.url)
  const hostOnly = details.domain === undefined
  const domain = hostOnly
    ? url.hostname.replace(/^\[(.*)\]$/, "$1")
    : `.${(details.domain as string).replace(/^\./, "")}`
  return identityKey({
    domain,
    hostOnly,
    path: details.path ?? defaultPath(url.pathname),
    name: details.name ?? "",
    firstPartyDomain: details.firstPartyDomain ?? "",
    partitionKey: details.partitionKey ?? null,
  })
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
