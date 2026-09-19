package host

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"firefox-ctl/internal/nativemsg"
	"firefox-ctl/internal/protocol"
)

const testVersion = "9.9.9-test"

var uuidRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// safeBuffer collects log output that the test goroutine reads while server
// goroutines write.
type safeBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *safeBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.buf.Write(p)
}

func (b *safeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.buf.String()
}

type fakeTimer struct {
	d    time.Duration
	fire func()

	mu      sync.Mutex
	stopped bool
}

func (t *fakeTimer) stop() {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.stopped = true
}

func (t *fakeTimer) isStopped() bool {
	t.mu.Lock()
	defer t.mu.Unlock()

	return t.stopped
}

// fakeClock replaces time.AfterFunc so request timeouts fire on demand.
type fakeClock struct {
	created chan *fakeTimer
}

func newFakeClock() *fakeClock {
	return &fakeClock{created: make(chan *fakeTimer, 64)}
}

func (c *fakeClock) afterFunc(d time.Duration, f func()) func() {
	t := &fakeTimer{d: d, fire: f}
	c.created <- t

	return t.stop
}

func (c *fakeClock) next(t *testing.T) *fakeTimer {
	t.Helper()

	select {
	case timer := <-c.created:
		return timer
	case <-time.After(2 * time.Second):
		t.Fatal("no request timer was created")

		return nil
	}
}

type fixture struct {
	t       *testing.T
	stopped bool
	sock    string
	ext     *extensionSide
	clock   *fakeClock
	logs    *safeBuffer
	done    chan error
	cancel  context.CancelFunc
	stdin   *io.PipeWriter
}

// extensionSide is the fake extension: it reads the frames the host writes to
// stdout and writes frames into the host's stdin.
type extensionSide struct {
	in  *nativemsg.Reader
	out *nativemsg.Writer
}

func (e *extensionSide) read(t *testing.T) protocol.HostCommand {
	t.Helper()

	raw := e.readRaw(t)

	var cmd protocol.HostCommand
	if err := json.Unmarshal(raw, &cmd); err != nil {
		t.Fatalf("unmarshal host frame %s: %v", raw, err)
	}

	return cmd
}

func (e *extensionSide) readRaw(t *testing.T) json.RawMessage {
	t.Helper()

	type result struct {
		raw json.RawMessage
		err error
	}

	ch := make(chan result, 1)

	go func() {
		raw, err := e.in.Read()
		ch <- result{raw, err}
	}()

	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatalf("read host frame: %v", r.err)
		}

		return r.raw
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for a host frame")

		return nil
	}
}

func (e *extensionSide) reply(t *testing.T, msg *protocol.ExtensionMessage) {
	t.Helper()

	if err := e.out.Write(msg); err != nil {
		t.Fatalf("write extension frame: %v", err)
	}
}

type options struct {
	idleTimeout    time.Duration
	drainTimeout   time.Duration
	maxConns       int
	maxRequestSize int
	stdout         io.Writer
	listener       net.Listener
}

func start(t *testing.T, opt options) *fixture {
	t.Helper()

	sock := filepath.Join(shortTempDir(t), "s")

	ln := opt.listener
	if ln == nil {
		var err error
		if ln, err = net.Listen("unix", sock); err != nil {
			t.Fatalf("listen: %v", err)
		}
	}

	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()

	var hostOut io.Writer = stdoutW
	if opt.stdout != nil {
		hostOut = opt.stdout
	}

	logs := &safeBuffer{}
	clock := newFakeClock()

	srv := NewServer(&Options{
		Logger:         log.New(logs, "", 0),
		Version:        testVersion,
		IdleTimeout:    opt.idleTimeout,
		DrainTimeout:   opt.drainTimeout,
		MaxConnections: opt.maxConns,
		MaxRequestSize: opt.maxRequestSize,
		AfterFunc:      clock.afterFunc,
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)

	go func() { done <- srv.Run(ctx, ln, stdinR, hostOut) }()

	f := &fixture{
		t:      t,
		sock:   sock,
		ext:    &extensionSide{in: nativemsg.NewReader(stdoutR), out: nativemsg.NewWriter(stdinW)},
		clock:  clock,
		logs:   logs,
		done:   done,
		cancel: cancel,
		stdin:  stdinW,
	}

	t.Cleanup(func() {
		cancel()
		_ = stdinW.Close()
		_ = stdoutR.Close()
		_ = ln.Close()

		if f.stopped {
			return
		}

		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("server did not stop")
		}
	})

	return f
}

// wait returns the error Run reported.
func (f *fixture) wait() error {
	f.t.Helper()

	select {
	case err := <-f.done:
		f.stopped = true

		return err
	case <-time.After(2 * time.Second):
		f.t.Fatal("server did not stop")

		return nil
	}
}

type client struct {
	conn net.Conn
	r    *bufio.Reader
}

func (f *fixture) dial() *client {
	f.t.Helper()

	conn, err := net.Dial("unix", f.sock)
	if err != nil {
		f.t.Fatalf("dial %s: %v", f.sock, err)
	}

	f.t.Cleanup(func() { _ = conn.Close() })

	return &client{conn: conn, r: bufio.NewReader(conn)}
}

func (c *client) send(t *testing.T, line string) {
	t.Helper()

	if _, err := c.conn.Write([]byte(line + "\n")); err != nil {
		t.Fatalf("write request: %v", err)
	}
}

func (c *client) sendCommand(t *testing.T, command string, params map[string]any) {
	t.Helper()

	line, err := json.Marshal(protocol.ClientRequest{Command: command, Params: params})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}

	c.send(t, string(line))
}

// raw reads one NDJSON response line as a generic map so tests can assert on
// absent fields such as id.
func (c *client) raw(t *testing.T) map[string]any {
	t.Helper()

	_ = c.conn.SetReadDeadline(time.Now().Add(2 * time.Second))

	line, err := c.r.ReadBytes('\n')
	if err != nil {
		t.Fatalf("read response: %v", err)
	}

	var out map[string]any
	if err := json.Unmarshal(line, &out); err != nil {
		t.Fatalf("unmarshal response %s: %v", line, err)
	}

	return out
}

func boolPtr(v bool) *bool { return &v }

func TestServerForwardsCommandAndRoutesResponse(t *testing.T) {
	t.Parallel()

	f := start(t, options{})
	c := f.dial()

	c.sendCommand(t, "navigate", map[string]any{"url": "https://example.com"})

	cmd := f.ext.read(t)
	if !uuidRE.MatchString(cmd.ID) {
		t.Errorf("id = %q, want a uuid v4", cmd.ID)
	}

	if cmd.Type != protocol.TypeCommand {
		t.Errorf("type = %q, want %q", cmd.Type, protocol.TypeCommand)
	}

	if cmd.Command != "navigate" {
		t.Errorf("command = %q, want navigate", cmd.Command)
	}

	if cmd.Params["url"] != "https://example.com" {
		t.Errorf("params = %v, want url passed through", cmd.Params)
	}

	f.ext.reply(t, &protocol.ExtensionMessage{
		ID:      cmd.ID,
		Success: boolPtr(true),
		Result:  json.RawMessage(`{"ok":true}`),
	})

	resp := c.raw(t)
	if resp["success"] != true {
		t.Errorf("success = %v, want true", resp["success"])
	}

	if _, ok := resp["id"]; ok {
		t.Errorf("response carries id: %v", resp)
	}

	result, ok := resp["result"].(map[string]any)
	if !ok || result["ok"] != true {
		t.Errorf("result = %v, want {ok:true}", resp["result"])
	}
}

func TestServerForwardsErrorResponse(t *testing.T) {
	t.Parallel()

	f := start(t, options{})
	c := f.dial()

	c.sendCommand(t, "click", nil)

	cmd := f.ext.read(t)
	if cmd.Params == nil {
		t.Error("params must be an object even when the client omits them")
	}

	f.ext.reply(t, &protocol.ExtensionMessage{
		ID:      cmd.ID,
		Success: boolPtr(false),
		Error:   "element not found",
	})

	resp := c.raw(t)
	if resp["success"] != false {
		t.Errorf("success = %v, want false", resp["success"])
	}

	if resp["error"] != "element not found" {
		t.Errorf("error = %v, want element not found", resp["error"])
	}
}

func TestServerRoutesConcurrentClients(t *testing.T) {
	t.Parallel()

	f := start(t, options{})
	first, second := f.dial(), f.dial()

	first.sendCommand(t, "ping", nil)
	second.sendCommand(t, "version", nil)

	byCommand := map[string]string{}
	for range 2 {
		cmd := f.ext.read(t)
		byCommand[cmd.Command] = cmd.ID
	}

	// answer out of order to prove correlation is by id, not arrival
	f.ext.reply(t, &protocol.ExtensionMessage{
		ID:      byCommand["version"],
		Success: boolPtr(true),
		Result:  json.RawMessage(`{"who":"version"}`),
	})
	f.ext.reply(t, &protocol.ExtensionMessage{
		ID:      byCommand["ping"],
		Success: boolPtr(true),
		Result:  json.RawMessage(`{"who":"ping"}`),
	})

	for name, c := range map[string]*client{"ping": first, "version": second} {
		resp := c.raw(t)

		result, ok := resp["result"].(map[string]any)
		if !ok || result["who"] != name {
			t.Errorf("%s client got %v", name, resp)
		}

		if _, ok := resp["id"]; ok {
			t.Errorf("%s response carries id: %v", name, resp)
		}
	}
}

func TestServerRequestTimeout(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		params map[string]any
		wantMs int
	}{
		{name: "default when absent", params: nil, wantMs: protocol.DefaultTimeoutMs},
		{name: "honoured in range", params: map[string]any{protocol.TimeoutParam: 5000}, wantMs: 5000},
		{name: "below minimum falls back", params: map[string]any{protocol.TimeoutParam: 100}, wantMs: protocol.DefaultTimeoutMs},
		{name: "above maximum falls back", params: map[string]any{protocol.TimeoutParam: 400000}, wantMs: protocol.DefaultTimeoutMs},
		{name: "non-numeric falls back", params: map[string]any{protocol.TimeoutParam: "soon"}, wantMs: protocol.DefaultTimeoutMs},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			f := start(t, options{})
			c := f.dial()

			c.sendCommand(t, "getContent", tc.params)
			f.ext.read(t)

			timer := f.clock.next(t)
			if want := time.Duration(tc.wantMs) * time.Millisecond; timer.d != want {
				t.Fatalf("timer duration = %s, want %s", timer.d, want)
			}

			timer.fire()

			resp := c.raw(t)
			if resp["success"] != false {
				t.Errorf("success = %v, want false", resp["success"])
			}

			wantErr := fmt.Sprintf("Request timed out after %dms (command: getContent)", tc.wantMs)
			if resp["error"] != wantErr {
				t.Errorf("error = %v, want %q", resp["error"], wantErr)
			}

			if resp["command"] != "getContent" {
				t.Errorf("command = %v, want getContent", resp["command"])
			}

			if resp["timeoutMs"] != float64(tc.wantMs) {
				t.Errorf("timeoutMs = %v, want %d", resp["timeoutMs"], tc.wantMs)
			}
		})
	}
}

func TestServerTimeoutFiresOnce(t *testing.T) {
	t.Parallel()

	f := start(t, options{})
	c := f.dial()

	c.sendCommand(t, "ping", nil)
	cmd := f.ext.read(t)
	timer := f.clock.next(t)

	timer.fire()
	_ = c.raw(t)

	// a late extension response must not produce a second client response
	f.ext.reply(t, &protocol.ExtensionMessage{ID: cmd.ID, Success: boolPtr(true)})

	_ = c.conn.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
	if _, err := c.r.ReadBytes('\n'); err == nil {
		t.Fatal("got a second response after the timeout")
	}
}

func TestServerClearsTimerOnResponse(t *testing.T) {
	t.Parallel()

	f := start(t, options{})
	c := f.dial()

	c.sendCommand(t, "ping", nil)
	cmd := f.ext.read(t)
	timer := f.clock.next(t)

	f.ext.reply(t, &protocol.ExtensionMessage{ID: cmd.ID, Success: boolPtr(true)})
	_ = c.raw(t)

	if !timer.isStopped() {
		t.Error("request timer was not cleared after the response")
	}
}

func TestServerIgnoresLateTimerAfterResponse(t *testing.T) {
	t.Parallel()

	f := start(t, options{})
	c := f.dial()

	c.sendCommand(t, "ping", nil)
	cmd := f.ext.read(t)
	timer := f.clock.next(t)

	f.ext.reply(t, &protocol.ExtensionMessage{ID: cmd.ID, Success: boolPtr(true)})
	_ = c.raw(t)

	// the request was already answered and removed from the pending table;
	// a timer that still fires afterwards must be a no-op.
	timer.fire()

	_ = c.conn.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
	if _, err := c.r.ReadBytes('\n'); err == nil {
		t.Fatal("got a second response after the request was already answered")
	}
}

func TestServerDropsPendingOnClientDisconnect(t *testing.T) {
	t.Parallel()

	f := start(t, options{})
	c := f.dial()

	c.sendCommand(t, "screenshot", nil)
	cmd := f.ext.read(t)
	timer := f.clock.next(t)

	if err := c.conn.Close(); err != nil {
		t.Fatalf("close client: %v", err)
	}

	waitFor(t, "pending request dropped", timer.isStopped)

	// the late response has nowhere to go and must be dropped, not panic
	f.ext.reply(t, &protocol.ExtensionMessage{ID: cmd.ID, Success: boolPtr(true)})

	f.ext.reply(t, &protocol.ExtensionMessage{ID: "probe", Command: "ping"})
	if got := f.ext.read(t); got.ID != "probe" {
		t.Errorf("host stopped serving after a dropped response: %+v", got)
	}
}

func TestServerIdleTimeoutClosesSilentConnection(t *testing.T) {
	t.Parallel()

	f := start(t, options{idleTimeout: 50 * time.Millisecond})
	c := f.dial()

	_ = c.conn.SetReadDeadline(time.Now().Add(2 * time.Second))

	if _, err := c.r.ReadBytes('\n'); !errors.Is(err, io.EOF) {
		t.Fatalf("read after idle timeout = %v, want EOF", err)
	}
}

func TestServerIdleTimeoutDisarmedByRequest(t *testing.T) {
	t.Parallel()

	f := start(t, options{idleTimeout: 50 * time.Millisecond})
	c := f.dial()

	c.sendCommand(t, "waitFor", map[string]any{"selector": "#done"})
	cmd := f.ext.read(t)

	time.Sleep(150 * time.Millisecond)

	f.ext.reply(t, &protocol.ExtensionMessage{
		ID:      cmd.ID,
		Success: boolPtr(true),
		Result:  json.RawMessage(`{"found":true}`),
	})

	if resp := c.raw(t); resp["success"] != true {
		t.Errorf("active connection was closed by the idle timeout: %v", resp)
	}
}

func TestServerRejectsInvalidRequests(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		line    string
		wantErr string
	}{
		{name: "malformed json", line: `{"command":`, wantErr: "Invalid JSON"},
		{name: "missing command", line: `{"params":{}}`, wantErr: "Invalid or missing command"},
		{name: "empty command", line: `{"command":""}`, wantErr: "Invalid or missing command"},
		{name: "non-string command", line: `{"command":123}`, wantErr: "Invalid or missing command"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			f := start(t, options{})
			c := f.dial()

			c.send(t, tc.line)

			resp := c.raw(t)
			if resp["success"] != false {
				t.Errorf("success = %v, want false", resp["success"])
			}

			if resp["error"] != tc.wantErr {
				t.Errorf("error = %v, want %q", resp["error"], tc.wantErr)
			}
		})
	}
}

func TestServerIgnoresBlankLines(t *testing.T) {
	t.Parallel()

	f := start(t, options{})
	c := f.dial()

	c.send(t, "")
	c.send(t, "   ")
	c.sendCommand(t, "ping", nil)

	if cmd := f.ext.read(t); cmd.Command != "ping" {
		t.Errorf("command = %q, want ping", cmd.Command)
	}
}

func TestServerRejectsOversizeRequest(t *testing.T) {
	t.Parallel()

	f := start(t, options{maxRequestSize: 256})
	c := f.dial()

	big := strings.Repeat("x", 1024)
	c.sendCommand(t, "type", map[string]any{"text": big})

	resp := c.raw(t)
	if resp["error"] != "Message too large" {
		t.Errorf("error = %v, want Message too large", resp["error"])
	}

	_ = c.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := c.r.ReadBytes('\n'); !errors.Is(err, io.EOF) {
		t.Errorf("connection after oversize request = %v, want EOF", err)
	}
}

// refuse sends a request above the cap and reads the refusal, leaving the
// connection open with the unread rest of the line still in flight.
func (c *client) refuse(t *testing.T) {
	t.Helper()

	c.sendCommand(t, "type", map[string]any{"text": strings.Repeat("x", 1024)})

	if resp := c.raw(t); resp["error"] != "Message too large" {
		t.Fatalf("error = %v, want Message too large", resp["error"])
	}
}

// TestServerDrainReleasesSlotAtDeadline covers a refused client that never
// hangs up: once drainTimeout passes its socket is closed and its connection
// slot goes back to the pool, so the next client is served.
func TestServerDrainReleasesSlotAtDeadline(t *testing.T) {
	t.Parallel()

	const drain = 50 * time.Millisecond

	f := start(t, options{maxRequestSize: 256, maxConns: 1, drainTimeout: drain})
	stuck := f.dial()
	stuck.refuse(t)

	refused := time.Now()

	next := f.dial()
	next.sendCommand(t, "version", nil)

	if cmd := f.ext.read(t); cmd.Command != "version" {
		t.Errorf("command = %q, want version once the drained slot freed", cmd.Command)
	}

	if waited := time.Since(refused); waited < drain {
		t.Errorf("slot freed after %s, before the %s drain deadline", waited, drain)
	}

	_ = stuck.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := stuck.r.ReadBytes('\n'); err == nil {
		t.Error("refused client still readable after the drain deadline, want EOF or reset")
	}

	if !strings.Contains(f.logs.String(), "request above 256 bytes, closing client") {
		t.Errorf("logs = %q, want the oversize refusal logged", f.logs.String())
	}
}

// TestServerDrainDeadlineIsAbsolute covers a refused client that keeps
// sending: incoming bytes must not push the deadline back, so the socket is
// closed at about drainTimeout even though data never stops arriving.
func TestServerDrainDeadlineIsAbsolute(t *testing.T) {
	t.Parallel()

	const drain = 100 * time.Millisecond

	f := start(t, options{maxRequestSize: 256, drainTimeout: drain})
	c := f.dial()
	c.refuse(t)

	refused := time.Now()
	chunk := []byte(strings.Repeat("y", 4096))

	var closedAfter time.Duration

	for {
		_ = c.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		if _, err := c.conn.Write(chunk); err != nil {
			closedAfter = time.Since(refused)

			break
		}

		if time.Since(refused) > 3*time.Second {
			t.Fatal("writes still accepted 3 s after the refusal; the drain deadline was extended")
		}

		time.Sleep(5 * time.Millisecond)
	}

	if closedAfter > 10*drain {
		t.Errorf("socket closed %s after the refusal, want about %s: the deadline was extended by the stream", closedAfter, drain)
	}
}

// TestServerCloseInterruptsDrain covers shutdown while a drain is in flight:
// closing the clients must interrupt the discard copy so Run returns at once
// rather than after the full drain deadline.
func TestServerCloseInterruptsDrain(t *testing.T) {
	t.Parallel()

	f := start(t, options{maxRequestSize: 256, drainTimeout: 30 * time.Second})
	c := f.dial()
	c.refuse(t)

	started := time.Now()
	f.cancel()

	if err := f.wait(); err != nil {
		t.Errorf("Run() = %v, want nil", err)
	}

	if took := time.Since(started); took > time.Second {
		t.Errorf("Run returned after %s, want well under the 30 s drain deadline", took)
	}
}

func TestServerStopsOnStdinEOF(t *testing.T) {
	t.Parallel()

	f := start(t, options{})

	if err := f.stdin.Close(); err != nil {
		t.Fatalf("close stdin: %v", err)
	}

	if err := f.wait(); err != nil {
		t.Errorf("Run() = %v, want nil on stdin EOF", err)
	}
}

func TestServerStopsOnContextCancel(t *testing.T) {
	t.Parallel()

	f := start(t, options{})
	f.dial()
	f.cancel()

	if err := f.wait(); err != nil {
		t.Errorf("Run() = %v, want nil on cancellation", err)
	}
}

// TestServerDropsPendingOnShutdown guards against a shutdown that closes a
// client's socket without also dropping its pending request: a late extension
// reply for that request must not reach the now-dead connection.
func TestServerDropsPendingOnShutdown(t *testing.T) {
	t.Parallel()

	f := start(t, options{})
	c := f.dial()

	c.sendCommand(t, "ping", nil)
	cmd := f.ext.read(t)
	f.clock.next(t)

	f.cancel()

	if err := f.wait(); err != nil {
		t.Errorf("Run() = %v, want nil on cancellation", err)
	}

	_ = c.conn.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
	if _, err := c.r.ReadBytes('\n'); err == nil {
		t.Fatal("client received a response after shutdown closed its connection")
	}

	// the extension replying after shutdown must not panic or hang the host.
	f.ext.reply(t, &protocol.ExtensionMessage{ID: cmd.ID, Success: boolPtr(true)})
}

// TestServerServeDropsConnectionDuringShutdown exercises serve()'s own guard
// directly: the accept loop normally stops pulling new connections once
// s.closing is set, but a connection accepted in the same instant must still
// be dropped by serve() itself rather than served out to its idle timeout.
func TestServerServeDropsConnectionDuringShutdown(t *testing.T) {
	t.Parallel()

	srv := NewServer(&Options{
		Version: testVersion})
	srv.closing = true

	server, client := net.Pipe()
	t.Cleanup(func() { _ = client.Close() })

	done := make(chan struct{})
	go func() {
		srv.serve(server)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("serve() did not return immediately while shutting down")
	}

	buf := make([]byte, 1)
	if _, err := client.Read(buf); err == nil {
		t.Error("serve() did not close the connection while shutting down")
	}
}

func TestServerAnswersExtensionPing(t *testing.T) {
	t.Parallel()

	f := start(t, options{})

	f.ext.reply(t, &protocol.ExtensionMessage{ID: "ext-1", Command: "ping"})

	var got struct {
		ID      string `json:"id"`
		Success bool   `json:"success"`
		Result  struct {
			Pong      bool  `json:"pong"`
			Timestamp int64 `json:"timestamp"`
		} `json:"result"`
	}

	raw := f.ext.readRaw(t)
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal %s: %v", raw, err)
	}

	if got.ID != "ext-1" || !got.Success || !got.Result.Pong {
		t.Errorf("ping reply = %s", raw)
	}

	if got.Result.Timestamp <= 0 {
		t.Errorf("timestamp = %d, want a unix milli value", got.Result.Timestamp)
	}
}

func TestServerAnswersExtensionVersion(t *testing.T) {
	t.Parallel()

	f := start(t, options{})

	f.ext.reply(t, &protocol.ExtensionMessage{ID: "ext-2", Command: "version"})

	var got struct {
		ID     string `json:"id"`
		Result struct {
			Host     string `json:"host"`
			Go       string `json:"go"`
			Platform string `json:"platform"`
		} `json:"result"`
	}

	raw := f.ext.readRaw(t)
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal %s: %v", raw, err)
	}

	if got.ID != "ext-2" || got.Result.Host != testVersion {
		t.Errorf("version reply = %s", raw)
	}

	if got.Result.Go == "" || got.Result.Platform == "" {
		t.Errorf("version reply misses runtime details: %s", raw)
	}
}

func TestServerDropsUnknownExtensionMessage(t *testing.T) {
	t.Parallel()

	f := start(t, options{})

	f.ext.reply(t, &protocol.ExtensionMessage{ID: "orphan", Command: "surprise"})
	f.ext.reply(t, &protocol.ExtensionMessage{ID: "ext-3", Command: "ping"})

	// the next frame is the ping answer, proving the unknown message produced none
	if got := f.ext.read(t); got.ID != "ext-3" {
		t.Errorf("unexpected frame for the dropped message: %+v", got)
	}

	waitFor(t, "drop logged", func() bool {
		return strings.Contains(f.logs.String(), "surprise")
	})
}

func TestServerSkipsMalformedExtensionFrame(t *testing.T) {
	t.Parallel()

	f := start(t, options{})

	writeFrame(t, f.stdin, []byte(`{"id":`))
	f.ext.reply(t, &protocol.ExtensionMessage{ID: "ext-4", Command: "ping"})

	if got := f.ext.read(t); got.ID != "ext-4" {
		t.Errorf("host did not skip the malformed frame: %+v", got)
	}
}

func TestServerStopsOnStdinFramingError(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		frame []byte
		want  error
	}{
		{name: "partial frame", frame: append(header(64), []byte("{}")...), want: io.ErrUnexpectedEOF},
		{name: "oversize header", frame: header(nativemsg.MaxInbound + 1), want: nativemsg.ErrTooLarge},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			f := start(t, options{})

			if _, err := f.stdin.Write(tc.frame); err != nil {
				t.Fatalf("write frame: %v", err)
			}

			if errors.Is(tc.want, io.ErrUnexpectedEOF) {
				_ = f.stdin.Close()
			}

			err := f.wait()
			if !errors.Is(err, tc.want) {
				t.Fatalf("Run() = %v, want %v", err, tc.want)
			}
		})
	}
}

// flakyListener returns one transient error before delegating to the real
// listener, so the accept loop is exercised on a recoverable failure.
type flakyListener struct {
	net.Listener

	mu     sync.Mutex
	failed bool
}

func (l *flakyListener) Accept() (net.Conn, error) {
	l.mu.Lock()
	first := !l.failed
	l.failed = true
	l.mu.Unlock()

	if first {
		return nil, errors.New("transient accept failure")
	}

	return l.Listener.Accept()
}

func TestServerContinuesAfterAcceptError(t *testing.T) {
	t.Parallel()

	sock := filepath.Join(shortTempDir(t), "s")

	base, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	f := start(t, options{listener: &flakyListener{Listener: base}})
	f.sock = sock

	waitFor(t, "accept error logged", func() bool {
		return strings.Contains(f.logs.String(), "transient accept failure")
	})

	c := f.dial()
	c.sendCommand(t, "ping", nil)

	if cmd := f.ext.read(t); cmd.Command != "ping" {
		t.Errorf("command = %q, want ping", cmd.Command)
	}
}

// failingWriter stands in for a closed stdout pipe.
type failingWriter struct{}

var errStdoutClosed = errors.New("stdout closed")

func (failingWriter) Write([]byte) (int, error) { return 0, errStdoutClosed }

func TestServerStopsOnStdoutWriteError(t *testing.T) {
	t.Parallel()

	f := start(t, options{stdout: failingWriter{}})
	c := f.dial()

	c.sendCommand(t, "ping", nil)

	err := f.wait()
	if !errors.Is(err, errStdoutClosed) {
		t.Fatalf("Run() = %v, want %v", err, errStdoutClosed)
	}
}

func TestServerAnswerWriteErrorStopsServer(t *testing.T) {
	t.Parallel()

	f := start(t, options{stdout: failingWriter{}})

	f.ext.reply(t, &protocol.ExtensionMessage{ID: "ext-1", Command: "ping"})

	err := f.wait()
	if !errors.Is(err, errStdoutClosed) {
		t.Fatalf("Run() = %v, want %v", err, errStdoutClosed)
	}
}

func TestServerLimitsConnections(t *testing.T) {
	t.Parallel()

	f := start(t, options{maxConns: 1})

	first := f.dial()
	first.sendCommand(t, "ping", nil)
	f.ext.read(t)
	f.clock.next(t)

	second := f.dial()
	second.sendCommand(t, "version", nil)

	select {
	case <-f.clock.created:
		t.Fatal("second connection was served while the limit was reached")
	case <-time.After(150 * time.Millisecond):
	}

	if err := first.conn.Close(); err != nil {
		t.Fatalf("close first client: %v", err)
	}

	if cmd := f.ext.read(t); cmd.Command != "version" {
		t.Errorf("command = %q, want version once a slot freed", cmd.Command)
	}
}

func TestServerReplySkipsClosedClient(t *testing.T) {
	t.Parallel()

	srv := NewServer(&Options{
		Version: testVersion})

	server, client := net.Pipe()
	t.Cleanup(func() { _ = client.Close(); _ = server.Close() })

	c := &clientConn{nc: server, closed: true}

	srv.reply(c, protocol.ClientResponse{Success: true})

	_ = client.SetReadDeadline(time.Now().Add(50 * time.Millisecond))

	buf := make([]byte, 1)
	if _, err := client.Read(buf); !os.IsTimeout(err) {
		t.Errorf("reply() wrote to a client marked closed (err = %v)", err)
	}
}

func TestServerReplyLogsWriteError(t *testing.T) {
	t.Parallel()

	logs := &safeBuffer{}
	srv := NewServer(&Options{
		Logger: log.New(logs, "", 0), Version: testVersion})

	server, client := net.Pipe()
	if err := client.Close(); err != nil {
		t.Fatalf("close client: %v", err)
	}
	t.Cleanup(func() { _ = server.Close() })

	c := &clientConn{nc: server}

	srv.reply(c, protocol.ClientResponse{Success: true})

	if !strings.Contains(logs.String(), "write response:") {
		t.Errorf("logs = %q, want a write response error logged", logs.String())
	}
}

// TestServerReplyBoundedByWriteTimeout guards against a stuck client wedging
// reply(): without a write deadline a client that never reads blocks the
// caller forever, which would stall the single-threaded extension message
// pump and, during shutdown, closeClient's wait on the same mutex.
func TestServerReplyBoundedByWriteTimeout(t *testing.T) {
	t.Parallel()

	logs := &safeBuffer{}
	srv := NewServer(&Options{
		Logger:       log.New(logs, "", 0),
		Version:      testVersion,
		WriteTimeout: 20 * time.Millisecond,
	})

	server, client := net.Pipe()
	t.Cleanup(func() { _ = client.Close(); _ = server.Close() })

	c := &clientConn{nc: server, ids: make(map[string]struct{})}

	done := make(chan struct{})

	go func() {
		srv.reply(c, protocol.ClientResponse{Success: true})
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("reply() blocked on a stuck client instead of honouring the write deadline")
	}

	if !strings.Contains(logs.String(), "write response:") {
		t.Errorf("logs = %q, want a write timeout error logged", logs.String())
	}
}

// TestServerReplyClosesClientAfterWriteTimeout guards against a client that
// stopped reading holding its connection slot forever: without closing it, a
// handful of stuck clients could exhaust MaxConnections while their read loop
// blocks with no deadline waiting on a peer that will never write again.
func TestServerReplyClosesClientAfterWriteTimeout(t *testing.T) {
	t.Parallel()

	logs := &safeBuffer{}
	srv := NewServer(&Options{
		Logger:       log.New(logs, "", 0),
		Version:      testVersion,
		WriteTimeout: 20 * time.Millisecond,
	})

	server, client := net.Pipe()
	t.Cleanup(func() { _ = client.Close(); _ = server.Close() })

	c := &clientConn{nc: server, ids: make(map[string]struct{})}

	srv.mu.Lock()
	srv.conns[c] = struct{}{}
	srv.mu.Unlock()

	done := make(chan struct{})

	go func() {
		srv.reply(c, protocol.ClientResponse{Success: true})
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("reply() blocked on a stuck client instead of honouring the write deadline")
	}

	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()

	if !closed {
		t.Error("client not marked closed after a write timeout; it keeps holding a connection slot")
	}

	srv.mu.Lock()
	_, stillTracked := srv.conns[c]
	srv.mu.Unlock()

	if stillTracked {
		t.Error("client still tracked in conns after a write timeout; it keeps holding a MaxConnections slot")
	}
}

func header(length int) []byte {
	buf := make([]byte, 4)
	//nolint:gosec // test-only helper, lengths are small literals
	binary.NativeEndian.PutUint32(buf, uint32(length))

	return buf
}

func writeFrame(t *testing.T, w io.Writer, payload []byte) {
	t.Helper()

	if _, err := w.Write(append(header(len(payload)), payload...)); err != nil {
		t.Fatalf("write frame: %v", err)
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

func TestNewServerDefaultsNilLoggerToStderr(t *testing.T) {
	t.Parallel()

	srv := NewServer(&Options{
		Version: testVersion})

	if srv.log == nil {
		t.Fatal("log = nil, want a default stderr logger")
	}
}

func TestDefaultAfterFuncFires(t *testing.T) {
	t.Parallel()

	fired := make(chan struct{})
	defaultAfterFunc(10*time.Millisecond, func() { close(fired) })

	select {
	case <-fired:
	case <-time.After(2 * time.Second):
		t.Fatal("callback never fired")
	}
}

func TestDefaultAfterFuncStopCancelsPendingCallback(t *testing.T) {
	t.Parallel()

	fired := make(chan struct{}, 1)
	stop := defaultAfterFunc(50*time.Millisecond, func() { fired <- struct{}{} })
	stop()

	select {
	case <-fired:
		t.Fatal("callback fired after stop")
	case <-time.After(150 * time.Millisecond):
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}

		time.Sleep(5 * time.Millisecond)
	}

	t.Fatalf("timed out waiting for %s", what)
}
