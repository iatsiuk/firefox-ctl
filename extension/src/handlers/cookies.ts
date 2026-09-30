// The cookie commands. They answer from the background page over
// browser.cookies and touch no session state; the pure logic lives in
// ../cookies.

import { cookieFilter, sortCookies } from "../cookies"
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
