package main

import (
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"

	"firefox-ctl/internal/ipc"
	"firefox-ctl/internal/protocol"
)

var version = "dev"

const (
	exitOK      = 0
	exitFailure = 1
	exitUsage   = 2
)

// usageError marks everything the user can fix on the command line: unknown
// commands and flags, bad flag values, a --json payload that is not an object.
type usageError struct{ err error }

func (e *usageError) Error() string { return e.err.Error() }
func (e *usageError) Unwrap() error { return e.err }

// rootOptions holds the flags shared by every subcommand.
type rootOptions struct {
	socket         string
	jsonParams     string
	requestTimeout int
}

func main() {
	os.Exit(runCLI(os.Args[1:], os.Stdout, os.Stderr))
}

func runCLI(args []string, stdout, stderr io.Writer) int {
	cmd := newRootCmd()
	cmd.SetArgs(spawnArgs(args))
	cmd.SetOut(stdout)
	cmd.SetErr(stderr)

	if err := cmd.Execute(); err != nil {
		_, _ = fmt.Fprintf(stderr, "Error: %v\n", err)

		return exitCode(err)
	}

	return exitOK
}

func exitCode(err error) int {
	var ue *usageError
	if errors.As(err, &ue) {
		return exitUsage
	}

	return exitFailure
}

func newRootCmd() *cobra.Command {
	return buildRootCmd(sendCommand)
}

func buildRootCmd(dispatch dispatchFunc) *cobra.Command {
	rootCmd := &cobra.Command{
		Use:               "firefox-ctl",
		Short:             "Control Firefox from the terminal",
		Version:           version,
		Args:              rejectUnknownCommand,
		RunE:              func(cmd *cobra.Command, _ []string) error { return cmd.Help() },
		SilenceUsage:      true,
		SilenceErrors:     true,
		CompletionOptions: cobra.CompletionOptions{DisableDefaultCmd: true},
	}
	rootCmd.SetHelpCommand(&cobra.Command{Hidden: true})
	rootCmd.SetFlagErrorFunc(func(_ *cobra.Command, err error) error {
		return &usageError{err}
	})

	opts := &rootOptions{}
	rootCmd.PersistentFlags().StringVar(&opts.socket, "socket", "",
		"unix socket path (default $XDG_RUNTIME_DIR/firefox-ctl.sock or ~/.firefox-ctl/firefox-ctl.sock)")

	rootCmd.PersistentFlags().StringVar(&opts.jsonParams, "json", "",
		"extra params as a JSON object, merged over the typed flags")
	rootCmd.PersistentFlags().IntVar(&opts.requestTimeout, "request-timeout", protocol.DefaultTimeoutMs,
		fmt.Sprintf("per-request timeout in ms (%d-%d)", protocol.MinTimeoutMs, protocol.MaxTimeoutMs))

	rootCmd.AddCommand(newHostCmd(opts))
	rootCmd.AddCommand(newInstallCmd())

	for _, spec := range protocol.Commands {
		rootCmd.AddCommand(newCommandCmd(spec, opts, dispatch))
	}

	return rootCmd
}

// rejectUnknownCommand runs because the root is made runnable: cobra only
// validates args on a runnable command, and a bare `firefox-ctl` prints help.
func rejectUnknownCommand(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		return nil
	}

	return &usageError{fmt.Errorf("unknown command %q for %q", args[0], cmd.CommandPath())}
}

// usageArgs turns a cobra positional-args rule into a usage error so the exit
// code is 2 rather than 1.
func usageArgs(validate cobra.PositionalArgs) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if err := validate(cmd, args); err != nil {
			return &usageError{err}
		}

		return nil
	}
}

// resolveSocket falls back to the default location when --socket is empty.
func resolveSocket(override string) (string, error) {
	if override != "" {
		return override, nil
	}

	return ipc.SocketPath()
}
