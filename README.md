# firefox-ctl

Control Firefox from the terminal. Each command takes flags, writes JSON to stdout, and exits non-zero on failure.

Inspired by [claudezilla](https://claudezilla.com/).

## Requirements

- macOS or Linux
- Firefox 155 or newer
- To build from source: Go 1.25 or newer, golangci-lint (used by `make -C cli build`), Bun 1.4 or newer

## Install

Two parts: the `firefox-ctl` binary with its native-messaging manifest, and the Firefox add-on.

### 1. Binary

Homebrew:

```sh
brew install --cask iatsiuk/tap/firefox-ctl
firefox-ctl install
```

The manifest points at Homebrew's `firefox-ctl` link, so upgrades need no reinstall.

Or download the archive for your platform from the [GitHub Releases](https://github.com/iatsiuk/firefox-ctl/releases) page (macOS arm64, Linux amd64, Linux arm64), put `firefox-ctl` somewhere permanent and run `firefox-ctl install`.

### 2. Add-on

Install [Terminal Control for Firefox](https://addons.mozilla.org/en-US/firefox/addon/firefox-ctl/) from addons.mozilla.org. Firefox starts the native host itself; there is no daemon to run by hand.

```sh
firefox-ctl ping
```

Each GitHub release also carries `firefox-ctl-extension-<version>.zip`, the unsigned add-on package. Release Firefox only installs the signed AMO build, so that one is for Developer Edition, Nightly, ESR or any build with `xpinstall.signatures.required` set to false.

### From source

From the repository root:

```sh
make -C cli build
cli/firefox-ctl install
cd extension && bun install && bun run build
```

`firefox-ctl install` writes the native-messaging manifest to `~/Library/Application Support/Mozilla/NativeMessagingHosts/firefoxctl.json` on macOS and to `~/.mozilla/native-messaging-hosts/firefoxctl.json` on Linux. It records the binary's absolute path, so run it again after moving the binary. On any other system there is no default directory and `--dir` is required.

```sh
cli/firefox-ctl ping
cli/firefox-ctl createWindow --url https://example.com
cli/firefox-ctl waitFor --selector h1
cli/firefox-ctl getContent
cli/firefox-ctl screenshot --purpose read-text
cli/firefox-ctl closeWindow
```

Use `firefox-ctl --help` or `firefox-ctl <command> --help` for flags. `--json '{...}'` supplies nested or array parameters and overrides typed flags. Every command accepts `--request-timeout <ms>` from 5000 to 300000; the default is 150000.

## Commands

- Probes: `ping`, `version`
- Windows and tabs: `createWindow`, `navigate`, `canNavigate`, `getWindowMode`, `getActiveTab`, `getTabs`, `listAllTabs`, `attachTab`, `detachTab`, `closeTab`, `closeWindow`, `getWindows`, `resizeWindow`, `setViewport`
- Page actions: `getContent`, `click`, `type`, `pressKey`, `scroll`, `waitFor`
- Page analysis: `getPageState`, `getAccessibilitySnapshot`, `getElementInfo`, `evaluate` (opt-in, see Limitations)
- Capture and diagnostics: `screenshot`, `handleConsent`, `getConsoleLogs`, `getNetworkRequests`

The complete parameters, result shapes, and error texts are in [docs/commands.md](docs/commands.md).

## Screenshots

`screenshot` returns a `dataUrl`. On macOS, save it like this:

```sh
cli/firefox-ctl screenshot --purpose read-text \
  | jq -r '.dataUrl' \
  | sed 's#^data:image/[^;]*;base64,##' \
  | base64 -D > screenshot.jpg
```

Large replies are kept below the host's 10 MiB extension-to-host frame cap. firefox-ctl re-encodes them at a lower quality or scale and returns `reduced`; if they still do not fit, it returns `SCREENSHOT_TOO_LARGE`.

## Limitations

- This is a single-user tool. There is no auth token, command allowlist, or URL allowlist. The Unix-socket directory is mode 0700 and the socket is mode 0600.
- `evaluate` is off by default. It runs only after you tick "Allow the `evaluate` command" in the add-on preferences (about:addons > Terminal Control for Firefox > Preferences); until then it fails with `EVALUATE_DISABLED` and no page is touched. Nothing on the command line can turn it on.
- `createWindow` requests a private window by default. If the add-on lacks Firefox's private-window permission, it falls back to a normal window and returns `privateFallback: true` and `modeWarning`.
- Content scripts cannot run on restricted browser or extension pages such as `about:` and `moz-extension:`. Those return `RESTRICTED_PAGE`. JSON, PDF, download, and other non-HTML pages return `CONTENT_SCRIPT_ERROR` when detected.
- Only the top-level document is scripted (`all_frames: false`). Commands, including `handleConsent`, do not operate inside any iframe.
- `getConsoleLogs` captures the content-script world, uncaught errors, and unhandled rejections. It does not capture the site's own `console.log` calls. Its result reports `scope: "content-world"`.
- A command whose page reply never arrives returns `COMMAND_TIMEOUT` at `--request-timeout`. Timed-out work is not cancelled; late results are dropped. `click`, `type`, `pressKey`, and `evaluate` are not retried automatically.

## Session model

`createWindow` creates or reuses one managed window with a pool of up to 12 tabs. Commands without `--tabId` target its active tab. An explicit `--tabId` can target an existing pool tab, attached tab, or user tab without a session.

Use `attachTab --tabId <id>` to control a user tab in place. A normal, non-private `createWindow --private=false` may adopt the last focused normal window; `closeWindow` then closes only firefox-ctl's tabs.

## Development

```sh
make test
make ext-test
make ext-check
make ext-build
```

Architecture, transport, and lifecycle details are in [docs/architecture.md](docs/architecture.md). The Firefox extension has additional build instructions in [extension/README.md](extension/README.md).

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Aleksei Iatsiuk.
