// The cookie commands. They answer from the background page over
// browser.cookies and touch no session state; the pure logic lives in
// ../cookies.

import type { Cookie } from "../browser"
import {
  type CookieEntry,
  cookieFilter,
  expireDetails,
  identityKey,
  parseCookieEntry,
  requestedIdentity,
  setCookieDetails,
  setDetails,
  sortCookies,
} from "../cookies"
import type { Handler, HandlerDeps } from "../dispatch"
import type { JsonObject, JsonValue } from "../protocol"
import { resolveTargetTab } from "./tabs"

const DEFAULT_STORE = "firefox-default"
const PRIVATE_STORE = "firefox-private"

/**
 * The cookie store a command reads or writes: an explicit `storeId`, which
 * needs no session, or the store of the target tab, so the private managed
 * window lands in `firefox-private` and a container tab in its container.
 */
export async function resolveCookieStore(deps: HandlerDeps, params: JsonObject): Promise<string> {
  const storeId = params.storeId
  if (storeId !== undefined && storeId !== null) {
    if (typeof storeId !== "string" || storeId === "") {
      throw new Error("storeId must be a non-empty string.")
    }
    return storeId
  }
  const tab = await resolveTargetTab(deps, params)
  return tab.cookieStoreId ?? (tab.incognito ? PRIVATE_STORE : DEFAULT_STORE)
}

/** Every cookie of the store matching the filter, partitioned ones included. */
export const exportCookies: Handler = async (params, deps) => {
  const filter = cookieFilter(params)
  const store = await resolveCookieStore(deps, params)
  const found = await deps.browser.cookies.getAll({ ...filter, storeId: store })
  const cookies = sortCookies(found)
  return { store, total: cookies.length, cookies } as unknown as JsonValue
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Writes one cookie. The answer of cookies.set is cookies.get(url, name),
 * which can be a parent-domain cookie or null after a good write, so the
 * cookie is read back by its identity instead. A past expirationDate deletes
 * the cookie and answers null.
 */
export const setCookie: Handler = async (params, deps) => {
  const requested = setCookieDetails(params)
  const store = await resolveCookieStore(deps, params)
  const details = { ...requested, storeId: store }
  const name = details.name ?? ""
  try {
    await deps.browser.cookies.set(details)
  } catch (error) {
    throw new Error(`Cannot set cookie ${name}: ${errorText(error)}`)
  }
  const wanted = requestedIdentity(details)
  const found = await deps.browser.cookies.getAll({
    name,
    storeId: store,
    partitionKey: {},
    firstPartyDomain: null,
  })
  const cookie = found.find((candidate) => identityKey(candidate) === wanted)
  if (cookie) {
    return { store, cookie } as unknown as JsonValue
  }
  const expired =
    details.expirationDate !== undefined && details.expirationDate * 1000 <= deps.env.now()
  if (expired) {
    return { store, cookie: null }
  }
  throw new Error(`Firefox did not store cookie ${name}.`)
}

function deleteAll(params: JsonObject): boolean {
  const all = params.all
  if (all === undefined || all === null) {
    return false
  }
  if (typeof all !== "boolean") {
    throw new Error("all must be a boolean.")
  }
  return all
}

function cookieRef(cookie: Cookie): { name: string; domain: string; path: string } {
  return { name: cookie.name, domain: cookie.domain, path: cookie.path }
}

/**
 * Removes every cookie matching the filter. cookies.remove picks among the
 * cookies of a url by path length and age, so it can hit a parent-domain
 * cookie outside the filter; each match is overwritten by an expired cookie
 * of its exact identity instead, and a re-query tells what is really gone.
 */
export const deleteCookies: Handler = async (params, deps) => {
  const filter = cookieFilter(params)
  const all = deleteAll(params)
  const filtered =
    filter.url !== undefined || filter.domain !== undefined || filter.name !== undefined
  if (!all && !filtered) {
    throw new Error("deleteCookies needs --url, --domain, --name or --all.")
  }
  const store = await resolveCookieStore(deps, params)
  const query = { ...filter, storeId: store }
  const targets = sortCookies(await deps.browser.cookies.getAll(query))
  const errors = new Map<string, string>()
  for (const cookie of targets) {
    try {
      await deps.browser.cookies.set(expireDetails(cookie, store))
    } catch (error) {
      errors.set(identityKey(cookie), errorText(error))
    }
  }
  const remaining = new Set((await deps.browser.cookies.getAll(query)).map(identityKey))
  const cookies = []
  const failed = []
  for (const cookie of targets) {
    const key = identityKey(cookie)
    if (remaining.has(key)) {
      failed.push({ ...cookieRef(cookie), error: errors.get(key) ?? "Firefox kept the cookie." })
    } else {
      cookies.push(cookieRef(cookie))
    }
  }
  return { store, deleted: cookies.length, cookies, failed }
}

function cookieEntries(params: JsonObject): JsonValue[] {
  const cookies = params.cookies
  if (cookies === undefined || cookies === null) {
    throw new Error("cookies is required.")
  }
  if (!Array.isArray(cookies)) {
    throw new Error("cookies must be an array.")
  }
  return cookies
}

type EntryRef = { name: string; domain: string }

// name and domain of an entry for failed, even when the entry is malformed
function entryRef(value: JsonValue): EntryRef {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    domain: typeof raw.domain === "string" ? raw.domain : "",
  }
}

function expired(entry: CookieEntry, nowMs: number): boolean {
  return (
    !entry.session && entry.expirationDate !== undefined && entry.expirationDate * 1000 <= nowMs
  )
}

/**
 * Writes a batch of cookies, typically an exportCookies result, into the
 * resolved store: a transfer, so the store of the export and of each entry
 * is ignored. One re-query after all sets tells which cookies Firefox kept;
 * the set answers are not trusted. A bad entry lands in failed and the rest
 * go on.
 */
export const importCookies: Handler = async (params, deps) => {
  const entries = cookieEntries(params)
  const store = await resolveCookieStore(deps, params)
  const failed: (EntryRef & { error: string })[] = []
  const sent: { ref: EntryRef; key: string }[] = []
  for (const value of entries) {
    const ref = entryRef(value)
    const parsed = parseCookieEntry(value)
    if ("error" in parsed) {
      failed.push({ ...ref, error: parsed.error })
      continue
    }
    if (expired(parsed.entry, deps.env.now())) {
      failed.push({ ...ref, error: "expired" })
      continue
    }
    const details = setDetails(parsed.entry, store)
    try {
      await deps.browser.cookies.set(details)
      sent.push({ ref, key: requestedIdentity(details) })
    } catch (error) {
      failed.push({ ...ref, error: errorText(error) })
    }
  }
  const found = await deps.browser.cookies.getAll({
    storeId: store,
    partitionKey: {},
    firstPartyDomain: null,
  })
  const kept = new Set(found.map(identityKey))
  let imported = 0
  for (const { ref, key } of sent) {
    if (kept.has(key)) {
      imported++
    } else {
      failed.push({ ...ref, error: "Firefox did not store the cookie." })
    }
  }
  return { store, imported, failed }
}
