package client

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"firefox-ctl/internal/protocol"
)

// handler answers one request line; returning ok=false leaves the client
// waiting, which is how the timeout cases are exercised.
type handler func(line []byte) (reply string, ok bool)

func TestSendSuccess(t *testing.T) {
	t.Parallel()

	var (
		mu   sync.Mutex
		seen []byte
	)

	sock := startServer(t, func(line []byte) (string, bool) {
		mu.Lock()
		seen = append([]byte(nil), line...)
		mu.Unlock()

		return `{"success":true,"result":{"pong":true}}`, true
	})

	resp, err := Send(t.Context(), sock, "ping", map[string]any{"_timeout": 5000})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}

	if !resp.Success {
		t.Errorf("success = false, want true")
	}

	if got := string(resp.Result); got != `{"pong":true}` {
		t.Errorf("result = %s, want {\"pong\":true}", got)
	}

	mu.Lock()
	line := seen
	mu.Unlock()

	var req protocol.ClientRequest
	if err := json.Unmarshal(line, &req); err != nil {
		t.Fatalf("unmarshal request %q: %v", line, err)
	}

	if req.Command != "ping" {
		t.Errorf("command = %q, want ping", req.Command)
	}

	if got, ok := req.Params["_timeout"].(float64); !ok || got != 5000 {
		t.Errorf("params[_timeout] = %v, want 5000", req.Params["_timeout"])
	}
}

func TestSendNilParamsOmitsParams(t *testing.T) {
	t.Parallel()

	var (
		mu   sync.Mutex
		seen []byte
	)

	sock := startServer(t, func(line []byte) (string, bool) {
		mu.Lock()
		seen = append([]byte(nil), line...)
		mu.Unlock()

		return `{"success":true}`, true
	})

	if _, err := Send(t.Context(), sock, "getActiveTab", nil); err != nil {
		t.Fatalf("Send: %v", err)
	}

	mu.Lock()
	line := string(seen)
	mu.Unlock()

	// omitempty drops an empty map; the host substitutes {} for a missing key
	if line != `{"command":"getActiveTab"}` {
		t.Errorf("request = %s, want {\"command\":\"getActiveTab\"}", line)
	}
}

func TestSendErrorResponsePassthrough(t *testing.T) {
	t.Parallel()

	sock := startServer(t, func([]byte) (string, bool) {
		return `{"success":false,"error":"Element not found","command":"click","timeoutMs":5000}`, true
	})

	resp, err := Send(t.Context(), sock, "click", map[string]any{"selector": "#missing"})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}

	if resp.Success {
		t.Errorf("success = true, want false")
	}

	if resp.Error != "Element not found" {
		t.Errorf("error = %q, want Element not found", resp.Error)
	}

	if resp.Command != "click" || resp.TimeoutMs != 5000 {
		t.Errorf("command/timeoutMs = %q/%d, want click/5000", resp.Command, resp.TimeoutMs)
	}
}

func TestSendMissingSocket(t *testing.T) {
	t.Parallel()

	sock := filepath.Join(shortTempDir(t), "absent.sock")

	_, err := Send(t.Context(), sock, "ping", nil)
	if !errors.Is(err, ErrHostNotRunning) {
		t.Fatalf("err = %v, want ErrHostNotRunning", err)
	}
}

func TestSendConnectionRefused(t *testing.T) {
	t.Parallel()

	sock := filepath.Join(shortTempDir(t), "s")

	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	// keep the socket file so the dial is refused instead of missing
	ln.(*net.UnixListener).SetUnlinkOnClose(false)

	if err := ln.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}

	_, err = Send(t.Context(), sock, "ping", nil)
	if !errors.Is(err, ErrConnectionRefused) {
		t.Fatalf("err = %v, want ErrConnectionRefused", err)
	}
}

func TestSendContextTimeout(t *testing.T) {
	t.Parallel()

	sock := startServer(t, func([]byte) (string, bool) { return "", false })

	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()

	_, err := Send(ctx, sock, "waitFor", nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want context.DeadlineExceeded", err)
	}
}

func TestSendContextCancelledBeforeDial(t *testing.T) {
	t.Parallel()

	sock := startServer(t, func([]byte) (string, bool) { return `{"success":true}`, true })

	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	_, err := Send(ctx, sock, "ping", nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestSendClosedWithoutResponse(t *testing.T) {
	t.Parallel()

	sock := startServer(t, func([]byte) (string, bool) { return "", true })

	_, err := Send(t.Context(), sock, "ping", nil)
	if !errors.Is(err, ErrNoResponse) {
		t.Fatalf("err = %v, want ErrNoResponse", err)
	}
}

func TestSendMalformedResponse(t *testing.T) {
	t.Parallel()

	sock := startServer(t, func([]byte) (string, bool) { return "not json", true })

	_, err := Send(t.Context(), sock, "ping", nil)
	if err == nil || !strings.Contains(err.Error(), "decode response") {
		t.Fatalf("err = %v, want a decode response error", err)
	}
}

// TestSendPartialResponseTreatedAsNoResponse guards against a response that
// is severed mid-write: ReadBytes returns the partial fragment together with
// io.EOF, and that must surface as ErrNoResponse rather than a misleading
// JSON decode error.
func TestSendPartialResponseTreatedAsNoResponse(t *testing.T) {
	t.Parallel()

	sock := filepath.Join(shortTempDir(t), "s")

	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	t.Cleanup(func() { _ = ln.Close() })

	go func() {
		nc, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = nc.Close() }()

		buf := make([]byte, 1024)
		_, _ = nc.Read(buf)
		_, _ = nc.Write([]byte(`{"success"`))
	}()

	_, err = Send(t.Context(), sock, "ping", nil)
	if !errors.Is(err, ErrNoResponse) {
		t.Fatalf("err = %v, want ErrNoResponse", err)
	}
}

// TestSendContextCancelledMidResponse guards against a partial fragment
// masking the cancellation cause: the deadline closing the connection mid
// read must still surface as ctx.Err(), not a decode error over the
// fragment collected so far.
func TestSendContextCancelledMidResponse(t *testing.T) {
	t.Parallel()

	sock := filepath.Join(shortTempDir(t), "s")

	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	t.Cleanup(func() { _ = ln.Close() })

	go func() {
		nc, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = nc.Close() }()

		buf := make([]byte, 1024)
		_, _ = nc.Read(buf)
		_, _ = nc.Write([]byte(`{"success"`))
		// client closes its end on cancellation, which unblocks this read with EOF
		_, _ = io.Copy(io.Discard, nc)
	}()

	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()

	_, err = Send(ctx, sock, "ping", nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want context.DeadlineExceeded", err)
	}
}

// startServer runs a fake host on a unix socket that answers with handle.
func startServer(t *testing.T, handle handler) string {
	t.Helper()

	sock := filepath.Join(shortTempDir(t), "s")

	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen on %s: %v", sock, err)
	}

	t.Cleanup(func() { _ = ln.Close() })

	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}

			go serveConn(nc, handle)
		}
	}()

	return sock
}

func serveConn(nc net.Conn, handle handler) {
	defer func() { _ = nc.Close() }()

	sc := bufio.NewScanner(nc)
	for sc.Scan() {
		reply, ok := handle(sc.Bytes())
		if !ok {
			// hold the connection open until the client hits its deadline and
			// closes its end, which unblocks this read with EOF
			_, _ = io.Copy(io.Discard, nc)
			return
		}

		if reply == "" {
			return
		}

		if _, err := nc.Write([]byte(reply + "\n")); err != nil {
			return
		}
	}
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
