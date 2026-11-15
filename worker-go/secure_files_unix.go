//go:build linux || darwin

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// writeAnchoredFile stages bytes in the opened destination directory, then
// atomically replaces the target by directory descriptor. Path-based os.Rename
// would reintroduce a symlink race after os.Root's secure traversal.
func writeAnchoredFile(ctx context.Context, root *os.Root, rel string, content io.Reader) error {
	name := filepath.Base(rel)
	existing, err := root.Lstat(rel)
	if err == nil {
		if !existing.Mode().IsRegular() {
			return fail("WORKER_PATH_DENIED", "File target is not a regular file.")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	dir, err := root.Open(filepath.Dir(rel))
	if err != nil {
		return err
	}
	defer dir.Close()
	info, err := dir.Stat()
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fail("WORKER_PATH_DENIED", "File parent is not a directory.")
	}

	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return err
	}
	temp := ".mcp-worker-write-" + hex.EncodeToString(random)
	fd, err := unix.Openat(int(dir.Fd()), temp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), temp)
	committed := false
	defer func() {
		_ = f.Close()
		if !committed {
			_ = unix.Unlinkat(int(dir.Fd()), temp, 0)
		}
	}()
	if existing != nil {
		if err := f.Chmod(existing.Mode().Perm()); err != nil {
			return err
		}
	}
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
	if err := f.Sync(); err != nil {
		return err
	}
	if err := checkJobContext(ctx); err != nil {
		return err
	}
	if err := unix.Renameat(int(dir.Fd()), temp, int(dir.Fd()), name); err != nil {
		return err
	}
	committed = true
	return dir.Sync()
}
