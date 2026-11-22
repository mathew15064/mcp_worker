//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestManagedServiceCommandsRequireInstallerMarker(t *testing.T) {
	t.Setenv("MCP_WORKER_WORKER_HOME", t.TempDir())
	for _, action := range []string{"status", "start", "stop", "restart", "logs", "install"} {
		if err := platformManageService(action); err == nil || errorCode(err) != "WORKER_SERVICE_NOT_INSTALLED" {
			t.Fatalf("%s must not manage an unverified systemd unit: %v", action, err)
		}
	}
}

func TestManagedServiceStatusAndLogsUseSystemToolsWithoutModification(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MCP_WORKER_WORKER_HOME", home)
	if err := os.WriteFile(filepath.Join(home, "service-mode"), []byte("systemd\n"), 0600); err != nil {
		t.Fatal(err)
	}
	binDir := t.TempDir()
	callLog := filepath.Join(binDir, "calls.log")
	t.Setenv("TEST_SERVICE_CALLS", callLog)
	script := "#!/bin/sh\nprintf '%s %s\\n' \"$(basename \"$0\")\" \"$*\" >> \"$TEST_SERVICE_CALLS\"\nprintf 'OK\\n'\n"
	for _, name := range []string{"systemctl", "journalctl"} {
		if err := os.WriteFile(filepath.Join(binDir, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	if err := platformManageService("status"); err != nil {
		t.Fatalf("status: %v", err)
	}
	if err := platformManageService("logs"); err != nil {
		t.Fatalf("logs: %v", err)
	}
	if err := platformManageService("stop"); err != nil {
		t.Fatalf("stop: %v", err)
	}
	calls, err := os.ReadFile(callLog)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"systemctl show worker_mcp.service", "journalctl --unit=worker_mcp.service", "systemctl stop worker_mcp.service"} {
		if !strings.Contains(string(calls), expected) {
			t.Fatalf("missing %s in %s", expected, calls)
		}
	}
	if err := platformManageService("uninstall"); err == nil || !strings.Contains(err.Error(), "Usage") {
		t.Fatalf("invalid subcommand must fail closed: %v", err)
	}
}

func TestServiceSubcommandArgumentParsing(t *testing.T) {
	cmd, opts, err := parseArgs([]string{"service", "status"})
	if err != nil || cmd != "service" || opts["action"] != "status" {
		t.Fatalf("parse service status: %q %v %v", cmd, opts, err)
	}
	if _, _, err := parseArgs([]string{"start", "status"}); err == nil {
		t.Fatal("other CLI commands must reject extra positional arguments")
	}
	if _, _, err := parseArgs([]string{"service", "stop", "extra"}); err == nil {
		t.Fatal("service command must reject unexpected positional arguments")
	}
}
