package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"

	"firefox-ctl/internal/protocol"
)

// handlerFunc answers one client request. Returning false leaves the request
// unanswered, which is how the timeout path is exercised.
type handlerFunc func(protocol.ClientRequest) (protocol.ClientResponse, bool)

// startFakeHost serves the socket the CLI dials: one request per connection.
func startFakeHost(t *testing.T, handler handlerFunc) (socket string, seen chan protocol.ClientRequest) {
	t.Helper()

	path := filepath.Join(shortTempDir(t), "firefox-ctl.sock")

	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	t.Cleanup(func() { _ = ln.Close() })

	requests := make(chan protocol.ClientRequest, 4)

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}

			go serveOne(t, conn, handler, requests)
		}
	}()

	return path, requests
}

func serveOne(t *testing.T, conn net.Conn, handler handlerFunc, seen chan protocol.ClientRequest) {
	t.Helper()

	defer func() { _ = conn.Close() }()

	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return
	}

	var req protocol.ClientRequest
	if err := json.Unmarshal(line, &req); err != nil {
		return
	}

	seen <- req

	resp, answer := handler(req)
	if !answer {
		// hold the connection open so the client hits its deadline
		<-t.Context().Done()

		return
	}

	encoded, err := json.Marshal(resp)
	if err != nil {
		return
	}

	_, _ = conn.Write(append(encoded, '\n'))
}

func answerWith(resp protocol.ClientResponse) handlerFunc {
	return func(protocol.ClientRequest) (protocol.ClientResponse, bool) {
		return resp, true
	}
}

// runBinary drives the CLI exactly as main does, including the exit code.
func runBinary(t *testing.T, args ...string) (stdout, stderr string, code int) {
	t.Helper()

	out := &bytes.Buffer{}
	errOut := &bytes.Buffer{}
	code = runCLI(args, out, errOut)

	return out.String(), errOut.String(), code
}

func TestDispatchPrintsIndentedResult(t *testing.T) {
	t.Parallel()

	socket, seen := startFakeHost(t, answerWith(protocol.ClientResponse{
		Success: true,
		Result:  json.RawMessage(`{"pong":true,"tabs":[1,2]}`),
	}))

	stdout, stderr, code := runBinary(t, "ping", "--socket", socket)
	if code != exitOK {
		t.Fatalf("exit code = %d, want 0 (stderr %q)", code, stderr)
	}

	want := "{\n  \"pong\": true,\n  \"tabs\": [\n    1,\n    2\n  ]\n}\n"
	if stdout != want {
		t.Errorf("stdout = %q, want %q", stdout, want)
	}

	if stderr != "" {
		t.Errorf("stderr = %q, want empty", stderr)
	}

	req := <-seen
	if req.Command != "ping" {
		t.Errorf("command = %q, want ping", req.Command)
	}

	if got := req.Params[protocol.TimeoutParam]; got != float64(protocol.DefaultTimeoutMs) {
		t.Errorf("%s = %#v, want %d", protocol.TimeoutParam, got, protocol.DefaultTimeoutMs)
	}
}

func TestDispatchForwardsTypedParams(t *testing.T) {
	t.Parallel()

	socket, seen := startFakeHost(t, answerWith(protocol.ClientResponse{
		Success: true,
		Result:  json.RawMessage(`null`),
	}))

	_, stderr, code := runBinary(t, "getContent", "--selector", "#main", "--maxLength", "10", "--socket", socket)
	if code != exitOK {
		t.Fatalf("exit code = %d, want 0 (stderr %q)", code, stderr)
	}

	req := <-seen
	if req.Params["selector"] != "#main" || req.Params["maxLength"] != float64(10) {
		t.Errorf("params = %#v, want selector and maxLength", req.Params)
	}
}

func TestDispatchEmptyResultPrintsNull(t *testing.T) {
	t.Parallel()

	socket, _ := startFakeHost(t, answerWith(protocol.ClientResponse{Success: true}))

	stdout, stderr, code := runBinary(t, "ping", "--socket", socket)
	if code != exitOK {
		t.Fatalf("exit code = %d, want 0 (stderr %q)", code, stderr)
	}

	if stdout != "null\n" {
		t.Errorf("stdout = %q, want %q", stdout, "null\n")
	}
}

func TestDispatchCommandFailureExitsOne(t *testing.T) {
	t.Parallel()

	// the extension's text reaches stderr unchanged, prefix codes included
	tests := []struct {
		name  string
		args  []string
		error string
	}{
		{
			name:  "plain message",
			args:  []string{"closeTab", "--tabId", "7"},
			error: "No tab with id 7",
		},
		{
			name: "coded message",
			args: []string{"evaluate", "--expression", "1 + 1"},
			error: "EVALUATE_DISABLED: evaluate is disabled; enable it in the add-on " +
				"preferences (about:addons > firefox-ctl > Preferences)",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			socket, _ := startFakeHost(t, answerWith(protocol.ClientResponse{
				Success: false,
				Error:   tt.error,
			}))

			stdout, stderr, code := runBinary(t, append(tt.args, "--socket", socket)...)
			if code != exitFailure {
				t.Fatalf("exit code = %d, want 1", code)
			}

			if stderr != "Error: "+tt.error+"\n" {
				t.Errorf("stderr = %q, want the error line", stderr)
			}

			if stdout != "" {
				t.Errorf("stdout = %q, want empty", stdout)
			}
		})
	}
}

func TestDispatchFailureWithoutMessage(t *testing.T) {
	t.Parallel()

	socket, _ := startFakeHost(t, answerWith(protocol.ClientResponse{Success: false}))

	_, stderr, code := runBinary(t, "ping", "--socket", socket)
	if code != exitFailure {
		t.Fatalf("exit code = %d, want 1", code)
	}

	if !strings.Contains(stderr, "ping failed") {
		t.Errorf("stderr = %q, want a generic failure message", stderr)
	}
}

func TestDispatchHostNotRunning(t *testing.T) {
	t.Parallel()

	socket := filepath.Join(shortTempDir(t), "missing.sock")

	_, stderr, code := runBinary(t, "ping", "--socket", socket)
	if code != exitFailure {
		t.Fatalf("exit code = %d, want 1", code)
	}

	if !strings.Contains(stderr, "host not running") {
		t.Errorf("stderr = %q, want the host-not-running hint", stderr)
	}
}

func TestDispatchTimeout(t *testing.T) {
	t.Parallel()

	socket, _ := startFakeHost(t, func(protocol.ClientRequest) (protocol.ClientResponse, bool) {
		return protocol.ClientResponse{}, false
	})

	ctx, cancel := context.WithTimeout(t.Context(), 150*time.Millisecond)
	defer cancel()

	cmd := &cobra.Command{}
	cmd.SetContext(ctx)
	cmd.SetOut(io.Discard)

	err := sendCommand(cmd, &rootOptions{socket: socket, requestTimeout: protocol.MinTimeoutMs},
		"ping", map[string]any{protocol.TimeoutParam: protocol.MinTimeoutMs})
	if err == nil {
		t.Fatal("expected a timeout error")
	}

	if !strings.Contains(err.Error(), "timed out") {
		t.Errorf("error = %v, want a timeout message", err)
	}

	if got := exitCode(err); got != exitFailure {
		t.Errorf("exit code = %d, want 1", got)
	}
}

func TestRequestDeadline(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		params map[string]any
		want   time.Duration
	}{
		{name: "timeout plus grace", params: map[string]any{protocol.TimeoutParam: 5000}, want: 10 * time.Second},
		{name: "default when absent", params: nil, want: protocol.DefaultTimeoutMs*time.Millisecond + responseGrace},
		{name: "default when not an int", params: map[string]any{protocol.TimeoutParam: "soon"},
			want: protocol.DefaultTimeoutMs*time.Millisecond + responseGrace},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			if got := requestDeadline(tt.params); got != tt.want {
				t.Errorf("requestDeadline() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestUsageErrorsExitTwo(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		args []string
	}{
		{name: "unknown command", args: []string{"nosuchcommand"}},
		{name: "unknown flag", args: []string{"ping", "--nope"}},
		{name: "positional argument", args: []string{"ping", "extra"}},
		{name: "malformed json", args: []string{"ping", "--json", "{oops"}},
		{name: "json not an object", args: []string{"ping", "--json", "[1]"}},
		{name: "request timeout out of range", args: []string{"ping", "--request-timeout", "1"}},
		{name: "flag value of the wrong kind", args: []string{"ping", "--request-timeout", "soon"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			_, stderr, code := runBinary(t, tt.args...)
			if code != exitUsage {
				t.Fatalf("exit code = %d, want 2 (stderr %q)", code, stderr)
			}

			if !strings.HasPrefix(stderr, "Error: ") {
				t.Errorf("stderr = %q, want an Error: line", stderr)
			}
		})
	}
}

func TestHelpAndVersionExitZero(t *testing.T) {
	t.Parallel()

	for _, args := range [][]string{{"--help"}, {"--version"}, {"ping", "--help"}} {
		stdout, stderr, code := runBinary(t, args...)
		if code != exitOK {
			t.Errorf("%v: exit code = %d, want 0 (stderr %q)", args, code, stderr)
		}

		if stdout == "" {
			t.Errorf("%v: stdout is empty", args)
		}
	}
}
