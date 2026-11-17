package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Re-enrollment is staged: failed enrollment leaves the existing identity untouched.
// The old identity is retained in an owner-private directory for explicit recovery.
func reEnroll(options cliOptions) error {
	if options["confirm"] != "true" {
		return fail("WORKER_REENROLL_CONFIRM_REQUIRED", "Re-enrollment changes Worker identity; rerun with --confirm.")
	}
	if clearStalePID() != 0 || serviceManaged() {
		return fail("WORKER_REENROLL_RUNNING", "Stop the Worker/service before changing identity.")
	}
	var previous State
	ok, err := readJSON(statePath(), &previous)
	if err != nil {
		return err
	}
	if !ok || previous.WorkerID == "" {
		return fail("WORKER_NOT_CONFIGURED", "Run mcp_worker setup first.")
	}
	home := workerHome()
	temp, err := os.MkdirTemp(filepath.Dir(home), ".worker-reenroll-")
	if err != nil {
		return err
	}
	_ = os.Chmod(temp, 0700)
	defer os.RemoveAll(temp)
	originalEnv, hadEnv := os.LookupEnv("MCP_WORKER_WORKER_HOME")
	defer func() {
		if hadEnv {
			_ = os.Setenv("MCP_WORKER_WORKER_HOME", originalEnv)
		} else {
			_ = os.Unsetenv("MCP_WORKER_WORKER_HOME")
		}
	}()
	_ = os.Setenv("MCP_WORKER_WORKER_HOME", temp)
	staged := cliOptions{}
	for k, v := range options {
		staged[k] = v
	}
	staged["no-start"] = "true"
	// Do not inherit the old default-server implicitly when changing hosts.
	if staged["server"] == "" {
		staged["server"] = previous.ServerURL
	}
	err = login(staged)
	if err != nil {
		return err
	}
	_ = os.Setenv("MCP_WORKER_WORKER_HOME", home)
	backup := filepath.Join(home, "identity-backup-"+time.Now().UTC().Format("20060102T150405")+"-"+randomHex(4))
	if err = os.Mkdir(backup, 0700); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(backup)
		}
	}()
	// Preserve all prior configuration and keys without copying token data.
	for _, file := range []string{"config.json", "state.json"} {
		data, readErr := os.ReadFile(filepath.Join(home, file))
		if readErr != nil {
			return readErr
		}
		if err = os.WriteFile(filepath.Join(backup, file), data, 0600); err != nil {
			return err
		}
	}
	newConfig, err := os.ReadFile(filepath.Join(temp, "config.json"))
	if err != nil {
		return err
	}
	newState, err := os.ReadFile(filepath.Join(temp, "state.json"))
	if err != nil {
		return err
	}
	// Old pair is recoverable; if the second write fails, restore both previous files.
	if err = writeJSONBytesAtomic(configPath(), newConfig); err != nil {
		return err
	}
	if err = writeJSONBytesAtomic(statePath(), newState); err != nil {
		oldConfig, _ := os.ReadFile(filepath.Join(backup, "config.json"))
		_ = writeJSONBytesAtomic(configPath(), oldConfig)
		return err
	}
	committed = true
	fmt.Println("re-enrolled; previous identity saved locally in:", backup)
	fmt.Println("run mcp_worker start to connect; revoke old Worker identity in Admin when ready")
	return nil
}

func writeJSONBytesAtomic(dest string, content []byte) error {
	if !json.Valid(content) {
		return errors.New("invalid staged identity JSON")
	}
	temp := dest + "." + randomHex(8) + ".tmp"
	if err := os.WriteFile(temp, content, 0600); err != nil {
		return err
	}
	if err := os.Rename(temp, dest); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return nil
}
