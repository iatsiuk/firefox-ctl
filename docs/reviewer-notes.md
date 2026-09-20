# Notes to reviewer

The text below is what goes into the "Notes to reviewer" field of the AMO submission form.

---

## What firefox-ctl is

"Terminal Control for Firefox" is the add-on half of firefox-ctl, which drives Firefox from a terminal. The add-on is one half of a two-part tool: the other
half is `firefox-ctl`, a small Go binary the user installs as a native messaging host. The user
types `firefox-ctl getContent` in a shell, the binary passes the command to this add-on over
native messaging, the add-on runs it against a tab and answers with JSON. There is no
server, no account and no remote endpoint; the add-on talks to nothing but the native host
Firefox spawns for it.

Homepage and full source: https://github.com/iatsiuk/firefox-ctl

The add-on has no toolbar button and no popup. Its only user interface is the preferences
page (`options.html`), which carries the two switches described under "User-facing settings".

## Permissions

| Permission | Why it is needed |
|---|---|
| `nativeMessaging` | the entire point of the add-on: it receives every command from the local `firefox-ctl` host over stdio and answers on the same port. Nothing else uses this channel |
| `tabs` | commands create, list, navigate, close and read tabs and windows (`createWindow`, `getTabs`, `navigate`, `closeTab`, `attachTab`, `getActiveTab`), and `tabs.captureTab` renders the screenshot |
| `tabGroups` | the managed tabs are put in a tab group named `firefox-ctl` so the user can see at a glance which tabs the terminal owns; only `tabGroups.query` and `tabGroups.update` are called |
| `<all_urls>` | the user names the page to drive, so no narrower host list is possible; it backs the content script, `tabs.captureTab` and the network log |
| `webRequest` | `getNetworkRequests` reports request and response metadata, and the screenshot readiness check waits for a tab's pending requests to settle. Listeners are read-only: there is no `webRequestBlocking`, nothing is redirected and no request body is read |
| `webNavigation` | `watchFrames` listens for `onDOMContentLoaded` to inject the content script into a matching child frame of a watched tab. Only the frame id, parent frame id and document url of that one tab are read, never a request body |
| `storage` | two `storage.local` keys hold the managed window id and the attached tab ids so a background restart re-adopts the same window instead of opening a second one, plus the two preference flags. No page data is stored |

## Data collection

`browser_specific_settings.gecko.data_collection_permissions.required` declares
`browsingActivity`, `websiteContent`, `websiteActivity` and `authenticationInfo`. Policy
section 6 applies the data rules to what is handed to a native application, so `none` would
be wrong even though nothing goes over the network.

| Command family | What leaves the browser | Category |
|---|---|---|
| `version`, `ping` | extension version and feature list, a timestamp | none |
| tabs, windows, groups, `navigate`, `getActiveTab`, `getTabs`, `listAllTabs` | urls, page titles, tab, window and group ids | `browsingActivity` |
| `getContent`, `getAccessibilitySnapshot`, `getElementInfo`, `getPageState`, `waitFor` | text, HTML, link and form structure of the page | `websiteContent` |
| `screenshot` | a rendered image of the page | `websiteContent` |
| `getConsoleLogs`, `getNetworkRequests` | console output, request and response metadata, urls with credential-looking query values stripped, response headers redacted by default | `websiteContent` |
| `click`, `type`, `pressKey`, `scroll`, `handleConsent` | what was clicked, typed, pressed or scrolled and the resulting element state | `websiteActivity` |
| `type` into a password field, `getContent` or `evaluate` over one | the value of a credential field | `authenticationInfo` |
| `evaluate` (opt-in, off by default) | whatever the expression returns, so any of the above | the categories above |

The only destination is the local native host over stdio, which prints the JSON on the
user's terminal. The add-on makes no network request of its own and collects no telemetry.
`technicalAndInteraction` is not declared: it can only be optional, and the one field that
would have needed it, the browser user agent in the `version` result, was removed instead.

Nothing from a private browsing session is written to disk: a private managed window and an
attached private tab are kept in memory only and do not survive a background restart.

## User-facing settings

Both switches live on the preferences page (about:addons > Terminal Control for Firefox > Preferences), are stored
in `storage.local` and are read on every command, so a toggle takes effect without a restart.
No command line flag can change either of them.

- "Allow the `evaluate` command" - off by default. While it is off, `evaluate` fails with
  `EVALUATE_DISABLED: evaluate is disabled; enable it in the add-on preferences (about:addons
  > Terminal Control for Firefox > Preferences)` and no message is sent to the tab, so no string from the host is
  ever compiled. An unreadable `storage.local` keeps the gate shut
- "Redact credential response headers" - on by default. With it on, `getNetworkRequests
  --includeHeaders` keeps the header names but replaces the values of `set-cookie`, `cookie`,
  `authorization`, `proxy-authorization`, `www-authenticate` and `proxy-authenticate` with
  `[redacted]`. Unticking it returns them raw

## Trying it out

The add-on answers nothing until the native host is installed, so this part needs a terminal.

1. Get the `firefox-ctl` binary. Either build it from `cli/` in the repository with Go 1.25+
   (`make -C cli build`, no cgo, no network beyond the Go module cache), or take the
   matching archive from the release builds: `firefox-ctl_<version>_darwin_arm64.tar.gz`,
   `firefox-ctl_<version>_linux_amd64.tar.gz` or `firefox-ctl_<version>_linux_arm64.tar.gz`. Each
   archive holds the `firefox-ctl` binary and `LICENSE`
2. Register the host:

   ```sh
   ./firefox-ctl install
   ```

   This writes `~/Library/Application Support/Mozilla/NativeMessagingHosts/firefoxctl.json` on
   macOS and `~/.mozilla/native-messaging-hosts/firefoxctl.json` on Linux, with the absolute
   path of the binary and `firefox-ctl@firefox-ctl.dev` in `allowed_extensions`. `--dir <path>`
   overrides the directory; `--uninstall` removes the file
3. Install the add-on and run four commands. Firefox starts the host itself; there is no
   daemon to launch:

   ```sh
   firefox-ctl ping                                     # {"pong": true, ...}
   firefox-ctl createWindow --url https://example.com   # opens the managed window
   firefox-ctl getContent                                # text of the page
   firefox-ctl screenshot --purpose read-text            # a data url
   ```

   `firefox-ctl evaluate --expression "document.title"` fails with `EVALUATE_DISABLED` until the
   preferences checkbox is ticked, and succeeds after it.

## Source archive

`dist/background.js`, `dist/content.js` and `dist/options.js` in the xpi are bundled by bun
from the TypeScript sources; they are unminified and carry no source map. The source archive
holds `BUILD.md` with the exact steps: bun 1.4.2, `bun install --frozen-lockfile`,
`bun run build`. The repository target `make ext-reproduce` performs exactly that in a
throwaway copy of the archive and compares the three bundles with the ones in the xpi byte
for byte.

## Linter warnings

`addons-linter` on the submitted package reports zero errors, zero notices and one warning:

- `DANGEROUS_EVAL` in `dist/content.js` - "The Function constructor is eval." This is the
  `evaluate` command, the add-on's documented purpose: it compiles the expression the user
  typed in their own terminal with `new Function` and runs it in the content script's
  isolated world. The string never comes from a page or from the network, only from the
  native host on the same machine. It is additionally gated: the command is refused with
  `EVALUATE_DISABLED` unless the user has ticked the checkbox in the add-on preferences, and
  the gate is in the background script, so with the box unticked the content script is not
  even messaged
