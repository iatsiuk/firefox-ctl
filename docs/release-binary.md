# Releasing the binary

A pushed `v*` tag runs `.github/workflows/ci.yaml`: tests and lint for both projects, then
`make ext-xpi` builds the unsigned extension package, and goreleaser from `cli/` publishes
the GitHub release (macOS arm64, Linux amd64, Linux arm64, checksums, plus that package as
`firefox-ctl-extension-<version>.zip`) and pushes the `firefox-ctl` cask to
`iatsiuk/homebrew-tap`. The job fails if `extension/manifest.json` does not carry the tag's
version. The workflow needs the `HOMEBREW_TAP_TOKEN` repository secret; the extension is not
signed in CI, the signed build comes from AMO. Nothing in the tap is edited by hand.
