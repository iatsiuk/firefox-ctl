package ipc

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestSocketPathXDG(t *testing.T) {
	runtimeDir := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", runtimeDir)

	got, err := SocketPath()
	if err != nil {
		t.Fatalf("SocketPath() error = %v", err)
	}

	if want := filepath.Join(runtimeDir, socketName); got != want {
		t.Errorf("SocketPath() = %q, want %q", got, want)
	}
}

func TestSocketPathFallsBackToHome(t *testing.T) {
	tests := []struct {
		name string
		xdg  func(t *testing.T) string
	}{
		{
			name: "unset",
			xdg:  func(*testing.T) string { return "" },
		},
		{
			name: "regular file",
			xdg: func(t *testing.T) string {
				t.Helper()

				path := filepath.Join(t.TempDir(), "runtime")
				if err := os.WriteFile(path, nil, 0o600); err != nil {
					t.Fatalf("write file: %v", err)
				}

				return path
			},
		},
		{
			name: "missing directory",
			xdg: func(t *testing.T) string {
				t.Helper()

				return filepath.Join(t.TempDir(), "absent")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("XDG_RUNTIME_DIR", tt.xdg(t))

			got, err := SocketPath()
			if err != nil {
				t.Fatalf("SocketPath() error = %v", err)
			}

			if want := filepath.Join(home, dirName, socketName); got != want {
				t.Errorf("SocketPath() = %q, want %q", got, want)
			}

			assertMode(t, filepath.Join(home, dirName), dirMode)
		})
	}
}

func TestSocketPathFixesDirMode(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_RUNTIME_DIR", "")

	dir := filepath.Join(home, dirName)

	//nolint:gosec // the too-permissive mode is what this test repairs
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	if _, err := SocketPath(); err != nil {
		t.Fatalf("SocketPath() error = %v", err)
	}

	assertMode(t, dir, dirMode)
}

func TestSocketPathHomeIsFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_RUNTIME_DIR", "")

	if err := os.WriteFile(filepath.Join(home, dirName), nil, 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}

	if _, err := SocketPath(); err == nil {
		t.Fatal("SocketPath() error = nil, want error")
	}
}

func TestSocketPathWithoutHome(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "")
	t.Setenv("HOME", "")

	if _, err := SocketPath(); err == nil {
		t.Fatal("SocketPath() error = nil, want error")
	}
}

func TestSocketPathHomeUnreadable(t *testing.T) {
	home := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(home, nil, 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}

	t.Setenv("XDG_RUNTIME_DIR", "")
	t.Setenv("HOME", home)

	if _, err := SocketPath(); err == nil {
		t.Fatal("SocketPath() error = nil, want error")
	}
}

func TestRemoveStale(t *testing.T) {
	t.Parallel()

	t.Run("socket", func(t *testing.T) {
		t.Parallel()

		path := listenTemp(t)

		if err := RemoveStale(path); err != nil {
			t.Fatalf("RemoveStale() error = %v", err)
		}

		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("Lstat() error = %v, want not exist", err)
		}
	})

	t.Run("missing", func(t *testing.T) {
		t.Parallel()

		if err := RemoveStale(filepath.Join(t.TempDir(), "absent.sock")); err != nil {
			t.Errorf("RemoveStale() error = %v, want nil", err)
		}
	})

	t.Run("regular file", func(t *testing.T) {
		t.Parallel()

		path := filepath.Join(t.TempDir(), "regular")
		if err := os.WriteFile(path, []byte("keep"), 0o600); err != nil {
			t.Fatalf("write file: %v", err)
		}

		if err := RemoveStale(path); !errors.Is(err, ErrNotSocket) {
			t.Fatalf("RemoveStale() error = %v, want ErrNotSocket", err)
		}

		if _, err := os.Stat(path); err != nil {
			t.Errorf("file removed: %v", err)
		}
	})

	t.Run("directory", func(t *testing.T) {
		t.Parallel()

		if err := RemoveStale(t.TempDir()); !errors.Is(err, ErrNotSocket) {
			t.Errorf("RemoveStale() error = %v, want ErrNotSocket", err)
		}
	})

	t.Run("live socket", func(t *testing.T) {
		t.Parallel()

		path := filepath.Join(tempSocketDir(t), "live.sock")

		ln, err := net.Listen("unix", path)
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		defer func() { _ = ln.Close() }()

		if err := RemoveStale(path); !errors.Is(err, ErrAlreadyRunning) {
			t.Fatalf("RemoveStale() error = %v, want ErrAlreadyRunning", err)
		}

		if _, err := os.Lstat(path); err != nil {
			t.Errorf("live socket removed: %v", err)
		}
	})

	t.Run("unstattable path", func(t *testing.T) {
		t.Parallel()

		file := filepath.Join(t.TempDir(), "file")
		if err := os.WriteFile(file, nil, 0o600); err != nil {
			t.Fatalf("write file: %v", err)
		}

		err := RemoveStale(filepath.Join(file, "firefox-ctl.sock"))
		if err == nil || errors.Is(err, ErrNotSocket) {
			t.Errorf("RemoveStale() error = %v, want stat error", err)
		}
	})
}

func TestListen(t *testing.T) {
	t.Parallel()

	t.Run("mode 0600", func(t *testing.T) {
		t.Parallel()

		path := filepath.Join(tempSocketDir(t), "firefox-ctl.sock")

		ln, err := Listen(path)
		if err != nil {
			t.Fatalf("Listen() error = %v", err)
		}
		defer func() { _ = ln.Close() }()

		assertMode(t, path, socketMode)
	})

	t.Run("replaces stale socket", func(t *testing.T) {
		t.Parallel()

		path := listenTemp(t)

		ln, err := Listen(path)
		if err != nil {
			t.Fatalf("Listen() error = %v", err)
		}
		defer func() { _ = ln.Close() }()

		conn, err := net.Dial("unix", path)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		_ = conn.Close()
	})

	t.Run("missing directory fails acquiring the setup lock", func(t *testing.T) {
		t.Parallel()

		path := filepath.Join(tempSocketDir(t), "absent", "firefox-ctl.sock")

		if _, err := Listen(path); err == nil {
			t.Error("Listen() error = nil, want error")
		}
	})

	t.Run("bind failure is wrapped", func(t *testing.T) {
		t.Parallel()

		// one path component long enough to exceed AF_UNIX's sun_path limit
		// while still valid for a regular file, so the setup lock (a plain
		// file open) succeeds and net.Listen itself is what fails.
		path := filepath.Join(tempSocketDir(t), strings.Repeat("a", 200))

		_, err := Listen(path)
		if err == nil {
			t.Fatal("Listen() error = nil, want error")
		}

		if !strings.Contains(err.Error(), "listen on") {
			t.Errorf("Listen() error = %q, want it to wrap the net.Listen failure", err.Error())
		}
	})

	t.Run("refuses regular file", func(t *testing.T) {
		t.Parallel()

		path := filepath.Join(tempSocketDir(t), "regular")
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatalf("write file: %v", err)
		}

		if _, err := Listen(path); !errors.Is(err, ErrNotSocket) {
			t.Errorf("Listen() error = %v, want ErrNotSocket", err)
		}
	})

	t.Run("refuses to steal a live socket", func(t *testing.T) {
		t.Parallel()

		path := filepath.Join(tempSocketDir(t), "firefox-ctl.sock")

		first, err := Listen(path)
		if err != nil {
			t.Fatalf("Listen() first error = %v", err)
		}
		defer func() { _ = first.Close() }()

		if _, err := Listen(path); !errors.Is(err, ErrAlreadyRunning) {
			t.Fatalf("Listen() second error = %v, want ErrAlreadyRunning", err)
		}

		conn, err := net.Dial("unix", path)
		if err != nil {
			t.Fatalf("dial first listener: %v", err)
		}
		_ = conn.Close()
	})

	t.Run("close does not remove a replacement socket", func(t *testing.T) {
		t.Parallel()

		path := filepath.Join(tempSocketDir(t), "firefox-ctl.sock")

		first, err := Listen(path)
		if err != nil {
			t.Fatalf("Listen() first error = %v", err)
		}

		// simulate a new host claiming path in the window between the old
		// host's kernel-level listener closing and its own Close running:
		// swap in a socket first never created.
		if err := os.Remove(path); err != nil {
			t.Fatalf("remove: %v", err)
		}

		replacement, err := net.Listen("unix", path)
		if err != nil {
			t.Fatalf("listen replacement: %v", err)
		}
		defer func() { _ = replacement.Close() }()

		if err := first.Close(); err != nil {
			t.Fatalf("first.Close() error = %v", err)
		}

		if _, err := os.Lstat(path); err != nil {
			t.Errorf("replacement socket removed: %v", err)
		}
	})

	t.Run("close without the setup lock still closes the listener", func(t *testing.T) {
		t.Parallel()

		dir := tempSocketDir(t)
		path := filepath.Join(dir, "firefox-ctl.sock")

		ln, err := Listen(path)
		if err != nil {
			t.Fatalf("Listen() error = %v", err)
		}

		if err := os.RemoveAll(dir); err != nil {
			t.Fatalf("remove socket dir: %v", err)
		}

		if err := ln.Close(); err != nil {
			t.Errorf("Close() error = %v, want nil", err)
		}
	})

	t.Run("concurrent listen has exactly one winner", func(t *testing.T) {
		t.Parallel()

		path := filepath.Join(tempSocketDir(t), "concurrent.sock")

		const attempts = 8

		var (
			wg      sync.WaitGroup
			mu      sync.Mutex
			winners []net.Listener
			losses  []error
		)

		for range attempts {
			wg.Add(1)

			go func() {
				defer wg.Done()

				ln, err := Listen(path)

				mu.Lock()
				defer mu.Unlock()

				if err != nil {
					losses = append(losses, err)

					return
				}

				winners = append(winners, ln)
			}()
		}

		wg.Wait()

		defer func() {
			for _, ln := range winners {
				_ = ln.Close()
			}
		}()

		if len(winners) != 1 {
			t.Fatalf("got %d winners, want 1", len(winners))
		}

		if len(losses) != attempts-1 {
			t.Fatalf("got %d losses, want %d", len(losses), attempts-1)
		}

		for _, err := range losses {
			if !errors.Is(err, ErrAlreadyRunning) {
				t.Errorf("loser error = %v, want ErrAlreadyRunning", err)
			}
		}
	})
}

// listenTemp leaves a closed socket file behind so callers can exercise the
// stale-socket paths.
func listenTemp(t *testing.T) string {
	t.Helper()

	path := filepath.Join(tempSocketDir(t), "stale.sock")

	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	ln.(*net.UnixListener).SetUnlinkOnClose(false)

	if err := ln.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}

	return path
}

// tempSocketDir keeps socket paths under the sun_path length limit, which
// t.TempDir() can exceed on macOS.
func tempSocketDir(t *testing.T) string {
	t.Helper()

	dir, err := os.MkdirTemp("", "firefox-ctl")
	if err != nil {
		t.Fatalf("mkdir temp: %v", err)
	}

	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	return dir
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}

	if got := info.Mode().Perm(); got != want {
		t.Errorf("mode of %s = %o, want %o", path, got, want)
	}
}
