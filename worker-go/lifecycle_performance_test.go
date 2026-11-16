package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func BenchmarkManagedProcessStatusLargeLog(b *testing.B) {
	p := filepath.Join(b.TempDir(), "process.log")
	data := bytes.Repeat([]byte("0123456789 benchmark log line\n"), 300000)
	if err := os.WriteFile(p, data, 0600); err != nil {
		b.Fatal(err)
	}
	record := &managedProcess{id: "fixture", logPath: p}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := record.snapshot(20); err != nil {
			b.Fatal(err)
		}
	}
}

func TestWorkspaceTimeoutStopsChildHoldingOutputPipe(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix child process group fixture")
	}
	t.Setenv("MCP_WORKER_WORKER_DISABLE_SYSTEMD_SCOPES", "1")
	root := t.TempDir()
	a := &Agent{cfg: Config{AllowShell: true}, roots: []string{root}, commands: map[int]*exec.Cmd{}}
	began := time.Now()
	_, err := a.runShell("sleep 2 & wait", root, 100*time.Millisecond, 1024)
	if err == nil || errorCode(err) != "WORKER_JOB_TIMEOUT" {
		t.Fatalf("expected timeout, got %v", err)
	}
	if elapsed := time.Since(began); elapsed > time.Second {
		t.Fatalf("timeout waited for child output pipe: %v", elapsed)
	}
}

func TestManagedProcessStatusTailMatchesSmallLog(t *testing.T) {
	p := filepath.Join(t.TempDir(), "process.log")
	if err := os.WriteFile(p, []byte("first\r\nsecond\r\nthird\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	record := &managedProcess{id: "fixture", logPath: p}
	status, err := record.snapshot(3)
	if err != nil {
		t.Fatal(err)
	}
	if got := status["output_tail"].(string); got != "second\nthird\n" {
		t.Fatalf("tail mismatch %q", got)
	}
	if strings.Contains(status["output_tail"].(string), "first") {
		t.Fatal("tail includes older line")
	}
}

func TestManagedProcessLogCapAndCursor(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	w := &boundedProcessLog{file: f, limit: 8}
	for _, s := range []string{"1234", "567890", "later"} {
		n, e := w.Write([]byte(s))
		if n != len(s) || e != nil {
			t.Fatal(n, e)
		}
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	r := &managedProcess{id: "test", logPath: path, logWriter: w}
	a := &Agent{processes: map[string]*managedProcess{"test": r}}
	out, err := a.processLogs(map[string]any{"process_id": "test", "cursor": 4, "max_bytes": 20})
	if err != nil {
		t.Fatal(err)
	}
	v := out.(map[string]any)
	if v["text"] != "5678" || v["next_cursor"] != int64(8) || v["log_limit_reached"] != true {
		t.Fatalf("incorrect cursor/limit: %#v", v)
	}
}

func TestManagedProcessAdmissionAndRetention(t *testing.T) {
	a := &Agent{processes: map[string]*managedProcess{}}
	for i := 0; i < maxManagedRunning; i++ {
		id := fmt.Sprintf("live-%d", i)
		a.processes[id] = &managedProcess{id: id}
	}
	if err := a.reserveManagedProcess(); errorCode(err) != "WORKER_BUSY" {
		t.Fatalf("running cap: %v", err)
	}
	a.processes = map[string]*managedProcess{}
	dir := t.TempDir()
	for i := 0; i < maxManagedRecords; i++ {
		id := fmt.Sprintf("done-%03d", i)
		p := filepath.Join(dir, id)
		if err := os.WriteFile(p, []byte("retained"), 0600); err != nil {
			t.Fatal(err)
		}
		a.processes[id] = &managedProcess{id: id, logPath: p, startedAt: id, exitedAt: "done"}
	}
	if err := a.reserveManagedProcess(); err != nil {
		t.Fatal(err)
	}
	if len(a.processes) != maxManagedRecords-1 || a.processes["done-000"] != nil {
		t.Fatal("oldest completed record not evicted")
	}
	if _, err := os.Stat(filepath.Join(dir, "done-000")); !os.IsNotExist(err) {
		t.Fatal("old log not removed")
	}
}

func TestManagedProcessStopReturnsWhenExited(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix signal fixture")
	}
	t.Setenv("TMPDIR", t.TempDir())
	root := t.TempDir()
	a := &Agent{cfg: Config{AllowShell: true}, roots: []string{root}, processes: map[string]*managedProcess{}}
	v, err := a.startManagedProcess(map[string]any{"cwd": root, "command": "sleep 10"})
	if err != nil {
		t.Fatal(err)
	}
	id := v.(map[string]any)["process_id"].(string)
	defer a.shutdown()
	began := time.Now()
	out, err := a.processStop(map[string]any{"process_id": id, "grace_ms": 3000, "force": true})
	if err != nil || out.(map[string]any)["state"] != "EXITED" {
		t.Fatalf("stop failed: %v %v", out, err)
	}
	if time.Since(began) > time.Second {
		t.Fatal("stop waited full grace")
	}
}

func TestWorkerShutdownStopsWorkspaceAndManagedProcess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix process-group fixture")
	}
	t.Setenv("TMPDIR", t.TempDir())
	root := t.TempDir()
	a := &Agent{cfg: Config{AllowShell: true}, roots: []string{root}, processes: map[string]*managedProcess{}, commands: map[int]*exec.Cmd{}}
	v, err := a.startManagedProcess(map[string]any{"cwd": root, "command": "sleep 10"})
	if err != nil {
		t.Fatal(err)
	}
	id := v.(map[string]any)["process_id"].(string)
	done := make(chan error, 1)
	go func() { _, err := a.runShell("sleep 10", root, 15*time.Second, 1024); done <- err }()
	deadline := time.Now().Add(time.Second)
	for {
		a.commandMu.Lock()
		n := len(a.commands)
		a.commandMu.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			a.shutdown()
			t.Fatal("workspace command not tracked")
		}
		time.Sleep(5 * time.Millisecond)
	}
	a.shutdown()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("workspace command left running after shutdown")
	}
	record, err := a.getProcess(id)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-record.done:
	case <-time.After(time.Second):
		t.Fatal("managed process left running after shutdown")
	}
	if _, err := a.runShell("printf should-not-run", root, time.Second, 1024); errorCode(err) != "WORKER_SHUTTING_DOWN" {
		t.Fatalf("expected shutdown guard, got %v", err)
	}
}

func TestServerRevocationStopsManagedWorkloadsWithoutRetry(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix process-group fixture; Windows requires native test")
	}
	for _, tc := range []struct {
		name string
		code int
		text string
	}{
		{"owner-disabled", 4003, "owner-disabled"},
		{"worker-disabled", 4003, "worker-disabled"},
		{"owner-db-unavailable", 4003, "owner-status-unavailable"},
		{"worker-db-unavailable", 4003, "worker-status-unavailable"},
		{"worker-capability-revoked", 4003, "worker-capability-revoked"},
		{"worker-identity-changed", 4003, "worker-identity-changed"},
		{"worker-removed", 4004, "worker-removed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("TMPDIR", t.TempDir())
			root := t.TempDir()
			a := &Agent{
				cfg: Config{AllowShell: true}, roots: []string{root},
				processes: map[string]*managedProcess{}, commands: map[int]*exec.Cmd{},
			}
			started, err := a.startManagedProcess(map[string]any{
				"cwd": root, "command": "sleep 10",
			})
			if err != nil {
				t.Fatal(err)
			}
			id := started.(map[string]any)["process_id"].(string)
			record, err := a.getProcess(id)
			if err != nil {
				t.Fatal(err)
			}
			if !a.stopOnAuthoritativeClose(&websocket.CloseError{Code: tc.code, Text: tc.text}) {
				t.Fatal("revocation must stop reconnect")
			}
			if !a.shutting.Load() {
				t.Fatal("revocation must shut down the agent")
			}
			select {
			case <-record.done:
			case <-time.After(2 * time.Second):
				t.Fatal("revocation left a managed process running")
			}
		})
	}
}

func TestOrdinaryDisconnectDoesNotStopWorker(t *testing.T) {
	a := &Agent{processes: map[string]*managedProcess{}, commands: map[int]*exec.Cmd{}}
	for _, closeErr := range []error{
		fmt.Errorf("network disconnected"),
		&websocket.CloseError{Code: websocket.CloseNormalClosure, Text: "test-done"},
		&websocket.CloseError{Code: 4003, Text: "unexpected-reason"},
		&websocket.CloseError{Code: 4004, Text: "unexpected-reason"},
	} {
		if a.stopOnAuthoritativeClose(closeErr) || a.shutting.Load() {
			t.Fatalf("unexpected retry suppression on %v", closeErr)
		}
	}
}

func TestManagedStatusTailMarksLongPartialLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	if err := os.WriteFile(path, bytes.Repeat([]byte("x"), int(managedStatusTailBytes)+20), 0600); err != nil {
		t.Fatal(err)
	}
	s, cut := managedLogTail(path, 20)
	if !cut || len(s) != int(managedStatusTailBytes) {
		t.Fatalf("unexpected bounded tail len=%d truncated=%v", len(s), cut)
	}
}
