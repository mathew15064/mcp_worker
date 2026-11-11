//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"time"
)

func platformStartManagedService() error {
	args := []string{"start", "systemtd.service"}
	var cmd *exec.Cmd
	if os.Geteuid() == 0 {
		cmd = exec.Command("systemctl", args...)
	} else {
		cmd = exec.Command("sudo", append([]string{"-n", "systemctl"}, args...)...)
	}
	if output, err := cmd.CombinedOutput(); err != nil {
		return fail("WORKER_SERVICE_START_FAILED", fmt.Sprintf("Unable to start systemtd.service: %s", string(output)))
	}
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if pid := clearStalePID(); pid != 0 {
			fmt.Printf("[systemtd] service started pid=%d\n", pid)
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fail("WORKER_SERVICE_START_FAILED", "systemtd.service started but Worker PID was not observed within 8 seconds.")
}

func platformRestartManagedService() error {
	oldPID := clearStalePID()
	if oldPID == 0 {
		return platformStartManagedService()
	}
	args := []string{"kill", "--kill-who=main", "--signal=TERM", "systemtd.service"}
	var cmd *exec.Cmd
	if os.Geteuid() == 0 {
		cmd = exec.Command("systemctl", args...)
	} else {
		cmd = exec.Command("sudo", append([]string{"-n", "systemctl"}, args...)...)
	}
	if output, err := cmd.CombinedOutput(); err != nil {
		return fail("WORKER_SERVICE_RESTART_FAILED", fmt.Sprintf("Unable to restart systemtd.service: %s", string(output)))
	}
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		pid := clearStalePID()
		if pid != 0 && pid != oldPID {
			fmt.Printf("[systemtd] service restarted old_pid=%d pid=%d\n", oldPID, pid)
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fail("WORKER_SERVICE_RESTART_FAILED", "systemtd.service did not restart with a new PID within 12 seconds.")
}
