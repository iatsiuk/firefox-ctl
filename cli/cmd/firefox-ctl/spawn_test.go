package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"firefox-ctl/internal/ipc"
)

// firefoxExtensionArg is the second argument Firefox appends when it spawns the
// native messaging host.
const firefoxExtensionArg = "firefox-ctl@firefox-ctl.dev"

func TestFirefoxSpawnStartsHostMode(t *testing.T) {
	t.Parallel()

	// a plain file where the socket belongs makes ipc.Listen fail, which proves
	// host mode ran instead of the root reporting an unknown command
	socket := filepath.Join(shortTempDir(t), "firefox-ctl.sock")
	if err := os.WriteFile(socket, nil, 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}

	manifest := filepath.Join(shortTempDir(t), "firefoxctl.json")

	_, stderr, code := runBinary(t, manifest, firefoxExtensionArg, "--socket", socket)
	if code != exitFailure {
		t.Fatalf("exit = %d, want %d (stderr %q)", code, exitFailure, stderr)
	}

	if !strings.Contains(stderr, ipc.ErrNotSocket.Error()) {
		t.Errorf("stderr = %q, want the listener failure raised by host mode", stderr)
	}
}

func TestSpawnArgs(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		args []string
		want []string
	}{
		{
			name: "firefox spawn",
			args: []string{"/Users/me/Library/firefoxctl.json", firefoxExtensionArg},
			want: []string{"host"},
		},
		{
			name: "manifest path only",
			args: []string{"/Users/me/Library/firefoxctl.json"},
			want: []string{"host"},
		},
		{
			name: "extra positional arguments are ignored",
			args: []string{"/Users/me/Library/firefoxctl.json", firefoxExtensionArg, "extra"},
			want: []string{"host"},
		},
		{
			name: "flags after the manifest path are kept",
			args: []string{"/Users/me/Library/firefoxctl.json", firefoxExtensionArg, "--socket", "/tmp/s.sock"},
			want: []string{"host", "--socket", "/tmp/s.sock"},
		},
		{
			name: "no arguments",
			args: nil,
			want: nil,
		},
		{
			name: "unknown subcommand",
			args: []string{"nosuchcommand"},
			want: []string{"nosuchcommand"},
		},
		{
			name: "known subcommand",
			args: []string{"host", "--socket", "/tmp/s.sock"},
			want: []string{"host", "--socket", "/tmp/s.sock"},
		},
		{
			name: "relative json path",
			args: []string{"firefoxctl.json"},
			want: []string{"firefoxctl.json"},
		},
		{
			name: "absolute path without the json suffix",
			args: []string{"/Users/me/Library/firefox-ctl"},
			want: []string{"/Users/me/Library/firefox-ctl"},
		},
		{
			name: "flag first",
			args: []string{"--version"},
			want: []string{"--version"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got := spawnArgs(tc.args)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("spawnArgs(%q) = %q, want %q", tc.args, got, tc.want)
			}
		})
	}
}

func TestSpawnFallbackKeepsUsageErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		args []string
	}{
		{name: "typo", args: []string{"nosuchcommand"}},
		{name: "relative manifest", args: []string{"firefoxctl.json"}},
		{name: "absolute non-json", args: []string{"/tmp/firefox-ctl"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			_, stderr, code := runBinary(t, tc.args...)
			if code != exitUsage {
				t.Fatalf("exit = %d, want %d (stderr %q)", code, exitUsage, stderr)
			}

			if !strings.Contains(stderr, "unknown command") {
				t.Errorf("stderr = %q, want an unknown command error", stderr)
			}
		})
	}
}

// TestFirefoxSpawnProcessServesSocket runs the built binary exactly as Firefox
// does: manifest path, extension id, framed stdio, no subcommand.
func TestFirefoxSpawnProcessServesSocket(t *testing.T) {
	t.Parallel()

	bin := buildBinary(t)
	socket := filepath.Join(shortTempDir(t), "firefox-ctl.sock")
	manifest := filepath.Join(shortTempDir(t), "firefoxctl.json")

	hostCmd := exec.Command(bin, manifest, firefoxExtensionArg, "--socket", socket) //nolint:gosec // test-built binary path

	stdin, err := hostCmd.StdinPipe()
	if err != nil {
		t.Fatalf("stdin pipe: %v", err)
	}

	var hostErr bytes.Buffer

	hostCmd.Stderr = &hostErr

	if err := hostCmd.Start(); err != nil {
		t.Fatalf("start host: %v", err)
	}

	t.Cleanup(func() { _ = hostCmd.Process.Kill() })

	waitForSocket(t, socket)

	if err := stdin.Close(); err != nil {
		t.Fatalf("close stdin: %v", err)
	}

	if err := hostCmd.Wait(); err != nil {
		t.Fatalf("host exit: %v (stderr: %s)", err, hostErr.String())
	}

	assertRemoved(t, socket)
}
