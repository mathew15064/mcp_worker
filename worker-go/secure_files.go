package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// The directory handles are opened before the Worker accepts jobs. os.Root
// prevents symlink replacement of descendants from redirecting I/O outside
// the approved directory tree (including during concurrent renames).
type anchoredRoot struct {
	path string
	dir  *os.Root
}

func openAnchoredRoots(paths []string) ([]anchoredRoot, error) {
	opened := make([]anchoredRoot, 0, len(paths))
	for _, path := range paths {
		root, err := os.OpenRoot(path)
		if err != nil {
			for _, prev := range opened {
				_ = prev.dir.Close()
			}
			return nil, err
		}
		opened = append(opened, anchoredRoot{path: path, dir: root})
	}
	return opened, nil
}

func (a *Agent) allowedFile(path string) (*os.Root, string, func(), error) {
	if strings.TrimSpace(path) == "" || strings.ContainsRune(path, '\x00') {
		return nil, "", nil, fail("WORKER_PATH_INVALID", "Path is invalid.")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, "", nil, err
	}
	// With no configured path allowlist, anchor each operation to the
	// filesystem volume containing its target. os.Root still protects writes
	// against symlink races; filesystem permissions remain the only boundary.
	if len(a.roots) == 0 {
		volumeRoot := filepath.VolumeName(absolute) + string(os.PathSeparator)
		root, err := os.OpenRoot(volumeRoot)
		if err != nil {
			return nil, "", nil, err
		}
		rel, err := filepath.Rel(volumeRoot, absolute)
		if err != nil {
			_ = root.Close()
			return nil, "", nil, err
		}
		return root, rel, func() { _ = root.Close() }, nil
	}
	roots := a.fileRoots
	// Directly constructed test agents use a temporary root for each call.
	// Production agents pin the handles before the first connection.
	if len(roots) == 0 {
		roots = make([]anchoredRoot, 0, len(a.roots))
		for _, allowed := range a.roots {
			roots = append(roots, anchoredRoot{path: allowed})
		}
	}
	for _, allowed := range roots {
		rel, err := filepath.Rel(allowed.path, absolute)
		if err != nil || rel == ".." || filepath.IsAbs(rel) || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			continue
		}
		if allowed.dir != nil {
			return allowed.dir, rel, func() {}, nil
		}
		root, err := os.OpenRoot(allowed.path)
		if err != nil {
			return nil, "", nil, err
		}
		return root, rel, func() { _ = root.Close() }, nil
	}
	return nil, "", nil, fail("WORKER_PATH_DENIED", "Path is outside worker allowed roots.")
}

func checkJobContext(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return fail("WORKER_JOB_TIMEOUT", "Worker job was cancelled or exceeded its timeout.")
	}
	return nil
}

func (a *Agent) collectAllowedFile(ctx context.Context, path string, maxBytes int64) (any, error) {
	if err := checkJobContext(ctx); err != nil {
		return nil, err
	}
	root, rel, closeRoot, err := a.allowedFile(path)
	if err != nil {
		return nil, err
	}
	defer closeRoot()
	f, err := root.Open(rel)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fail("ARTIFACT_NOT_FILE", "Artifact path is not a regular file.")
	}
	if info.Size() > maxBytes {
		return nil, fail("ARTIFACT_TOO_LARGE", fmt.Sprintf("Artifact exceeds max_bytes (%d > %d).", info.Size(), maxBytes))
	}
	data, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fail("ARTIFACT_TOO_LARGE", "Artifact exceeds max_bytes.")
	}
	if err := checkJobContext(ctx); err != nil {
		return nil, err
	}
	mimeType := mime.TypeByExtension(filepath.Ext(path))
	if mimeType == "" {
		mimeType = http.DetectContentType(data)
	}
	isText := strings.HasPrefix(mimeType, "text/") || strings.Contains(mimeType, "json") || strings.Contains(mimeType, "javascript") || strings.Contains(mimeType, "xml") || !strings.ContainsRune(string(data), '\x00')
	sum := sha256.Sum256(data)
	var text any
	if isText {
		text = string(data)
	}
	absolute, _ := filepath.Abs(path)
	// This is an approved-root path, not a post-open symlink re-resolution.
	return map[string]any{"path": path, "real_path": absolute, "size": int64(len(data)), "mime_type": mimeType, "sha256": hex.EncodeToString(sum[:]), "is_text": isText, "text": text}, nil
}

func (a *Agent) writeAllowedFile(ctx context.Context, path string, content io.Reader, createDirs bool) error {
	if err := checkJobContext(ctx); err != nil {
		return err
	}
	root, rel, closeRoot, err := a.allowedFile(path)
	if err != nil {
		return err
	}
	defer closeRoot()
	dir := filepath.Dir(rel)
	if createDirs && dir != "." {
		current := ""
		for _, part := range strings.Split(dir, string(os.PathSeparator)) {
			if err := checkJobContext(ctx); err != nil {
				return err
			}
			current = filepath.Join(current, part)
			if err := root.Mkdir(current, 0755); err != nil && !errors.Is(err, os.ErrExist) {
				return err
			}
			info, err := root.Stat(current)
			if err != nil {
				return err
			}
			if !info.IsDir() {
				return fail("WORKER_PATH_DENIED", "File parent is not a directory.")
			}
		}
	}
	if err := checkJobContext(ctx); err != nil {
		return err
	}
	return writeAnchoredFile(ctx, root, rel, content)
}
