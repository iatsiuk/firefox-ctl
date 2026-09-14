package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"

	"github.com/spf13/cobra"
)

const (
	nativeHostName    = "firefoxctl"
	nativeExtensionID = "firefox-ctl@firefox-ctl.dev"
	manifestFileName  = "firefoxctl.json"
	manifestDesc      = "Control Firefox from the terminal"
)

// manifestSubdirs is where Firefox looks for per-user native host manifests,
// relative to the home directory, per GOOS.
var manifestSubdirs = map[string]string{
	"darwin": filepath.Join("Library", "Application Support", "Mozilla", "NativeMessagingHosts"),
	"linux":  filepath.Join(".mozilla", "native-messaging-hosts"),
}

// manifestSubdirFor keeps the OS lookup separate from the home directory so it
// stays testable for every GOOS, not only the one running the tests.
func manifestSubdirFor(goos string) (string, error) {
	subdir, ok := manifestSubdirs[goos]
	if !ok {
		return "", fmt.Errorf("no default manifest directory for %s: pass --dir", goos)
	}

	return subdir, nil
}

// nativeManifest is the Firefox native messaging host manifest.
type nativeManifest struct {
	Name              string   `json:"name"`
	Description       string   `json:"description"`
	Path              string   `json:"path"`
	Type              string   `json:"type"`
	AllowedExtensions []string `json:"allowed_extensions"`
}

// installConfig keeps the manifest directory and the binary lookup injectable,
// so tests never touch the real Firefox location.
type installConfig struct {
	dir        string
	uninstall  bool
	executable func() (string, error)
}

func newInstallCmd() *cobra.Command {
	cfg := installConfig{}

	cmd := &cobra.Command{
		Use:   "install",
		Short: "Install the Firefox native messaging manifest",
		Args:  usageArgs(cobra.NoArgs),
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runInstall(cmd.OutOrStdout(), cfg)
		},
	}

	cmd.Flags().StringVar(&cfg.dir, "dir", "", "manifest directory (default "+defaultDirHelp(runtime.GOOS)+")")
	cmd.Flags().BoolVar(&cfg.uninstall, "uninstall", false, "remove the manifest instead of writing it")

	return cmd
}

// defaultDirHelp names the per-user directory of goos, or says that --dir is
// required where Firefox has no documented one. Takes goos rather than reading
// runtime.GOOS itself so every branch is table-testable.
func defaultDirHelp(goos string) string {
	subdir, err := manifestSubdirFor(goos)
	if err != nil {
		return "required on " + goos
	}

	return "~/" + subdir
}

func runInstall(w io.Writer, cfg installConfig) error {
	dir, err := cfg.manifestDir()
	if err != nil {
		return err
	}

	path := filepath.Join(dir, manifestFileName)

	if cfg.uninstall {
		return removeManifest(w, path)
	}

	exe, err := cfg.binaryPath()
	if err != nil {
		return err
	}

	if err := writeManifest(path, dir, exe); err != nil {
		return err
	}

	_, err = fmt.Fprintf(w, "installed %s\n", path)

	return err
}

func writeManifest(path, dir, exe string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil { //nolint:gosec // firefox reads this dir
		return fmt.Errorf("create manifest dir: %w", err)
	}

	encoded, err := json.MarshalIndent(nativeManifest{
		Name:              nativeHostName,
		Description:       manifestDesc,
		Path:              exe,
		Type:              "stdio",
		AllowedExtensions: []string{nativeExtensionID},
	}, "", "  ")
	if err != nil {
		return fmt.Errorf("encode manifest: %w", err)
	}

	if err := os.WriteFile(path, append(encoded, '\n'), 0o644); err != nil { //nolint:gosec // firefox reads this file
		return fmt.Errorf("write manifest: %w", err)
	}

	return nil
}

func removeManifest(w io.Writer, path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove manifest: %w", err)
	}

	_, err := fmt.Fprintf(w, "removed %s\n", path)

	return err
}

func (c installConfig) manifestDir() (string, error) {
	if c.dir != "" {
		return c.dir, nil
	}

	subdir, err := manifestSubdirFor(runtime.GOOS)
	if err != nil {
		return "", err
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home dir: %w", err)
	}

	return filepath.Join(home, subdir), nil
}

// binaryPath is the absolute path Firefox has to spawn. Symlinks are kept on
// purpose: a package manager's link (Homebrew's /opt/homebrew/bin/firefox-ctl)
// stays put across upgrades while the versioned target it points at does not.
func (c installConfig) binaryPath() (string, error) {
	lookup := c.executable
	if lookup == nil {
		lookup = os.Executable
	}

	exe, err := lookup()
	if err != nil {
		return "", fmt.Errorf("locate binary: %w", err)
	}

	abs, err := filepath.Abs(exe)
	if err != nil {
		return "", fmt.Errorf("resolve binary path: %w", err)
	}

	return abs, nil
}
