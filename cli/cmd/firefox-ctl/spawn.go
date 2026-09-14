package main

import (
	"path/filepath"
	"strings"
)

// spawnArgs turns the arguments Firefox passes to the native messaging host
// into a `host` invocation. Firefox spawns the binary with the manifest path
// and the extension id as positional arguments, which cobra would reject as an
// unknown command. Only an absolute path ending in .json triggers the fallback,
// so `firefox-ctl <typo>` keeps its usage error.
func spawnArgs(args []string) []string {
	if len(args) == 0 || !isNativeManifestPath(args[0]) {
		return args
	}

	// the extension id and anything else positional is dropped; flags still win
	for i, arg := range args[1:] {
		if strings.HasPrefix(arg, "-") {
			return append([]string{"host"}, args[1+i:]...)
		}
	}

	return []string{"host"}
}

func isNativeManifestPath(arg string) bool {
	return filepath.IsAbs(arg) && strings.HasSuffix(arg, ".json")
}
