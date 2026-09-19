# firefox-ctl extension

The Firefox side of firefox-ctl: an MV2 WebExtension that connects to the
`firefox-ctl` native messaging host, runs the commands the CLI sends and answers with the
result. Transport and frame shapes are documented in [`../docs/architecture.md`](../docs/architecture.md),
the command set in [`../docs/commands.md`](../docs/commands.md).

Extension ID `firefox-ctl@firefox-ctl.dev`, native host name `firefox-ctl`, minimum Firefox 155.0.

## Requirements

- [bun](https://bun.sh) 1.4.2, the version the shipped bundles are built with
- Firefox 155 or newer
- the `firefox-ctl` binary built from [`../cli`](../cli), for anything end to end

## Install dependencies

```
bun install --frozen-lockfile
```

`--frozen-lockfile` installs exactly what `bun.lock` records, which is what a release build
and the AMO source review use; plain `bun install` is fine for local hacking.

## Build

```
bun run build
```

`build.ts` runs `Bun.build` over `src/background.ts`, `src/content.ts` and `src/options.ts`
into `dist/` as classic IIFE scripts, because MV2 background, content and options scripts are
not modules. `dist/` is a build artefact: it is gitignored and `manifest.json` points at
`dist/background.js`, `dist/content.js` and `options.html` at `dist/options.js`, so the add-on
only loads after a build.

[`BUILD.md`](BUILD.md) is the same build written out for the AMO source reviewer:
bun 1.4.2, `bun install --frozen-lockfile`, `bun run build`, and how to compare the three
bundles with the ones inside the xpi. It links nowhere outside this directory, because the
source archive contains only `extension/`.

## Test and lint

```
bun test           # unit, contract and build tests
bun run check      # tsc --noEmit and biome check
bun run lint       # biome only
```

From the repository root the same three run as `make ext-build`, `make ext-test` and
`make ext-check`.

Tests never touch a real browser: `test/fakes.ts` provides a typed `FakeBrowser`,
`FakePort` and `FakeEnvironment` with a manual clock and deterministic UUIDs, and
happy-dom is registered through the `bunfig.toml` preload for the DOM side.

## Run it against Firefox

1. Build both halves:

   ```
   make -C cli build
   cd extension && bun run build
   ```

2. Register the native host once, so Firefox knows how to spawn it:

   ```
   cli/firefox-ctl install
   ```

   This writes `~/Library/Application Support/Mozilla/NativeMessagingHosts/firefoxctl.json`
   on macOS, `~/.mozilla/native-messaging-hosts/firefoxctl.json` on Linux, with the absolute path of the
   binary and `firefox-ctl@firefox-ctl.dev` in `allowed_extensions`. Re-run it after moving
   the binary.

3. Install the add-on from AMO:
   [Terminal Control for Firefox](https://addons.mozilla.org/en-US/firefox/addon/firefox-ctl/).
   Firefox starts the host on its own; there is no daemon to run by hand. "Inspect" in
   about:debugging opens the background console, where the link logs connects,
   disconnects and reconnect attempts.

4. Talk to it:

   ```
   cli/firefox-ctl ping       # {"pong": true, "timestamp": ...}
   cli/firefox-ctl version    # extension version and features
   ```

Reloading the add-on after a rebuild restarts the background page and reconnects the port.

## A session, end to end

```
cli/firefox-ctl createWindow --url https://example.com   # private window, tab 1/12
cli/firefox-ctl getTabs                                  # the pool: windowId, tabs, tabCount, maxTabs
cli/firefox-ctl navigate --url https://mozilla.org       # the session's active tab
cli/firefox-ctl setViewport --device iphone-14           # resize the window around a 390x844 viewport
cli/firefox-ctl listAllTabs                              # every Firefox tab, flagged pool / attached
cli/firefox-ctl attachTab --tabId 7                      # drive one of your own tabs in place
cli/firefox-ctl navigate --url https://mozilla.org --tabId 7
cli/firefox-ctl detachTab --tabId 7
cli/firefox-ctl closeTab --tabId 2                       # a pool tab, or an attached one
cli/firefox-ctl closeWindow                              # ends the session
```

`createWindow` is the entry point: it opens the single managed window, or adds a tab to the
existing one, evicting the oldest of the 12 when the pool is full. Windows are private
unless you pass `--private=false`, which instead adopts your last focused normal window and
touches only the tabs firefox-ctl put there - `closeWindow` on an adopted session leaves your own
tabs alone. Without a private-windows permission the first `createWindow` falls back to a
normal window and says so in `privateFallback` and `modeWarning`; `cli/firefox-ctl getWindowMode`
reports what is available.

Commands without `--tabId` act on the session's active tab. An explicit `--tabId` names any
existing tab - pool, attached or a plain user tab - and needs no session at all, so
`getActiveTab` followed by `navigate --tabId` works in an adopted window.

The session lives in `storage.local` (`firefoxCtlWindowState`, `firefoxCtlAttachedTabs`), so
disabling and re-enabling the add-on, or any other background restart, re-adopts the
surviving window instead of opening a second one. A private session is never written there,
so a private window and an attached private tab are gone after a restart and the next
`createWindow` opens a fresh one. `docs/commands.md` has the full command set and every
error text.

## Driving a page

Once a tab exists, the page commands run inside it through the content script. They take
`--tabId` like every other tab command and default to the session's active tab.

```
cli/firefox-ctl createWindow --url https://example.com
cli/firefox-ctl waitFor --selector h1                    # {found, elapsed, visible, position}
cli/firefox-ctl getPageState                             # headings, links, buttons, inputs, landmarks
cli/firefox-ctl getContent --selector "#main"            # rendered text (innerText), --includeHtml for innerHTML, --tail N for the last N chars
cli/firefox-ctl getElementInfo --selector h1             # attributes, computed styles, visibility
cli/firefox-ctl getAccessibilitySnapshot --maxDepth 3    # role/name tree
cli/firefox-ctl type --selector "input[name=q]" --text firefox-ctl
cli/firefox-ctl pressKey --key Enter
cli/firefox-ctl waitFor --url "https://example.com/search*"
cli/firefox-ctl click --selector "a.result"              # waits up to 5 s for the element
cli/firefox-ctl scroll --y 400                           # or --selector, or nothing to read the position
cli/firefox-ctl evaluate --expression "document.title"    # needs the preferences opt-in
```

`click` and `type` poll for their element until `waitTimeout` (5000 ms), so a command issued
right after a navigation usually does not need its own `waitFor`. When the element never turns
up the error names alternatives found on the page, the URL and title, and whether the frame is
an iframe. `type` drives the input through the native value setter and fires `input` and
`change`, so React and Angular forms see the value; a contenteditable element is written
through its text content, anything else errors.

`waitFor` takes one of `--text`, `--url` or `--selector`, checked in that order, `--url` being
a glob where only `*` is a wildcard. The URL wait runs in the background page on tab events
rather than in the content script, so it still answers when the navigation it waits for
replaces the document. A `--text` or `--selector` wait first holds the tab until it reports
`status: complete` and retries the send every 100 ms while the content script is still
missing, so `waitFor` right after `createWindow --url ...` works without a pause of its own -
it is the one page command that waits, because a repeated read-only send is harmless.

`scroll` on a tab that is not active reports `backgroundTab: true` with a hint: Firefox does
not scroll background tabs. `evaluate` runs in the content script's isolated world, so it sees
the DOM but not the page's own globals, and an expression that throws comes back as a normal
result with `type: "error"`.

`evaluate` is off until you tick "Allow the `evaluate` command" in the add-on preferences
(about:addons > Terminal Control for Firefox > Preferences). Until
then the command fails with `EVALUATE_DISABLED` and the tab is never messaged. The page is
`options.html` over `src/options.ts`; the same page holds the header redaction switch. Both
settings live in `storage.local` and are read on every command, so a toggle needs no restart.

Page commands need a content script, which restricted pages (`about:*`, `moz-extension:`, the
PDF and JSON viewers) do not have: those answer `RESTRICTED_PAGE`. A tab reloading underneath
a command answers `CONTENT_SCRIPT_UNAVAILABLE` or `TAB_CLOSED`, and a tab that is still loading
says so and suggests a `waitFor`.

A page that never replies no longer blocks the rest of the extension. Every command carries a
deadline taken from `--request-timeout` minus a second, so a stuck page command comes back as
`COMMAND_TIMEOUT` instead of hanging, and only the five commands that mutate session state
(`createWindow`, `closeTab`, `closeWindow`, `attachTab`, `detachTab`) wait for each other -
everything else, `ping` and `version` included, keeps answering meanwhile. A timed-out command
is abandoned, not cancelled: the extension stops waiting for it and drops whatever it produces
later. `screenshot` is the one narrower exception: captures of the same tab serialise behind
their own lock so badges from one request never bleed into another, but that lock is freed at
the command's deadline too, so a tab whose content script never answers cannot wedge every
later capture of it.

## Screenshots, DevTools and consent

```
cli/firefox-ctl screenshot --purpose read-text           # jpeg, quality 60, scale 0.5
cli/firefox-ctl screenshot --annotate true --scale 1     # numbered badges plus a labels map
cli/firefox-ctl screenshot --format png --skipReadiness  # capture now, no waiting
cli/firefox-ctl getConsoleLogs --level error             # turns capture on for this document
cli/firefox-ctl getNetworkRequests --limit 5 --type xmlhttprequest
cli/firefox-ctl handleConsent                            # dismiss the cookie banner
```

`screenshot` renders the target tab with `tabs.captureTab`, which works on a background tab,
so nothing is activated and a capture never disturbs the window you are looking at. `--purpose`
is a preset over quality and scale (`quick-glance` 30/0.25, `read-text` 60/0.5, `inspect-ui`
80/0.75, `full-detail` 95/1.0) that an explicit `--quality` or `--scale` overrides. The reply
is a `dataUrl`, plus `originalSize` and `scaledSize` whenever the image went through the
content script's canvas, and `labels` with `--annotate`.

Before capturing, the handler waits for the tab to settle: critical requests first, then
images and fonts (skip with `--waitForImages=false`), then a render check inside the tab,
all bounded by `--maxWait` and by what is left of `--request-timeout`. The wait is reported
as `readiness {waitMs, timedOut, timeline}` and never fails the command; `--skipReadiness`
captures straight away.

A reply has to fit the host's 10 MiB frame, so a large capture is re-encoded down a ladder -
PNG to JPEG, then quality, then scale - and the result reports what was applied plus
`reduced {from, to, steps}`. A capture that cannot be made to fit fails with
`SCREENSHOT_TOO_LARGE` rather than timing out the client.

`getConsoleLogs` turns capture on when it is first called, so it never reports what happened
before that; the buffer belongs to the document and a navigation starts a new one. The
wrapper lives in the content script's world, so the site's own `console.log` calls are not
visible, while uncaught page errors, unhandled rejections and anything `evaluate` prints are -
the result says so with `scope: "content-world"`. `getPageState.errors` shows the last 10
captured errors.

`getNetworkRequests` reads the background page's `webRequest` log: 200 entries shared by every
tab, filtered down to the target tab, with credential-looking query values redacted.
`--includeHeaders` adds the response headers, with credential-bearing ones such as
`Set-Cookie` and `Authorization` reduced to `[redacted]` by default; unticking "Redact
credential response headers" in the add-on preferences returns them raw. `--clear` empties the
buffer after answering.

`handleConsent` hunts for an accept button in four passes - known CMP selectors, button text,
open shadow roots, aria dialogs - and reports which one matched in `method`. A "Reject all"
button is never clicked, and a second call on a dismissed banner reports `found: false`.

## Layout

```
src/background.ts   background entry, the only file touching browser globals
src/content.ts      content script entry
src/app.ts          composition root: dispatcher + native link + runtime messaging
src/port.ts         NativeLink: native port, request correlation, reconnect backoff
src/dispatch.ts     command table, handler registry and the per-command deadline
src/lock.ts         state lock the five mutating commands take
src/capture-locks.ts per-tab screenshot locks, pruned on tab close
src/memo.ts         epoch-fenced memo behind restore() and the command preamble
src/tab-errors.ts   tabs.sendMessage failures as coded errors
src/glob.ts         the waitFor --url glob
src/session.ts      managed window, tab pool, persistence and duplicate sweep
src/attached.ts     attached user tabs
src/network.ts      webRequest tracker behind getNetworkRequests and readiness
src/readiness.ts    waitForPageReady, the gate a screenshot waits on
src/handlers/       window, tab, attachment, page (dom.ts), screenshot and devtools handlers
src/devices.ts      setViewport device presets
src/protocol.ts     native wire contract, mirrors cli/internal/protocol
src/messages.ts     in-browser messaging shapes (runtime/tabs.sendMessage)
src/page.ts         content script composition root
src/content/        Page interface, action registry, the page actions and the
                    internal ones the background drives (readiness, image, consent)
src/browser.ts      the browser.* subset used, plus realBrowser()
src/env.ts          clock, UUIDs and timers, plus realEnvironment()
src/commands.json   the 30 command names, kept equal to the Go fixture by a test
test/               bun tests and the fakes
```

Everything except the two entry points takes `Browser` and `Environment` by injection, so
no module reaches for `browser`, `navigator`, `crypto` or timers on its own.

## Changing the protocol

`src/protocol.ts` and `cli/internal/protocol` are one contract and change together.
`src/commands.json` is a checked-in copy of `cli/internal/protocol/testdata/commands.json`;
`test/protocol.test.ts` fails when the two drift apart.

## License

MIT, the same as the rest of the repository: [`../LICENSE`](../LICENSE).
