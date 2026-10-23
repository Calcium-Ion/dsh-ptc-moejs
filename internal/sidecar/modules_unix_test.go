//go:build !windows

package sidecar

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestImportsStayInsideTheWorkingDirectory(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "work")
	writeFiles(t, parent, map[string]string{"secret.ts": "export const secret = 1\n", "work/ok.ts": "export const ok = 1\n"})
	if err := os.Symlink(filepath.Join(parent, "secret.ts"), filepath.Join(dir, "link.ts")); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(dir, "fifo.ts"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := start(t, testConfig)
	expectFailure(t, h.evalIn(dir, `await import("./link.ts")`), kindException, "link.ts cannot be read")
	expectFailure(t, h.evalIn(dir, `await import("./fifo.ts")`), kindException, "fifo.ts is not a regular file")
	expectValue(t, h.evalIn(dir, `return (await import("./ok.ts")).ok`), `1`)
}
