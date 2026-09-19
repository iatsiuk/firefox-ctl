package protocol

// Kind is the value type of a command parameter the CLI can express as a flag.
// Objects and arrays have no kind; they reach params through --json.
type Kind string

// Parameter kinds, mapped to cobra flag types by the command factory.
const (
	KindString Kind = "string"
	KindInt    Kind = "int"
	KindFloat  Kind = "float"
	KindBool   Kind = "bool"
)

// Flag is one command parameter. Default documents the extension-side default;
// it is help text only, since a flag the user did not set is never sent.
type Flag struct {
	Name    string `json:"name"`
	Kind    Kind   `json:"kind"`
	Default any    `json:"default,omitempty"`
	Usage   string `json:"-"`
}

// Spec is one command and its parameters. The parity fixture
// `testdata/commands.json` is the canonical copy of this table.
type Spec struct {
	Name  string `json:"name"`
	Flags []Flag `json:"flags"`
}

// Commands is the full command set documented in docs/commands.md.
var Commands = []Spec{
	{Name: "ping", Flags: []Flag{}},
	{Name: "version", Flags: []Flag{}},
	{Name: "createWindow", Flags: []Flag{
		{Name: "url", Kind: KindString, Usage: "url to open in the first tab"},
		{Name: "private", Kind: KindBool, Usage: "open a private window when allowed"},
	}},
	{Name: "navigate", Flags: page(
		Flag{Name: "url", Kind: KindString, Usage: "url to load"},
	)},
	{Name: "canNavigate", Flags: []Flag{}},
	{Name: "getWindowMode", Flags: []Flag{}},
	{Name: "getActiveTab", Flags: []Flag{}},
	{Name: "getTabs", Flags: []Flag{}},
	{Name: "listAllTabs", Flags: []Flag{}},
	{Name: "attachTab", Flags: []Flag{tabID("tab to bring under control")}},
	{Name: "detachTab", Flags: []Flag{tabID("tab to release")}},
	{Name: "closeTab", Flags: []Flag{tabID("tab to close")}},
	{Name: "closeWindow", Flags: []Flag{}},
	{Name: "getWindows", Flags: []Flag{}},
	{Name: "resizeWindow", Flags: []Flag{
		windowID("window to resize"),
		{Name: "width", Kind: KindInt, Usage: "window width in pixels"},
		{Name: "height", Kind: KindInt, Usage: "window height in pixels"},
		{Name: "left", Kind: KindInt, Usage: "window x position"},
		{Name: "top", Kind: KindInt, Usage: "window y position"},
	}},
	{Name: "setViewport", Flags: []Flag{
		windowID("window to resize"),
		{Name: "device", Kind: KindString, Usage: "device preset, for example iphone-14"},
		{Name: "width", Kind: KindInt, Usage: "viewport width in pixels"},
		{Name: "height", Kind: KindInt, Usage: "viewport height in pixels"},
	}},
	{Name: "getContent", Flags: page(
		Flag{Name: "selector", Kind: KindString, Usage: "css selector to extract"},
		Flag{Name: "includeHtml", Kind: KindBool, Usage: "include html alongside text"},
		Flag{Name: "maxLength", Kind: KindInt, Default: 50000, Usage: "maximum characters returned"},
	)},
	{Name: "click", Flags: page(
		Flag{Name: "selector", Kind: KindString, Usage: "css selector to click"},
		Flag{Name: "text", Kind: KindString, Usage: "exact visible text of the element, alternative to --selector"},
		Flag{Name: "scope", Kind: KindString, Usage: "css selector of the element to search inside, only with --text"},
		Flag{Name: "autoWait", Kind: KindBool, Default: true, Usage: "wait for the element to appear"},
		Flag{Name: "waitTimeout", Kind: KindInt, Usage: "auto-wait timeout in ms"},
	)},
	{Name: "type", Flags: page(
		Flag{Name: "selector", Kind: KindString, Usage: "css selector of the input"},
		Flag{Name: "text", Kind: KindString, Usage: "text to type"},
		Flag{Name: "clear", Kind: KindBool, Default: true, Usage: "clear the field first"},
		Flag{Name: "autoWait", Kind: KindBool, Usage: "wait for the element to appear"},
		Flag{Name: "waitTimeout", Kind: KindInt, Usage: "auto-wait timeout in ms"},
	)},
	{Name: "pressKey", Flags: page(
		Flag{Name: "key", Kind: KindString, Usage: "key name, for example Enter"},
		Flag{Name: "selector", Kind: KindString, Usage: "css selector to focus first"},
		Flag{Name: "ctrlKey", Kind: KindBool, Usage: "hold control"},
		Flag{Name: "shiftKey", Kind: KindBool, Usage: "hold shift"},
		Flag{Name: "altKey", Kind: KindBool, Usage: "hold alt"},
		Flag{Name: "metaKey", Kind: KindBool, Usage: "hold command"},
	)},
	{Name: "scroll", Flags: page(
		Flag{Name: "selector", Kind: KindString, Usage: "css selector to scroll into view"},
		Flag{Name: "x", Kind: KindInt, Usage: "horizontal scroll position"},
		Flag{Name: "y", Kind: KindInt, Usage: "vertical scroll position"},
		Flag{Name: "behavior", Kind: KindString, Default: "smooth", Usage: "scroll behavior: smooth or auto"},
	)},
	{Name: "waitFor", Flags: page(
		Flag{Name: "selector", Kind: KindString, Usage: "css selector to wait for"},
		Flag{Name: "text", Kind: KindString, Usage: "page text to wait for"},
		Flag{Name: "url", Kind: KindString, Usage: "url substring to wait for"},
		Flag{Name: "timeout", Kind: KindInt, Default: 10000, Usage: "wait timeout in ms"},
		Flag{Name: "interval", Kind: KindInt, Default: 100, Usage: "poll interval in ms"},
	)},
	{Name: "screenshot", Flags: page(
		Flag{Name: "format", Kind: KindString, Usage: "image format: jpeg or png"},
		Flag{Name: "quality", Kind: KindInt, Default: 60, Usage: "jpeg quality 1-100"},
		Flag{Name: "scale", Kind: KindFloat, Default: 0.5, Usage: "output scale factor"},
		Flag{Name: "purpose", Kind: KindString, Usage: "preset: quick-glance, read-text, inspect-ui, full-detail"},
		Flag{Name: "annotate", Kind: KindBool, Usage: "label interactive elements"},
		Flag{Name: "maxWait", Kind: KindInt, Default: 10000, Usage: "page readiness timeout in ms"},
		Flag{Name: "waitForImages", Kind: KindBool, Default: true, Usage: "wait for images to decode"},
		Flag{Name: "skipReadiness", Kind: KindBool, Usage: "capture without the readiness check"},
	)},
	{Name: "handleConsent", Flags: page(
		Flag{Name: "scanTimeout", Kind: KindInt, Default: 3000, Usage: "consent banner scan timeout in ms"},
	)},
	{Name: "getPageState", Flags: page(
		Flag{Name: "maxHeadings", Kind: KindInt, Default: 30, Usage: "maximum headings returned"},
		Flag{Name: "maxLinks", Kind: KindInt, Default: 50, Usage: "maximum links returned"},
		Flag{Name: "maxButtons", Kind: KindInt, Default: 30, Usage: "maximum buttons returned"},
		Flag{Name: "maxInputs", Kind: KindInt, Default: 30, Usage: "maximum inputs returned"},
		Flag{Name: "maxImages", Kind: KindInt, Default: 20, Usage: "maximum images returned"},
	)},
	{Name: "getAccessibilitySnapshot", Flags: page(
		Flag{Name: "selector", Kind: KindString, Default: "body", Usage: "subtree root selector"},
		Flag{Name: "maxDepth", Kind: KindInt, Default: 5, Usage: "maximum tree depth"},
		Flag{Name: "maxNodes", Kind: KindInt, Default: 200, Usage: "maximum nodes returned"},
	)},
	{Name: "getElementInfo", Flags: page(
		Flag{Name: "selector", Kind: KindString, Usage: "css selector to inspect"},
		Flag{Name: "text", Kind: KindString, Usage: "exact visible text of the element, alternative to --selector"},
		Flag{Name: "scope", Kind: KindString, Usage: "css selector of the element to search inside, only with --text"},
	)},
	{Name: "evaluate", Flags: page(
		Flag{Name: "expression", Kind: KindString, Usage: "javascript expression to run in the page"},
	)},
	{Name: "getConsoleLogs", Flags: page(
		Flag{Name: "level", Kind: KindString, Usage: "filter by level: log, info, warn, error"},
		Flag{Name: "clear", Kind: KindBool, Usage: "clear the buffer after reading"},
		Flag{Name: "limit", Kind: KindInt, Default: 100, Usage: "maximum entries returned"},
	)},
	{Name: "getNetworkRequests", Flags: page(
		Flag{Name: "type", Kind: KindString, Usage: "filter by request type, for example xhr"},
		Flag{Name: "status", Kind: KindString, Usage: "filter by status, for example error"},
		Flag{Name: "clear", Kind: KindBool, Usage: "clear the buffer after reading"},
		Flag{Name: "limit", Kind: KindInt, Default: 50, Usage: "maximum entries returned"},
		Flag{Name: "includeHeaders", Kind: KindBool, Usage: "include request and response headers"},
	)},
}

// page appends the tab and window selectors every page command accepts.
func page(flags ...Flag) []Flag {
	out := make([]Flag, 0, len(flags)+2)
	out = append(out, flags...)

	return append(out, tabID("target tab, defaults to the session active tab"), windowID("target window"))
}

func tabID(usage string) Flag {
	return Flag{Name: "tabId", Kind: KindInt, Usage: usage}
}

func windowID(usage string) Flag {
	return Flag{Name: "windowId", Kind: KindInt, Usage: usage}
}
