//go:build windows

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Rename by an open directory handle, not a path: changing an ancestor
// symlink cannot redirect the replacement outside the allowed os.Root.
type fileRenameInformation struct {
	ReplaceIfExists uint32
	RootDirectory   windows.Handle
	FileNameLength  uint32
	FileName        [1]uint16
}

func writeAnchoredFile(ctx context.Context, root *os.Root, rel string, content io.Reader) error {
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
	if info, err := dir.Stat(); err != nil {
		return err
	} else if !info.IsDir() {
		return fail("WORKER_PATH_DENIED", "File parent is not a directory.")
	}

	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return err
	}
	temp := ".mcp-worker-write-" + hex.EncodeToString(random)
	ntName, err := windows.NewNTUnicodeString(temp)
	if err != nil {
		return err
	}
	attributes := &windows.OBJECT_ATTRIBUTES{
		RootDirectory: windows.Handle(dir.Fd()),
		ObjectName:    ntName,
		Attributes:    windows.OBJ_CASE_INSENSITIVE,
	}
	attributes.Length = uint32(unsafe.Sizeof(*attributes))
	var h windows.Handle
	var iosb windows.IO_STATUS_BLOCK
	var allocation int64
	err = windows.NtCreateFile(&h, windows.FILE_GENERIC_READ|windows.FILE_GENERIC_WRITE|windows.DELETE,
		attributes, &iosb, &allocation, 0,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		windows.FILE_CREATE, windows.FILE_NON_DIRECTORY_FILE|windows.FILE_SYNCHRONOUS_IO_NONALERT, 0, 0)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(h), temp)
	committed := false
	defer func() {
		_ = f.Close()
		if !committed {
			_ = root.Remove(filepath.Join(filepath.Dir(rel), temp))
		}
	}()
	if existing != nil {
		if err := f.Chmod(existing.Mode().Perm()); err != nil {
			return err
		}
	}
	buf := make([]byte, 32*1024)
	for {
		n, readErr := content.Read(buf)
		if err := checkJobContext(ctx); err != nil {
			return err
		}
		if n > 0 {
			if _, err := f.Write(buf[:n]); err != nil {
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

	name, err := windows.UTF16FromString(filepath.Base(rel))
	if err != nil {
		return err
	}
	var layout fileRenameInformation
	buffer := make([]byte, int(unsafe.Offsetof(layout.FileName))+len(name)*2)
	info := (*fileRenameInformation)(unsafe.Pointer(&buffer[0]))
	info.ReplaceIfExists = windows.FILE_RENAME_REPLACE_IF_EXISTS | windows.FILE_RENAME_POSIX_SEMANTICS
	info.RootDirectory = windows.Handle(dir.Fd())
	info.FileNameLength = uint32((len(name) - 1) * 2)
	copy(unsafe.Slice(&info.FileName[0], len(name)), name)
	if err := windows.NtSetInformationFile(windows.Handle(f.Fd()), &iosb,
		&buffer[0], uint32(len(buffer)), windows.FileRenameInformation); err != nil {
		// Do not fall back to unsafe pathname rename or truncate.
		return err
	}
	committed = true
	return nil
}
