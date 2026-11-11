//go:build windows

package main

import "os/exec"

func platformTerminateWorkload(cmd *exec.Cmd, force bool) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	if force {
		return platformTerminateProcessTree(cmd.Process.Pid)
	}
	return terminateProcess(cmd.Process, false)
}

func platformWorkloadIsolationStatus() string { return "process-group" }
