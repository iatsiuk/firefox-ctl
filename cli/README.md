# firefox-ctl

Control Firefox from the terminal. One static Go binary with two modes:

- `firefox-ctl host` is spawned by Firefox as the native messaging host and bridges a unix socket to stdio
- every other subcommand is a client: it sends one command over that socket and prints the JSON result

Command names, parameters and result shapes are documented in `../docs/commands.md`, the transport in `../docs/architecture.md`.

## Requirements

- macOS or Linux, current Firefox release
- Go 1.25+ and `golangci-lint` to build from source
- goreleaser, for `make release-check` / `make release-snapshot`

## Build

```
make build            # golangci-lint run, then go build -o firefox-ctl ./cmd/firefox-ctl
make install          # go install ./cmd/firefox-ctl into $GOBIN
make test             # go test -v -race with coverage profile
make cover            # per-package coverage, fails below 80%
make lint
make release-check    # goreleaser check
make release-snapshot # goreleaser release --snapshot --clean (darwin/arm64, linux/amd64, linux/arm64)
```

## Install the native manifest

Firefox only spawns a host it has a manifest for. Run this once, after the binary is in its final location:

```
firefox-ctl install
```

It writes `~/Library/Application Support/Mozilla/NativeMessagingHosts/firefoxctl.json` on macOS and `~/.mozilla/native-messaging-hosts/firefoxctl.json` on Linux - `firefox-ctl install` picks the directory from the OS it runs on, and elsewhere asks for `--dir`. The manifest carries the absolute path the binary was started through; on macOS that keeps a symlink such as Homebrew's `/opt/homebrew/bin/firefox-ctl`, so upgrades need no reinstall (Linux resolves `/proc/self/exe`, so there the target is recorded), and `firefox-ctl@firefox-ctl.dev` in `allowed_extensions`, and prints the path it wrote. Re-running it overwrites the manifest, so repeat it after moving the binary.

```
firefox-ctl install --uninstall     # remove the manifest
firefox-ctl install --dir <path>    # write somewhere else, required outside macOS and Linux
```

Load the extension from `../extension` (about:debugging, "Load Temporary Add-on") and Firefox starts the host on its own. There is no daemon to run by hand.

## Host mode

```
firefox-ctl host [--socket <path>]
```

Reads native messaging frames on stdin, writes them on stdout, serves CLI clients on the socket. Logs go to stderr; stdout carries nothing but frames. It shuts down and removes the socket on SIGINT, SIGTERM or stdin EOF.

Socket path: `$XDG_RUNTIME_DIR/firefox-ctl.sock` when that variable points at a directory, otherwise `~/.firefox-ctl/firefox-ctl.sock` (directory 0700, socket 0600). The socket mode is the only access control: no auth token, no whitelists.

Running `firefox-ctl host` by hand is only useful for debugging, and then stdin must speak the framing protocol.

Firefox itself never passes `host`: it spawns the binary as `firefox-ctl <absolute manifest path>.json <extension id>`. The root command recognizes an absolute path ending in `.json` as its first argument and falls back to host mode, dropping the extension id; flags after it (e.g. `--socket`) still apply. A bare typo like `firefox-ctl nosuchcommand` is unaffected and stays a usage error.

## Client usage

```
firefox-ctl ping
firefox-ctl createWindow --url https://example.com --private
firefox-ctl navigate --url https://example.com/login
firefox-ctl type --selector "#email" --text me@example.com
firefox-ctl click --selector "button[type=submit]"
firefox-ctl waitFor --selector ".dashboard" --timeout 15000
firefox-ctl getContent --selector main --maxLength 20000
firefox-ctl screenshot --purpose read-text > shot.json
firefox-ctl evaluate --expression "document.title"   # only after the opt-in, see below
```

`evaluate` is the one command the extension refuses by default: it answers
`EVALUATE_DISABLED: evaluate is disabled; enable it in the add-on preferences (about:addons >
Terminal Control for Firefox > Preferences)` until "Allow the `evaluate` command" is ticked there. The switch lives in
the browser on purpose, so no flag here can lift it.

Flags are the protocol parameter names verbatim, in camelCase (`--tabId`, `--maxLength`), so the CLI and the extension speak the same vocabulary. Only flags you actually set are sent, which leaves extension defaults in place; `--flag=false` is an explicit value and is sent.

`firefox-ctl --help` lists every command, `firefox-ctl <command> --help` its flags.

### Global flags

- `--json '{"...": ...}'` adds params the four flag kinds cannot express (objects, arrays). It must be a JSON object and it is shallow-merged over the typed flags
- `--request-timeout <ms>` (5000-300000, default 150000) is sent as `_timeout`; the host uses it as the per-request timeout, the client waits 5 s longer. The name avoids a clash with `waitFor --timeout`
- `--socket <path>` overrides the socket path for both host and client

### Output and exit codes

Success prints `result` as indented JSON on stdout. A failed command prints `Error: <message>` on stderr.

- 0 success
- 1 the command failed (`success:false`) or the transport failed
- 2 usage error: unknown command or flag, bad flag value, `--json` that is not an object, out-of-range `--request-timeout`

Common transport errors:

- `host not running, open Firefox with the extension loaded (socket ...)`: Firefox is closed or the extension is not loaded
- `connection refused, make sure the extension is connected (socket ...)`: a stale socket file with nothing listening on it
- `host closed the connection without a response`: the host exited or crashed mid-request
- `timed out waiting for a response from the extension`: the extension never answered within `--request-timeout`

## Layout

```
cmd/firefox-ctl/         main, cobra root, host/install subcommands, command factory, dispatch
internal/nativemsg/ stdio framing (uint32 native-endian length + JSON)
internal/host/      socket server, id correlation, timeouts
internal/client/    socket client
internal/ipc/       socket path, stale socket removal, listener
internal/protocol/  message types and the command specs the CLI is generated from
```

Adding a command means one entry in `internal/protocol/testdata/commands.json`, one `Spec` in `internal/protocol/commands.go` and a row in `../docs/commands.md`; the subcommand is generated from the spec.
