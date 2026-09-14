package main

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/spf13/cobra"

	"firefox-ctl/internal/protocol"
)

var (
	// errJSONNotObject rejects a --json payload that is not a JSON object.
	errJSONNotObject = errors.New("--json must be a JSON object")

	// errTimeoutRange rejects a --request-timeout the host would clamp away.
	errTimeoutRange = fmt.Errorf("--request-timeout must be between %d and %d ms",
		protocol.MinTimeoutMs, protocol.MaxTimeoutMs)
)

// dispatchFunc delivers a built command to the host. It is a seam: tests record
// the call instead of dialling the socket.
type dispatchFunc func(cmd *cobra.Command, opts *rootOptions, name string, params map[string]any) error

// newCommandCmd builds the cobra subcommand for one spec. Flags keep the
// protocol parameter names verbatim (camelCase) so a flag reads like the
// parameter it sets; cobra's kebab convention loses to that.
func newCommandCmd(spec protocol.Spec, opts *rootOptions, dispatch dispatchFunc) *cobra.Command {
	values := make(map[string]any, len(spec.Flags))

	cmd := &cobra.Command{
		Use:   spec.Name,
		Short: fmt.Sprintf("Run %s in Firefox", spec.Name),
		Args:  usageArgs(cobra.NoArgs),
	}

	for _, flag := range spec.Flags {
		values[flag.Name] = registerFlag(cmd, flag)
	}

	cmd.RunE = func(c *cobra.Command, _ []string) error {
		params, err := buildParams(c, spec, values, opts)
		if err != nil {
			return err
		}

		return dispatch(c, opts, spec.Name, params)
	}

	return cmd
}

// registerFlag declares one parameter and returns the pointer holding its
// value. The spec default is shown in help only: an untouched flag is never
// sent, so the extension-side default applies.
func registerFlag(cmd *cobra.Command, flag protocol.Flag) any {
	switch flag.Kind {
	case protocol.KindString:
		def, _ := flag.Default.(string)

		return cmd.Flags().String(flag.Name, def, flag.Usage)
	case protocol.KindInt:
		def, _ := flag.Default.(int)

		return cmd.Flags().Int(flag.Name, def, flag.Usage)
	case protocol.KindFloat:
		def, _ := flag.Default.(float64)

		return cmd.Flags().Float64(flag.Name, def, flag.Usage)
	case protocol.KindBool:
		def, _ := flag.Default.(bool)

		return cmd.Flags().Bool(flag.Name, def, flag.Usage)
	default:
		return nil
	}
}

// buildParams collects the params for one invocation: flags the user actually
// set, then the --json overlay, then the validated request timeout.
func buildParams(
	cmd *cobra.Command,
	spec protocol.Spec,
	values map[string]any,
	opts *rootOptions,
) (map[string]any, error) {
	params := make(map[string]any, len(spec.Flags)+1)

	for _, flag := range spec.Flags {
		if !cmd.Flags().Changed(flag.Name) {
			continue
		}

		params[flag.Name] = flagValue(values[flag.Name])
	}

	if err := mergeJSON(params, opts.jsonParams); err != nil {
		return nil, &usageError{err}
	}

	if opts.requestTimeout < protocol.MinTimeoutMs || opts.requestTimeout > protocol.MaxTimeoutMs {
		return nil, &usageError{fmt.Errorf("%w (got %d)", errTimeoutRange, opts.requestTimeout)}
	}

	params[protocol.TimeoutParam] = opts.requestTimeout

	return params, nil
}

func flagValue(holder any) any {
	switch p := holder.(type) {
	case *string:
		return *p
	case *int:
		return *p
	case *float64:
		return *p
	case *bool:
		return *p
	default:
		return nil
	}
}

// mergeJSON overlays raw onto params. It wins over typed flags and is the only
// way to pass objects and arrays.
func mergeJSON(params map[string]any, raw string) error {
	if raw == "" {
		return nil
	}

	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return fmt.Errorf("parse --json: %w", err)
	}

	object, ok := decoded.(map[string]any)
	if !ok {
		return errJSONNotObject
	}

	for key, value := range object {
		params[key] = value
	}

	return nil
}
