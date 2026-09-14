package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

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
			name:  "oversize header",
			frame: frameHeader(nativemsg.MaxInbound + 1),
			want:  nativemsg.ErrTooLarge,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			socket := filepath.Join(shortTempDir(t), "firefox-ctl.sock")
			stdin, stdinWriter := io.Pipe()

			done := runHostAsync(t, hostConfig{
				socket:  socket,
				signals: make(chan os.Signal),
				stdin:   stdin,
				stdout:  io.Discard,
				logger:  discardLogger(),
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
