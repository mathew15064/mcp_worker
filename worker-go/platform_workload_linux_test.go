//go:build linux

package main

import (
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

func resetWorkloadScopeDetectionForTest() {
	workloadScopeOnce = sync.Once{}
	workloadScopeModeCached = workloadScopeNone
	workloadSystemdRunPath = ""
	workloadSudoPath = ""
}

func TestSanitizeWorkloadKind(t *testing.T) {
	cases := map[string]string{
		"workspace":                            "workspace",
		" Process Start ":                      "process-start",
		"SHELL///ATTACH":                       "shell-attach",
		"":                                     "task",
		"abcdefghijklmnopqrstuvwxyz0123456789": "abcdefghijklmnopqrstuvwx",
	}
	for input, expected := range cases {
		if got := sanitizeWorkloadKind(input); got != expected {
			t.Fatalf("sanitizeWorkloadKind(%q)=%q, want %q", input, got, expected)
		}
	}
}

func TestManagedLinuxWorkloadRunsInSiblingSystemdScopeWhenAvailable(t *testing.T) {
	home := t.TempDir()
	t.Setenv("BOT_REPORT_WORKER_HOME", home)
	if err := os.WriteFile(serviceModePath(), []byte("systemd\n"), 0600); err != nil {
		t.Fatal(err)
	}
	resetWorkloadScopeDetectionForTest()
	defer resetWorkloadScopeDetectionForTest()

	mode, _, _ := workloadScopeConfig()
	if mode == workloadScopeNone {
		t.Skip("systemd scope creation is unavailable in this test environment")
	}
	cmd := platformShellCommand("cat /proc/self/cgroup", "workspace")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("scoped command failed: %v: %s", err, output)
	}
	if !strings.Contains(string(output), "systemtd-workspace-") || !strings.Contains(string(output), ".scope") {
		t.Fatalf("command did not enter a systemtd workload scope: %s", output)
	}
	if unit := workloadUnitFromCommand(cmd); !strings.HasPrefix(unit, "systemtd-workspace-") || !strings.HasSuffix(unit, ".scope") {
		t.Fatalf("unexpected workload unit %q", unit)
	}
}

func TestManagedScopeWorkspaceTimeout(t *testing.T) {
	home := t.TempDir()
	t.Setenv("BOT_REPORT_WORKER_HOME", home)
	if err := os.WriteFile(serviceModePath(), []byte("systemd\n"), 0600); err != nil {
		t.Fatal(err)
	}
	resetWorkloadScopeDetectionForTest()
	defer resetWorkloadScopeDetectionForTest()
	mode, _, _ := workloadScopeConfig()
	if mode == workloadScopeNone {
		t.Skip("systemd scope creation unavailable")
	}
	a := &Agent{cfg: Config{AllowShell: true}, roots: []string{home}, commands: map[int]*exec.Cmd{}}
	started := time.Now()
	_, err := a.runShell("sleep 3 & wait", home, 200*time.Millisecond, 1024)
	if err == nil || errorCode(err) != "WORKER_JOB_TIMEOUT" {
		t.Fatalf("expected scoped timeout: %v", err)
	}
	if time.Since(started) > 2*time.Second {
		t.Fatalf("scope timeout took %s", time.Since(started))
	}
}
