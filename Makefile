.PHONY: build test cover lint release-check release-snapshot ext-build ext-test ext-check ext-source ext-reproduce

build:
	$(MAKE) -C cli build

test:
	$(MAKE) -C cli test

cover:
	$(MAKE) -C cli cover

lint:
	$(MAKE) -C cli lint

release-check:
	$(MAKE) -C cli release-check

release-snapshot:
	$(MAKE) -C cli release-snapshot

ext-build:
	cd extension && bun run build

ext-test:
	cd extension && bun test

ext-check:
	cd extension && bun run check

# unsigned xpi for Developer Edition, Nightly or ESR; signed one for release Firefox
ext-xpi: ext-build
	cd extension && bunx web-ext build --overwrite-dest --filename 'firefox-ctl-{version}.zip' --ignore-files 'src' 'src/**' 'test' 'test/**' 'node_modules' 'node_modules/**' 'web-ext-artifacts' 'dist/*.map' 'build.ts' 'bunfig.toml' 'biome.json' 'tsconfig.json' 'package.json' 'bun.lock' 'README.md' 'BUILD.md'

ext-sign: ext-build
	cd extension && set -a && . ../.env && set +a && bunx web-ext sign --channel unlisted --api-key "$$JWT_ISSUER" --api-secret "$$JWT_SECRET" --ignore-files 'src' 'src/**' 'test' 'test/**' 'node_modules' 'node_modules/**' 'web-ext-artifacts' 'dist/*.map' 'build.ts' 'bunfig.toml' 'biome.json' 'tsconfig.json' 'package.json' 'bun.lock' 'README.md' 'BUILD.md'

# the version both artefacts are named after
EXT_VERSION = $(shell sed -n 's/^  "version": "\(.*\)",$$/\1/p' extension/manifest.json)
EXT_SOURCE = web-ext-artifacts/firefox-ctl-source-$(EXT_VERSION).zip
EXT_PACKAGE = web-ext-artifacts/firefox-ctl-$(EXT_VERSION).zip

# the source archive AMO asks for next to a bundled xpi: everything a reviewer needs to
# rebuild, without build output, dependencies or the upload id
ext-source:
	mkdir -p extension/web-ext-artifacts
	rm -f extension/$(EXT_SOURCE)
	cd extension && zip -q -r -X $(EXT_SOURCE) . \
		-x 'node_modules/*' 'dist/*' 'web-ext-artifacts/*' '.amo-upload-uuid' \
		   '.DS_Store' '*/.DS_Store'
	@echo extension/$(EXT_SOURCE)

# proves the source archive rebuilds the shipped bundles: frozen install and build in a
# throwaway copy, then byte comparison against the xpi
ext-reproduce: ext-xpi ext-source
	@set -e; \
	tmp=$$(mktemp -d); \
	trap 'rm -rf "$$tmp"' EXIT; \
	unzip -q extension/$(EXT_SOURCE) -d $$tmp/source; \
	unzip -q extension/$(EXT_PACKAGE) -d $$tmp/package; \
	cd $$tmp/source && bun install --frozen-lockfile --silent && bun run build >/dev/null; \
	for bundle in background content options; do \
		cmp $$tmp/source/dist/$$bundle.js $$tmp/package/dist/$$bundle.js; \
		echo "dist/$$bundle.js matches the package"; \
	done
