// Command moejs-ptc is the sidecar of dsh-ptc-moejs. The plugin
// starts it and speaks the protocol of package sidecar on its stdin and
// stdout.
package main

import (
	"fmt"
	"os"

	"github.com/Calcium-Ion/dsh-ptc-moejs/internal/sidecar"
)

func main() {
	if err := sidecar.Serve(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "moejs-ptc:", err)
		os.Exit(2)
	}
}
