// Package host implements the native messaging host: it bridges CLI clients
// connected to the unix socket with the Firefox extension on stdio.
package host

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"runtime"
	"sync"
	"time"

	"firefox-ctl/internal/nativemsg"
	"firefox-ctl/internal/protocol"
)

const (
	// MaxRequestSize caps one NDJSON request line; a longer one is refused and
	// the connection is closed.
	MaxRequestSize = 10 * 1024 * 1024
	// DefaultDrainTimeout bounds how long a client refused for an oversize
	// request may keep sending before its socket is closed anyway.
	DefaultDrainTimeout = time.Second
	// DefaultIdleTimeout closes clients that connect but never send a request.
	DefaultIdleTimeout = 60 * time.Second
	// DefaultMaxConnections bounds concurrently served CLI clients.
	DefaultMaxConnections = 10
	// DefaultWriteTimeout bounds each chunk of a reply write so a client that
	// stopped reading is cut and can never hold its connection or shutdown.
	DefaultWriteTimeout = 5 * time.Second
)

// writeChunkSize is the largest piece of a reply written under one deadline.
const writeChunkSize = 64 * 1024

// Client-facing error strings; docs/architecture.md pins them.
const (
	msgInvalidJSON    = "Invalid JSON"
	msgMissingCommand = "Invalid or missing command"
	msgTooLarge       = "Message too large"
)

const (
	cmdPing    = "ping"
	cmdVersion = "version"
)

// Options configures a Server. Every field has a production default; the
// timing and size knobs exist so tests do not have to wait or allocate.
type Options struct {
	Logger         *log.Logger
	Version        string
	IdleTimeout    time.Duration
	WriteTimeout   time.Duration
	DrainTimeout   time.Duration
	MaxConnections int
	MaxRequestSize int
	MaxInbound     uint32
	NewID          func() string
	AfterFunc      func(d time.Duration, f func()) (stop func())
}

// Server owns the socket listener, the pending request table and the stdio
// bridge to the extension.
type Server struct {
	log            *log.Logger
	version        string
	idleTimeout    time.Duration
	writeTimeout   time.Duration
	drainTimeout   time.Duration
	maxConns       int
	maxRequestSize int
	maxInbound     uint32
	newID          func() string
	afterFunc      func(d time.Duration, f func()) (stop func())

	out   *nativemsg.Writer
	fatal chan error

	mu      sync.Mutex
	pending map[string]*request
	conns   map[*clientConn]struct{}
	closing bool

	// extension replies in flight to any client, written off the pump
	replies sync.WaitGroup
}

// request is one forwarded command awaiting an extension response.
type request struct {
	command string
	conn    *clientConn
	stop    func()
}

// clientConn serialises writes to one CLI client and tracks the ids it owns.
type clientConn struct {
	nc  net.Conn
	ids map[string]struct{}

	// replies being written to this client; encoding is not counted
	writes sync.WaitGroup

	mu     sync.Mutex
	closed bool
}

// NewServer returns a Server with defaults applied for unset options; a nil
// opts means all defaults.
func NewServer(opts *Options) *Server {
	if opts == nil {
		opts = &Options{}
	}

	s := &Server{
		log:            opts.Logger,
		version:        opts.Version,
		idleTimeout:    opts.IdleTimeout,
		writeTimeout:   opts.WriteTimeout,
		drainTimeout:   opts.DrainTimeout,
		maxConns:       opts.MaxConnections,
		maxRequestSize: opts.MaxRequestSize,
		maxInbound:     opts.MaxInbound,
		newID:          opts.NewID,
		afterFunc:      opts.AfterFunc,
		fatal:          make(chan error, 1),
		pending:        make(map[string]*request),
		conns:          make(map[*clientConn]struct{}),
	}

	if s.log == nil {
		s.log = log.New(os.Stderr, "[firefox-ctl-host] ", log.LstdFlags)
	}

	if s.newID == nil {
		s.newID = newUUID
	}

	if s.afterFunc == nil {
		s.afterFunc = defaultAfterFunc
	}

	s.applyLimits()

	return s
}

// applyLimits fills the timing and size knobs left unset.
func (s *Server) applyLimits() {
	if s.idleTimeout == 0 {
		s.idleTimeout = DefaultIdleTimeout
	}

	if s.writeTimeout == 0 {
		s.writeTimeout = DefaultWriteTimeout
	}

	if s.drainTimeout == 0 {
		s.drainTimeout = DefaultDrainTimeout
	}

	if s.maxConns <= 0 {
		s.maxConns = DefaultMaxConnections
	}

	if s.maxRequestSize <= 0 {
		s.maxRequestSize = MaxRequestSize
	}

	if s.maxInbound == 0 {
		s.maxInbound = nativemsg.MaxInbound
	}
}

func defaultAfterFunc(d time.Duration, f func()) func() {
	t := time.AfterFunc(d, f)

	return func() { t.Stop() }
}

// Run serves ln until stdin reaches EOF, ctx is cancelled or a write to the
// extension fails. It returns nil for the two clean shutdowns.
func (s *Server) Run(ctx context.Context, ln net.Listener, stdin io.Reader, stdout io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	s.out = nativemsg.NewWriter(stdout)

	stdinDone := make(chan error, 1)
	go func() { stdinDone <- s.readExtension(stdin) }()

	acceptDone := make(chan struct{})

	go func() {
		defer close(acceptDone)
		s.accept(ctx, ln)
	}()

	var err error

	select {
	case err = <-stdinDone:
		// only a clean EOF waits; a framing error is fatal like any other
		if err == nil {
			s.awaitReplies(ctx)
		}
	case err = <-s.fatal:
	case <-ctx.Done():
	}

	cancel()
	_ = ln.Close()
	s.closeClients()
	<-acceptDone

	return err
}

// awaitReplies lets the replies the pump handed off before stdin ended reach
// their clients before closeClients cuts the sockets. The pump is gone, so no
// reply joins the wait; a slow reader holds shutdown for drainTimeout at most
// and cancellation ends the wait at once.
func (s *Server) awaitReplies(ctx context.Context) {
	done := make(chan struct{})

	go func() {
		s.replies.Wait()
		close(done)
	}()

	t := time.NewTimer(s.drainTimeout)
	defer t.Stop()

	select {
	case <-done:
	case <-t.C:
	case <-ctx.Done():
	}
}

// accept serves connections until ctx is done or the listener is closed. The
// semaphore is taken before Accept so the process stops pulling new clients
// off the backlog once maxConns are in flight.
func (s *Server) accept(ctx context.Context, ln net.Listener) {
	var wg sync.WaitGroup
	defer wg.Wait()

	sem := make(chan struct{}, s.maxConns)

	for {
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			return
		}

		nc, err := ln.Accept()
		if err != nil {
			<-sem

			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}

			s.log.Printf("accept: %v", err)

			continue
		}

		wg.Add(1)

		go func() {
			defer wg.Done()
			defer func() { <-sem }()

			s.serve(nc)
		}()
	}
}

// serve reads NDJSON requests from one client until it disconnects.
func (s *Server) serve(nc net.Conn) {
	c := &clientConn{nc: nc, ids: make(map[string]struct{})}

	// a client accepted while shutting down is dropped straight away, so the
	// accept loop never waits out its idle timeout
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		_ = nc.Close()

		return
	}

	s.conns[c] = struct{}{}
	s.mu.Unlock()

	// closing first makes a reply still being written fail at once
	defer c.writes.Wait()
	defer s.closeClient(c)

	s.armIdle(c)

	sc := bufio.NewScanner(nc)
	sc.Buffer(nil, s.maxRequestSize)

	idle := true

	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}

		if idle {
			s.disarmIdle(c)

			idle = false
		}

		s.handleRequest(c, line)
	}

	s.reportScanError(c, sc.Err())
}

func (s *Server) reportScanError(c *clientConn, err error) {
	switch {
	case err == nil:
	case errors.Is(err, bufio.ErrTooLong):
		s.log.Printf("request above %d bytes, closing client", s.maxRequestSize)
		s.reply(c, protocol.ClientResponse{Error: msgTooLarge})
		s.drain(c)
	case errors.Is(err, os.ErrDeadlineExceeded):
		s.log.Printf("client idle for %s, closing", s.idleTimeout)
	default:
		s.log.Printf("read from client: %v", err)
	}
}

// drain lets the client read the refusal before the socket goes away. The
// unread rest of the oversize line still sits in the receive buffer, and on
// Linux closing over unread bytes resets the connection, which can discard
// the reply. Writes are shut first so the client sees EOF right after the
// reply, then the leftover is read away until the client hangs up or the
// deadline passes; a size bound would not do, the leftover can exceed the
// request cap by any amount.
func (s *Server) drain(c *clientConn) {
	if uc, ok := c.nc.(*net.UnixConn); ok {
		_ = uc.CloseWrite()
	}

	_ = c.nc.SetReadDeadline(time.Now().Add(s.drainTimeout))
	_, _ = io.Copy(io.Discard, c.nc)
}

func (s *Server) armIdle(c *clientConn) {
	_ = c.nc.SetReadDeadline(time.Now().Add(s.idleTimeout))
}

// disarmIdle drops the connection deadline once a request arrives: the
// per-request timeout governs from that point on.
func (s *Server) disarmIdle(c *clientConn) {
	_ = c.nc.SetReadDeadline(time.Time{})
}

func (s *Server) handleRequest(c *clientConn, line []byte) {
	var envelope struct {
		Command json.RawMessage `json:"command"`
		Params  map[string]any  `json:"params,omitempty"`
	}

	if err := json.Unmarshal(line, &envelope); err != nil {
		s.log.Printf("invalid request: %v", err)
		s.reply(c, protocol.ClientResponse{Error: msgInvalidJSON})

		return
	}

	// a command that is not a JSON string (e.g. a number) is a missing
	// command, not malformed JSON: the envelope itself parsed fine.
	var command string
	if len(envelope.Command) > 0 {
		_ = json.Unmarshal(envelope.Command, &command)
	}

	if command == "" {
		s.reply(c, protocol.ClientResponse{Error: msgMissingCommand})

		return
	}

	s.forward(c, protocol.ClientRequest{Command: command, Params: envelope.Params})
}

// forward registers a pending request, arms its timeout and writes the frame.
func (s *Server) forward(c *clientConn, req protocol.ClientRequest) {
	params := req.Params
	if params == nil {
		params = map[string]any{}
	}

	id := s.newID()
	timeoutMs := timeoutMs(params)

	s.mu.Lock()
	s.pending[id] = &request{command: req.Command, conn: c}
	c.ids[id] = struct{}{}
	s.mu.Unlock()

	stop := s.afterFunc(time.Duration(timeoutMs)*time.Millisecond, func() {
		s.expire(id, req.Command, timeoutMs)
	})

	s.mu.Lock()
	if pending, ok := s.pending[id]; ok {
		pending.stop = stop
	} else {
		stop()
	}
	s.mu.Unlock()

	s.log.Printf("forwarding %s (id=%s, timeout=%dms)", req.Command, id, timeoutMs)

	cmd := protocol.HostCommand{ID: id, Type: protocol.TypeCommand, Command: req.Command, Params: params}

	err := s.out.Write(cmd)

	// the size check runs before any byte is written, so the framing is
	// intact: refuse this one request and keep serving
	var sizeErr *nativemsg.SizeError
	if errors.As(err, &sizeErr) {
		s.refuse(id, req.Command, sizeErr)

		return
	}

	if err != nil {
		s.fail(fmt.Errorf("send %s to extension: %w", req.Command, err))
	}
}

// refuse answers a command whose frame exceeds the Firefox limit.
func (s *Server) refuse(id, command string, sizeErr *nativemsg.SizeError) {
	pending := s.take(id)
	if pending == nil {
		return
	}

	s.log.Printf("refusing %s (id=%s): %v", command, id, sizeErr)
	s.reply(pending.conn, protocol.ClientResponse{
		Error: fmt.Sprintf("%s: %s message is %d bytes, the Firefox limit is %d",
			msgTooLarge, command, sizeErr.Size, sizeErr.Max),
	})
}

func (s *Server) expire(id, command string, ms int) {
	req := s.take(id)
	if req == nil {
		return
	}

	s.log.Printf("request %s timed out after %dms (command: %s)", id, ms, command)
	s.reply(req.conn, protocol.ClientResponse{
		Error:     fmt.Sprintf("Request timed out after %dms (command: %s)", ms, command),
		Command:   command,
		TimeoutMs: ms,
	})
}

// take removes a pending request and clears its timer. It returns nil when the
// request already timed out or its client disconnected.
func (s *Server) take(id string) *request {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.takeLocked(id)
}

// claim takes a pending request for a reply written off the message pump and
// counts it for awaitReplies.
func (s *Server) claim(id string) *request {
	s.mu.Lock()
	defer s.mu.Unlock()

	req := s.takeLocked(id)
	if req != nil {
		s.replies.Add(1)
	}

	return req
}

func (s *Server) takeLocked(id string) *request {
	req, ok := s.pending[id]
	if !ok {
		return nil
	}

	delete(s.pending, id)
	delete(req.conn.ids, id)

	if req.stop != nil {
		req.stop()
	}

	return req
}

func (s *Server) reply(c *clientConn, resp protocol.ClientResponse) {
	line, err := encodeLine(resp)
	if err != nil {
		s.log.Printf("marshal response: %v", err)

		return
	}

	c.mu.Lock()

	if c.closed {
		c.mu.Unlock()

		return
	}

	// only the write is counted, never the encoding: closeClient sets closed
	// under c.mu before serve waits, so no write joins after the wait began,
	// and shutdown waits for a write that fails at once on the closed socket
	c.writes.Add(1)
	defer c.writes.Done()

	writeErr := writeLine(c.nc, line, s.writeTimeout)

	c.mu.Unlock()

	if writeErr != nil {
		s.log.Printf("write response: %v", writeErr)

		// a client that failed a write is unlikely to ever read again; drop it
		// so it stops holding a connection slot and its idle read loop.
		s.closeClient(c)
	}
}

// encodeLine renders resp as one NDJSON line that carries the result bytes as
// the extension sent them. The encoder escapes <, >, & and U+2028 inside a raw
// result, six bytes for each of a HAR body's, and SetEscapeHTML(false) leaves
// U+2028 and U+2029 escaped; json.Compact keeps them, so the result is
// spliced in after the envelope.
func encodeLine(resp protocol.ClientResponse) ([]byte, error) {
	result := resp.Result
	resp.Result = nil

	var line bytes.Buffer

	line.Grow(len(result) + 64)

	enc := json.NewEncoder(&line)
	enc.SetEscapeHTML(false)

	if err := enc.Encode(resp); err != nil {
		return nil, fmt.Errorf("encode response: %w", err)
	}

	if len(result) == 0 {
		return line.Bytes(), nil
	}

	// reopen the object Encode closed with "}\n"; success is never omitted,
	// so the object already has a member and needs the comma
	line.Truncate(line.Len() - 2)
	line.WriteString(`,"result":`)

	if err := json.Compact(&line, result); err != nil {
		return nil, fmt.Errorf("compact result: %w", err)
	}

	line.WriteString("}\n")

	return line.Bytes(), nil
}

// writeLine writes line in chunks, each under its own deadline: a client that
// keeps reading gets a reply of any size, one that stalls for timeout is cut.
// A chunk that times out half-written is a stall too, the line cannot be
// resumed.
func writeLine(nc net.Conn, line []byte, timeout time.Duration) error {
	for len(line) > 0 {
		n := min(len(line), writeChunkSize)

		_ = nc.SetWriteDeadline(time.Now().Add(timeout))

		if _, err := nc.Write(line[:n]); err != nil {
			return err
		}

		line = line[n:]
	}

	return nil
}

// closeClient drops every request the client still owns, so a disconnect never
// leaves a live timer or a write to a dead socket.
func (s *Server) closeClient(c *clientConn) {
	s.mu.Lock()

	for id := range c.ids {
		if req, ok := s.pending[id]; ok {
			if req.stop != nil {
				req.stop()
			}

			delete(s.pending, id)
		}
	}

	c.ids = make(map[string]struct{})

	delete(s.conns, c)
	s.mu.Unlock()

	// closing first makes a reply blocked in Write fail at once and release
	// c.mu; a slow reader that keeps up with every chunk deadline would
	// otherwise hold shutdown until the whole reply is out
	_ = c.nc.Close()

	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()

	s.log.Printf("client disconnected")
}

func (s *Server) closeClients() {
	s.mu.Lock()
	s.closing = true
	conns := make([]*clientConn, 0, len(s.conns))

	for c := range s.conns {
		conns = append(conns, c)
	}
	s.mu.Unlock()

	// closeClient also drops the connection's pending requests and stops their
	// timers, so a late extension reply never reaches a socket this closed.
	for _, c := range conns {
		s.closeClient(c)
	}
}

// readExtension pumps frames from stdin until EOF or a framing error. An
// oversize frame has been read away by the time ErrTooLarge comes back, so the
// framing is intact and the pump goes on; the reply it carried is lost and its
// request times out. Replies to other clients wait while such a frame drains.
func (s *Server) readExtension(stdin io.Reader) error {
	r := nativemsg.NewReaderLimit(stdin, s.maxInbound)

	for {
		raw, err := r.Read()

		switch {
		case errors.Is(err, io.EOF):
			s.log.Printf("extension disconnected (eof)")

			return nil
		case errors.Is(err, nativemsg.ErrTooLarge):
			s.log.Printf("discarding extension message: %v", err)

			continue
		case err != nil:
			return fmt.Errorf("read extension message: %w", err)
		}

		var msg protocol.ExtensionMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			s.log.Printf("invalid extension message: %v", err)

			continue
		}

		s.handleExtensionMessage(&msg)
	}
}

func (s *Server) handleExtensionMessage(msg *protocol.ExtensionMessage) {
	if msg.ID != "" && msg.Success != nil {
		if req := s.claim(msg.ID); req != nil {
			resp := protocol.ClientResponse{Success: *msg.Success, Result: msg.Result, Error: msg.Error}

			// a client reading a large reply slowly holds only its own writer,
			// never the pump the other clients' replies come through
			go func() {
				defer s.replies.Done()
				s.reply(req.conn, resp)
			}()

			return
		}
	}

	switch msg.Command {
	case cmdPing:
		s.answer(msg.ID, map[string]any{"pong": true, "timestamp": time.Now().UnixMilli()})
	case cmdVersion:
		s.answer(msg.ID, map[string]any{
			"host":     s.version,
			"go":       runtime.Version(),
			"platform": runtime.GOOS,
		})
	default:
		s.log.Printf("dropping extension message (id=%q, command=%q)", msg.ID, msg.Command)
	}
}

// hostReply answers an extension-initiated request. It mirrors the response
// half of extension/src/protocol.ts and never carries a type.
type hostReply struct {
	ID      string `json:"id,omitempty"`
	Success bool   `json:"success"`
	Result  any    `json:"result,omitempty"`
}

func (s *Server) answer(id string, result map[string]any) {
	if err := s.out.Write(hostReply{ID: id, Success: true, Result: result}); err != nil {
		s.fail(fmt.Errorf("answer extension request %s: %w", id, err))
	}
}

// fail records the first unrecoverable error and unblocks Run.
func (s *Server) fail(err error) {
	s.log.Printf("fatal: %v", err)

	select {
	case s.fatal <- err:
	default:
	}
}

// timeoutMs reads the per-request timeout from params, falling back to the
// default for a missing, non-numeric or out-of-range value.
func timeoutMs(params map[string]any) int {
	raw, ok := params[protocol.TimeoutParam]
	if !ok {
		return protocol.DefaultTimeoutMs
	}

	ms, ok := asInt(raw)
	if !ok || ms < protocol.MinTimeoutMs || ms > protocol.MaxTimeoutMs {
		return protocol.DefaultTimeoutMs
	}

	return ms
}

// asInt reads a JSON number decoded into a map[string]any, which json.Unmarshal
// always represents as float64.
func asInt(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	default:
		return 0, false
	}
}
