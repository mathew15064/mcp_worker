//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

func platformStartManagedService() error {
	if err := serviceSystemctl("start"); err != nil {
		return err
	}
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if pid := clearStalePID(); pid != 0 {
			fmt.Printf("[worker_mcp] service started pid=%d\n", pid)
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fail("WORKER_SERVICE_START_FAILED", "worker_mcp.service started but Worker PID was not observed within 8 seconds.")
}

func platformRestartManagedService() error {
	oldPID := clearStalePID()
	if oldPID == 0 {
		return platformStartManagedService()
	}
	if err := serviceSystemctl("restart"); err != nil {
		return err
	}
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		pid := clearStalePID()
		if pid != 0 && pid != oldPID {
			fmt.Printf("[worker_mcp] service restarted old_pid=%d pid=%d\n", oldPID, pid)
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fail("WORKER_SERVICE_RESTART_FAILED", "worker_mcp.service did not restart with a new PID within 12 seconds.")
}

// platformManageService deliberately operates only on installer-managed units.
// Installing the unit remains the signed installer's responsibility: the CLI
// must not silently trust or install an unverified executable.
func platformManageService(action string) error {
	if !serviceManaged() {
		return fail("WORKER_SERVICE_NOT_INSTALLED", "Install the signed Linux Worker with MCP_WORKER_WORKER_SYSTEMD=1 first; existing manual Workers must be migrated by the verified installer.")
	}
	switch action {
	case "start":
		return platformStartManagedService()
	case "restart":
		return platformRestartManagedService()
	case "stop":
		return serviceSystemctl("stop")
	case "status":
		cmd := exec.Command("systemctl", "show", "worker_mcp.service", "--property=ActiveState,SubState,MainPID,UnitFileState", "--no-pager")
		output, err := cmd.CombinedOutput()
		if err != nil {
			return fail("WORKER_SERVICE_STATUS_FAILED", strings.TrimSpace(string(output)))
		}
		fmt.Print(string(output))
		return nil
	case "logs":
		cmd := exec.Command("journalctl", "--unit=worker_mcp.service", "--lines=80", "--no-pager", "--output=short-iso")
		output, err := cmd.CombinedOutput()
		if err != nil {
			return fail("WORKER_SERVICE_LOGS_FAILED", strings.TrimSpace(string(output)))
		}
		fmt.Print(string(output))
		return nil
	default:
		return fail("CLI_ARGUMENT_INVALID", "Usage: worker_mcp service <status|start|stop|restart|logs>. Install with the verified signed Linux installer and MCP_WORKER_WORKER_SYSTEMD=1.")
	}
}

func serviceSystemctl(action string) error {
	args := []string{action, "worker_mcp.service"}
	var cmd *exec.Cmd
	if os.Geteuid() == 0 {
		cmd = exec.Command("systemctl", args...)
	} else {
		cmd = exec.Command("sudo", append([]string{"-n", "systemctl"}, args...)...)
	}
	if output, err := cmd.CombinedOutput(); err != nil {
		return fail("WORKER_SERVICE_"+strings.ToUpper(action)+"_FAILED", strings.TrimSpace(string(output)))
	}
	return nil
}
