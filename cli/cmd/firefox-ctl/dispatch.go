package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/spf13/cobra"

	"firefox-ctl/internal/client"
	"firefox-ctl/internal/protocol"
)

// responseGrace is how much longer than the host-side timeout the client waits
// before giving up, so a host timeout response still wins the race.
const responseGrace = 5 * time.Second

var errTimedOut = errors.New("timed out waiting for a response from the extension")

// sendCommand is the real dispatch: one command over the socket, the result as
// indented JSON on stdout.
func sendCommand(cmd *cobra.Command, opts *rootOptions, name string, params map[string]any) error {
	socket, err := resolveSocket(opts.socket)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(cmd.Context(), requestDeadline(params))
	defer cancel()

	resp, err := client.Send(ctx, socket, name, params)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return fmt.Errorf("%s: %w", name, errTimedOut)
		}

		return err
	}

	if !resp.Success {
		return responseError(name, resp)
	}

	return printResult(cmd.OutOrStdout(), resp.Result)
}

// requestDeadline derives the client deadline from the `_timeout` param the
// host is going to use.
func requestDeadline(params map[string]any) time.Duration {
	ms := protocol.DefaultTimeoutMs

	if raw, ok := params[protocol.TimeoutParam]; ok {
		if value, ok := raw.(int); ok {
			ms = value
		}
	}

	return time.Duration(ms)*time.Millisecond + responseGrace
}

func responseError(name string, resp protocol.ClientResponse) error {
	if resp.Error == "" {
		return fmt.Errorf("%s failed", name)
	}

	return errors.New(resp.Error)
}

func printResult(w io.Writer, result json.RawMessage) error {
	if len(result) == 0 {
		result = json.RawMessage("null")
	}

	var buf bytes.Buffer
	if err := json.Indent(&buf, result, "", "  "); err != nil {
		return fmt.Errorf("format result: %w", err)
	}

	buf.WriteByte('\n')

	if _, err := w.Write(buf.Bytes()); err != nil {
		return fmt.Errorf("write result: %w", err)
	}

	return nil
}
