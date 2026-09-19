# Shipping an extension change

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
   --amo-metadata <json>` from `extension/`, same `--ignore-files` list as `ext-sign`, keys
   from `.env`. The metadata JSON is `{"version": {"approval_notes": "...", "release_notes":
   {"en-US": "..."}}}`. AMO caps `approval_notes` at 3000 characters: over it the metadata
   validation refuses to create the version (the note is not truncated; the xpi may already
   sit in AMO's upload step, and the retry reuses it), so paste a delta since the previous
   version plus a link to the full notes at
   `https://github.com/iatsiuk/firefox-ctl/blob/v<version>/docs/reviewer-notes.md`, never
   the full file. The source zip holds `extension/` only, so a relative `docs/` path is not
   visible to the reviewer. License MIT/X11, homepage
   `https://github.com/iatsiuk/firefox-ctl` and the privacy statement live on the listing
   and need no resubmission
