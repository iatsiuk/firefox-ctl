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
	// drainTimeout bounds how long a refused client may keep sending before
	// its socket is closed anyway.
	drainTimeout = time.Second
	// DefaultIdleTimeout closes clients that connect but never send a request.
	DefaultIdleTimeout = 60 * time.Second
	// DefaultMaxConnections bounds concurrently served CLI clients.
	DefaultMaxConnections = 10
	// DefaultWriteTimeout bounds a reply write so a client that stopped
	// reading can never block the extension message pump or shutdown.
	DefaultWriteTimeout = 5 * time.Second
)

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
	MaxConnections int
	MaxRequestSize int
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
	maxConns       int
	maxRequestSize int
	newID          func() string
	afterFunc      func(d time.Duration, f func()) (stop func())

	out   *nativemsg.Writer
	fatal chan error

	mu      sync.Mutex
	pending map[string]*request
	conns   map[*clientConn]struct{}
	closing bool
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

	mu     sync.Mutex
	closed bool
}

// NewServer returns a Server with defaults applied for unset options.
func NewServer(opts Options) *Server {
	s := &Server{
		log:            opts.Logger,
		version:        opts.Version,
		idleTimeout:    opts.IdleTimeout,
		writeTimeout:   opts.WriteTimeout,
		maxConns:       opts.MaxConnections,
		maxRequestSize: opts.MaxRequestSize,
		newID:          opts.NewID,
		afterFunc:      opts.AfterFunc,
		fatal:          make(chan error, 1),
		pending:        make(map[string]*request),
		conns:          make(map[*clientConn]struct{}),
	}

	if s.log == nil {
		s.log = log.New(os.Stderr, "[firefox-ctl-host] ", log.LstdFlags)
	}

	if s.idleTimeout == 0 {
		s.idleTimeout = DefaultIdleTimeout
	}

	if s.writeTimeout == 0 {
		s.writeTimeout = DefaultWriteTimeout
	}

	if s.maxConns <= 0 {
		s.maxConns = DefaultMaxConnections
	}

	if s.maxRequestSize <= 0 {
		s.maxRequestSize = MaxRequestSize
	}

	if s.newID == nil {
		s.newID = newUUID
	}

	if s.afterFunc == nil {
		s.afterFunc = defaultAfterFunc
	}

	return s
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
	case err = <-s.fatal:
	case <-ctx.Done():
	}

	cancel()
	_ = ln.Close()
	s.closeClients()
	<-acceptDone

	return err
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

	_ = c.nc.SetReadDeadline(time.Now().Add(drainTimeout))
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
	if err := s.out.Write(cmd); err != nil {
		s.fail(fmt.Errorf("send %s to extension: %w", req.Command, err))
	}
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
	line, err := json.Marshal(resp)
	if err != nil {
		s.log.Printf("marshal response: %v", err)

		return
	}

	c.mu.Lock()

	if c.closed {
		c.mu.Unlock()

		return
	}

	// bounds the write so a client that stopped reading can never wedge the
	// single-threaded extension message pump or block shutdown indefinitely
	_ = c.nc.SetWriteDeadline(time.Now().Add(s.writeTimeout))
	_, writeErr := c.nc.Write(append(line, '\n'))

	c.mu.Unlock()

	if writeErr != nil {
		s.log.Printf("write response: %v", writeErr)

		// a client that failed a write is unlikely to ever read again; drop it
		// so it stops holding a connection slot and its idle read loop.
		s.closeClient(c)
	}
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

	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()

	_ = c.nc.Close()
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

// readExtension pumps frames from stdin until EOF or a framing error.
func (s *Server) readExtension(stdin io.Reader) error {
	r := nativemsg.NewReader(stdin)

	for {
		raw, err := r.Read()

		switch {
		case errors.Is(err, io.EOF):
			s.log.Printf("extension disconnected (eof)")

			return nil
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
		if req := s.take(msg.ID); req != nil {
			s.reply(req.conn, protocol.ClientResponse{
				Success: *msg.Success,
				Result:  msg.Result,
				Error:   msg.Error,
			})

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
