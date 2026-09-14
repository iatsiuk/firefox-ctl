#!/bin/sh
# copies the unsigned extension package `make ext-xpi` built into the goreleaser
# working directory: goreleaser cannot glob above it, and the exact manifest
# version is used so a stale package of another version is never picked up
set -eu

version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' ../extension/manifest.json | head -n 1)
src="../extension/web-ext-artifacts/firefox-ctl-$version.zip"

if [ ! -f "$src" ]; then
	echo "extension-package: $src is missing, run make ext-xpi first" >&2
	exit 1
fi

cp "$src" ./firefox-ctl-extension.zip
