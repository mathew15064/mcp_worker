package main

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestUnrestrictedFileOperationsUseOSPermissions(t *testing.T) {
	first, second := t.TempDir(), t.TempDir()
	file := filepath.Join(second, "nested", "output.txt")
	unrestricted := &Agent{cfg: Config{AllowShell: true}}
	if err := unrestricted.writeAllowedFile(context.Background(), file, strings.NewReader("outside-original-root"), true); err != nil {
		t.Fatalf("OS-allowed write outside working directory: %v", err)
	}
	artifact, err := unrestricted.collectAllowedFile(context.Background(), file, 4096)
	if err != nil {
		t.Fatalf("OS-allowed artifact outside working directory: %v", err)
	}
	if got := artifact.(map[string]any)["text"]; got != "outside-original-root" {
		t.Fatalf("unexpected artifact: %v", got)
	}
	restricted := &Agent{roots: []string{first}}
	if err := restricted.writeAllowedFile(context.Background(), file, strings.NewReader("denied"), false); errorCode(err) != "WORKER_PATH_DENIED" {
		t.Fatalf("explicit restricted roots must still deny cross-root write: %v", err)
	}
	data, err := os.ReadFile(file)
	if err != nil || string(data) != "outside-original-root" {
		t.Fatalf("rejected write modified file: %q %v", data, err)
	}
	if _, err := unrestricted.collectAllowedFile(context.Background(), "", 4096); errorCode(err) != "WORKER_PATH_INVALID" {
		t.Fatalf("invalid file path must still be denied: %v", err)
	}
}

func TestAnchoredFilesRejectSwappedSymlinkForReadWriteAndArtifact(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Symlink creation requires Windows privilege; checked on Unix")
	}
	root, outside := t.TempDir(), t.TempDir()
	nested := filepath.Join(root, "nested")
	if err := os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nested, "data.txt"), []byte("inside"), 0600); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(outside, "data.txt")
	if err := os.WriteFile(victim, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	handles, err := openAnchoredRoots([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	defer handles[0].dir.Close()
	a := &Agent{roots: []string{root}, fileRoots: handles}

	// Pin the approved directory handle, then replace a checked descendant
	// with a link to a different directory before each operation.
	if err := os.Rename(nested, filepath.Join(root, "original")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, nested); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(nested, "data.txt")
	if _, err := a.collectAllowedFile(context.Background(), path, 1024); err == nil {
		t.Fatal("artifact read followed swapped symlink outside the approved root")
	}
	if err := a.writeAllowedFile(context.Background(), path, strings.NewReader("tampered"), true); err == nil {
		t.Fatal("write followed swapped symlink outside the approved root")
	}
	if _, err := a.executeOperationContext(context.Background(), "artifact.collect", map[string]any{"path": path}); err == nil {
		t.Fatal("artifact operation followed swapped symlink")
	}
	if _, err := a.executeOperationContext(context.Background(), "file.write", map[string]any{"path": path, "content": "tampered"}); err == nil {
		t.Fatal("file.write operation followed swapped symlink")
	}
	got, err := os.ReadFile(victim)
	if err != nil || string(got) != "outside" {
		t.Fatalf("outside file modified: %q, %v", got, err)
	}
}

func TestAnchoredFilesKeepPinnedRootWhenRootPathReplaced(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Symlink creation requires Windows privilege; checked on Unix")
	}
	parent := t.TempDir()
	root := filepath.Join(parent, "allowed")
	outside := filepath.Join(parent, "outside")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(outside, 0700); err != nil {
		t.Fatal(err)
	}
	handles, err := openAnchoredRoots([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	defer handles[0].dir.Close()
	a := &Agent{roots: []string{root}, fileRoots: handles}
	moved := filepath.Join(parent, "moved-root")
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, root); err != nil {
		t.Fatal(err)
	}
	if err := a.writeAllowedFile(context.Background(), filepath.Join(root, "safe.txt"), strings.NewReader("safe"), false); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(moved, "safe.txt")); err != nil || string(data) != "safe" {
		t.Fatalf("original anchored directory not written: %q %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(outside, "safe.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("swapped root destination was modified: %v", err)
	}
}

type delayedReader struct {
	began   chan struct{}
	release <-chan struct{}
}

func (r *delayedReader) Read(p []byte) (int, error) {
	select {
	case <-r.began:
	default:
		close(r.began)
	}
	<-r.release
	copy(p, "late-write")
	return len("late-write"), io.EOF
}

func TestCancelledBlockedWriteNeverWritesAfterDeadline(t *testing.T) {
	root := t.TempDir()
	a := &Agent{roots: []string{root}}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	release := make(chan struct{})
	began := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- a.writeAllowedFile(ctx, filepath.Join(root, "delayed.txt"), &delayedReader{began: began, release: release}, false)
	}()
	// The file is opened before the reader blocks; cancellation must be checked
	// again after the blocked read, before writing any bytes.
	select {
	case <-began:
	case <-time.After(time.Second):
		t.Fatal("write did not reach delayed read")
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("deadline did not fire")
	}
	close(release)
	select {
	case err := <-done:
		if errorCode(err) != "WORKER_JOB_TIMEOUT" {
			t.Fatalf("expected bounded cancelled write, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation left a blocked write goroutine")
	}
	data, err := os.ReadFile(filepath.Join(root, "delayed.txt"))
	if runtime.GOOS == "linux" || runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		if !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("atomic write should leave no target after cancellation: %q %v", data, err)
		}
	} else if err != nil || len(data) != 0 {
		t.Fatalf("delayed content reached file after cancellation: %q %v", data, err)
	}
}

func TestCancelledAtomicWritePreservesOriginalFile(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		t.Skip("Atomic directory-handle replacement is not supported on this platform")
	}
	root := t.TempDir()
	path := filepath.Join(root, "existing.txt")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	a := &Agent{roots: []string{root}}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	release := make(chan struct{})
	began := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- a.writeAllowedFile(ctx, path, &delayedReader{began: began, release: release}, false)
	}()
	<-began
	<-ctx.Done()
	close(release)
	if err := <-done; errorCode(err) != "WORKER_JOB_TIMEOUT" {
		t.Fatalf("expected cancelled atomic update, got %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "original" {
		t.Fatalf("cancelled write destroyed existing contents: %q %v", data, err)
	}
	leftover, err := filepath.Glob(filepath.Join(root, ".mcp-worker-write-*"))
	if err != nil || len(leftover) > 0 {
		t.Fatalf("temporary upload files left behind: %v %v", leftover, err)
	}
	if err := a.writeAllowedFile(context.Background(), path, strings.NewReader("replacement"), false); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(path)
	if err != nil || string(data) != "replacement" {
		t.Fatalf("completed atomic write failed: %q %v", data, err)
	}
}

type fixtureReaderError struct{}

func (fixtureReaderError) Read([]byte) (int, error) {
	return 0, errors.New("fixture-read-failed")
}

func TestAtomicWriteReaderFailureDoesNotTruncateExistingFile(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		t.Skip("Atomic directory-handle replacement is not supported on this platform")
	}
	root := t.TempDir()
	target := filepath.Join(root, "preserve.txt")
	if err := os.WriteFile(target, []byte("unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	a := &Agent{roots: []string{root}}
	incoming := io.MultiReader(strings.NewReader("partial"), fixtureReaderError{})
	if err := a.writeAllowedFile(context.Background(), target, incoming, false); err == nil {
		t.Fatal("expected injected read failure")
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "unchanged" {
		t.Fatalf("failed atomic write altered existing file: %q %v", data, err)
	}
	left, err := filepath.Glob(filepath.Join(root, ".mcp-worker-write-*"))
	if err != nil || len(left) != 0 {
		t.Fatalf("failed atomic write left temporary file: %v %v", left, err)
	}
}

func TestCancelledJobDoesNotLaunchProcessOrDelayedShellWrite(t *testing.T) {
	root := t.TempDir()
	a := &Agent{cfg: Config{AllowShell: true}, roots: []string{root}, processes: map[string]*managedProcess{}}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	out := filepath.Join(root, "started.txt")
	_, err := a.startManagedProcessContext(cancelled, map[string]any{"cwd": root, "command": testEchoCommand("should-not-start")})
	if errorCode(err) != "WORKER_JOB_TIMEOUT" || len(a.processes) != 0 {
		t.Fatalf("cancelled process.start did not fail closed: %v", err)
	}
	if runtime.GOOS == "windows" {
		return
	}
	t.Setenv("BOT_REPORT_WORKER_DISABLE_SYSTEMD_SCOPES", "1")
	ctx, stop := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer stop()
	_, err = a.runShellContext(ctx, "sleep 0.25; printf unauthorized > started.txt", root, time.Second, 1024)
	if errorCode(err) != "WORKER_JOB_TIMEOUT" {
		t.Fatalf("expected shell timeout, got %v", err)
	}
	time.Sleep(350 * time.Millisecond)
	if _, err := os.Stat(out); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("delayed shell action ran after deadline: %v", err)
	}
}

func TestCancelledJobCannotCreateInteractiveShell(t *testing.T) {
	root := t.TempDir()
	agent := &Agent{cfg: Config{AllowShell: true}, roots: []string{root}, shells: map[string]*shellSession{}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := agent.executeOperationContext(ctx, "shell.inspect", map[string]any{"session_key": "cancelled"})
	if errorCode(err) != "WORKER_JOB_TIMEOUT" {
		t.Fatalf("expected cancelled shell operation, got %v", err)
	}
	if len(agent.shells) != 0 {
		t.Fatal("shell started after job cancellation")
	}
}

func TestAnchoredArtifactRejectsOversizedReadAndNonRegularFile(t *testing.T) {
	root := t.TempDir()
	a := &Agent{roots: []string{root}}
	path := filepath.Join(root, "large")
	if err := os.WriteFile(path, []byte("123456789"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := a.collectAllowedFile(context.Background(), path, 4); errorCode(err) != "ARTIFACT_TOO_LARGE" {
		t.Fatalf("wanted bounded read error, got %v", err)
	}
	if _, err := a.collectAllowedFile(context.Background(), root, 1024); errorCode(err) != "ARTIFACT_NOT_FILE" {
		t.Fatalf("directory must not be collected, got %v", err)
	}
}
