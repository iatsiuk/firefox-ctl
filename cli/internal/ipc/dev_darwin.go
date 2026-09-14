//go:build darwin

package ipc

import "syscall"

// devOf widens the device id; it is int32 on darwin and always non-negative.
func devOf(stat *syscall.Stat_t) uint64 {
	return uint64(stat.Dev) //nolint:gosec // non-negative by construction
}
