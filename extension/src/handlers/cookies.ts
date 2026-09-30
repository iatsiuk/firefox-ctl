// The cookie commands. They answer from the background page over
// browser.cookies and touch no session state; the pure logic lives in
// ../cookies.

import type { Cookie } from "../browser"
import {
  cookieFilter,
  expireDetails,
  identityKey,
  requestedIdentity,
  setCookieDetails,
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
