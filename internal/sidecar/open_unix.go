//go:build !windows

package sidecar

import "syscall"

// openNonblock keeps opening a FIFO from blocking.
const openNonblock = syscall.O_NONBLOCK
