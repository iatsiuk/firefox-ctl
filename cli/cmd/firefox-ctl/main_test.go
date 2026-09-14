package main

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"
)

func execute(t *testing.T, args ...string) (string, error) {
	t.Helper()

	buf := &bytes.Buffer{}
	cmd := newRootCmd()
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs(args)
	err := cmd.Execute()

	return buf.String(), err
}

func TestRootCmdVersion(t *testing.T) {
	t.Parallel()

	out, err := execute(t, "--version")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !strings.Contains(out, version) {
		t.Errorf("version output %q does not contain %q", out, version)
	}
}

func TestRootCmdHelpListsSubcommands(t *testing.T) {
	t.Parallel()

	out, err := execute(t, "--help")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	for _, want := range []string{"host", "firefox-ctl"} {
		if !strings.Contains(out, want) {
			t.Errorf("help output does not mention %q:\n%s", want, out)
		}
	}
}

func TestUnknownCommandFails(t *testing.T) {
	t.Parallel()

	if _, err := execute(t, "nosuchcommand"); err == nil {
		t.Fatal("expected error for unknown command")
	}
}

func TestResolveSocketDefaultsToRuntimeDir(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())

	path, err := resolveSocket("")
	if err != nil {
		t.Fatalf("resolveSocket: %v", err)
	}

	if filepath.Base(path) != "firefox-ctl.sock" {
		t.Errorf("path = %q, want a firefox-ctl.sock under the runtime dir", path)
	}
}
