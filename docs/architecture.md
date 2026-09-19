# Architecture

A Go native messaging host and CLI plus a WebExtension: the managed-window session model, a 12-tab pool and the full CLI command set of `docs/commands.md`. There is no MCP server, no popup, no multi-agent ownership, no watermark or focus loops, and every security gate is absent except one: `evaluate` is off until the user ticks it in the add-on preferences, which `options.html` and `src/options.ts` serve together with the response-header redaction switch. Everything the commands read out of a page or a request leaves the browser through native messaging, so the manifest declares the four data categories that covers; see "Data leaving the browser" below and `docs/commands.md`.

## Data flow

```
firefox-ctl <cmd> --(unix socket, NDJSON)--> firefox-ctl host --(stdio native messaging)--> background.ts --(tabs.sendMessage)--> content.ts
                                                                                      ^
                                                                    webRequest events (network tracker)
```

## Data leaving the browser

Every command answers over the same path: content script or background API, then `background.ts`, then the native host over stdio, then the socket, then the terminal that asked. The only destination is the local native host over stdio, the `firefox-ctl` binary the user installed; the extension opens no network connection of its own, has no remote endpoint and no analytics. Data is not stored either, beyond the in-memory network ring and the two `storage.local` keys of "Session state", which hold tab and window ids, never page content.

| Command family | What leaves the browser | Category |
|---|---|---|
| `version`, `ping` | extension version and feature list, a timestamp | none |
| tabs, windows, groups, `navigate`, `getActiveTab`, `getTabs`, `listAllTabs` | urls, page titles, tab, window and group ids | `browsingActivity` |
| `getContent`, `getAccessibilitySnapshot`, `getElementInfo`, `getPageState`, `waitFor` | text, HTML, link and form structure of the page, including values of visible fields; `getContent` reports the browser's `innerText` of the root with its documented fallbacks (raw `textContent` for a root without layout boxes and for non-HTML roots), the other readers report `textContent` | `websiteContent` |
| `screenshot` | a rendered image of the page, which can hold anything the page shows | `websiteContent` |
| `getConsoleLogs`, `getNetworkRequests` | console output, request and response metadata, request urls with credential-looking query values already stripped, response headers redacted by default | `websiteContent` |
| `click`, `type`, `pressKey`, `scroll`, `handleConsent` | what was clicked, typed, pressed or scrolled and the resulting element state | `websiteActivity` |
| `type` into a password field, `getContent` or `evaluate` over one | the value of a credential field | `authenticationInfo` |
| `evaluate` (opt-in, off by default) | whatever the expression returns, so any of the above | the categories above |

`authenticationInfo` is declared rather than argued away: `type` echoes the value it typed, including into a password input, and `getContent` and `evaluate` can read one, so a credential path exists whatever the header redaction setting says. The browser user agent is not reported by any command; see the permissions notes under "Extension".

## Native messaging

- Framing: uint32 length in native byte order (little-endian on macOS) followed by UTF-8 JSON
- Firefox limits: 1 MB host->extension, 4 GB extension->host. Project cap: 10 MB extension->host
- Firefox spawns the host on `browser.runtime.connectNative` when the background script starts and kills it when the port closes. No separate daemon
- The native manifest lives in `~/Library/Application Support/Mozilla/NativeMessagingHosts/firefoxctl.json` on macOS and in `~/.mozilla/native-messaging-hosts/firefoxctl.json` on Linux, picked by `runtime.GOOS`; any other OS has no default and `firefox-ctl install --dir <path>` is required. It needs an absolute path to the binary and the extension ID in `allowed_extensions`. A static Go binary needs no PATH wrapper. `firefox-ctl install` writes the manifest (and `--uninstall` removes it), so there is no checked-in template
- Firefox spawns the manifest `path` with the manifest path and the extension ID as arguments, so the binary is entered without a `host` argument. The cobra root falls back to host mode when the first argument is an absolute path ending in `.json` and is not a known subcommand; the extension ID and any other positional argument is dropped, flags after it are kept. `firefox-ctl <typo>` still exits 2 with an unknown command error

## Socket protocol

- Request per line: `{"command","params"}`; response per line: `{"success","result","error"}` plus `command` and `timeoutMs` on a timeout. The host assigns the UUID it correlates on, so a client-provided `id` is ignored and the response never carries one. `details` from the extension is not forwarded
- Socket path: `$XDG_RUNTIME_DIR/firefox-ctl.sock` when that variable points at a directory, fallback `~/.firefox-ctl/firefox-ctl.sock` (dir 0700, socket 0600)
- No auth token: single-user machine, socket mode 0600 is the only access control
- Host removes the socket on SIGTERM, SIGINT and stdin EOF
- Startup guard: `ipc.Listen` takes a flock on a lock file next to the socket, probes an existing socket by dialing (only `ECONNREFUSED` counts as stale), unlinks only a stale socket and returns `ErrAlreadyRunning` for a live one; the listener remembers the socket's device and inode and on close never unlinks a socket a newer host has replaced
- Per-request timeout 5000-300000 ms, default 150000 (`--request-timeout`, sent as `_timeout`); host correlates by UUID and drops pending requests when the client disconnects. The client waits `_timeout` plus 5 s
- Connection limits: 60 s idle timeout armed on accept and disarmed by the first complete request, 10 concurrent connections, 10 MB per request line (over it the host replies `Message too large` and closes)
- Extension-initiated messages with no matching pending id: `ping` and `version` (host version, Go version, platform) are answered, anything else is logged to stderr and dropped

## Extension

- MV2, extension ID `firefox-ctl@firefox-ctl.dev`, `persistent: true`, `strict_min_version` pinned to the Firefox release installed when the manifest was last generated (155.0 as of this writing), bumped deliberately, CSP `script-src 'self'; object-src 'self'`
- Permissions: `nativeMessaging`, `tabs`, `tabGroups` (`tabGroups.query`/`.update`, used to name and find the `firefox-ctl` group), `<all_urls>`, `webRequest` (network capture), `storage` (persist managed window and attached tabs across background restarts)
- `browser_specific_settings.gecko.data_collection_permissions.required` lists `browsingActivity`, `websiteContent`, `websiteActivity` and `authenticationInfo`, the categories of the matrix above. `none` is wrong for an add-on that hands page data to a native application, and `technicalAndInteraction` is not declared at all: it may only be optional, which would need a `permissions.request` from a user gesture, so the `browser` user agent field was dropped from the `version` result instead
- `options_ui` opens `options.html` inside about:addons (`open_in_tab: false`); it is a static page with two checkboxes - the `evaluate` opt-in and header redaction - served by the third bundle, `dist/options.js`. It has no inline script, so the CSP stays as it is
- Content script `run_at: document_idle`, `all_frames: false`
- Content script is re-injected on every navigation. Page commands issued right after `navigate` must wait for readiness or retry, otherwise `tabs.sendMessage` fails with "Receiving end does not exist"
- Restricted pages (`about:*` except `about:blank`, `moz-extension:`, JSON/PDF viewers, downloads) cannot host a content script; return structured errors (`RESTRICTED_PAGE`, `PAGE_LOAD_FAILED`, `CONTENT_SCRIPT_UNAVAILABLE`, `TAB_CLOSED`)
- Screenshots: `browser.tabs.captureTab(tabId)` for every tab. It renders a background tab as it is, so no tab is ever activated and a capture never disturbs the window the user is looking at. A per-tab `StateLock` in `src/capture-locks.ts` serialises every capture of a tab, annotated or not, across the annotate/captureTab/removeAnnotations section, so a plain capture can never land while another request's badges are still on the page. Readiness detection (`waitForPageReady`), purpose presets, JPEG scaling via `resizeImage` in the content script and element annotation are kept. Neither readiness nor annotation needs a visible tab, but hidden tabs throttle requestAnimationFrame and idle callbacks, so readiness must honour its own timeout
- Frame budget: the host drops any frame above 10 MiB, so `src/handlers/screenshot.ts` measures the serialised reply against 9 MiB and re-encodes the image it already captured down a ladder (PNG to JPEG 80, quality in steps of 10 to 20, then scale x0.75 to 0.25, at most 8 steps) before failing with `SCREENSHOT_TOO_LARGE`. Every step re-encodes the same pixels through the content script, so a long page costs one render however far the ladder goes, and the result reports what was actually applied plus `reduced`
- `eval`: runs in the content script isolated world via `new Function`, with no length cap or pattern blocklist. An opt-in gate applies: `src/handlers/dom.ts` reads `readEvaluateEnabled` from `src/settings.ts` before it messages the tab and answers `EVALUATE_DISABLED: evaluate is disabled; enable it in the add-on preferences (about:addons > Terminal Control for Firefox > Preferences)` while the setting is unset, so the terminal alone can never turn it on. The setting is read per call and an unreadable `storage.local` keeps the gate shut

## Network tracker

- `src/network.ts` attaches three `webRequest` listeners over `<all_urls>` on startup: `onBeforeRequest` appends a pending entry, `onCompleted` (with the `responseHeaders` extra info) fills in the status code, headers and duration, `onErrorOccurred` marks the failure. Timestamps come from `Environment.now`, so the recency window is driven by the fake clock in tests
- One ring of 200 entries for the whole browser, oldest evicted. Only metadata is stored, never a request body, and query values whose key looks like a credential (`password`, `token`, `api_key`, `secret`, `auth`, `key`, `credential` and the rest) are replaced before the url is kept, so nothing sensitive lives in the buffer to begin with
- Two readers: `query()` serves `getNetworkRequests` (filters, `limit`, `includeHeaders`, and `clear`, which empties the buffer after the reply has been built), and `tabStatus()` serves readiness with the pending counts of one tab within the last 2000 ms, split into critical (script, stylesheet, xhr, fetch, main and sub frame) and visual (image, font, media)

## Readiness pipeline

```
screenshot -> waitForPageReady(tracker.tabStatus, executeInTab checkPageReadiness) -> annotate? -> captureTab -> resizeImage? -> removeAnnotations
waitFor    -> awaitTabComplete(tabs.onUpdated) -> content waitFor(selector|text) | background waitForUrl
```

- `src/readiness.ts` waits for critical network idle (25 ms polls), then optionally for visual idle (capped at 3000 ms), then for the tab's own render settlement through the `checkPageReadiness` content action. Every phase is bounded by both `maxWait` and the command budget minus 500 ms kept back for the capture and the reply
- It never throws: a restricted page, a missing content script or a busy one land in the timeline (`render_check_failed`) and the capture goes ahead, because a late screenshot beats no screenshot. The final render check is raced against the remaining budget, so a content script that never answers cannot consume the capture's share
- The stalled-request timeout (`idleThreshold * 3`) is measured from the tracker's `lastActivity`, not from the poll, where a pending request would reset it every round and make the branch unreachable. One hung fetch therefore ends phase 1 with `critical_timeout` rather than holding the capture until `maxWait`
- The `checkPageReadiness` action, `resizeImage`, `annotateElements` and `removeAnnotations` are internal actions: they live in the same `ActionMap` but are driven by the background page, not by a CLI command, and a test keeps the map equal to the page commands plus exactly those four
- Annotations are painted into a closed shadow root under a `__firefox_ctl_annotations__` host, so the page's CSS and scripts can neither see nor restyle the badges, and the host is removed after the capture, including when the capture fails

## Content script

- `content.ts` is the composition root: it calls `startPage(realBrowser(), realPage())` but reads no global itself. `realPage()` in `src/content/page.ts` is the only function in the content half that reads a real global, packing `document`, `window`, `raf`, `setTimeout`, `clearTimeout`, `now`, `cssEscape` and the `InputEvent`/`KeyboardEvent`/`Event` constructors into the `Page` interface, plus `inputValueSetter(el)` for the native `HTMLInputElement`/`HTMLTextAreaElement` prototype `value` setter that makes a React-controlled input notice a typed value
- Console capture (`src/content/console.ts`) wraps `Page.console` in place on the first `getConsoleLogs` and listens for `error` and `unhandledrejection` on the window; the ring of 500 belongs to the document, so a navigation starts from silence. The wrapper sits in the content script's world, which Firefox isolates from page scripts: the site's own console calls are not seen, uncaught errors and rejections are, and the result says so with `scope: "content-world"`. `getPageState.errors` reads the last 10 `error` entries of that buffer
- Every action takes `(params, page)` and reaches the DOM only through that `Page`, so bun tests drive them over happy-dom with a virtual scheduler: no real timers, no real `requestAnimationFrame`. A biome `noRestrictedGlobals` rule over `src/content/**` (all but `page.ts`) keeps it that way
- `src/content/actions.ts` is the registry: an `ActionMap` from command name to action, with one entry per page command in `commands.json`. `handleAction(map, page, message)` normalises missing `params` to `{}`, rejects a non-object with `params must be an object`, answers an unregistered name with `Unknown action: <name>` and turns a thrown error into `{success: false, error: message}`
- `startPage` registers a `runtime.onMessage` listener that returns the `Promise<ActionResponse>` from `handleAction` for an action message and `undefined` for anything else. Firefox keeps the message channel open for a returned promise, which is what lets `click --autoWait` and `waitFor` answer seconds later
- Shared building blocks: `selector.ts` validates a selector and polls for a late element (`smartQuerySelector`, 100 ms between double-`raf` frames until the timeout), `timing.ts` holds the frame and sleep helpers, `unique-selector.ts` generates a verified unique selector for an element - the candidate ladder `data-testid`, `aria-label`, id, class combination, `:nth-of-type` path, each checked with `querySelectorAll` before it is returned, `SelectorUnavailable` when none is - and is shared by `read.ts` (`getPageState`), `image.ts` (annotation labels), `text-target.ts` and `suggest.ts`, which builds the `Element not found` message with alternative selectors and page context, `visibility.ts` holds the box-plus-computed-style test the page actions share, and `text-target.ts` resolves the `selector` versus `text` contract of `click` and `getElementInfo`, finds the elements rendering a given text under a scope root - exact on whitespace-normalised `innerText`, case-sensitive, invisible elements skipped - and builds the `AMBIGUOUS_TEXT` refusal; `click` drives it over the poll loop `selector.ts` exposes as `pollUntil`
- The background half sends every page command through `executeInTab` in `src/handlers/dom.ts`: `tabs.sendMessage(tabId, {action, params})` minus `tabId`/`windowId`, a messaging rejection mapped by `src/tab-errors.ts`, a `success: false` reply rethrown with its own text, a non-`ActionResponse` reply (a tab whose content script never loaded resolves with `undefined`) reported as `CONTENT_SCRIPT_ERROR`. The result is returned as `{tabId, ...result}`. `tabs.sendMessage` cannot be cancelled, so a document replaced by a navigation while its reply was pending is caught by the command deadline alone; there is no navigation race and no retry, because `click`, `pressKey`, `type` and `evaluate` may start a navigation as their legitimate effect and a retry would duplicate it
- `waitFor` is also the one page command that waits for a loading tab: `awaitTabComplete` holds it until `tabs.onUpdated` reports `status: complete`, and because the `document_idle` content script may still be missing right after that, the send is retried every 100 ms within the remaining budget. It may do this because it is read-only; `click`, `type`, `pressKey` and `evaluate` may already have run when a send fails, so they keep failing fast with the loading hint
- `waitFor --url` is the one page command that does not reach the content script: `src/handlers/wait.ts` subscribes to `tabs.onUpdated` and `tabs.onRemoved` and then reads `tabs.get`, so the wait survives the navigation it is waiting for, which a promise owned by the outgoing document cannot. `text` and `selector` waits stay in the content script because they target the current document. The glob lives in `src/glob.ts`
- A tab with `status === "loading"` skips the non-HTML and restricted heuristics in `src/tab-errors.ts` and reports `CONTENT_SCRIPT_UNAVAILABLE` with a hint to wait: Firefox shows the URL as the title of a loading tab, which otherwise looks exactly like a non-HTML document, and `about:blank` before the first navigation otherwise looks restricted

## Session state

- One managed window at a time. `src/session.ts` holds `{windowId, tabs, createdAt, groupId, isPrivate, adopted}`; `tabs` is ordered by creation, index 0 is evicted first, `MAX_TABS` is 12. The active tab id is memory-only and re-derived as the last pool tab
- `storage.local` keys: `firefoxCtlWindowState` with that state (or `null`), `firefoxCtlAttachedTabs` with `[tabId, {attachedAt, incognito}][]` from `src/attached.ts`. Attached tabs are user tabs the caller may drive in place; they are never pool tabs, and `dropPoolTabs` enforces that on every command
- Private state never reaches `storage.local`, because add-on policy forbids storing data from a private session. `Session.persist` removes `firefoxCtlWindowState` instead of writing it while `state.isPrivate` is true, and `AttachedTabs.persist` serialises only the entries whose `incognito` is false, so a private window and an attached private tab live in memory for one background lifetime and are gone after a restart. Everything else about them works as usual; only persistence is skipped
- Adopt and sweep after a background restart: `restore()` reads the stored state once per background lifetime (a rejection drops the memo so the next command retries), forgets it when the window is gone, keeps only live tabs and absorbs untracked tabs of a dedicated window. An adopted window's untracked tabs stay the user's. So a disable/enable cycle re-adopts the surviving window instead of opening a sibling
- Pool tabs are grouped under the title `firefox-ctl` when `tabGroups` is available (tab groups landed in Firefox 138, so this is always true given the project's Firefox 155 minimum, but the extension still checks rather than assuming it). `sweepDuplicateWindows()` runs once, riding along on whichever `restore()` call is the first to succeed (the startup one, or a later command's retry after a transient storage failure), and closes a window left by an earlier lifetime only when every tab in it belongs to a `firefox-ctl` group and it is not the current session window. Best effort: without `tabGroups`, or on any failure, it is a no-op
- Events keep the state honest: `windows.onRemoved` clears it, `tabs.onRemoved` drops the tab and re-points the active tab (and forgets an attachment), `tabs.onActivated` tracks the active pool tab; each persists
- Command preamble: every host command except the probes awaits one memoised preamble - `session.restore()`, `attached.restore()` and `dropPoolTabs()` - before the handler and persists the session in a `finally` after it, so a handler that fails half way (a partially applied `createWindow` or `closeTab`) still leaves storage consistent while the original error reaches the host. Concurrent commands share that one in-flight attempt, so storage is read once and the pool drop never interleaves. A preamble failure is reported without persisting, so a transient storage error does not overwrite a live session with an empty one
- Epoch fence: `Session`, `AttachedTabs` and the preamble memo carry an epoch counter. An attempt captures the epoch when it starts and re-checks it after every `await` before touching state or persisting, and resetting a memo bumps the epoch. That is what makes a hung `restore()` recoverable: a command's deadline drops the memo, the next command starts a fresh attempt, and the stale one discards its late writes if it ever resolves
- Adoption: a non-private `createWindow` with no session adds its tab to `windows.getLastFocused()` when that window is `type: "normal"` and not incognito; `closeWindow` then closes only firefox-ctl's tabs and reports `adopted: true`. A private session always gets its own window, with a non-private fallback when the add-on lacks private-window permission

## Extension frames

- `port.onMessage(frame)`: `isHostCommand(frame)` (`type === "command"`) goes to the dispatcher, everything else resolves a pending extension-initiated request by `id`
- Replies to host commands are `{id, success, result|error}` with a real boolean `success`, matching Go `ExtensionMessage`; the host tells replies from requests by that field
- Extension-initiated requests are `{id, command}` with ids from `Environment.randomUUID` and a 150000 ms default timeout; the host answers `ping` and `version` and drops anything else
- Command deadline: `Dispatcher.handle` reads `_timeout` when the frame arrives (truncated and clamped exactly as the host does, default 150000), subtracts a 1000 ms margin so the reply beats the host's own timer, strips `_timeout` from the params the handler sees, and races the whole command - lock wait, preamble, handler and persist - against that one deadline. On expiry it answers `COMMAND_TIMEOUT: <command> did not finish within <ms> ms.`; the command itself keeps running, and its late result is logged and dropped
- State lock: only `createWindow`, `closeTab`, `closeWindow`, `attachTab` and `detachTab` mutate `Session` or `AttachedTabs` across await points, so only they serialise behind `src/lock.ts`, which covers the handler body and the `persist()` after it. Everything else - reads, `navigate`, geometry and the page commands - runs concurrently once the preamble is done, so a hung page command no longer delays the next one. A holder releases the lock when its promise actually settles, never because the dispatcher already answered `COMMAND_TIMEOUT` for it, so a late `tabs.create`, `tabs.remove` or storage write cannot interleave with the next owner
- Screenshot lock: `src/capture-locks.ts` keeps a per-tab `StateLock`, serialising a tab's annotate/`captureTab`/removeAnnotations section so a plain capture can never land mid-annotation and a capture never reports someone else's badges. Unlike the state lock above, badges are cosmetic, so this one is freed once the command's own `CommandContext` deadline passes even if the section is still awaiting the tab; otherwise a content script that never answers (a frozen page) would hold the lock forever and wedge every later capture of that tab, including a plain one that never touches the content script. That early release means the evicted holder may still be mid-annotate when the next capture starts, so it hands off a `staleAnnotations` flag: the next holder clears whatever badges show up before doing anything else. The evicted holder itself is fenced the same way the epoch fence above is: a check right after acquiring the handoff cleanup and again after `annotate` throws before it ever reaches `captureTab` or a fresh `annotateElements`, so a late reply can still paint or clear badges once but can never go on to report a stale image. A waiter whose whole budget elapsed while it queued for the lock is evicted by that same check the instant it acquires: `setTimeout` never fires synchronously, so a deadline that has already passed cannot be trusted to a timer registered only after acquiring, and the check compares the clock directly instead. A reply already in flight to the content script when the eviction happens cannot be recalled - that half is an accepted limit of `tabs.sendMessage`, the same one noted below for `executeInTab`. The registry itself is pruned rather than grown forever: `CaptureLocks.attach`, installed once at startup next to `session.attach()` and `attached.attach()`, drops a tab's entry on `tabs.onRemoved`, so a background page that runs for days does not keep one lock per tab it ever captured. Deleting an entry whose lock is held is safe - a holder or queued waiter works through its own reference, and the `staleAnnotations` handoff lives in that object rather than in the map - and because Firefox never reuses a tab id within a browser session, an entry recreated for that id can never belong to a different tab. The handler takes its entry synchronously right after `resolveTargetTab`, before the first `await`, so a tab closed during `waitForPageReady` cannot have its entry pruned and then recreated by the request still in flight
- `ping` and `version` bypass the startup restore, the preamble and the lock: liveness must not depend on session state or on another command finishing
- The `reply` closure captures the port a command arrived on, so an answer produced after a reconnect is logged and dropped instead of landing on the new port
- Unknown or unregistered commands come back as `success: false` with `UNKNOWN_COMMAND: <name>`; a handler throwing a non-`ExtensionError` is stringified into the same `error` field. There is no `code` or `details` on the wire, the prefix carries the code
- `runtime.onMessage` answers `getConnectionStatus` with `{connected, attempt, lastDisconnectReason, reconnectScheduled}` and returns `undefined` for anything else

## Reconnect

- States: `disconnected`, `connecting`, `connected`, `waiting(attempt)`, at most one pending timer
- Both a synchronous `connectNative` throw and `onDisconnect` schedule `waiting` with `min(1000 * 1.5^attempt, 30000)` ms: 10 attempts, 1000 ms initial, x1.5, 30000 ms cap
- A disconnect rejects every pending request with `port.error?.message` and clears its timer
- The attempt counter resets only after a connection proves stable: the first frame or 5 s, whichever comes first
- After 10 failed attempts the link stops, logs, resets the counter and waits for an explicit `connect()`

## Dependency injection

`background.ts` and `content.ts` are the composition roots: the former calls `realBrowser()` and `realEnvironment()`, the latter `realBrowser()` and `realPage()` (defined in `src/content/page.ts`, see above). `NativeLink`, `Dispatcher` and the handlers receive the `Browser` and `Environment` interfaces, so bun tests run with fakes, a manual clock, virtual timers and deterministic UUIDs.

## Layout

```
firefox-ctl/
├── cli/
│   ├── cmd/firefox-ctl/          # main, cobra root, host and client subcommands
│   ├── internal/nativemsg/  # stdio framing
│   ├── internal/host/       # socket server, correlation, timeouts
│   ├── internal/client/     # socket client
│   ├── internal/ipc/        # socket path
│   ├── internal/protocol/   # command names, param and result types
│   ├── scripts/cover.sh     # per-package coverage gate
│   ├── go.mod  Makefile  README.md  .golangci.yml
├── extension/
│   ├── src/background.ts    # background entry, real globals only here
│   ├── src/app.ts           # dispatcher + native link + runtime messaging
│   ├── src/port.ts          # native port, correlation, reconnect backoff
│   ├── src/dispatch.ts      # command table, ping/version, command deadline
│   ├── src/lock.ts          # state lock for the mutating commands
│   ├── src/capture-locks.ts # per-tab screenshot locks, pruned on tab close
│   ├── src/memo.ts          # epoch-fenced memo for restore and the preamble
│   ├── src/tab-errors.ts    # tab error mapping, loading-aware
│   ├── src/glob.ts          # waitFor --url glob
│   ├── src/session.ts       # managed window, tab pool, persistence, sweep
│   ├── src/attached.ts      # attached user tabs
│   ├── src/network.ts       # webRequest tracker behind getNetworkRequests and readiness
│   ├── src/readiness.ts     # waitForPageReady, the gate before a capture
│   ├── src/handlers/        # window, tab, attachment, page, screenshot and devtools handlers
│   ├── src/devices.ts       # setViewport presets
│   ├── src/protocol.ts      # wire contract, mirrors internal/protocol
│   ├── src/commands.json    # command names, kept equal to internal/protocol's fixture
│   ├── src/messages.ts      # in-browser message shapes
│   ├── src/settings.ts      # the two stored settings and their defaults
│   ├── src/options.ts       # preferences page logic and its DOM binding
│   ├── src/content.ts  src/page.ts   # content script entry and its listener
│   ├── src/content/         # Page interface, action registry and the page actions
│   ├── src/browser.ts  src/env.ts    # injected browser and environment
│   ├── manifest.json  options.html  package.json  bunfig.toml  build.ts  README.md
│   └── test/                # bun test, fakes, happy-dom preload
└── docs/
```
