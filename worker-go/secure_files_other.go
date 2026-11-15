//go:build !linux && !darwin && !windows

package main

import (
	"context"
	"io"
	"os"
)

// Go 1.24 os.Root has no atomic rename primitive on these platforms.
// Retain rooted writes rather than falling back to unsafe pathname renames;
// native atomic-replacement behavior remains a separate release QA gate.
func writeAnchoredFile(ctx context.Context, root *os.Root, rel string, content io.Reader) error {
	if err := checkJobContext(ctx); err != nil {
		return err
	}
	f, err := root.OpenFile(rel, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	buffer := make([]byte, 32*1024)
	for {
		n, readErr := content.Read(buffer)
		if err := checkJobContext(ctx); err != nil {
			return err
		}
		if n > 0 {
			if _, err := f.Write(buffer[:n]); err != nil {
				return err
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	return checkJobContext(ctx)
}
