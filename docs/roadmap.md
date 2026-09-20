# Roadmap

Five ralphex plans, executed in order, and a sixth added afterwards. Each plan was complete, tested and linted before the next started. Plans 1 and 2 had no dependency on each other apart from `protocol` types; plans 3-5 built on 2, plan 6 on 4. All six are delivered, plus two interim plans written during execution: command deadlines and the AMO public listing. The plan files themselves are working notes and are not tracked in git.

The interim plan came out of the plan 4 end-to-end run: a content-script reply lost to a navigation hung `executeInTab`, and because every command ran behind the previous one the whole extension stopped answering. It gave each command a deadline from `--request-timeout`, let `ping` and `version` bypass the session, moved the URL wait into the background page where it survives the navigation it waits for, and narrowed serialisation to the five commands that mutate session state. No new commands.

## Plan 1: Go binary (delivered)

Scope: everything under `cli/`.

- `internal/nativemsg`: read and write framing (uint32 native-endian length + JSON), 1 MB outbound cap, 10 MB inbound cap, EOF handling
- `internal/ipc`: socket path resolution (`$XDG_RUNTIME_DIR`, fallback `~/.firefox-ctl`, dir 0700, socket 0600), stale socket cleanup
- `internal/protocol`: command names, request and response types
- `internal/host`: socket server with NDJSON per connection, UUID correlation to native messages, per-request timeout 5000-300000 ms (default 150000), pending requests dropped on client disconnect, cleanup on SIGTERM, SIGINT and stdin EOF
- `internal/client`: connect, send one request, read one response, map transport errors to messages ("host not running", "connection refused")
- `cmd/firefox-ctl`: cobra root, `host` subcommand, one subcommand per protocol command with typed flags, `--json` for nested params, `--request-timeout`, `install` subcommand that writes the native manifest with the absolute binary path
- Makefile and CI mirroring orx-cli

Verification: unit tests for every package; process-level test that starts `firefox-ctl host` with a fake extension on stdio pipes and drives `firefox-ctl ping` through the socket. No Firefox involved.

## Plan 2: Extension skeleton (delivered)

Scope: `extension/` build, test infrastructure, transport.

- `manifest.json` (MV2, persistent background, `strict_min_version` per `docs/architecture.md`), `package.json`, `bunfig.toml` with happy-dom preload, biome and tsc config
- `bun build` to IIFE for `background.ts` and `content.ts`
- `test/fakes.ts`: typed fakes for `browser.runtime`, `browser.tabs`, `browser.windows`, `browser.storage`, `browser.webRequest`
- `src/protocol.ts` mirroring `internal/protocol`; fixture-based tests on both sides
- Native port: connect on startup, exponential backoff reconnect, pending request rejection on disconnect
- Command dispatch with structured errors (`TAB_CLOSED`, `TAB_UNAVAILABLE`, `NO_TABS`, `RESTRICTED_PAGE`, `PAGE_LOAD_FAILED`, `CONTENT_SCRIPT_UNAVAILABLE`, `CONTENT_SCRIPT_ERROR`)
- `ping`, `version`

Verification: bun tests for dispatch and port lifecycle; manual: load temporary add-on, `firefox-ctl ping` and `firefox-ctl version` succeed end-to-end. This is the first Firefox run.

## Plan 3: Sessions and windows (delivered)

Scope: managed window session in `background.ts`.

1. Session state: managed window, tab list with creation order, active tab; persistence in `browser.storage.local`; restore and duplicate-window sweep after background restart
2. `createWindow` with private-by-default and fallback, 12-tab pool with oldest eviction, result `windowId, tabId, tabCount, maxTabs, isNewWindow, isPrivate, privateFallback, closedOldestTab, message` (plus `modeWarning` on fallback)
3. `navigate` (returns immediately; readiness waiting lives in plan 5 with screenshots)
4. `getActiveTab`, `getTabs`, `closeTab`, `closeWindow`, `getWindows`, `resizeWindow`, `setViewport` with device presets, `canNavigate`, `getWindowMode`
5. `listAllTabs`, `attachTab`, `detachTab` with attached-tab persistence

Verification: bun tests against fakes for every command including eviction order, restore after restart, and mode-mismatch/private-fallback handling; manual smoke through `firefox-ctl`.

## Plan 4: DOM actions (delivered)

Scope: `content.ts` and the matching dispatch cases.

- Message listener in content script; `resolveTargetTab` in background with `tabId` and `windowId` handling
- `getContent` (text, optional HTML, 50K default limit), `click` and `type` with autoWait retry and React/Angular-compatible events, `pressKey` with modifiers, `scroll`, `waitFor` (selector, text, url)
- `getElementInfo`, `getPageState` with max limits forwarded, `getAccessibilitySnapshot` (depth 5, 200 nodes), `evaluate` via `new Function`

Verification: bun tests with happy-dom fixtures for each action, including autoWait timing and restricted-page errors from background; manual smoke on a real page.

## Plan 5: Screenshots, DevTools, consent (delivered)

Three independently testable deliverables, in order. Delivered with one addition the plan 4 run asked for: `waitFor --selector` and `--text` now wait for a loading tab instead of failing with the hint to call `waitFor`.

1. Screenshots: webRequest activity tracker, `waitForPageReady` (network idle plus content-script `checkPageReadiness`), `captureTab` for any tab, purpose presets (quick-glance, read-text, inspect-ui, full-detail), `resizeImage` in content script, `annotateElements` and `removeAnnotations`, readiness options `maxWait`, `waitForImages`, `skipReadiness`; test that concurrent requests never activate tabs
2. DevTools: console capture opt-in per tab with ring buffer and `getConsoleLogs`; webRequest monitor with URL redaction, 200-entry cap, `getNetworkRequests` filters (`type`, `status`, `clear`, `limit`, `includeHeaders`)
3. Consent: `handleConsent` with 4-pass CMP detection and `scanTimeout`

Verification: bun tests per deliverable; manual check of screenshot output and consent dismissal on real sites.

## Plan 6: Child frames (delivered)

Added after the five plans, when the payment fields of a stage checkout turned out to live in cross-origin zoid iframes that no command could reach.

1. Per-tab, opt-in observation: `watchFrames` (with a `--match` glob over the frame document url), `unwatchFrames`, `listFrames` (`--timeout` as a wait-for-first), the `webNavigation` permission and per-frame `tabs.executeScript` injection
2. `FrameRegistry` in `src/frames.ts`: generation-based port admission, immediate deactivation on unwatch, entries dropped on disconnect, tab close and stale sends
3. `--frameId` on the twelve document-local page commands, `FRAME_NOT_OBSERVED` for everything else, and an explicit `{frameId: 0}` on every background send

Verification: bun tests for the registry, the content-side guard, the routing and an end-to-end acceptance scenario through the port; manual smoke on the stage checkout.

## After the plans

The command set of `docs/commands.md` is complete: all 33 commands are registered and reachable end to end. What was dropped on purpose - MCP, the popup, multi-agent coordination, focus loops, the watermark, and every security gate except the `evaluate` opt-in - is listed under Dropped there and is not planned. The AMO listing plan added the preferences page, the data-collection declaration, the private-state rule, the Linux install path and the release pipeline.
