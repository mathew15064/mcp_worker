package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func captureStdout(t *testing.T, fn func() error) (string, error) {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	defer func() { os.Stdout = old }()
	e := fn()
	_ = w.Close()
	data, _ := io.ReadAll(r)
	_ = r.Close()
	return string(data), e
}

func TestStandaloneSubcommands(t *testing.T) {
	for _, tc := range []struct {
		args         []string
		command, sub string
		valid        bool
	}{
		{[]string{"setup", "--no-start"}, "setup", "", true},
		{[]string{"config", "show"}, "config", "show", true},
		{[]string{"connection", "test"}, "connection", "test", true},
		{[]string{"config", "show", "unexpected"}, "", "", false},
	} {
		cmd, opt, err := parseArgs(tc.args)
		if (err == nil) != tc.valid || (tc.valid && (cmd != tc.command || opt["subcommand"] != tc.sub)) {
			t.Errorf("%v got cmd=%q opt=%v err=%v", tc.args, cmd, opt, err)
		}
	}
}

func TestShowConfigNeverPrintsIdentitySecrets(t *testing.T) {
	t.Setenv("MCP_WORKER_WORKER_HOME", t.TempDir())
	state := State{PrivateKey: "PRIVATE_SECRET_MARKER", PublicKey: "PUBLIC_MARKER", WorkerID: "id"}
	if err := writeJSONAtomic(statePath(), state); err != nil {
		t.Fatal(err)
	}
	cfg := Config{ServerURL: "https://example.com", WorkerName: "example", ProfileName: "main"}
	if err := writeJSONAtomic(configPath(), cfg); err != nil {
		t.Fatal(err)
	}
	output, err := captureStdout(t, showConfig)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "https://example.com") || strings.Contains(output, "SECRET_MARKER") || strings.Contains(output, "PUBLIC_MARKER") {
		t.Fatalf("unexpected config output: %q", output)
	}
}

func TestConnectionReadinessNotClaimedOnline(t *testing.T) {
	t.Setenv("MCP_WORKER_WORKER_HOME", filepath.Join(t.TempDir(), "worker"))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" && r.URL.Path != "/readyz" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()
	if err := writeJSONAtomic(configPath(), Config{ServerURL: server.URL, AllowInsecureHTTP: true}); err != nil {
		t.Fatal(err)
	}
	output, err := captureStdout(t, testConnection)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "NOT verified") || !strings.Contains(output, "/readyz: reachable") {
		t.Fatalf("connection falsely claimed online: %q", output)
	}
	if err := writeJSONAtomic(configPath(), Config{ServerURL: "http://example.com"}); err != nil {
		t.Fatal(err)
	}
	_, err = captureStdout(t, testConnection)
	if errorCode(err) != "WORKER_TLS_REQUIRED" {
		t.Fatalf("expected TLS error, got %v", err)
	}
}

func TestOfflineHelpReadable(t *testing.T) {
	cmd, _, err := parseArgs([]string{"--help"})
	if err != nil || cmd != "help" {
		t.Fatal(cmd, err)
	}
}

func TestReEnrollRequiresConfirmationAndPreservesExistingIdentityOnFailure(t *testing.T) {
	home := filepath.Join(t.TempDir(), "worker")
	t.Setenv("MCP_WORKER_WORKER_HOME", home)
	old := State{WorkerID: "worker-old", ServerURL: "https://old.example.test", PrivateKey: "private-old"}
	if err := writeJSONAtomic(statePath(), old); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(configPath(), Config{ServerURL: old.ServerURL}); err != nil {
		t.Fatal(err)
	}
	if errorCode(reEnroll(cliOptions{})) != "WORKER_REENROLL_CONFIRM_REQUIRED" {
		t.Fatal("missing approval accepted")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "reject enrollment", http.StatusUnauthorized)
	}))
	defer server.Close()
	err := reEnroll(cliOptions{"confirm": "true", "server": server.URL, "insecure-http": "true", "token": "br_enroll_fixture", "no-start": "true"})
	if err == nil {
		t.Fatal("failed enrollment accepted")
	}
	var saved State
	if ok, readErr := readJSON(statePath(), &saved); readErr != nil || !ok || saved.WorkerID != "worker-old" || saved.PrivateKey != "private-old" {
		t.Fatalf("previous identity lost: %v %+v", readErr, saved)
	}
}

func TestRemoteInsecureHTTPAndCredentialsRejected(t *testing.T) {
	for _, target := range []string{"http://remote.example.test", "http://remote.example.test:3333", "https://user:pass@remote.example.test"} {
		if _, err := validateServerURL(target, true); err == nil {
			t.Errorf("unsafe URL accepted: %s", target)
		}
	}
	if _, err := validateServerURL("http://127.0.0.1:3333", true); err != nil {
		t.Fatal(err)
	}
}
