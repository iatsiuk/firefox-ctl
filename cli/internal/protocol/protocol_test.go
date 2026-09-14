package protocol_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"firefox-ctl/internal/protocol"
)

func TestClientRequestUnmarshal(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		line string
		want protocol.ClientRequest
	}{
		{
			name: "command with params",
			line: `{"command":"navigate","params":{"url":"https://example.com","tabId":7}}`,
			want: protocol.ClientRequest{
				Command: "navigate",
				Params:  map[string]any{"url": "https://example.com", "tabId": float64(7)},
			},
		},
		{
			name: "bare command",
			line: `{"command":"ping"}`,
			want: protocol.ClientRequest{Command: "ping"},
		},
		{
			name: "client id and auth token ignored",
			line: `{"id":"client-1","command":"ping","params":{},"authToken":"secret"}`,
			want: protocol.ClientRequest{Command: "ping", Params: map[string]any{}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var got protocol.ClientRequest
			if err := json.Unmarshal([]byte(tt.line), &got); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}

			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestHostCommandMarshal(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		cmd  protocol.HostCommand
		want string
	}{
		{
			name: "params forwarded verbatim",
			cmd: protocol.HostCommand{
				ID:      "4f1c",
				Type:    protocol.TypeCommand,
				Command: "click",
				Params:  map[string]any{"selector": "button"},
			},
			want: `{"id":"4f1c","type":"command","command":"click","params":{"selector":"button"}}`,
		},
		{
			name: "empty params stay an object",
			cmd: protocol.HostCommand{
				ID:      "4f1d",
				Type:    protocol.TypeCommand,
				Command: "ping",
				Params:  map[string]any{},
			},
			want: `{"id":"4f1d","type":"command","command":"ping","params":{}}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := json.Marshal(tt.cmd)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}

			if string(got) != tt.want {
				t.Errorf("got %s, want %s", got, tt.want)
			}
		})
	}
}

func TestExtensionMessageUnmarshal(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		frame       string
		wantID      string
		wantCommand string
		wantSuccess *bool
		wantResult  string
		wantError   string
	}{
		{
			name:        "successful response",
			frame:       `{"id":"4f1c","success":true,"result":{"pong":true}}`,
			wantID:      "4f1c",
			wantResult:  `{"pong":true}`,
			wantSuccess: boolPtr(true),
		},
		{
			name:        "failed response keeps details out of the struct",
			frame:       `{"id":"4f1c","success":false,"error":"Tab closed","details":{"code":"TAB_CLOSED"}}`,
			wantID:      "4f1c",
			wantSuccess: boolPtr(false),
			wantError:   "Tab closed",
		},
		{
			name:        "extension initiated request has no success field",
			frame:       `{"id":"ext-1","command":"ping"}`,
			wantID:      "ext-1",
			wantCommand: "ping",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var got protocol.ExtensionMessage
			if err := json.Unmarshal([]byte(tt.frame), &got); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}

			if got.ID != tt.wantID || got.Command != tt.wantCommand || got.Error != tt.wantError {
				t.Errorf("got %+v, want id=%q command=%q error=%q", got, tt.wantID, tt.wantCommand, tt.wantError)
			}

			if !equalBoolPtr(got.Success, tt.wantSuccess) {
				t.Errorf("success: got %v, want %v", got.Success, tt.wantSuccess)
			}

			if string(got.Result) != tt.wantResult {
				t.Errorf("result: got %s, want %s", got.Result, tt.wantResult)
			}
		})
	}
}

func TestClientResponseMarshal(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		resp protocol.ClientResponse
		want string
	}{
		{
			name: "success carries no id",
			resp: protocol.ClientResponse{Success: true, Result: json.RawMessage(`{"pong":true}`)},
			want: `{"success":true,"result":{"pong":true}}`,
		},
		{
			name: "failure carries the error only",
			resp: protocol.ClientResponse{Error: "Tab session lost"},
			want: `{"success":false,"error":"Tab session lost"}`,
		},
		{
			name: "timeout carries command and timeoutMs",
			resp: protocol.ClientResponse{
				Error:     "Request timed out after 5000ms (command: click)",
				Command:   "click",
				TimeoutMs: 5000,
			},
			want: `{"success":false,"error":"Request timed out after 5000ms (command: click)","command":"click","timeoutMs":5000}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := json.Marshal(tt.resp)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}

			if string(got) != tt.want {
				t.Errorf("got %s, want %s", got, tt.want)
			}
		})
	}
}

func TestTimeoutBounds(t *testing.T) {
	t.Parallel()

	if protocol.MinTimeoutMs != 5000 || protocol.MaxTimeoutMs != 300000 || protocol.DefaultTimeoutMs != 150000 {
		t.Errorf("timeout bounds changed: %d %d %d",
			protocol.MinTimeoutMs, protocol.MaxTimeoutMs, protocol.DefaultTimeoutMs)
	}

	if protocol.TimeoutParam != "_timeout" {
		t.Errorf("timeout param: got %q", protocol.TimeoutParam)
	}
}

func boolPtr(v bool) *bool { return &v }

func equalBoolPtr(a, b *bool) bool {
	if a == nil || b == nil {
		return a == b
	}

	return *a == *b
}
