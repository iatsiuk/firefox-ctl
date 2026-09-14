// Package ipc resolves the firefox-ctl unix socket path and prepares the listener.
package ipc

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const (
	socketName = "firefox-ctl.sock"
	dirName    = ".firefox-ctl"
	lockSuffix = ".lock"

	dirMode    os.FileMode = 0o700
	socketMode os.FileMode = 0o600

	dialProbeTimeout = 200 * time.Millisecond
)

// ErrNotSocket reports a socket path occupied by something else.
var ErrNotSocket = errors.New("path exists and is not a socket")

// ErrAlreadyRunning reports a socket path served by a live host.
var ErrAlreadyRunning = errors.New("another host is already listening on this socket")

// SocketPath returns the socket path, preferring $XDG_RUNTIME_DIR and falling
// back to ~/.firefox-ctl, whose directory it creates or repairs with mode 0700.
func SocketPath() (string, error) {
	if dir := os.Getenv("XDG_RUNTIME_DIR"); dir != "" {
		//nolint:gosec // the runtime dir comes from the user's own environment by design
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			return filepath.Join(dir, socketName), nil
		}
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}

	dir := filepath.Join(home, dirName)
	if err := ensureDir(dir); err != nil {
		return "", err
	}

	return filepath.Join(dir, socketName), nil
}

// Listen removes a stale socket, listens on path and restricts it to the
// owner. The stale check, removal and bind run under a file lock so two
// processes racing to claim the same path cannot both conclude it is stale
// and both bind; the loser observes the winner's fresh listener instead.
//
// The returned Listener defers the socket's unlink to its own Close, run
// under the same file lock and gated on the file at path still being the
// one this call created. That prevents a shutdown from unlinking a
// replacement socket that a new host bound at the same path in the window
// between this listener's own Close and the unlink.
func Listen(path string) (net.Listener, error) {
	lock, err := acquireSetupLock(path)
	if err != nil {
		return nil, err
	}
	defer releaseSetupLock(lock)

	if err := RemoveStale(path); err != nil {
		return nil, err
	}

	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", path, err)
	}

	// unlinking is done by our own Close, synchronised with the setup lock
	ln.(*net.UnixListener).SetUnlinkOnClose(false)

	if err := os.Chmod(path, socketMode); err != nil {
		_ = ln.Close()

		return nil, fmt.Errorf("chmod socket %s: %w", path, err)
	}

	ident, err := statIdentity(path)
	if err != nil {
		_ = ln.Close()

		return nil, fmt.Errorf("stat socket %s: %w", path, err)
	}

	return &listener{UnixListener: ln.(*net.UnixListener), path: path, ident: ident}, nil
}

// listener wraps a *net.UnixListener so Close unlinks path itself, under the
// same lock Listen uses, instead of relying on the kernel's unlink-on-close.
type listener struct {
	*net.UnixListener

	path  string
	ident fileIdentity

	closeOnce sync.Once
	closeErr  error
}

// Close closes the underlying listener and unlinks path, but only when path
// still resolves to the socket file this listener created: a concurrent
// Listen may already have replaced it with a new host's socket, which must
// survive this Close untouched.
func (l *listener) Close() error {
	l.closeOnce.Do(func() {
		lock, err := acquireSetupLock(l.path)
		if err != nil {
			l.closeErr = l.UnixListener.Close()

			return
		}
		defer releaseSetupLock(lock)

		l.closeErr = l.UnixListener.Close()

		if ident, err := statIdentity(l.path); err == nil && ident == l.ident {
			_ = os.Remove(l.path)
		}
	})

	return l.closeErr
}

// fileIdentity identifies a file by device and inode, stable across renames
// but unique per underlying file, so a stale reference to path can be told
// apart from a different file a later Listen bound there.
type fileIdentity struct {
	dev, ino uint64
}

func statIdentity(path string) (fileIdentity, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return fileIdentity{}, err
	}

	stat := info.Sys().(*syscall.Stat_t) //nolint:forcetypeassert // darwin always backs os.FileInfo with syscall.Stat_t

	return fileIdentity{dev: devOf(stat), ino: stat.Ino}, nil
}

// acquireSetupLock blocks until this process exclusively owns the setup
// critical section for path, so RemoveStale's stale check always sees the
// outcome of any setup that finished before it, never one racing alongside
// it. The lock file is a permanent companion of the socket path, not
// removed after use: deleting it would let a concurrent locker open a fresh
// inode and lock that instead, defeating the mutual exclusion.
func acquireSetupLock(path string) (*os.File, error) {
	lockPath := path + lockSuffix

	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, socketMode)
	if err != nil {
		return nil, fmt.Errorf("open lock file %s: %w", lockPath, err)
	}

	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil { //nolint:gosec // a descriptor fits in int
		_ = f.Close()

		return nil, fmt.Errorf("lock %s: %w", lockPath, err)
	}

	return f, nil
}

func releaseSetupLock(f *os.File) {
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) //nolint:gosec // a descriptor fits in int
	_ = f.Close()
}

// RemoveStale unlinks path when it is a leftover socket nobody is listening
// on. A socket still served by a live host is kept and reported as
// ErrAlreadyRunning, so a second host cannot steal the first one's socket;
// anything that is not a socket at all is also kept and reported, so a
// mistyped path cannot delete a real file.
func RemoveStale(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}

		return fmt.Errorf("stat socket %s: %w", path, err)
	}

	if info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("%w: %s", ErrNotSocket, path)
	}

	if isServing(path) {
		return fmt.Errorf("%w: %s", ErrAlreadyRunning, path)
	}

	if err := os.Remove(path); err != nil {
		return fmt.Errorf("remove stale socket %s: %w", path, err)
	}

	return nil
}

// isServing reports whether a live listener still accepts connections on
// path, distinguishing a stale (abandoned) socket file from one backed by a
// running host. Only a refused connection proves nobody is listening; any
// other dial failure (timeout, temporary resource exhaustion) is treated as
// still serving, so an ambiguous probe never causes a live socket to be
// unlinked.
func isServing(path string) bool {
	conn, err := net.DialTimeout("unix", path, dialProbeTimeout)
	if err != nil {
		return !errors.Is(err, syscall.ECONNREFUSED)
	}

	_ = conn.Close()

	return true
}

func ensureDir(dir string) error {
	info, err := os.Stat(dir)
	switch {
	case errors.Is(err, os.ErrNotExist):
		if err := os.MkdirAll(dir, dirMode); err != nil {
			return fmt.Errorf("create socket directory %s: %w", dir, err)
		}

		return nil
	case err != nil:
		return fmt.Errorf("stat socket directory %s: %w", dir, err)
	case !info.IsDir():
		return fmt.Errorf("socket directory %s: %w", dir, os.ErrExist)
	}

	if info.Mode().Perm() != dirMode {
		if err := os.Chmod(dir, dirMode); err != nil {
			return fmt.Errorf("chmod socket directory %s: %w", dir, err)
		}
	}

	return nil
}
