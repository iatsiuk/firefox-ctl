#!/bin/sh
# Reads `go test -cover ./...` output on stdin and fails when any internal
# package is untested or below the coverage threshold.
set -eu

min=${1:-80}

awk -v min="$min" '
{ print }

$1 == "FAIL" { failed = 1; next }

$2 ~ /^firefox-ctl\/internal\// {
    pct = -1

    if ($1 == "?") {
        printf "coverage gate: %s has no test files\n", $2
        failed = 1
        next
    }

    for (i = 1; i <= NF; i++) {
        if ($i ~ /%$/) {
            pct = $i + 0
        }
    }

    if (pct < min) {
        printf "coverage gate: %s at %.1f%%, want at least %s%%\n", $2, pct, min
        failed = 1
    }
}

END { if (failed) exit 1 }
'
