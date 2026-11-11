package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"
)

const daemonLogBytes int64 = 4 * 1024 * 1024
const daemonLogGenerations = 3
const retainedProcessSessions = 3

var sessionNameRE = regexp.MustCompile(`^session-[0-9a-f]{24}$`)
var processLogNameRE = regexp.MustCompile(`^brproc-[0-9a-f]{16}\.log$`)

// The private Worker home is the ownership boundary. Never follow symlinks
// or operate on an unexpected directory/file type.
func privateLogDir(path string) error {
	if err := os.Mkdir(path, 0700); err != nil && !os.IsExist(err) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("unsafe log directory: %s", path)
	}
	return nil
}
func regularLog(path string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("unsafe log file: %s", path)
	}
	return nil
}
func openLogOwner(home string) (*os.File, error) {
	p := filepath.Join(home, ".worker-log-owner.lock")
	if err := regularLog(p); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = lockLogOwner(f); err != nil {
		f.Close()
		return nil, fmt.Errorf("Worker home already locked: %w", err)
	}
	return f, nil
}

type rotatingDaemonLog struct {
	mu          sync.Mutex
	path        string
	file        *os.File
	size, limit int64
	closed      bool
}

func newRotatingDaemonLog(path string, limit int64) (*rotatingDaemonLog, error) {
	if limit <= 0 {
		return nil, fmt.Errorf("invalid daemon log limit")
	}
	w := &rotatingDaemonLog{path: path, limit: limit}
	if err := w.open(); err != nil {
		return nil, err
	}
	return w, nil
}
func (w *rotatingDaemonLog) open() error {
	if err := regularLog(w.path); err != nil {
		return err
	}
	f, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	s, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	w.file = f
	w.size = s.Size()
	return nil
}
func (w *rotatingDaemonLog) rotate() error {
	// Validate every generation before modifying any file.
	for i := 1; i <= daemonLogGenerations; i++ {
		if err := regularLog(fmt.Sprintf("%s.%d", w.path, i)); err != nil {
			return err
		}
	}
	if err := w.file.Close(); err != nil {
		return err
	}
	w.file = nil
	// Windows rename cannot replace an existing file.
	last := fmt.Sprintf("%s.%d", w.path, daemonLogGenerations)
	if err := os.Remove(last); err != nil && !os.IsNotExist(err) {
		return err
	}
	for i := daemonLogGenerations - 1; i >= 1; i-- {
		if err := os.Rename(fmt.Sprintf("%s.%d", w.path, i), fmt.Sprintf("%s.%d", w.path, i+1)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err := os.Rename(w.path, w.path+".1"); err != nil && !os.IsNotExist(err) {
		return err
	}
	return w.open()
}
func (w *rotatingDaemonLog) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return 0, os.ErrClosed
	}
	written := 0
	for len(p) > 0 {
		if w.file == nil {
			if err := w.open(); err != nil {
				return written, err
			}
		}
		if w.size >= w.limit {
			if err := w.rotate(); err != nil {
				return written, err
			}
		}
		n := int64(len(p))
		if n > w.limit-w.size {
			n = w.limit - w.size
		}
		k, err := w.file.Write(p[:n])
		written += k
		w.size += int64(k)
		p = p[k:]
		if err != nil {
			return written, err
		}
		if k == 0 {
			return written, io.ErrShortWrite
		}
	}
	return written, nil
}
func (w *rotatingDaemonLog) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}

// Called only while holding the per-home OS lock. An old Worker may have
// crashed, but its log-writing process no longer owns this home. Unknown
// entries and legacy temp logs are deliberately left untouched.
func prepareProcessSession(home string, now time.Time) (string, error) {
	root := filepath.Join(home, "process-logs-v1")
	if err := privateLogDir(root); err != nil {
		return "", err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", err
	}
	type oldSession struct {
		name     string
		modified time.Time
	}
	var old []oldSession
	for _, e := range entries {
		if !sessionNameRE.MatchString(e.Name()) || !e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			return "", err
		}
		old = append(old, oldSession{e.Name(), info.ModTime()})
	}
	sort.Slice(old, func(i, j int) bool { return old[i].modified.After(old[j].modified) })
	for i, s := range old {
		if i < retainedProcessSessions-1 && now.Sub(s.modified) < 7*24*time.Hour {
			continue
		}
		dir := filepath.Join(root, s.name)
		files, err := os.ReadDir(dir)
		if err != nil {
			return "", err
		}
		safe := true
		for _, f := range files {
			if !processLogNameRE.MatchString(f.Name()) || !f.Type().IsRegular() {
				safe = false
				break
			}
		}
		if !safe {
			continue
		}
		for _, f := range files {
			if err := os.Remove(filepath.Join(dir, f.Name())); err != nil {
				return "", err
			}
		}
		if err := os.Remove(dir); err != nil {
			return "", err
		}
	}
	dir := filepath.Join(root, "session-"+randomHex(12))
	if err := os.Mkdir(dir, 0700); err != nil {
		return "", err
	}
	return dir, nil
}
