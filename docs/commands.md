# Commands

Every command the CLI and the extension understand; the ones deliberately left out are listed under Dropped. Command names, parameter names and result shapes are stable so agent prompts keep working across versions. Invocation: `firefox-ctl <command> [--key value ...]`; nested or array values via `--json '{...}'`.

All commands accept `--request-timeout <ms>` (5000-300000, default 150000), sent as `_timeout`; the name avoids a clash with waitFor's own `timeout` parameter. Output is JSON on stdout; errors go to stderr with a non-zero exit code and the extension's error message. The message starts with a stable prefix where one is defined: `TAB_CLOSED`, `TAB_UNAVAILABLE`, `NO_TABS`, `MODE_MISMATCH`, `RESTRICTED_PAGE`, `PAGE_LOAD_FAILED`, `CONTENT_SCRIPT_UNAVAILABLE`, `CONTENT_SCRIPT_ERROR`, `COMMAND_TIMEOUT`, `SCREENSHOT_TOO_LARGE`, `EVALUATE_DISABLED`, `AMBIGUOUS_TEXT`. A `details` object from the extension is not forwarded.

The extension honours `_timeout` too: it gives every command a deadline 1000 ms shorter than the host's, covering the wait for the state lock, the session preamble, the handler and the persist, and answers `COMMAND_TIMEOUT: <command> did not finish within <ms> ms.` when that budget runs out, so a page that never replies is reported rather than hung. A timed-out command is answered, not cancelled: whatever it produces afterwards is logged and dropped. Only `createWindow`, `closeTab`, `closeWindow`, `attachTab` and `detachTab` serialise against each other; every other command runs concurrently, and `ping` and `version` skip the session entirely so they answer while another command is stuck. `screenshot` adds one more, narrower exception: every capture of the same tab serialises behind a per-tab lock around its own annotate/capture/remove section, so a plain capture can never land mid-annotation; that lock is freed once the command's own deadline passes, so a tab whose content script never answers cannot wedge later captures of it forever.

## Session model

`createWindow` opens or reuses the one managed window with a pool of 12 tabs and makes the new tab the active one. When the pool is full the oldest tab is evicted and its id comes back as `closedOldestTab`. Page and tab commands without `tabId` act on that active tab.

Windows are private by default. `createWindow --private=false` asks for a normal window and, when there is no session yet, adopts the user's last focused normal window instead of opening another one; the extension then adds and removes only its own tabs there. When Firefox denies private windows (the add-on lacks "Run in Private Windows") the handler retries non-private and reports `privateFallback: true` plus a `modeWarning`, and the session counts as non-private from then on. Asking for a mode that differs from the live session fails with `MODE_MISMATCH: Requested <a> mode, but existing window is <b>.`

An explicit `tabId` names any existing tab - a pool tab, an attached tab or a plain user tab - and no session is required for it: the tab is verified with `tabs.get` and used as is, so `getActiveTab` followed by `navigate --tabId` works in an adopted window. An id whose tab is gone gives `TAB_CLOSED: Tab <id> no longer exists.` Without a session and without `tabId` the extension returns `Tab session lost: call createWindow to start a new tab.`; a session whose window or tabs disappeared gives `Window expired. Call createWindow.`, `NO_TABS: ...` or `TAB_UNAVAILABLE: ...`.

`attachTab` brings any existing user tab under control without moving it. Attached tabs are never part of the pool, survive a background restart and are forgotten when the tab closes; `listAllTabs` flags every tab with `pool` and `attached`. Session and attachments live in `storage.local`, so a background restart adopts the surviving window instead of spawning a sibling (see `docs/architecture.md`). A private window and an attached private tab are the exception: nothing about a private session is written to disk, so they do not survive a restart and a new `createWindow` opens a fresh private window.

There are no agent ids, so no result carries an `ownerId`, there are no slot or reservation fields and no `POOL_FULL` error: eviction always removes the oldest pool tab, and `closeTab` and `closeWindow` need no agent id.

## Browser control

| Command | Params | Notes |
|---|---|---|
| ping | - | forwarded to the extension, like every other command |
| version | - | `{extension, features}`: the extension version and its feature list, and no user agent, so the add-on reports nothing about the browser or the machine |
| createWindow | [url], [private] | private by default when allowed, otherwise a normal window; `{windowId, tabId, tabCount, maxTabs: 12, isNewWindow, isPrivate, privateFallback, closedOldestTab, message}` plus `modeWarning` on a fallback; no `ownerId`, no slot fields |
| navigate | url, [tabId], [windowId] | |
| canNavigate | - | legacy: returns `isAllowedIncognitoAccess`; kept for compatibility |
| getWindowMode | - | privateWindowsAvailable, currentWindowMode, windowExists |
| getActiveTab | - | |
| getTabs | - | managed pool tabs |
| listAllTabs | - | every Firefox tab with attached flag |
| attachTab / detachTab | tabId | |
| closeTab | tabId | pool tab: `{closed, tabId, tabCount, maxTabs, message}`; attached tab: `{closed, tabId, attached: true, message}`; an unknown id errors with the available pool tabs |
| closeWindow | - | `{closed, windowId, tabsClosed}`; an adopted user window survives, only firefox-ctl's tabs close, and the result adds `adopted: true` with a message |
| getWindows | - | |
| resizeWindow | [windowId], [width], [height], [left], [top] | |
| setViewport | [windowId], [device] or [width], [height] | device presets: iphone-se, iphone-14, iphone-14-pro-max, pixel-7, galaxy-s23, ipad-mini, ipad-pro-11, ipad-pro-12 and the rest of the table in `src/devices.ts` |

## Page interaction

Every page command resolves its target tab in the background page and then runs the action of
the same name in that tab's content script, so the result is always the content script's own
object with the resolved `tabId` merged in. A tab that cannot host a content script answers
with the coded errors above (`RESTRICTED_PAGE`, `PAGE_LOAD_FAILED`, `CONTENT_SCRIPT_UNAVAILABLE`,
`CONTENT_SCRIPT_ERROR`, `TAB_CLOSED`); a refused action keeps the content script's plain
message, for example `Element not found: #missing`. A tab that is still loading is never
reported as a restricted or non-HTML page: it answers `CONTENT_SCRIPT_UNAVAILABLE: Tab <id>
is still loading <url>. Wait for it to finish (waitFor --selector or --url) and retry.`

`waitFor` is the one exception. A `--text` or `--selector` wait first holds the tab until
`tabs.onUpdated` reports `status: complete`, and because the `document_idle` content script
may still be missing for a moment after that, it re-sends the action every 100 ms until the
tab answers or its own `timeout` runs out; a tab that never finishes loading produces the
wait's own message (`Timeout waiting for element: <s>`), never `COMMAND_TIMEOUT`. Only
`waitFor` may do this: it is read-only, so a repeated send costs nothing, while `click`,
`type`, `pressKey` and `evaluate` may already have run once when a send fails and a retry
would duplicate their effect. They keep failing fast with the loading hint and leave the
decision to the caller. Nothing else retries on its own.

A selector is validated before use: `selector is required and must be a string`,
`selector cannot be empty`, `selector too long (max 1000 characters)`,
`Invalid CSS selector: <message>`. When `click` or `type` cannot find their element the
message continues with `Suggested alternatives:` (up to five, each with a reason), a
`Page context:` block with URL and title, a warning when the frame is not the top one, and
`Hint: Use getPageState to see available elements.` A required non-selector param missing
its value fails the same way: `text is required` for `type`, `key is required` for
`pressKey`, `expression is required` for `evaluate`.

### Text targeting

`click` and `getElementInfo` can name their target by the text a user reads instead of by a
selector: `selector` and `text` are mutually exclusive, by presence rather than by value, so a
call carrying both fails with `selector and text are mutually exclusive` and a call carrying
neither keeps the selector message above. A match is exact on whitespace-normalised visible text
and case-sensitive. The text read is `innerText`, so `<br>` and block boundaries become spaces
and hidden parts are left out - `<button>Apply<br>now</button>` matches `Apply now` and
`<button>Ap<span hidden>X</span>ply</button>` matches `Apply` - runs of whitespace and
non-breaking spaces collapse to one space, and a button whose `text-transform: uppercase`
renders `Apply` as `APPLY` matches `APPLY`, because that is what the user sees. Invisible
elements are skipped, by the test `getElementInfo.visible` reports: a non-zero box plus computed
`display` other than `none` and `visibility` other than `hidden`. An off-screen element is
visible and `click` scrolls it into view as it does for a selector. `text` must be a string,
must not be empty once normalised and is at most 500 characters measured on the raw value:
`text must be a string`, `text cannot be empty`, `text too long (max 500 characters)`.

`scope` narrows the search to one element found by CSS selector and is accepted only together
with `text`: `scope requires text`, `scope must be a string`, `scope cannot be empty`, the
selector validation messages above, `Scope not found: <scope>` and `Scope is ambiguous: <scope>
matches <n> elements`. Without it the search starts at `documentElement`. `click` re-resolves
the scope at every probe of its wait, so a dialog that is re-rendered while the wait runs is
followed rather than searched in its stale element.

The two commands pick a different element out of the same matches. `click` maps every match to
its nearest actionable ancestor-or-self inside the scope - the actionable set is `button,
a[href], input[type=button], input[type=submit], [role=button], summary, label` - keeps it only
when that ancestor's own visible text also equals the query, and deduplicates by identity, so a
`<div>` wrapping a single `Apply` button resolves to the button, while
`<button><span>Apply</span> changes</button>` is not a match for `Apply` at all, because the
button renders `Apply changes`. Text that is never rendered as text is never matched:
`<input type="submit" value="Apply">` and `<button aria-label="Apply"></button>` need
`--selector`. `getElementInfo` takes the deepest match instead - the innermost element rendering
exactly that text - so `<p><b>Total</b> 42</p>` with `--text Total` answers the `b`.

More than one target left after that is a refusal, never a guess: `AMBIGUOUS_TEXT: "<text>"
matches <n> elements: <sel1>, <sel2>` names up to five candidates and then `and <k> more`, each
one a verified selector or `<tag (no unique selector)>` where none verifies. It is raised as
soon as the second target is seen, so `click` presses nothing and does not wait out its timeout
first. No target at all is `Element not found: text "<text>"`, with the `Suggested
alternatives:`, `Page context:` and `Hint:` blocks a failed selector gets, the alternatives
taken from the page's buttons and links. `click --text` polls on the same `autoWait` and
`waitTimeout` schedule as `click --selector` and clicks its target only while it is still
connected after the scroll; `getElementInfo` probes once, because reading never auto-waits.

Both results say how the element was found: `matchedBy` is `"selector"` or `"text"`, and in text
mode `selector` holds a selector generated for the element, or `null` when the generator cannot
describe it (see Selectors), so the answer can be handed straight to `type`, `waitFor` or a
second `click`. Only these two commands read `text` as a target.
`type --text` is the text to type
and `waitFor --text` is an unnormalised substring wait over `body.innerText`; both keep that
meaning, and neither takes `scope`.

| Command | Params | Notes |
|---|---|---|
| getContent | [selector], [includeHtml], [maxLength=50000] | text is `textContent` trimmed; with a selector `{selector, text, tagName, textLength, truncated}`, without one `{url, title, text, textLength, truncated}`; `includeHtml` adds `html` - `innerHTML` of the element, `documentElement.outerHTML` for the page; over `maxLength` the text ends in `\n\n[... truncated, use selector for specific content]` |
| click | selector \| text, [scope], [autoWait=true], [waitTimeout=5000] | polls every 100 ms until `waitTimeout` when `autoWait`, scrolls the element into view, then `element.click()`; `{selector, clicked: true, tagName, text, id, className, matchedBy}` with `id` and `className` null when absent and `matchedBy` naming the parameter that found the element, `"selector"` or `"text"`. With `text` the nearest actionable ancestor-or-self wins, two or more targets answer `AMBIGUOUS_TEXT` without clicking and `selector` is generated for the element, or `null`; see Text targeting above |
| type | selector, text, [clear=true], [autoWait], [waitTimeout] | React/Angular compatible input events: the native value setter, then `input` (`inputType: "insertText"`) and `change`; contenteditable elements are written through `textContent`; anything else errors `Element is not editable: <selector>`; `{selector, typed, currentValue}` |
| pressKey | key, [selector], [ctrlKey], [shiftKey], [altKey], [metaKey] | focuses the selector target, else `activeElement` or `body`; dispatches `keydown`, `keypress` (single characters only) and `keyup` with the `code` and `keyCode` maps of `src/content/interact.ts`; `{key, selector, targetTag, modifiers}`, `selector` being `"(active element)"` when none was given |
| scroll | [selector], [x], [y], [behavior=smooth] | selector: `{selector, scrolledTo: true, elementPosition}`; coordinates: `{scrolledTo: true, noEffect, position}`, a missing axis keeping its current value; neither: `{position, pageHeight, viewportHeight}`. On an inactive tab the result adds `backgroundTab: true` and `hint: "Scroll has no effect on background tabs. Switch tab to active first."` |
| waitFor | [selector], [text], [url], [timeout=10000], [interval=100] | one mode per call, `text` first, then `url`, then `selector`, so a call carrying both `--url` and `--selector` waits for the URL: `{text, found, elapsed}`, `{url, matched, found, elapsed}` or `{selector, found, elapsed, visible, position}`. `url` is a glob anchored at both ends where only `*` is a wildcard. Timeouts error `Timeout waiting for text: "<t>"`, `Timeout waiting for URL matching: "<u>"`, `Timeout waiting for element: <s>`; no mode at all gives the selector validation error. The `url` wait runs in the background on `tabs.onUpdated`, not in the content script, so it survives the navigation it is waiting for; `interval` is accepted for compatibility and ignored there, and its `timeout` is capped by what is left of `--request-timeout`. The `text` and `selector` waits wait for the tab to finish loading first, as described above, and their `elapsed` covers both phases |
| screenshot | [format], [quality=60], [scale=0.5], [purpose], [annotate], [maxWait=10000], [waitForImages=true], [skipReadiness] | `{tabId, format, quality, scale, dataUrl, readiness}`, plus `originalSize` and `scaledSize` whenever the image went through the resizer, `labels` with `--annotate` and `reduced` when the reply had to be shrunk. See Screenshots |
| handleConsent | [scanTimeout=3000] | four-pass cookie-banner dismissal: `{found, clicked, buttonText, method, elapsed}`, the last two `null` when nothing matched. See Consent |

## Page analysis

| Command | Params | Notes |
|---|---|---|
| getPageState | [maxHeadings=30], [maxLinks=50], [maxButtons=30], [maxInputs=30], [maxImages=20] | the limits are forwarded to the content script. `{url, title, viewport, errors, headings, links, buttons, inputs, images, landmarks, counts}`; links, buttons and inputs are filtered to visible elements and images to those larger than 20x20, but headings and landmarks are listed regardless of visibility; password values are masked as `***`, input labels come from `aria-label`, `placeholder` or `label[for]`, images need alt text and more than 20x20; `counts` holds `{shown, total}` per group. Every returned link, button and input also carries a `selector`, generated for the entries that survive the limits, not for the ones dropped by them; see Selectors below. `errors` holds the messages of the last 10 captured `error` entries, so it stays `[]` until the first `getConsoleLogs` turns console capture on (see DevTools) |
| getAccessibilitySnapshot | [selector=body], [maxDepth=5], [maxNodes=200] | `{url, title, tree, nodeCount, maxNodes, truncated}`; invisible nodes are skipped except the root, a `div`/`span`/`p` with no role, name or text collapses into its children, node fields are `role, name, text, disabled, checked, expanded, selected, value` and appear only when set |
| getElementInfo | selector \| text, [scope] | `{selector, tagName, attributes, text, visible, position, styles, matchedBy}` with the computed `display`, `visibility`, `opacity`, `color`, `backgroundColor` and `fontSize`; a missing element errors `Element not found: <selector>` with the same diagnostics as `click` and `type`: `Suggested alternatives:` when the page holds a near candidate, then `Page context:`. `getContent` keeps the bare message. With `text` the deepest element rendering that text wins, a miss is `Element not found: text "<text>"`, two or more matches answer `AMBIGUOUS_TEXT`, `matchedBy` is `"text"` and `selector` is generated for the element, or `null`; there is no auto-wait, see Text targeting |
| evaluate | expression | off until the user ticks "Allow the `evaluate` command" in the add-on preferences (about:addons > Terminal Control for Firefox > Preferences); while it is off the command fails with `EVALUATE_DISABLED: evaluate is disabled; enable it in the add-on preferences (about:addons > Terminal Control for Firefox > Preferences)` and no message reaches the tab. The opt-in is read on every call, so a toggle takes effect at once, and only the browser can set it - no CLI flag turns it on. Once on there is no length cap or blocklist; it runs `new Function("return (<expression>)")` in the content script's isolated world, so only the DOM is reachable, not the page's own globals. `{expression, result, type}` with `result` JSON round-tripped (anything unserialisable becomes its string form); a throwing expression is a successful reply with `{expression, error, type: "error"}` |

### Selectors

`getPageState` entries, `screenshot --annotate` labels and every suggested alternative of an
`Element not found` message come from one generator. Its guarantee is narrow and exact: the
returned selector matches exactly one element in the light DOM of the page document and that
element is the one described, so it is
unique in the current DOM at the time of the call.
It is not stable across re-renders - a framework that rebuilds the tree may invalidate it, so
a selector is meant to be used right away, not stored. Every candidate is verified with
`querySelectorAll` before it is returned, and where none verifies the field is
`null` when no verified selector exists,
never an unverified guess. A shadow-root or detached element is the documented failure case.

Candidates are tried in order: `[data-testid="..."]`, `[aria-label="..."]`, `#id` (after the
class combination when the id looks generated - all digits, a run of six hex characters or a
trailing `-<digits>`), the element's class combination, then an `:nth-of-type` path rooted at
`body`; identifiers and attribute values are CSS-escaped, identifiers through `CSS.escape` and
attribute values as double-quoted CSS strings, so an id starting with a digit or a
`data-testid` holding a quote, a backslash or a newline still resolves.

## Screenshots

`screenshot` renders a tab with `tabs.captureTab`, which renders a background tab as it is:
no tab is activated, and a capture of a tab the user is not looking at leaves their window
alone. A per-tab lock exists for one reason: `--annotate` numbers a tab's
elements before the capture and clears the badges after it, and every capture of that tab -
annotated or not - queues behind that section, so a plain capture can never land mid-annotation
and come back with someone else's badges baked into an image it never asked to be annotated.
The lock is freed once a capture's own deadline passes even if it is still waiting on the tab
(see above), so a request evicted mid-annotate hands its cleanup duty to whichever request the
eviction let in next, rather than clearing badges that may by then be someone else's.

`purpose` names a preset over `quality` and `scale`; an explicit `--quality` or `--scale`
still wins over it, and without a purpose the defaults are JPEG at quality 60 and scale 0.5:

| --purpose | quality | scale |
|---|---|---|
| quick-glance | 30 | 0.25 |
| read-text | 60 | 0.5 |
| inspect-ui | 80 | 0.75 |
| full-detail | 95 | 1.0 |

`--format png` captures a PNG, which carries no quality. Any scale below 1 is applied in the
content script - an `Image` decode drawn into a canvas of the scaled size - so those replies
also carry `originalSize` and `scaledSize`.

`--annotate true` numbers up to 30 interactive elements (`button`, `a[href]`, `input`,
`select`, `textarea`, `[role=button]`, `[role=link]`, in that order) with red badges and
returns `labels`, a map from the badge number to `{selector, text, role}`, so a vision model
can read a number off the image and hand it back as a selector. `labels[n].selector` comes from
the generator of Selectors above and carries its guarantee; it is `string | null`, `null` for an
element the generator cannot describe, which still keeps its badge, text and role. The badges
live in a closed shadow root under `__firefox_ctl_annotations__`, out of reach of the page's CSS and scripts, and
are removed after the capture, including when the capture fails. An element with no box at
all is skipped. Annotation is cosmetic: a page that refuses it is still captured, just
without `labels`.

### Readiness

Unless `--skipReadiness`, the handler waits for the tab to settle before it captures. A tab
the network tracker already reports idle goes straight to the render check; otherwise:

1. **critical idle** - poll every 25 ms until no `script`, `stylesheet`, `xmlhttprequest`,
   `fetch`, `main_frame` or `sub_frame` request of that tab is pending. A request that stalls
   without any new activity for three idle thresholds (450 ms) ends the phase as
   `critical_timeout` instead of holding the capture until `maxWait`
2. **visual idle** - the same for `image`, `font` and `media`, capped at 3000 ms. Skipped by
   `--waitForImages=false`
3. **render check** - `checkPageReadiness` inside the tab: a double `requestAnimationFrame`
   with a 100 ms fallback, the number of running animations where `document.getAnimations`
   exists, and one `requestIdleCallback` slice with a 100 ms timeout where that exists. A
   hidden tab throttles both, which is what the fallbacks are for

Every phase is bounded by `maxWait` (10000 ms) and by what is left of `--request-timeout`
minus 500 ms kept back for the capture itself, so a caller with little budget left gets a
short wait and an image rather than a `COMMAND_TIMEOUT`. Readiness never fails the command:
whatever goes wrong is a timeline entry (`render_check_failed` for an unreachable content
script) and the capture proceeds. The result reports it as
`readiness {waitMs, timedOut, timeline}`, the timeline being `{t, event, ...}` entries from
`start` to `complete`.

### The frame limit

The host drops any extension frame over 10 MiB, so the handler measures the serialised reply
and keeps it under 9 MiB. Over that it re-encodes the image it already has - never a second
capture, so a long page costs one render however far this goes - down a ladder: a PNG becomes
a JPEG at quality 80 first, then quality falls in steps of 10 to a floor of 20, then scale is
multiplied by 0.75 per step to a floor of 0.25, at most 8 steps. `format`, `quality` and
`scale` in the result are the values actually applied, and `reduced {from, to, steps}` records
the downgrade. When both floors are reached and the reply still does not fit, the command
fails with `SCREENSHOT_TOO_LARGE: <bytes> exceeds the 10 MiB frame limit; lower --scale or
--quality.` rather than letting the host drop the frame and the client time out.

## Consent

`handleConsent` looks for the button that dismisses a cookie banner and clicks it. Four
passes run in order and the first hit wins, each candidate having to be visible (a non-zero
box, `display` and `visibility`), the whole scan bounded by `scanTimeout` (3000 ms) on the
page clock:

1. `cmp-selector` - the known accept buttons of the common consent platforms: Google
   (`#L2AGLb`), OneTrust, Quantcast, Didomi, Cookiebot, plus the generic shapes they share
   (`[id*="accept"][id*="cookie"]`, `[class*="accept-all"]` and friends)
2. `text-match` - every `button`, `[role=button]`, `input[type=submit]` or `input[type=button]`
   in the document whose label matches an accept pattern. A candidate inside a `role=dialog`
   subtree is left to pass 4, which reports it more precisely
3. `shadow-dom` - both searches again inside the open shadow roots of likely consent hosts
   (`div[id*="consent"]`, `div[class*="cookie"]`, `#usercentrics-root` and the rest); a closed
   root reports none and is skipped silently
4. `aria-dialog` - the label match inside `[role="dialog"]` and `[role="alertdialog"]`

The accept patterns match whole labels only (`i agree`, `accept all`, `accept all cookies`,
`allow all`, `allow all cookies`, `agree`, `got it`, `consent`), so "Accept all except
tracking" is not clicked, and a label containing `reject`, `decline`, `refuse`, `deny` or
`no thanks` never counts as an accept whatever else it matches. `buttonText` is the element's
text, or its `aria-label` for an icon-only button, capped at 50 characters. The match is
scrolled into view, given a frame to settle, and clicked.

The result is `{found: true, clicked: true, buttonText, method, elapsed}` with `method` being
one of the four names above, or `{found: false, clicked: false, buttonText: null, method: null,
elapsed}` when no pass matched - which is also what a second call reports once the banner is
gone.

All four passes see only the tab's main document: the content script is injected with
`all_frames: false`, and a cross-origin `<iframe>` is opaque to it anyway. Consent platforms
that render the banner inside such a frame (Sourcepoint on theguardian.com, for example)
therefore report `found: false` even while the banner is on screen. That is a limit of the
content script, not a failure, and no other command reaches into that frame either
(`evaluate` and `click` run in the main document too). Dismiss such banners by hand.
Reaching into frames would need `all_frames: true` plus a per-frame dispatch in the
background and is out of scope.

## DevTools

| Command | Params | Notes |
|---|---|---|
| getConsoleLogs | [level], [clear], [limit=100] | `{logs, total, filtered, captureEnabled, scope: "content-world"}`; capture is enabled by the first call |
| getNetworkRequests | [type], [status], [clear], [limit=50], [includeHeaders] | `{tabId, requests, total, filtered}` over a 200-entry buffer shared by every tab |

### Console

Capture is lazy: the first `getConsoleLogs` wraps the content script's
`console.log`, `warn`, `error`, `info` and `debug` and adds `error` and `unhandledrejection`
listeners on the window. Nothing before that first call is recorded, and each document has
its own buffer, so a navigation starts from silence.

The wrapper lives in the content script's world, which Firefox isolates from page scripts, so
the site's own `console.log` calls are not seen. What does cross the boundary and is captured
as an `error` entry: uncaught page errors (`Uncaught Error: <message> at <file>:<line>:<col>`)
and unhandled rejections. Anything `evaluate` prints is captured too, because it runs in the
same world. The result says which world it is through `scope: "content-world"`; there is no
main-world bridge.

Entries are `{level, timestamp, message}` in a ring of 500, the oldest dropped. Arguments are
joined with a space, objects through `JSON.stringify(arg, null, 2)`, anything that cannot be
serialised as `[Unserializable]`. `level` filters, `limit` (100) keeps the newest, and
`clear` empties the buffer after the reply has been built, so the call returns the old logs
with `total: 0`. `getPageState.errors` reads the last 10 `error` entries of the same buffer.

### Network

The background page logs every request Firefox makes through `webRequest` over `<all_urls>`:
`{requestId, url, method, type, tabId, timestamp, status, statusCode?, responseHeaders?,
duration?, error?}`, where `status` is `pending`, `completed` or `error`. The buffer holds
200 entries, oldest dropped, and is shared by every tab; `getNetworkRequests` filters it down
to the resolved tab. Only metadata is kept - request bodies never are - and query values are
replaced with `[REDACTED]` when the key contains, case-insensitively, `password`, `passwd`,
`pwd`, `token`, `api_key`, `apikey`, `secret`, `auth`, `key` or `credential`.

Response headers are stripped unless `--includeHeaders`. Even then the credential-bearing ones
- `set-cookie`, `cookie`, `authorization`, `proxy-authorization`, `www-authenticate` and
`proxy-authenticate`, matched case-insensitively - keep their name but come back with the value
`[redacted]`. That is the default; the only way to see the raw values, `Set-Cookie` among them,
is to untick "Redact credential response headers" in the add-on preferences
(about:addons > Terminal Control for Firefox > Preferences). The setting is read on every call, so a toggle takes
effect at once, and the buffer itself always holds the raw headers - redaction happens on the
way out. `--type` and `--status` filter, `--limit` (50) keeps the newest, and `--clear`
empties the whole buffer - not only the target tab's share - after the
reply has been built, so the call returns the old requests with `total: 0`.

The same buffer drives the screenshot readiness pipeline, which looks at the pending requests
of the last 2000 ms. A `--clear` therefore leaves every tab looking idle until new requests
arrive, and a `screenshot` issued right after one can capture a page that is still loading;
`--maxWait` cannot help there, because there is nothing left to wait for.

All page commands additionally accept `tabId` and `windowId`.

## Dropped

- MCP server and its tool wrappers
- Settings: `setPrivateMode` (private mode decided per `createWindow --private`), popup, screenshot compression preference, `adoptCurrentWindow` toggle. Two settings do exist, both in the add-on preferences and neither reachable from the CLI: the evaluate opt-in and header redaction
- Security: auth token, command whitelist, URL scheme whitelist, evaluate length cap and blocklist. The evaluate gate itself stays, as a checkbox the user ticks in the browser
- Multi-agent coordination that needs an MCP agentId: `requestTabSpace`, `grantTabSpace`, `getSlotRequests`, `cleanupOrphanedTabs`, `goodbye`, tab ownership checks, per-owner eviction, slot reservations and the `POOL_FULL` error
- Focus loops (`startLoop`, `stopLoop`, `getLoopState`, `incrementLoopIteration`): Claude Code plugin feature, not browser control
- Watermark visuals and welcome/support pages
