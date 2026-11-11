package main

import (
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
)

// Limit status responses independently from the retained log and cursor API.
const managedStatusTailBytes int64 = 256 * 1024

func managedLogTail(path string, lines int) (string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", false
	}
	size := info.Size()
	start := size - managedStatusTailBytes
	if start < 0 {
		start = 0
	}
	buf := make([]byte, size-start)
	n, err := f.ReadAt(buf, start)
	if err != nil && err != io.EOF {
		return "", false
	}
	rows := strings.Split(strings.ReplaceAll(string(buf[:n]), "\r\n", "\n"), "\n")
	// A truncated byte window may begin halfway through a logical line.
	// If enough complete lines exist, preserve the exact old tail semantics.
	if len(rows) > lines {
		return strings.Join(rows[len(rows)-lines:], "\n"), false
	}
	return strings.Join(rows, "\n"), start > 0
}

// Keep an append-only prefix so existing byte cursors remain valid. The
// caller receives an explicit log_limit_reached flag after output is dropped.
const (
	managedProcessLogBytes int64 = 16 * 1024 * 1024
	maxManagedRunning            = 32
	maxManagedRecords            = 128
)

type boundedProcessLog struct {
	file    *os.File
	limit   int64
	written int64
	mu      sync.Mutex
	limited atomic.Bool
}

func (w *boundedProcessLog) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := len(p)
	remaining := w.limit - w.written
	if int64(n) > remaining {
		w.limited.Store(true)
		if remaining <= 0 {
			return n, nil
		}
		p = p[:remaining]
	}
	k, err := w.file.Write(p)
	w.written += int64(k)
	if err != nil {
		return k, err
	}
	return n, nil
}

func (p *managedProcess) logLimitReached() bool {
	return p.logWriter != nil && p.logWriter.limited.Load()
}

// Called with processMu held. Never evict a running job; completed records
// remain queryable until the oldest one must be evicted to admit a new job.
func (a *Agent) reserveManagedProcess() error {
	running := 0
	var oldest *managedProcess
	for _, p := range a.processes {
		p.mu.RLock()
		exited := p.exitedAt
		p.mu.RUnlock()
		if exited == "" {
			running++
			continue
		}
		if oldest == nil || p.startedAt < oldest.startedAt {
			oldest = p
		}
	}
	if running >= maxManagedRunning {
		return fail("WORKER_BUSY", "Managed process limit reached (32 running).")
	}
	if len(a.processes) >= maxManagedRecords {
		if oldest == nil {
			return fail("WORKER_BUSY", "Managed process record limit reached.")
		}
		if err := os.Remove(oldest.logPath); err != nil && !os.IsNotExist(err) {
			return err
		}
		delete(a.processes, oldest.id)
	}
	return nil
}
