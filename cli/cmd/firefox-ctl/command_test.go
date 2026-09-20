package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/spf13/cobra"

	"firefox-ctl/internal/protocol"
)

// capture records what the command factory would send instead of dialling the
// host, so flag semantics can be tested without a server.
type capture struct {
	command string
	params  map[string]any
	calls   int
}

func (c *capture) dispatch() dispatchFunc {
	return func(_ *cobra.Command, _ *rootOptions, name string, params map[string]any) error {
		c.command = name
		c.params = params
		c.calls++

		return nil
	}
}

func run(t *testing.T, args ...string) (*capture, string, error) {
	t.Helper()

	rec := &capture{}
	buf := &bytes.Buffer{}
	cmd := buildRootCmd(rec.dispatch())
	cmd.SetOut(buf)
	cmd.SetErr(buf)
	cmd.SetArgs(args)

	return rec, buf.String(), cmd.Execute()
}

func TestEverySpecBecomesSubcommand(t *testing.T) {
	t.Parallel()

	root := buildRootCmd(nil)

	for _, spec := range protocol.Commands {
		sub, _, err := root.Find([]string{spec.Name})
		if err != nil || sub.Name() != spec.Name {
			t.Errorf("command %q not registered (%v)", spec.Name, err)

			continue
		}

		for _, flag := range spec.Flags {
			registered := sub.Flags().Lookup(flag.Name)
			if registered == nil {
				t.Errorf("%s: flag --%s not registered", spec.Name, flag.Name)

				continue
			}

			if got, want := registered.Value.Type(), flagValueType(flag.Kind); got != want {
				t.Errorf("%s/--%s: flag type %q, want %q", spec.Name, flag.Name, got, want)
			}
		}
	}
}

func flagValueType(kind protocol.Kind) string {
	switch kind {
	case protocol.KindString:
		return "string"
	case protocol.KindInt:
		return "int"
	case protocol.KindFloat:
		return "float64"
	case protocol.KindBool:
		return "bool"
	default:
		return "unknown"
	}
}

func TestFlagKindsReachParams(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		args []string
		want map[string]any
	}{
		{
			name: "string and int",
			args: []string{"getContent", "--selector", "#main", "--maxLength", "120"},
			want: map[string]any{"selector": "#main", "maxLength": 120},
		},
		{
			name: "tail",
			args: []string{"getContent", "--selector", "#log", "--tail", "1500"},
			want: map[string]any{"selector": "#log", "tail": 1500},
		},
		{
			name: "float and bool",
			args: []string{"screenshot", "--scale", "0.25", "--annotate"},
			want: map[string]any{"scale": 0.25, "annotate": true},
		},
		{
			name: "explicit false is sent",
			args: []string{"click", "--selector", "button", "--autoWait=false"},
			want: map[string]any{"selector": "button", "autoWait": false},
		},
		{
			name: "no flags sends no params",
			args: []string{"ping"},
			want: map[string]any{},
		},
		{
			name: "click by text with scope",
			args: []string{"click", "--tabId", "3", "--text", "Apply", "--scope", "main"},
			want: map[string]any{"tabId": 3, "text": "Apply", "scope": "main"},
		},
		{
			name: "getElementInfo by text with scope",
			args: []string{"getElementInfo", "--text", "Apply", "--scope", "#dialog"},
			want: map[string]any{"text": "Apply", "scope": "#dialog"},
		},
		{
			name: "watchFrames with a match glob",
			args: []string{"watchFrames", "--tabId", "16", "--match", "*y.uno*"},
			want: map[string]any{"tabId": 16, "match": "*y.uno*"},
		},
		{
			name: "unwatchFrames by tab",
			args: []string{"unwatchFrames", "--tabId", "16"},
			want: map[string]any{"tabId": 16},
		},
		{
			name: "listFrames with a wait budget",
			args: []string{"listFrames", "--tabId", "16", "--timeout", "5000"},
			want: map[string]any{"tabId": 16, "timeout": 5000},
		},
		{
			name: "page command targets a child frame",
			args: []string{"type", "--tabId", "16", "--frameId", "7", "--selector", "input", "--text", "4111"},
			want: map[string]any{"tabId": 16, "frameId": 7, "selector": "input", "text": "4111"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			rec, out, err := run(t, tt.args...)
			if err != nil {
				t.Fatalf("execute: %v (%s)", err, out)
			}

			if rec.calls != 1 {
				t.Fatalf("dispatch called %d times, want 1", rec.calls)
			}

			if rec.command != tt.args[0] {
				t.Errorf("dispatched %q, want %q", rec.command, tt.args[0])
			}

			assertParams(t, rec.params, tt.want)
		})
	}
}

// assertParams compares params ignoring the always-present _timeout, which has
// its own tests.
func assertParams(t *testing.T, got, want map[string]any) {
	t.Helper()

	trimmed := make(map[string]any, len(got))

	for k, v := range got {
		if k == protocol.TimeoutParam {
			continue
		}

		trimmed[k] = v
	}

	if !reflect.DeepEqual(trimmed, want) {
		t.Errorf("params %#v, want %#v", trimmed, want)
	}
}

func TestJSONFlag(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		args    []string
		want    map[string]any
		wantErr bool
	}{
		{
			name: "merges into params",
			args: []string{"evaluate", "--json", `{"expression":"1+1"}`},
			want: map[string]any{"expression": "1+1"},
		},
		{
			name: "wins over typed flags",
			args: []string{"getContent", "--selector", "#a", "--json", `{"selector":"#b"}`},
			want: map[string]any{"selector": "#b"},
		},
		{
			name: "nested object and array pass through",
			args: []string{"evaluate", "--json", `{"args":[1,"two"],"opts":{"deep":true}}`},
			want: map[string]any{
				"args": []any{float64(1), "two"},
				"opts": map[string]any{"deep": true},
			},
		},
		{
			name:    "array rejected",
			args:    []string{"ping", "--json", `[1,2]`},
			wantErr: true,
		},
		{
			name:    "scalar rejected",
			args:    []string{"ping", "--json", `"text"`},
			wantErr: true,
		},
		{
			name:    "malformed rejected",
			args:    []string{"ping", "--json", `{oops`},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			rec, out, err := run(t, tt.args...)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got params %#v (%s)", rec.params, out)
				}

				if rec.calls != 0 {
					t.Errorf("dispatch called %d times on a rejected --json", rec.calls)
				}

				return
			}

			if err != nil {
				t.Fatalf("execute: %v (%s)", err, out)
			}

			assertParams(t, rec.params, tt.want)
		})
	}
}

func TestRequestTimeoutFlag(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		args    []string
		want    int
		wantErr bool
	}{
		{name: "default", args: []string{"ping"}, want: protocol.DefaultTimeoutMs},
		{name: "lower bound", args: []string{"ping", "--request-timeout", "5000"}, want: protocol.MinTimeoutMs},
		{name: "upper bound", args: []string{"ping", "--request-timeout", "300000"}, want: protocol.MaxTimeoutMs},
		{name: "below range", args: []string{"ping", "--request-timeout", "4999"}, wantErr: true},
		{name: "above range", args: []string{"ping", "--request-timeout", "300001"}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			rec, out, err := run(t, tt.args...)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got params %#v (%s)", rec.params, out)
				}

				return
			}

			if err != nil {
				t.Fatalf("execute: %v (%s)", err, out)
			}

			if got := rec.params[protocol.TimeoutParam]; got != tt.want {
				t.Errorf("%s is %#v, want %d", protocol.TimeoutParam, got, tt.want)
			}
		})
	}
}

func TestWaitForTimeoutIsSeparateFromRequestTimeout(t *testing.T) {
	t.Parallel()

	rec, out, err := run(t, "waitFor", "--selector", "#done", "--timeout", "3000", "--request-timeout", "20000")
	if err != nil {
		t.Fatalf("execute: %v (%s)", err, out)
	}

	if got := rec.params["timeout"]; got != 3000 {
		t.Errorf("timeout param is %#v, want 3000", got)
	}

	if got := rec.params[protocol.TimeoutParam]; got != 20000 {
		t.Errorf("%s is %#v, want 20000", protocol.TimeoutParam, got)
	}
}

func TestParamsAreJSONSerialisable(t *testing.T) {
	t.Parallel()

	rec, out, err := run(t, "screenshot", "--scale", "0.5", "--quality", "70", "--tabId", "4", "--annotate")
	if err != nil {
		t.Fatalf("execute: %v (%s)", err, out)
	}

	encoded, err := json.Marshal(rec.params)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}

	for key, want := range map[string]any{
		"scale": 0.5, "quality": float64(70), "tabId": float64(4), "annotate": true,
	} {
		if decoded[key] != want {
			t.Errorf("%s is %#v, want %#v", key, decoded[key], want)
		}
	}
}

func TestCommandRejectsPositionalArgs(t *testing.T) {
	t.Parallel()

	if _, _, err := run(t, "ping", "extra"); err == nil {
		t.Fatal("expected error for positional argument")
	}
}
