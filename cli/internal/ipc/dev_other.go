//go:build !darwin

package ipc

import "syscall"

// devOf returns the device id, already uint64 on every other unix.
func devOf(stat *syscall.Stat_t) uint64 {
	return stat.Dev
}
