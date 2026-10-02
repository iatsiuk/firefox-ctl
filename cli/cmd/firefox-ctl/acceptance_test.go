package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"firefox-ctl/internal/client"
	"firefox-ctl/internal/nativemsg"
	"firefox-ctl/internal/protocol"
)

func TestDocumentedCommandsAreReachable(t *testing.T) {
	t.Parallel()

	documented := documentedCommands(t)
	if len(documented) == 0 {
		t.Fatal("no commands parsed from docs/commands.md")
	}

	for _, name := range documented {
		stdout, stderr, code := runBinary(t, name, "--help")
		if code != exitOK {
			t.Errorf("%s --help: exit %d, stderr %q", name, code, stderr)

			continue
		}

		if !strings.Contains(stdout, "Usage:\n  firefox-ctl "+name) {
			t.Errorf("%s --help: usage line missing:\n%s", name, stdout)
		}
	}

	if len(documented) != len(protocol.Commands) {
		t.Errorf("docs/commands.md lists %d commands, protocol.Commands has %d",
			len(documented), len(protocol.Commands))
	}
}

// documentedCommands reads the command tables of docs/commands.md, stopping at
// the Dropped section, which lists names that must not resolve.
func documentedCommands(t *testing.T) []string {
	t.Helper()

	doc, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "commands.md"))
	if err != nil {
		t.Fatalf("read commands doc: %v", err)
	}

	var names []string

	for _, line := range strings.Split(string(doc), "\n") {
		if strings.HasPrefix(line, "## Dropped") {
			break
		}

		if !strings.HasPrefix(line, "|") {
			continue
		}

		cell := strings.TrimSpace(strings.Split(strings.TrimPrefix(line, "|"), "|")[0])
		// one row documents two commands: "attachTab / detachTab"
		for _, name := range strings.Split(cell, "/") {
			if name = strings.TrimSpace(name); isCommandName(name) {
				names = append(names, name)
			}
		}
	}

	return names
}

func isCommandName(s string) bool {
	if s == "" || s == "Command" {
		return false
	}

	for _, r := range s {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') {
			return false
		}
	}

	return true
}

func TestDroppedCommandsAreNotRegistered(t *testing.T) {
	t.Parallel()

	// --help is not used here: cobra answers the help flag before it validates
	// the positional argument, so an unknown name would still print root help
	for _, name := range []string{"startLoop", "setPrivateMode", "goodbye", "requestTabSpace"} {
		if _, _, code := runBinary(t, name); code != exitUsage {
			t.Errorf("%s: exit %d, want %d", name, code, exitUsage)
		}
	}
}

func TestHostSkipsInvalidJSONInValidFrame(t *testing.T) {
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

	// a well-framed payload that is not JSON must not kill the stdin loop
	if _, err := stdinWriter.Write(rawFrame([]byte(`{"id":`))); err != nil {
		t.Fatalf("write frame: %v", err)
	}

	go answerOnce(t, stdoutReader, stdinWriter)

	resp, err := client.Send(t.Context(), socket, "ping", nil)
	if err != nil {
		t.Fatalf("client.Send() error = %v", err)
	}

	if !resp.Success {
		t.Fatalf("response = %+v, want success after the malformed frame", resp)
	}

	signals <- syscall.SIGTERM

	if err := waitDone(t, done); err != nil {
		t.Fatalf("runHost() error = %v, want nil", err)
	}

	assertRemoved(t, socket)
}

// answerOnce plays the extension: it replies to the first forwarded command.
func answerOnce(t *testing.T, framed io.Reader, out io.Writer) {
	t.Helper()

	raw, err := nativemsg.NewReader(framed).Read()
	if err != nil {
		return
	}

	var cmd protocol.HostCommand
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return
	}

	ok := true
	_ = nativemsg.NewWriter(out).Write(protocol.ExtensionMessage{
		ID:      cmd.ID,
		Command: cmd.Command,
		Success: &ok,
		Result:  json.RawMessage(`{"pong":true}`),
	})
}

func TestHostStopsOnFramingErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		maxInbound uint32
		frame      []byte
		closeStdin bool
		want       error
	}{
		{
			name:       "partial frame",
			frame:      frameHeader(64),
			closeStdin: true,
			want:       io.ErrUnexpectedEOF,
		},
		{
			name:       "oversize header then eof",
			frame:      frameHeader(nativemsg.MaxInbound + 1),
			closeStdin: true,
			want:       io.ErrUnexpectedEOF,
		},
		{
			name:       "eof inside the discarded payload",
			maxInbound: 16,
			frame:      append(frameHeader(64), make([]byte, 32)...),
			closeStdin: true,
			want:       io.ErrUnexpectedEOF,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			socket := filepath.Join(shortTempDir(t), "firefox-ctl.sock")
			stdin, stdinWriter := io.Pipe()

			done := runHostAsync(t, hostConfig{
				socket:     socket,
				signals:    make(chan os.Signal),
				stdin:      stdin,
				stdout:     io.Discard,
				logger:     discardLogger(),
				maxInbound: tc.maxInbound,
			})

			waitForSocket(t, socket)

			if _, err := stdinWriter.Write(tc.frame); err != nil {
				t.Fatalf("write frame: %v", err)
			}

			if tc.closeStdin {
				_ = stdinWriter.Close()
			}

			if err := waitDone(t, done); !errors.Is(err, tc.want) {
				t.Fatalf("runHost() error = %v, want %v", err, tc.want)
			}

			assertRemoved(t, socket)
		})
	}
}

// syncBuffer collects host logs the test reads while the host writes them.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.buf.String()
}

func frameHeader(size uint32) []byte {
	buf := make([]byte, 4)
	binary.NativeEndian.PutUint32(buf, size)

	return buf
}

// rawFrame frames bytes the nativemsg writer would refuse to marshal.
func rawFrame(payload []byte) []byte {
	//nolint:gosec // test-only helper, payloads are small literals
	return append(frameHeader(uint32(len(payload))), payload...)
}

// TestHostSurvivesOversizeFrame drives the recovery through the binary's host
// mode: a fully discarded frame is logged and the next command still works.
func TestHostSurvivesOversizeFrame(t *testing.T) {
	t.Parallel()

	socket := filepath.Join(shortTempDir(t), "firefox-ctl.sock")
	signals := make(chan os.Signal, 1)
	stdin, stdinWriter := io.Pipe()
	stdoutReader, stdout := io.Pipe()
	logs := &syncBuffer{}

	done := runHostAsync(t, hostConfig{
		socket:     socket,
		signals:    signals,
		stdin:      stdin,
		stdout:     stdout,
		logger:     log.New(logs, "", 0),
		maxInbound: 1024,
	})

	waitForSocket(t, socket)

	if _, err := stdinWriter.Write(rawFrame(bytes.Repeat([]byte("x"), 4096))); err != nil {
		t.Fatalf("write oversize frame: %v", err)
	}

	go answerOnce(t, stdoutReader, stdinWriter)

	resp, err := client.Send(t.Context(), socket, "ping", nil)
	if err != nil {
		t.Fatalf("client.Send() after the oversize frame: %v", err)
	}

	if !resp.Success || string(resp.Result) != `{"pong":true}` {
		t.Fatalf("response = %+v, want the pong after the oversize frame", resp)
	}

	// frames are read in order, so the discard was logged before the pong
	if !strings.Contains(logs.String(), "discarding extension message") {
		t.Errorf("logs = %q, want the discarded frame logged", logs.String())
	}

	signals <- syscall.SIGTERM

	if err := waitDone(t, done); err != nil {
		t.Fatalf("runHost() error = %v, want nil", err)
	}

	assertRemoved(t, socket)
}

// TestHostStopsOnSignalDuringDrain: a termination signal while an oversize
// frame is read away is a normal exit, the rest of the payload never comes.
func TestHostStopsOnSignalDuringDrain(t *testing.T) {
	t.Parallel()

	socket := filepath.Join(shortTempDir(t), "firefox-ctl.sock")
	signals := make(chan os.Signal, 1)
	stdin, stdinWriter := io.Pipe()

	t.Cleanup(func() { _ = stdinWriter.Close() })

	done := runHostAsync(t, hostConfig{
		socket:     socket,
		signals:    signals,
		stdin:      stdin,
		stdout:     io.Discard,
		logger:     discardLogger(),
		maxInbound: 16,
	})

	waitForSocket(t, socket)

	if _, err := stdinWriter.Write(append(frameHeader(1<<20), make([]byte, 64)...)); err != nil {
		t.Fatalf("write frame: %v", err)
	}

	signals <- syscall.SIGTERM

	if err := waitDone(t, done); err != nil {
		t.Fatalf("runHost() error = %v, want nil on SIGTERM during a drain", err)
	}

	assertRemoved(t, socket)
}

// TestHostStopsOnSignalDuringLargeWrite: SIGTERM ends the host promptly while
// it writes a large reply to a client that keeps reading in small portions.
func TestHostStopsOnSignalDuringLargeWrite(t *testing.T) {
	t.Parallel()

	socket := filepath.Join(shortTempDir(t), "firefox-ctl.sock")
	signals := make(chan os.Signal, 1)
	stdin, stdinWriter := io.Pipe()
	stdoutReader, stdout := io.Pipe()

	t.Cleanup(func() { _ = stdinWriter.Close(); _ = stdoutReader.Close() })

	done := runHostAsync(t, hostConfig{
		socket:  socket,
		signals: signals,
		stdin:   stdin,
		stdout:  stdout,
		logger:  discardLogger(),
	})

	waitForSocket(t, socket)

	go answerWithFrame(t, stdoutReader, stdinWriter, func(id string) []byte {
		return []byte(fmt.Sprintf(`{"id":%q,"success":true,"result":%q}`, id, strings.Repeat("z", 32<<20)))
	})

	conn, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	t.Cleanup(func() { _ = conn.Close() })

	if _, err := conn.Write([]byte(`{"command":"stopHar"}` + "\n")); err != nil {
		t.Fatalf("send request: %v", err)
	}

	reading := make(chan struct{})

	go func() {
		buf := make([]byte, 4096)
		once := sync.OnceFunc(func() { close(reading) })

		for {
			if _, err := conn.Read(buf); err != nil {
				return
			}

			once()
			time.Sleep(10 * time.Millisecond)
		}
	}()

	select {
	case <-reading:
	case <-time.After(10 * time.Second):
		t.Fatal("the reply never started")
	}

	began := time.Now()
	signals <- syscall.SIGTERM

	if err := waitDone(t, done); err != nil {
		t.Fatalf("runHost() error = %v, want nil", err)
	}

	if elapsed := time.Since(began); elapsed > time.Second {
		t.Errorf("shutdown took %s during a large write, want under a second", elapsed)
	}

	assertRemoved(t, socket)
}

// answerWithFrame plays the extension: it answers the first forwarded command
// with a raw frame, which may exceed what nativemsg.Writer would send.
func answerWithFrame(t *testing.T, framed io.Reader, out io.Writer, payload func(id string) []byte) {
	t.Helper()

	raw, err := nativemsg.NewReader(framed).Read()
	if err != nil {
		return
	}

	var cmd protocol.HostCommand
	if err := json.Unmarshal(raw, &cmd); err != nil {
		return
	}

	_, _ = out.Write(rawFrame(payload(cmd.ID)))
}

// TestLargeReplyReachesStdoutIntact sends a 64 MiB result through the whole
// path, extension pipe, host, socket and printResult, and checks it arrives
// byte-equal to the indented input: no HTML escaping, no lost bytes.
func TestLargeReplyReachesStdoutIntact(t *testing.T) {
	if testing.Short() {
		t.Skip("64 MiB stress test")
	}

	t.Parallel()

	socket := filepath.Join(shortTempDir(t), "firefox-ctl.sock")
	signals := make(chan os.Signal, 1)
	stdin, stdinWriter := io.Pipe()
	stdoutReader, stdout := io.Pipe()

	t.Cleanup(func() { _ = stdinWriter.Close(); _ = stdoutReader.Close() })

	done := runHostAsync(t, hostConfig{
		socket:  socket,
		signals: signals,
		stdin:   stdin,
		stdout:  stdout,
		logger:  discardLogger(),
	})

	waitForSocket(t, socket)

	result := largeResult(64 << 20)

	go func() {
		answerWithFrame(t, stdoutReader, stdinWriter, func(id string) []byte {
			return []byte(fmt.Sprintf(`{"id":%q,"success":true,"result":%s}`, id, result))
		})
		answerOnce(t, stdoutReader, stdinWriter)
	}()

	got, stderr, code := runBinary(t, "ping", "--socket", socket)
	if code != exitOK {
		t.Fatalf("large reply: exit %d, stderr %q", code, stderr)
	}

	var want bytes.Buffer
	if err := json.Indent(&want, result, "", "  "); err != nil {
		t.Fatalf("indent input: %v", err)
	}

	want.WriteByte('\n')

	if got != want.String() {
		t.Fatalf("stdout differs from the indented input: %d bytes, want %d", len(got), want.Len())
	}

	if _, stderr, code := runBinary(t, "ping", "--socket", socket); code != exitOK {
		t.Fatalf("ping after the large reply: exit %d, stderr %q", code, stderr)
	}

	signals <- syscall.SIGTERM

	if err := waitDone(t, done); err != nil {
		t.Fatalf("runHost() error = %v, want nil", err)
	}
}

// largeResult builds a JSON array of about size bytes mixing base64, text
// that json.Marshal would HTML-escape and non-ASCII text.
func largeResult(size int) []byte {
	b64 := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("\x00\x01\x7f\x80\xfe\xff<&>"), 6*1024))
	html := strings.Repeat(`<a href=\"/q?a=1&b=2\">x</a> `, 256)
	text := strings.Repeat("привет   日本 😀 ", 256)

	var buf bytes.Buffer

	buf.WriteString(`{"log":{"entries":[`)

	for i := 0; buf.Len() < size; i++ {
		if i > 0 {
			buf.WriteByte(',')
		}

		fmt.Fprintf(&buf, `{"n":%d,"b64":%q,"html":"%s","text":"%s"}`, i, b64, html, text)
	}

	buf.WriteString(`]}}`)

	return buf.Bytes()
}

// TestStopHarPrintsHarLiterally plays the extension answering stopHar with a
// HAR whose body holds markup, and checks the CLI prints it as indented JSON
// under one top-level "log" key, with < and & as they are, not as <.
func TestStopHarPrintsHarLiterally(t *testing.T) {
	t.Parallel()

	socket := filepath.Join(shortTempDir(t), "firefox-ctl.sock")
	signals := make(chan os.Signal, 1)
	stdin, stdinWriter := io.Pipe()
	stdoutReader, stdout := io.Pipe()

	t.Cleanup(func() { _ = stdinWriter.Close(); _ = stdoutReader.Close() })

	done := runHostAsync(t, hostConfig{
		socket:  socket,
		signals: signals,
		stdin:   stdin,
		stdout:  stdout,
		logger:  discardLogger(),
	})

	waitForSocket(t, socket)

	har := []byte(`{"log":{"version":"1.2","creator":{"name":"firefox-ctl","version":"1.0.0"},` +
		`"pages":[],"entries":[{"request":{"method":"GET","url":"https://example.com/?a=1&b=2"},` +
		`"response":{"status":200,"content":{"size":28,"mimeType":"text/html",` +
		`"text":"<p>Fish &amp; chips</p> & <b>"}}}]}}`)

	commands := make(chan protocol.HostCommand, 1)

	go func() {
		raw, err := nativemsg.NewReader(stdoutReader).Read()
		if err != nil {
			return
		}

		var cmd protocol.HostCommand
		if err := json.Unmarshal(raw, &cmd); err != nil {
			return
		}

		commands <- cmd

		_, _ = stdinWriter.Write(rawFrame([]byte(fmt.Sprintf(`{"id":%q,"success":true,"result":%s}`, cmd.ID, har))))
	}()

	got, stderr, code := runBinary(t, "stopHar", "--tabId", "7", "--socket", socket)
	if code != exitOK {
		t.Fatalf("stopHar: exit %d, stderr %q", code, stderr)
	}

	cmd := <-commands
	if cmd.Command != "stopHar" || cmd.Params["tabId"] != float64(7) {
		t.Errorf("forwarded %q with %#v, want stopHar with tabId 7", cmd.Command, cmd.Params)
	}

	var want bytes.Buffer
	if err := json.Indent(&want, har, "", "  "); err != nil {
		t.Fatalf("indent input: %v", err)
	}

	want.WriteByte('\n')

	if got != want.String() {
		t.Errorf("stdout = %q, want %q", got, want.String())
	}

	for _, literal := range []string{`"text": "<p>Fish &amp; chips</p> & <b>"`, `?a=1&b=2`} {
		if !strings.Contains(got, literal) {
			t.Errorf("stdout lacks %q", literal)
		}
	}

	var top map[string]json.RawMessage
	if err := json.Unmarshal([]byte(got), &top); err != nil {
		t.Fatalf("stdout is not JSON: %v", err)
	}

	if _, ok := top["log"]; !ok || len(top) != 1 {
		t.Errorf("top-level keys of %v, want log only", top)
	}

	signals <- syscall.SIGTERM

	if err := waitDone(t, done); err != nil {
		t.Fatalf("runHost() error = %v, want nil", err)
	}
}
