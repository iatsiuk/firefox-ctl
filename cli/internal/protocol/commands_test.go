package protocol_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"firefox-ctl/internal/protocol"
)

// allowedCommands is the documented command set plus droppedCommands, which
// must never come back.
var allowedCommands = []string{
	"ping", "version", "canNavigate", "navigate", "getActiveTab", "getContent",
	"click", "type", "screenshot", "getTabs", "listAllTabs", "attachTab",
	"detachTab", "closeTab", "createWindow", "closeWindow", "getWindows",
	"resizeWindow", "setViewport", "getConsoleLogs", "getNetworkRequests",
	"scroll", "waitFor", "evaluate", "getElementInfo", "getPageState",
	"getAccessibilitySnapshot", "pressKey", "startLoop", "stopLoop",
	"getLoopState", "incrementLoopIteration", "requestTabSpace",
	"grantTabSpace", "getSlotRequests", "cleanupOrphanedTabs",
	"setPrivateMode", "goodbye", "handleConsent", "getWindowMode",
	"watchFrames", "unwatchFrames", "listFrames",
}

var droppedCommands = []string{
	"startLoop", "stopLoop", "getLoopState", "incrementLoopIteration",
	"requestTabSpace", "grantTabSpace", "getSlotRequests",
	"cleanupOrphanedTabs", "setPrivateMode", "goodbye",
}

func TestCommandsMatchFixture(t *testing.T) {
	t.Parallel()

	want := decodeJSON(t, readFixture(t))

	encoded, err := json.Marshal(protocol.Commands)
	if err != nil {
		t.Fatalf("marshal commands: %v", err)
	}

	got := decodeJSON(t, encoded)

	if !reflect.DeepEqual(got, want) {
		t.Errorf("Commands and testdata/commands.json differ\ngot:  %s\nwant: %s", encoded, readFixture(t))
	}
}

func TestCommandsCountMatchesParityBudget(t *testing.T) {
	t.Parallel()

	want := len(allowedCommands) - len(droppedCommands)
	if len(protocol.Commands) != want {
		t.Errorf("got %d commands, want %d (%d allowed minus %d dropped)",
			len(protocol.Commands), want, len(allowedCommands), len(droppedCommands))
	}

	names := commandNames(protocol.Commands)

	for _, name := range droppedCommands {
		if names[name] {
			t.Errorf("dropped command %q is still registered", name)
		}
	}

	allowed := make(map[string]bool, len(allowedCommands))
	for _, name := range allowedCommands {
		allowed[name] = true
	}

	for name := range names {
		if !allowed[name] {
			t.Errorf("command %q is not a documented command", name)
		}
	}

	dropped := make(map[string]bool, len(droppedCommands))
	for _, name := range droppedCommands {
		dropped[name] = true
	}

	for _, name := range allowedCommands {
		if !dropped[name] && !names[name] {
			t.Errorf("whitelisted command %q is missing", name)
		}
	}
}

func TestCommandNamesAndFlagsAreUnique(t *testing.T) {
	t.Parallel()

	seen := make(map[string]bool, len(protocol.Commands))

	for _, spec := range protocol.Commands {
		if seen[spec.Name] {
			t.Errorf("duplicate command %q", spec.Name)
		}

		seen[spec.Name] = true

		flags := make(map[string]bool, len(spec.Flags))

		for _, flag := range spec.Flags {
			if flags[flag.Name] {
				t.Errorf("%s: duplicate flag %q", spec.Name, flag.Name)
			}

			flags[flag.Name] = true

			if flag.Name == protocol.TimeoutParam {
				t.Errorf("%s: %s must come from --request-timeout, not a spec flag",
					spec.Name, protocol.TimeoutParam)
			}
		}
	}
}

func TestFlagKindsAreKnownAndDefaultsMatch(t *testing.T) {
	t.Parallel()

	for _, spec := range protocol.Commands {
		for _, flag := range spec.Flags {
			var ok bool

			switch flag.Kind {
			case protocol.KindString:
				_, ok = flag.Default.(string)
			case protocol.KindInt:
				_, ok = flag.Default.(int)
			case protocol.KindFloat:
				_, ok = flag.Default.(float64)
			case protocol.KindBool:
				_, ok = flag.Default.(bool)
			default:
				t.Errorf("%s/%s: unknown kind %q", spec.Name, flag.Name, flag.Kind)

				continue
			}

			if flag.Default != nil && !ok {
				t.Errorf("%s/%s: default %#v does not match kind %q",
					spec.Name, flag.Name, flag.Default, flag.Kind)
			}

			if flag.Usage == "" {
				t.Errorf("%s/%s: empty usage", spec.Name, flag.Name)
			}
		}
	}
}

func TestEveryCommandIsDocumented(t *testing.T) {
	t.Parallel()

	doc, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "commands.md"))
	if err != nil {
		t.Fatalf("read commands doc: %v", err)
	}

	text := string(doc)

	for name := range commandNames(protocol.Commands) {
		if !strings.Contains(text, name) {
			t.Errorf("command %q is missing from docs/commands.md", name)
		}
	}
}

func commandNames(specs []protocol.Spec) map[string]bool {
	names := make(map[string]bool, len(specs))
	for _, spec := range specs {
		names[spec.Name] = true
	}

	return names
}

func readFixture(t *testing.T) []byte {
	t.Helper()

	data, err := os.ReadFile(filepath.Join("testdata", "commands.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	return data
}

// decodeJSON normalises typed values (int, float64) into the generic JSON
// number so a Go table and the fixture can be compared directly.
func decodeJSON(t *testing.T, data []byte) any {
	t.Helper()

	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("decode json: %v", err)
	}

	return v
}
