package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"firefox-ctl/internal/client"
	"firefox-ctl/internal/ipc"
	"firefox-ctl/internal/nativemsg"
	"firefox-ctl/internal/protocol"
)

func TestRunHostStopsOnSignal(t *testing.T) {
	t.Parallel()

	socket := filepath.Join(shortTempDir(t), "firefox-ctl.sock")
	signals := make(chan os.Signal, 1)
	stdin, stdinWriter := io.Pipe()

	t.Cleanup(func() { _ = stdinWriter.Close() })

	done := runHostAsync(t, hostConfig{
		socket:  socket,
		signals: signals,
		stdin:   stdin,
		stdout:  io.Discard,
		logger:  discardLogger(),
	})

	waitForSocket(t, socket)
	signals <- syscall.SIGTERM

	if err := waitDone(t, done); err != nil {
		t.Fatalf("runHost() error = %v, want nil", err)
	}

	assertRemoved(t, socket)
}

func TestRunHostStopsOnStdinEOF(t *testing.T) {
	t.Parallel()

	socket := filepath.Join(shortTempDir(t), "firefox-ctl.sock")

	done := runHostAsync(t, hostConfig{
		socket:  socket,
		signals: make(chan os.Signal),
		stdin:   strings.NewReader(""),
		stdout:  io.Discard,
		logger:  discardLogger(),
	})

	if err := waitDone(t, done); err != nil {
		t.Fatalf("runHost() error = %v, want nil", err)
	}

	assertRemoved(t, socket)
}

func TestRunHostBridgesClientAndExtension(t *testing.T) {
	t.Parallel()

	socket := filepath.Join(shortTempDir(t), "firefox-ctl.sock")
	signals := make(chan os.Signal, 1)
	stdin, stdinWriter := io.Pipe()
	stdoutReader, stdout := io.Pipe()

	done := runHostAsync(t, hostConfig{
		socket:  socket,
		signals: signals,
		stdin:   stdin,
		stdout:  stdout,
		logger:  discardLogger(),
	})

	waitForSocket(t, socket)

	// fake extension: answer the first forwarded command with success
	extDone := make(chan error, 1)

	go func() {
		raw, err := nativemsg.NewReader(stdoutReader).Read()
		if err != nil {
			extDone <- err

			return
		}

		var cmd protocol.HostCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			extDone <- err

			return
		}

		ok := true
		extDone <- nativemsg.NewWriter(stdinWriter).Write(protocol.ExtensionMessage{
			ID:      cmd.ID,
			Command: cmd.Command,
			Success: &ok,
			Result:  json.RawMessage(`{"pong":true}`),
		})
	}()

	resp, err := client.Send(t.Context(), socket, "ping", nil)
	if err != nil {
		t.Fatalf("client.Send() error = %v", err)
	}

	if err := <-extDone; err != nil {
		t.Fatalf("fake extension: %v", err)
	}

	if !resp.Success || string(resp.Result) != `{"pong":true}` {
		t.Fatalf("response = %+v, want success with pong result", resp)
	}

	signals <- syscall.SIGINT

	if err := waitDone(t, done); err != nil {
		t.Fatalf("runHost() error = %v, want nil", err)
	}

	assertRemoved(t, socket)
}

func TestRunHostListenerFailure(t *testing.T) {
	t.Parallel()

	socket := filepath.Join(shortTempDir(t), "firefox-ctl.sock")
	if err := os.WriteFile(socket, nil, 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}

	err := runHost(t.Context(), hostConfig{
		socket:  socket,
		signals: make(chan os.Signal),
		stdin:   strings.NewReader(""),
		stdout:  io.Discard,
		logger:  discardLogger(),
	})
	if !errors.Is(err, ipc.ErrNotSocket) {
		t.Fatalf("runHost() error = %v, want ErrNotSocket", err)
	}
}

func TestRunHostResolveSocketFailure(t *testing.T) {
	t.Setenv("HOME", "")
	t.Setenv("XDG_RUNTIME_DIR", "")

	err := runHost(t.Context(), hostConfig{
		signals: make(chan os.Signal),
		stdin:   strings.NewReader(""),
		stdout:  io.Discard,
		logger:  discardLogger(),
	})
	if err == nil {
		t.Fatal("runHost() error = nil, want a resolveSocket error")
	}
}

func TestHostCmdReportsListenerFailure(t *testing.T) {
	t.Parallel()

	socket := filepath.Join(shortTempDir(t), "firefox-ctl.sock")
	if err := os.WriteFile(socket, nil, 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}

	if _, err := execute(t, "host", "--socket", socket); !errors.Is(err, ipc.ErrNotSocket) {
		t.Fatalf("execute() error = %v, want ErrNotSocket", err)
	}
}

func runHostAsync(t *testing.T, cfg hostConfig) chan error {
	t.Helper()

	done := make(chan error, 1)

	go func() { done <- runHost(context.Background(), cfg) }()

	return done
}

func waitDone(t *testing.T, done chan error) error {
	t.Helper()

	select {
	case err := <-done:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("runHost did not return")

		return nil
	}
}

func waitForSocket(t *testing.T, path string) {
	t.Helper()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSocket != 0 {
			return
		}

		time.Sleep(5 * time.Millisecond)
	}

	t.Fatalf("socket %s never appeared", path)
}

func assertRemoved(t *testing.T, path string) {
	t.Helper()

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
			return
		}

		time.Sleep(5 * time.Millisecond)
	}

	t.Fatalf("socket %s still exists after shutdown", path)
}

func discardLogger() *log.Logger {
	return log.New(io.Discard, "", 0)
}

// shortTempDir keeps socket paths under the 104-byte sun_path limit that long
// test names blow through.
func shortTempDir(t *testing.T) string {
	t.Helper()

	dir, err := os.MkdirTemp("", "fx")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}

	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	return dir
}
