// Package protocol defines the firefox-ctl wire contract: the NDJSON messages
// exchanged over the unix socket, the native messaging frames exchanged with
// the extension, and the declarative command set the CLI is generated from.
// It mirrors `extension/src/protocol.ts` and changes together with it.
package protocol

import "encoding/json"

// TypeCommand marks a host->extension frame carrying a CLI command.
const TypeCommand = "command"

const (
	// TimeoutParam is the per-request timeout the client puts into params.
	TimeoutParam = "_timeout"

	// MinTimeoutMs, MaxTimeoutMs and DefaultTimeoutMs bound that timeout; the
	// host clamps out-of-range values to the default.
	MinTimeoutMs     = 5000
	MaxTimeoutMs     = 300000
	DefaultTimeoutMs = 150000
)

// ClientRequest is one NDJSON line from a CLI client. A client-supplied id is
// ignored: the host assigns its own.
type ClientRequest struct {
	Command string         `json:"command"`
	Params  map[string]any `json:"params,omitempty"`
}

// HostCommand is the frame the host writes to the extension.
type HostCommand struct {
	ID      string         `json:"id"`
	Type    string         `json:"type"`
	Command string         `json:"command"`
	Params  map[string]any `json:"params"`
}

// ExtensionMessage is a frame from the extension: either a response to a
// pending request or an extension-initiated request. Success distinguishes the
// two, so it is a pointer. The extension's `details` field is not forwarded to
// clients and has no field here.
type ExtensionMessage struct {
	ID      string          `json:"id,omitempty"`
	Command string          `json:"command,omitempty"`
	Success *bool           `json:"success,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
}

// ClientResponse is the NDJSON line the host writes back. It never carries an
// id; Command and TimeoutMs are set on timeouts only.
type ClientResponse struct {
	Success   bool            `json:"success"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     string          `json:"error,omitempty"`
	Command   string          `json:"command,omitempty"`
	TimeoutMs int             `json:"timeoutMs,omitempty"`
}
