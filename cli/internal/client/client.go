// Package client talks to the firefox-ctl host over the unix socket: one NDJSON
// request per connection, one NDJSON response back.
package client

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"syscall"

	"firefox-ctl/internal/protocol"
)

var (
	// ErrHostNotRunning reports a missing socket: Firefox never spawned the host.
	ErrHostNotRunning = errors.New("host not running, open Firefox with the extension loaded")

	// ErrConnectionRefused reports a stale socket with nothing listening on it.
	ErrConnectionRefused = errors.New("connection refused, make sure the extension is connected")

	// ErrNoResponse reports a host that closed the connection before replying.
	ErrNoResponse = errors.New("host closed the connection without a response")
)

// Send delivers one command to the host and returns its response. A response
// with Success false is not an error here: the caller decides the exit code.
// Cancellation and the deadline the caller derives from `_timeout` are honoured
// at every stage, including a read already in flight.
func Send(
	ctx context.Context,
	socketPath, command string,
	params map[string]any,
) (protocol.ClientResponse, error) {
	var resp protocol.ClientResponse

	line, err := encodeRequest(command, params)
	if err != nil {
		return resp, err
	}

	var d net.Dialer

	nc, err := d.DialContext(ctx, "unix", socketPath)
	if err != nil {
		return resp, dialError(socketPath, err)
	}

	defer func() { _ = nc.Close() }()

	// closing the connection unblocks a pending read on cancellation
	stop := context.AfterFunc(ctx, func() { _ = nc.Close() })
	defer stop()

	if _, err := nc.Write(line); err != nil {
		return resp, wrapCtx(ctx, fmt.Errorf("send %s: %w", command, err))
	}

	return readResponse(ctx, nc, command)
}

func encodeRequest(command string, params map[string]any) ([]byte, error) {
	if params == nil {
		params = map[string]any{}
	}

	line, err := json.Marshal(protocol.ClientRequest{Command: command, Params: params})
	if err != nil {
		return nil, fmt.Errorf("encode %s request: %w", command, err)
	}

	return append(line, '\n'), nil
}

func readResponse(ctx context.Context, r io.Reader, command string) (protocol.ClientResponse, error) {
	var resp protocol.ClientResponse

	line, err := bufio.NewReader(r).ReadBytes('\n')
	if err != nil {
		if errors.Is(err, io.EOF) {
			err = ErrNoResponse
		}

		return resp, wrapCtx(ctx, fmt.Errorf("read %s response: %w", command, err))
	}

	if err := json.Unmarshal(line, &resp); err != nil {
		return resp, fmt.Errorf("decode response to %s: %w", command, err)
	}

	return resp, nil
}

// dialError turns the two expected dial failures into actionable sentinels.
func dialError(socketPath string, err error) error {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return fmt.Errorf("%w (socket %s)", ErrHostNotRunning, socketPath)
	case errors.Is(err, syscall.ECONNREFUSED):
		return fmt.Errorf("%w (socket %s)", ErrConnectionRefused, socketPath)
	default:
		return fmt.Errorf("connect to %s: %w", socketPath, err)
	}
}

// wrapCtx reports the cancellation cause rather than the "closed connection"
// error it produced.
func wrapCtx(ctx context.Context, err error) error {
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}

	return err
}
