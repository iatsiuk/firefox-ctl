package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"firefox-ctl/internal/nativemsg"
	"firefox-ctl/internal/protocol"
)

type clientResult struct {
	stdout string
	err    error
}

// buildBinary compiles firefox-ctl for the process-level test. Tests are the one
// documented exception to the "build only with make" rule.
func buildBinary(t *testing.T) string {
	t.Helper()

	bin := filepath.Join(t.TempDir(), "firefox-ctl")

	build := exec.Command("go", "build", "-o", bin, ".") //nolint:gosec // test-built binary path

	var stderr bytes.Buffer

	build.Stderr = &stderr

	if err := build.Run(); err != nil {
		t.Fatalf("go build: %v\n%s", err, stderr.String())
	}

	return bin
}

func TestHostProcessServesClientThroughSocket(t *testing.T) {
	t.Parallel()

	bin := buildBinary(t)
	socket := filepath.Join(shortTempDir(t), "firefox-ctl.sock")

	hostCmd := exec.Command(bin, "host", "--socket", socket) //nolint:gosec // test-built binary path

	stdin, err := hostCmd.StdinPipe()
	if err != nil {
		t.Fatalf("stdin pipe: %v", err)
	}

	stdout, err := hostCmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}

	var hostErr bytes.Buffer

	hostCmd.Stderr = &hostErr

	if err := hostCmd.Start(); err != nil {
		t.Fatalf("start host: %v", err)
	}

	t.Cleanup(func() { _ = hostCmd.Process.Kill() })

	waitForSocket(t, socket)

	results := make(chan clientResult, 1)

	go func() {
		out, err := exec.Command(bin, "ping", "--socket", socket).Output() //nolint:gosec // test-built binary path
		results <- clientResult{stdout: string(out), err: err}
	}()

	// fake extension on the framed stdio pipes
	raw, err := nativemsg.NewReader(stdout).Read()
	if err != nil {
		t.Fatalf("read frame: %v (stderr: %s)", err, hostErr.String())
	}

	var forwarded protocol.HostCommand
	if err := json.Unmarshal(raw, &forwarded); err != nil {
		t.Fatalf("decode frame %s: %v", raw, err)
	}

	if forwarded.Command != "ping" || forwarded.Type != protocol.TypeCommand || forwarded.ID == "" {
		t.Fatalf("forwarded = %+v, want a ping command frame with an id", forwarded)
	}

	ok := true
	if err := (nativemsg.NewWriter(stdin)).Write(protocol.ExtensionMessage{
		ID:      forwarded.ID,
		Command: forwarded.Command,
		Success: &ok,
		Result:  json.RawMessage(`{"pong":true}`),
	}); err != nil {
		t.Fatalf("write response frame: %v", err)
	}

	select {
	case res := <-results:
		if res.err != nil {
			t.Fatalf("client: %v (stderr: %s)", res.err, hostErr.String())
		}

		if !strings.Contains(res.stdout, `"pong": true`) {
			t.Fatalf("client stdout = %q, want the pong result", res.stdout)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("client did not finish")
	}

	if err := stdin.Close(); err != nil {
		t.Fatalf("close stdin: %v", err)
	}

	_, _ = io.Copy(io.Discard, stdout)

	if err := hostCmd.Wait(); err != nil {
		t.Fatalf("host exit: %v (stderr: %s)", err, hostErr.String())
	}

	assertRemoved(t, socket)
}
