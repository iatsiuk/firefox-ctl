// The DevTools commands that answer from the background page. Console logs live
// in the content script and go through `pageCommand`; the network log is the
// background's own webRequest tracker, so it is served here.

import type { Handler, HandlerDeps } from "../dispatch"
import type { NetworkQuery } from "../network"
import type { JsonObject, JsonValue } from "../protocol"
import { REDACT_HEADERS_DEFAULT, readRedactHeaders } from "../settings"
import { resolveTargetTab } from "./tabs"

/** The query the tracker understands, with the target tab already resolved. */
function networkQuery(params: JsonObject, tabId: number, redact: boolean): NetworkQuery {
  return {
    tabId,
    type: typeof params.type === "string" ? params.type : undefined,
    status: typeof params.status === "string" ? params.status : undefined,
    clear: params.clear === true,
    limit: typeof params.limit === "number" ? params.limit : undefined,
    includeHeaders: params.includeHeaders === true,
    redact,
  }
}

/** Reads the setting on every call; an unreadable storage stays redacted. */
async function redactSetting(deps: HandlerDeps): Promise<boolean> {
  try {
    return await readRedactHeaders(deps.browser)
  } catch {
    return REDACT_HEADERS_DEFAULT
  }
}

/**
 * The requests Firefox made for one tab. `includeHeaders` returns the response
 * headers with the credential-bearing ones (`Set-Cookie`, `Authorization` and
 * their kin) reduced to `[redacted]` unless the user unticked header redaction
 * in the add-on preferences, and `clear` empties the whole buffer, not only
 * this tab's share.
 */
export const getNetworkRequests: Handler = async (params, deps) => {
  const tab = await resolveTargetTab(deps, params)
  if (tab.id === undefined) {
    throw new Error("Firefox returned a tab without an id.")
  }
  const redact = await redactSetting(deps)
  const result = deps.network.query(networkQuery(params, tab.id, redact))
  return { tabId: tab.id, ...result } as unknown as JsonValue
}
