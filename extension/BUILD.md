# Building the firefox-ctl add-on from source

These are complete instructions for rebuilding the packaged add-on from this source archive.
Everything needed is inside this directory; nothing is downloaded except the dependencies
listed in `package.json`, and the build runs offline once they are installed.

## What is in the archive

```
manifest.json     the add-on manifest
options.html      the preferences page (two checkboxes, no inline script)
icons/            the add-on icon
src/              TypeScript sources, the only hand-written code
test/             unit tests, not shipped in the xpi
build.ts          the build script, the single entry point of the build
package.json      dependencies and scripts
bun.lock          the exact dependency versions the release was built with
tsconfig.json     TypeScript configuration
biome.json        formatter and linter configuration
bunfig.toml       test preload (happy-dom)
```

`dist/` is not in the archive: it holds the three generated bundles and is produced by the
build below.

## Toolchain

- bun 1.4.2, the exact version the shipped bundles were built with (`bun --version`
  prints `1.4.2`). Install it from https://bun.sh; no Node.js, compiler or other tool is
  needed
- No operating system dependency: the build is pure JavaScript bundling

## Build

From this directory:

```sh
bun install --frozen-lockfile
bun run build
```

`bun install --frozen-lockfile` installs exactly the versions in `bun.lock` and fails
instead of resolving anything newer. `bun run build` runs `build.ts`, which calls
`Bun.build` over the three entry points with `target: "browser"`, `format: "iife"`,
`minify: false` and `sourcemap: "none"`:

| Entry point | Output |
|---|---|
| `src/background.ts` | `dist/background.js` |
| `src/content.ts` | `dist/content.js` |
| `src/options.ts` | `dist/options.js` |

MV2 background, content and options scripts are classic scripts, so each entry is bundled
on its own as an IIFE. The output is unminified and has no source map, so it reads as the
concatenated sources.

## Verifying against the package

`dist/background.js`, `dist/content.js` and `dist/options.js` produced by the command above
must match the files of the same name inside the submitted xpi byte for byte:

```sh
unzip -o -d /tmp/firefox-ctl-xpi <the submitted xpi>
for f in background content options; do
  cmp dist/$f.js /tmp/firefox-ctl-xpi/dist/$f.js && echo "$f.js matches"
done
```

The xpi additionally contains `manifest.json`, `options.html` and `icons/firefox-ctl.svg`, which
are checked into this archive unchanged and are not generated.

## Tests and checks (optional)

```sh
bun test           # unit, contract and build tests
bun run check      # tsc --noEmit and biome check
```
