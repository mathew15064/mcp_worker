package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func testEchoCommand(value string) string {
	if runtime.GOOS == "windows" {
		return "Write-Output '" + value + "'"
	}
	return "printf '" + value + "'"
}
func testProcessCommand() string {
	if runtime.GOOS == "windows" {
		return "Write-Output 'process-ok'; Start-Sleep -Milliseconds 100"
	}
	return "printf process-ok; sleep 0.1"
}
func testLongCommand() string {
	if runtime.GOOS == "windows" {
		return "Start-Sleep -Seconds 30"
	}
	return "sleep 30"
}

func parsePublicKeyForTest(t *testing.T, text string) ed25519.PublicKey {
	t.Helper()
	block, _ := pem.Decode([]byte(text))
	if block == nil {
		t.Fatal("missing public PEM block")
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	pub, ok := key.(ed25519.PublicKey)
	if !ok {
		t.Fatal("not Ed25519 public key")
	}
	return pub
}

func TestIdentityUsesNodeCompatiblePKCS8AndSPKIPEM(t *testing.T) {
	privatePEM, publicPEM, err := generateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	privateKey, err := parsePrivateKey(privatePEM)
	if err != nil {
		t.Fatal(err)
	}
	publicKey := parsePublicKeyForTest(t, publicPEM)
	message := []byte("worker-id\n1800000000000\nnonce_abcdefghijklmnop\n/worker/v1/connect")
	signature := ed25519.Sign(privateKey, message)
	if !ed25519.Verify(publicKey, message, signature) {
		t.Fatal("generated key pair cannot verify canonical worker signature")
	}
}

func TestAllowedPathRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("nope"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("Windows symlink privilege unavailable: %v", err)
		}
		t.Fatal(err)
	}
	if _, err := assertAllowedPath(filepath.Join(root, "escape", "secret.txt"), []string{root}, true); err == nil || errorCode(err) != "WORKER_PATH_DENIED" {
		t.Fatalf("expected WORKER_PATH_DENIED, got %v", err)
	}
	inside := filepath.Join(root, "ok.txt")
	if err := os.WriteFile(inside, []byte("ok"), 0600); err != nil {
		t.Fatal(err)
	}
	if got, err := assertAllowedPath(inside, []string{root}, true); err != nil || got != inside {
		t.Fatalf("expected inside path, got %q %v", got, err)
	}
}

func TestStandaloneAgentAuthenticatesAndExecutesTypedWorkspaceJob(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "worker-home")
	if err := os.MkdirAll(home, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BOT_REPORT_WORKER_HOME", home)

	privatePEM, publicPEM, err := generateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	workerID := "11111111-2222-4333-8444-555555555555"
	resultCh := make(chan map[string]any, 1)
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != connectPath {
			http.NotFound(w, r)
			return
		}
		timestamp := r.Header.Get("x-br-worker-timestamp")
		nonce := r.Header.Get("x-br-worker-nonce")
		signatureText := r.Header.Get("x-br-worker-signature")
		canonical := workerID + "\n" + timestamp + "\n" + nonce + "\n" + connectPath
		signature, err := base64.StdEncoding.DecodeString(signatureText)
		if err != nil || !ed25519.Verify(parsePublicKeyForTest(t, publicPEM), []byte(canonical), signature) {
			http.Error(w, "bad signature", http.StatusUnauthorized)
			return
		}
		if r.Header.Get("x-br-worker-runtime") != "go" {
			http.Error(w, "missing runtime header", http.StatusBadRequest)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		job := map[string]any{"type": "job", "job_id": "job_test", "operation": "workspace.exec", "payload": map[string]any{"command": testEchoCommand("go-worker-ok"), "cwd": root, "timeout_ms": 5000}, "timeout_ms": 5000}
		if err := conn.WriteJSON(job); err != nil {
			return
		}
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var result map[string]any
			if json.Unmarshal(raw, &result) != nil || result["type"] != "result" {
				continue
			}
			resultCh <- result
			break
		}
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "test-done"), time.Now().Add(time.Second))
	}))
	defer server.Close()

	cfg := Config{ServerURL: server.URL, WorkerName: "Go Test Worker", ProfileName: "Go Test", TmuxSession: "main", AllowedRoots: []string{root}, AllowShell: true, AllowInsecureHTTP: true, MaxJobMS: defaultMaxJobMS}
	state := State{PrivateKey: privatePEM, PublicKey: publicPEM, WorkerID: workerID, Name: "Go Test Worker", ServerURL: server.URL}
	if err := writeJSONAtomic(configPath(), &cfg); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(statePath(), &state); err != nil {
		t.Fatal(err)
	}

	agent, err := newAgent()
	if err != nil {
		t.Fatal(err)
	}
	_, err = agent.connectOnce()
	if err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-resultCh:
		if result["ok"] != true {
			t.Fatalf("job failed: %#v", result)
		}
		payload, _ := result["result"].(map[string]any)
		if strings.TrimSpace(payload["stdout"].(string)) != "go-worker-ok" {
			t.Fatalf("unexpected stdout: %#v", payload)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for worker result")
	}
}

func TestDirectWorkerShellUsesPersistentPTYWithoutTmux(t *testing.T) {
	root := t.TempDir()
	agent := &Agent{
		cfg:       Config{AllowShell: true},
		roots:     []string{root},
		maxJob:    10 * time.Second,
		processes: map[string]*managedProcess{},
		shells:    map[string]*shellSession{},
	}
	defer agent.shutdown()

	inspected, err := agent.executeOperation("shell.inspect", map[string]any{"session_key": "profile:test-direct-shell"})
	if err != nil {
		t.Fatal(err)
	}
	info := inspected.(map[string]any)
	if info["target_pane"] != "shell" || info["pane_count"] != 1 {
		t.Fatalf("unexpected shell inspection: %#v", info)
	}

	_, err = agent.executeOperation("shell.send", map[string]any{
		"session_key": "profile:test-direct-shell",
		"text":        testEchoCommand("__direct_shell_ok__"),
		"submit":      true,
	})
	if err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		read, err := agent.executeOperation("shell.read", map[string]any{"session_key": "profile:test-direct-shell", "lines": 50})
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(read.(map[string]any)["text"].(string), "__direct_shell_ok__") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("direct shell output not observed: %#v", read)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestStandaloneOperationsCoverFileArtifactAndProcessLifecycle(t *testing.T) {
	root := t.TempDir()
	agent := &Agent{
		cfg:       Config{AllowShell: true},
		roots:     []string{root},
		maxJob:    10 * time.Second,
		processes: map[string]*managedProcess{},
	}

	filePath := filepath.Join(root, "nested", "worker.txt")
	written, err := agent.executeOperation("file.write", map[string]any{"path": filePath, "content": "standalone-file\n", "create_dirs": true})
	if err != nil {
		t.Fatal(err)
	}
	if written.(map[string]any)["path"] != filePath {
		t.Fatalf("unexpected file.write result: %#v", written)
	}

	artifact, err := agent.executeOperation("artifact.collect", map[string]any{"path": filePath, "max_bytes": 1024 * 1024})
	if err != nil {
		t.Fatal(err)
	}
	artifactMap := artifact.(map[string]any)
	if artifactMap["text"] != "standalone-file\n" || artifactMap["is_text"] != true {
		t.Fatalf("unexpected artifact: %#v", artifactMap)
	}

	executed, err := agent.executeOperation("workspace.exec", map[string]any{"command": testEchoCommand("standalone-exec"), "cwd": root, "timeout_ms": 5000})
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(executed.(map[string]any)["stdout"].(string)) != "standalone-exec" {
		t.Fatalf("unexpected exec result: %#v", executed)
	}

	started, err := agent.executeOperation("process.start", map[string]any{"command": testProcessCommand(), "cwd": root})
	if err != nil {
		t.Fatal(err)
	}
	processID := started.(map[string]any)["process_id"].(string)
	deadline := time.Now().Add(3 * time.Second)
	for {
		status, err := agent.executeOperation("process.status", map[string]any{"process_id": processID, "lines": 20})
		if err != nil {
			t.Fatal(err)
		}
		statusMap := status.(map[string]any)
		if statusMap["state"] == "EXITED" {
			if !strings.Contains(statusMap["output_tail"].(string), "process-ok") {
				t.Fatalf("missing process output: %#v", statusMap)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("managed process did not exit")
		}
		time.Sleep(20 * time.Millisecond)
	}

	logs, err := agent.executeOperation("process.logs", map[string]any{"process_id": processID, "cursor": 0, "max_bytes": 1024})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(logs.(map[string]any)["text"].(string), "process-ok") {
		t.Fatalf("unexpected process logs: %#v", logs)
	}

	longRun, err := agent.executeOperation("process.start", map[string]any{"command": testLongCommand(), "cwd": root})
	if err != nil {
		t.Fatal(err)
	}
	longID := longRun.(map[string]any)["process_id"].(string)
	stopped, err := agent.executeOperation("process.stop", map[string]any{"process_id": longID, "grace_ms": 50, "force": true})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := stopped.(map[string]any)["forced"]; !ok {
		t.Fatalf("missing forced field: %#v", stopped)
	}
}

func TestStandaloneCleanupPlanRemovesOnlyInstallerManagedPaths(t *testing.T) {
	base := t.TempDir()
	userHome := filepath.Join(base, "user")
	t.Setenv("HOME", userHome)
	installRoot := filepath.Join(base, "share", "bot-report-worker")
	runtimeDir := filepath.Join(installRoot, "current")
	workerStateHome := filepath.Join(userHome, ".bot-report-worker")
	binDir := filepath.Join(userHome, ".local", "bin")
	binPath := filepath.Join(binDir, "bot-report-worker")
	if err := os.MkdirAll(runtimeDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(workerStateHome, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(binDir, 0755); err != nil {
		t.Fatal(err)
	}
	binaryPath := filepath.Join(runtimeDir, "bot-report-worker")
	if err := os.WriteFile(binaryPath, []byte("fixture"), 0755); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		binPath = binaryPath
	} else if err := os.Symlink(binaryPath, binPath); err != nil {
		t.Fatal(err)
	}
	aliasPath := filepath.Join(binDir, "systemtd")
	if runtime.GOOS != "windows" {
		if err := os.Symlink(binaryPath, aliasPath); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(workerStateHome, "install-root"), []byte(installRoot+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workerStateHome, "bin-path"), []byte(binPath+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workerStateHome, "config.json"), []byte(`{"tmux_created_by_worker":false}`), 0600); err != nil {
		t.Fatal(err)
	}

	plan, err := buildCleanupPlanFor(runtimeDir, workerStateHome)
	if err != nil {
		t.Fatal(err)
	}
	if plan.installRoot != installRoot || (runtime.GOOS != "windows" && !plan.removeBin) {
		t.Fatalf("unexpected cleanup plan: %#v", plan)
	}
	result, err := applyCleanupPlan(plan)
	if err != nil {
		t.Fatal(err)
	}
	if result["code"] != "UNINSTALLED" {
		t.Fatalf("unexpected cleanup result: %#v", result)
	}
	deadline := time.Now().Add(6 * time.Second)
	for _, target := range []string{workerStateHome, installRoot, binPath, aliasPath} {
		for {
			_, statErr := os.Lstat(target)
			if os.IsNotExist(statErr) {
				break
			}
			if runtime.GOOS != "windows" || time.Now().After(deadline) {
				t.Fatalf("expected removed path %s, got %v", target, statErr)
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
}

func TestResourceGuardStopsWorkerManagedProcessAndBlocksNewExecution(t *testing.T) {
	root := t.TempDir()
	agent := &Agent{
		cfg:       Config{AllowShell: true},
		roots:     []string{root},
		maxJob:    5 * time.Second,
		processes: map[string]*managedProcess{},
		commands:  map[int]*exec.Cmd{},
		shells:    map[string]*shellSession{},
	}
	started, err := agent.startManagedProcess(map[string]any{"command": testLongCommand(), "cwd": root})
	if err != nil {
		t.Fatal(err)
	}
	processID := started.(map[string]any)["process_id"].(string)
	time.Sleep(50 * time.Millisecond)
	stopped := agent.stopWorkerOwnedWorkloads()
	if stopped.ManagedProcesses != 1 {
		t.Fatalf("expected one managed process stopped, got %+v", stopped)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		status, statusErr := agent.processStatus(map[string]any{"process_id": processID, "lines": 10})
		if statusErr != nil {
			t.Fatal(statusErr)
		}
		if status.(map[string]any)["state"] == "EXITED" {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	agent.resourceEmergency.Store(true)
	_, err = agent.startManagedProcess(map[string]any{"command": testEchoCommand("should-not-run"), "cwd": root})
	if err == nil || errorCode(err) != "WORKER_MEMORY_EMERGENCY" {
		t.Fatalf("expected WORKER_MEMORY_EMERGENCY, got %v", err)
	}
	if !resourceGuardBlocksOperation("workspace.exec") || !resourceGuardBlocksOperation("process.start") || resourceGuardBlocksOperation("process.status") {
		t.Fatal("resource emergency operation policy is incorrect")
	}
}

func TestTaskScopedMemoryGuardDecisions(t *testing.T) {
	high := memorySnapshot{TotalBytes: 1000, AvailableBytes: 50}
	low := memorySnapshot{TotalBytes: 1000, AvailableBytes: 101}

	if !resourceGuardShouldRejectStart(high) {
		t.Fatal("task start at 95% RAM must be rejected")
	}
	if resourceGuardShouldRejectStart(low) {
		t.Fatal("task start below 90% RAM must be allowed")
	}
	if resourceGuardShouldStopActiveTask(false, high) {
		t.Fatal("idle Worker must ignore high host RAM")
	}
	if !resourceGuardShouldStopActiveTask(true, high) {
		t.Fatal("active Worker task must stop at 90%+ RAM")
	}
	if resourceGuardShouldStopActiveTask(true, low) {
		t.Fatal("active Worker task below 90% RAM must continue")
	}
	if resourceGuardBlocksOperation("file.write") || resourceGuardBlocksOperation("process.stop") || resourceGuardBlocksOperation("shell.read") {
		t.Fatal("recovery/read operations must remain available during high RAM")
	}
	if !resourceGuardBlocksOperation("workspace.exec") || !resourceGuardBlocksOperation("process.start") || !resourceGuardBlocksOperation("shell.send") {
		t.Fatal("execution operations must use RAM preflight")
	}
}

func TestPlatformMemorySnapshotIsSane(t *testing.T) {
	snapshot, err := platformMemorySnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.TotalBytes == 0 || snapshot.AvailableBytes > snapshot.TotalBytes {
		t.Fatalf("invalid memory snapshot: %+v", snapshot)
	}
	used := snapshot.usedPercent()
	if used < 0 || used > 100 {
		t.Fatalf("invalid used percent: %f", used)
	}
}
