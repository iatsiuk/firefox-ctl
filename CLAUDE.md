# firefox-ctl

Control Firefox from the terminal. Target: macOS, current Firefox release. Single-user tool: the owner installs the extension, runs the CLI and drives the agent, so there is no threat model beyond basic file hygiene. Two projects in one repo:

- `cli/` - Go binary `firefox-ctl`. Two modes: native messaging host (spawned by Firefox) and CLI client (run by a user or an LLM agent).
- `extension/` - Firefox WebExtension (MV2, TypeScript, built with bun). Executes commands from the host in tabs.

Transport: `docs/architecture.md`. Command set and error prefixes: `docs/commands.md`.

## Goals

- The full command set of `docs/commands.md`: every command works with the documented name, parameters and result shape. Not an MVP, not a subset
- Dropped on purpose: MCP, the popup, MCP-bound multi-agent coordination, focus loops, watermark, and every security gate except the `evaluate` opt-in, which the user ticks in the add-on preferences. Full list in `docs/commands.md`
- One statically built Go binary, no runtime dependencies (Go libraries such as cobra are fine)
- Protocol types in `cli/internal/protocol` and `extension/src/protocol.ts` are the contract and change together
- JSON on stdout; on failure the extension's error message on stderr and non-zero exit. Error text carries stable prefix codes (`TAB_CLOSED: ...`, `RESTRICTED_PAGE: ...`); no separate `code` or `details` field

## Development approach

Strict TDD: write the failing test, run it, implement, refactor. No production code without a test that demanded it. Manual verification in Firefox (about:debugging, load temporary add-on) is the last step, never a substitute for tests.

### Go (`cli/`)

Style and tooling follow orx-cli. `cli/.golangci.yml` is its config with local prefix `firefox-ctl`.

- Go 1.25+, stdlib `testing` only, no testify, no mocking libraries
- Table-driven tests, `t.Parallel()` for independent tests, `*_test.go` in the same package, always cover error paths: timeouts, context cancellation, malformed input
- Test through production entry points: framing via `io.Pipe`, socket server via a real unix socket in `t.TempDir()`, cobra commands via `SetArgs` and captured stdout
- Build only with `make build` (runs `golangci-lint run` first); `make test` runs `go test -v -race -coverprofile=coverage.out ./...`
- Imports grouped: stdlib, external, local (`firefox-ctl/...`); fix with `goimports -w` or `gofmt -w`
- Naming: short lowercase packages, PascalCase exported and camelCase unexported identifiers, 1-2 letter receivers, `Err` prefix for sentinel errors, consistent acronym case; group related functions together
- Functions: max 80 lines, 50 statements, cyclomatic complexity 10, nesting 5; early returns
- Errors: wrap with `fmt.Errorf("op: %w", err)`, compare with `errors.Is/As`
- Structs: JSON tags on exported fields, `omitempty` and pointer types for optional values
- Related constants in `const` blocks, unexported package state in `var` blocks; `for i := range n`, `switch` over long if-else chains
- `context.Context` first param for anything blocking; `sync.Mutex` for simple locking, `errgroup` for parallel work, `atomic` for counters
- Comments only for non-obvious logic: English, lowercase, brief

### Extension (`extension/`)

- TypeScript strict, ES2022 target, no `any`
- Build: `bun build src/background.ts src/content.ts src/options.ts --outdir dist --target browser --format iife`. MV2 background, content and options scripts are classic scripts, bun defaults to ESM, so `--format iife` is required
- Test: `bun test`. `happy-dom` registered via `GlobalRegistrator` in a `bunfig.toml` preload; `browser.*` APIs injected as typed fakes from `test/fakes.ts`
- Pure logic (protocol parsing, dispatch, selector and URL validation) lives in modules without `browser` globals
- Lint: `bunx tsc --noEmit` and `bunx biome check`
- Extension ID `firefox-ctl@firefox-ctl.dev`, native host name `firefox-ctl`

### Trust model

No auth token, no command or URL whitelists. The socket in a user-owned directory with mode 0600 is the only protection for every command but one: `evaluate` runs arbitrary expressions, so it stays off until the user ticks it in the add-on preferences (`options.html`), and no CLI flag can turn it on.

## Roadmap

Five ralphex plans in order, details in `docs/roadmap.md`: Go binary; extension skeleton (ends with the first end-to-end ping); sessions and windows; DOM actions; screenshots, DevTools and consent. Each plan is complete and tested before the next starts.

## Commands

```
make build               # cli: lint + build
make test                # cli: go test -race with coverage
make cover               # cli: per-package coverage, fails below 80%
make lint                # cli: golangci-lint run
make release-check       # cli: goreleaser check
make release-snapshot    # cli: goreleaser release --snapshot --clean (darwin/arm64, linux/amd64, linux/arm64)
make ext-build           # extension: bun run build into extension/dist
make ext-test            # extension: bun test
make ext-check           # extension: tsc --noEmit and biome check
make ext-xpi             # extension: unsigned package in extension/web-ext-artifacts
make ext-sign            # extension: sign on AMO as unlisted, keys from .env
make ext-source          # extension: source zip for the AMO listed submission
make ext-reproduce       # extension: rebuild the source zip and diff it against the xpi
```

### Shipping an extension change

The installed add-on is the AMO-signed xpi, not the temporary load. After any change under
`extension/`: bump `version` in `extension/manifest.json` and `extension/package.json` (AMO
rejects a version it has already seen), run `make ext-sign`, then install the new
`extension/web-ext-artifacts/*.xpi` over the old one via about:addons. `.env` holds
`JWT_ISSUER` and `JWT_SECRET` and is gitignored. That is the unlisted channel, for test
builds.

A release for the listed (public) channel needs a source archive and a human review:

1. `make ext-build`, `make ext-test`, `make ext-check`
2. `make ext-xpi` and `make ext-source`, then `make ext-reproduce`, which rebuilds the source
   zip in a temp dir and fails if the three bundles differ from the xpi
3. `bunx addons-linter extension/web-ext-artifacts/firefox-ctl-<version>.zip`: zero errors, and
   every remaining warning already justified in `docs/reviewer-notes.md`
4. Submit with `bunx web-ext sign --channel listed --upload-source-code <source zip>
   --amo-metadata <json>` from `extension/`, same `--ignore-files` list as `ext-sign`, keys from
   `.env`. The metadata JSON is `{"version": {"approval_notes": "...", "release_notes":
   {"en-US": "..."}}}`. AMO caps `approval_notes` at 3000 characters and rejects the whole
   submission over it, so paste a delta since the previous version plus a pointer to
   `docs/reviewer-notes.md` in the source zip, never the full file. License MIT/X11,
   homepage `https://github.com/iatsiuk/firefox-ctl` and the privacy statement live on the
   listing and need no resubmission

The `make -C cli <target>` and `cd extension && bun <script>` forms still work; the root
targets above only delegate to them.

### Releasing the binary

A pushed `v*` tag runs `.github/workflows/ci.yaml`: tests and lint for both projects, then
`make ext-xpi` builds the unsigned extension package, and goreleaser from `cli/` publishes
the GitHub release (macOS arm64, Linux amd64, Linux arm64, checksums, plus that package as
`firefox-ctl-extension-<version>.zip`) and pushes the `firefox-ctl` cask to
`iatsiuk/homebrew-tap`. The job fails if `extension/manifest.json` does not carry the tag's
version. The workflow needs the `HOMEBREW_TAP_TOKEN` repository secret; the extension is not
signed in CI, the signed build comes from AMO. Nothing in the tap is edited by hand.

## Language

Code, comments, docs and commit messages in English.
