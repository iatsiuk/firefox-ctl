package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func readManifest(t *testing.T, path string) nativeManifest {
	t.Helper()

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}

	var manifest nativeManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("decode manifest %q: %v", raw, err)
	}

	return manifest
}

func TestInstallWritesManifest(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()

	if _, err := execute(t, "install", "--dir", dir); err != nil {
		t.Fatalf("execute() error = %v", err)
	}

	manifest := readManifest(t, filepath.Join(dir, manifestFileName))

	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("executable: %v", err)
	}

	want, err := filepath.Abs(exe)
	if err != nil {
		t.Fatalf("abs: %v", err)
	}

	if manifest.Name != nativeHostName {
		t.Errorf("name = %q, want %q", manifest.Name, nativeHostName)
	}

	if manifest.Type != "stdio" {
		t.Errorf("type = %q, want stdio", manifest.Type)
	}

	if manifest.Path != want {
		t.Errorf("path = %q, want %q", manifest.Path, want)
	}

	if len(manifest.AllowedExtensions) != 1 || manifest.AllowedExtensions[0] != nativeExtensionID {
		t.Errorf("allowed_extensions = %v, want [%s]", manifest.AllowedExtensions, nativeExtensionID)
	}
}

func TestInstallReportsManifestPath(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()

	out, err := execute(t, "install", "--dir", dir)
	if err != nil {
		t.Fatalf("execute() error = %v", err)
	}

	if !strings.Contains(out, filepath.Join(dir, manifestFileName)) {
		t.Errorf("output %q does not mention the manifest path", out)
	}
}

// a symlink such as Homebrew's /opt/homebrew/bin/firefox-ctl survives upgrades
// while its target does not, so the manifest must keep the link itself
func TestInstallKeepsSymlinkedBinaryPath(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	target := filepath.Join(dir, "firefox-ctl-real")

	if err := os.WriteFile(target, nil, 0o755); err != nil { //nolint:gosec // fake binary
		t.Fatalf("write target: %v", err)
	}

	link := filepath.Join(dir, "firefox-ctl-link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	manifestDir := filepath.Join(dir, "manifests")

	cfg := installConfig{dir: manifestDir, executable: func() (string, error) { return link, nil }}
	if err := runInstall(os.Stdout, cfg); err != nil {
		t.Fatalf("runInstall() error = %v", err)
	}

	if got := readManifest(t, filepath.Join(manifestDir, manifestFileName)).Path; got != link {
		t.Errorf("path = %q, want the symlink %q", got, link)
	}
}

func TestInstallOverwritesExistingManifest(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, manifestFileName)

	if err := os.WriteFile(path, []byte("not json"), 0o600); err != nil {
		t.Fatalf("write stale manifest: %v", err)
	}

	for range 2 {
		if _, err := execute(t, "install", "--dir", dir); err != nil {
			t.Fatalf("execute() error = %v", err)
		}
	}

	if got := readManifest(t, path).Name; got != nativeHostName {
		t.Errorf("name = %q, want %q", got, nativeHostName)
	}
}

func TestInstallFailsWhenExecutableUnknown(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("no executable")

	cfg := installConfig{
		dir:        t.TempDir(),
		executable: func() (string, error) { return "", sentinel },
	}

	if err := runInstall(os.Stdout, cfg); !errors.Is(err, sentinel) {
		t.Fatalf("runInstall() error = %v, want %v", err, sentinel)
	}
}

func TestUninstallRemovesManifest(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, manifestFileName)

	if _, err := execute(t, "install", "--dir", dir); err != nil {
		t.Fatalf("execute() error = %v", err)
	}

	if _, err := execute(t, "install", "--dir", dir, "--uninstall"); err != nil {
		t.Fatalf("execute() error = %v", err)
	}

	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("manifest still present: %v", err)
	}

	// removing an absent manifest is not an error
	if _, err := execute(t, "install", "--dir", dir, "--uninstall"); err != nil {
		t.Fatalf("execute() error = %v", err)
	}
}

func TestInstallDefaultsToFirefoxManifestDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	if err := runInstall(os.Stdout, installConfig{}); err != nil {
		t.Fatalf("runInstall() error = %v", err)
	}

	path := filepath.Join(home, mustSubdir(t), manifestFileName)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("manifest not written to %s: %v", path, err)
	}
}

func TestManifestSubdirForOS(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		goos    string
		want    string
		wantErr bool
	}{
		{
			name: "darwin",
			goos: "darwin",
			want: filepath.Join("Library", "Application Support", "Mozilla", "NativeMessagingHosts"),
		},
		{
			name: "linux",
			goos: "linux",
			want: filepath.Join(".mozilla", "native-messaging-hosts"),
		},
		{name: "windows", goos: "windows", wantErr: true},
		{name: "empty", goos: "", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := manifestSubdirFor(tt.goos)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("manifestSubdirFor(%q) error = nil, want an error", tt.goos)
				}

				if !strings.Contains(err.Error(), "--dir") {
					t.Errorf("error %q does not mention --dir", err)
				}

				return
			}

			if err != nil {
				t.Fatalf("manifestSubdirFor(%q) error = %v", tt.goos, err)
			}

			if got != tt.want {
				t.Errorf("manifestSubdirFor(%q) = %q, want %q", tt.goos, got, tt.want)
			}
		})
	}
}

func TestDefaultDirHelp(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		goos string
		want string
	}{
		{
			name: "darwin",
			goos: "darwin",
			want: "~/" + filepath.Join("Library", "Application Support", "Mozilla", "NativeMessagingHosts"),
		},
		{
			name: "linux",
			goos: "linux",
			want: "~/" + filepath.Join(".mozilla", "native-messaging-hosts"),
		},
		{name: "unsupported", goos: "windows", want: "required on windows"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			if got := defaultDirHelp(tt.goos); got != tt.want {
				t.Errorf("defaultDirHelp(%q) = %q, want %q", tt.goos, got, tt.want)
			}
		})
	}
}

func TestManifestDirUsesHostOS(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	want, err := manifestSubdirFor(runtime.GOOS)
	if err != nil {
		t.Fatalf("manifestSubdirFor(%q) error = %v", runtime.GOOS, err)
	}

	got, err := installConfig{}.manifestDir()
	if err != nil {
		t.Fatalf("manifestDir() error = %v", err)
	}

	if got != filepath.Join(home, want) {
		t.Errorf("manifestDir() = %q, want %q", got, filepath.Join(home, want))
	}
}

func TestManifestDirPrefersExplicitDir(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()

	got, err := installConfig{dir: dir}.manifestDir()
	if err != nil {
		t.Fatalf("manifestDir() error = %v", err)
	}

	if got != dir {
		t.Errorf("manifestDir() = %q, want %q", got, dir)
	}
}

func mustSubdir(t *testing.T) string {
	t.Helper()

	subdir, err := manifestSubdirFor(runtime.GOOS)
	if err != nil {
		t.Fatalf("manifestSubdirFor(%q) error = %v", runtime.GOOS, err)
	}

	return subdir
}
