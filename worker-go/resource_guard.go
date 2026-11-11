package main

import (
	"fmt"
	"os/exec"
	"time"
)

const (
	workerMemoryEmergencyPercent = 90.0
	workerMemorySampleInterval   = 500 * time.Millisecond
)

type memorySnapshot struct {
	TotalBytes     uint64
	AvailableBytes uint64
}

func (m memorySnapshot) usedPercent() float64 {
	if m.TotalBytes == 0 {
		return 0
	}
	available := m.AvailableBytes
	if available > m.TotalBytes {
		available = m.TotalBytes
	}
	return float64(m.TotalBytes-available) * 100 / float64(m.TotalBytes)
}

type stoppedWorkloads struct {
	WorkspaceCommands int `json:"workspace_commands"`
	ManagedProcesses  int `json:"managed_processes"`
	ShellSessions     int `json:"shell_sessions"`
}

func resourceGuardBlocksOperation(operation string) bool {
	switch operation {
	case "workspace.exec", "process.start", "shell.send", "tmux.send":
		return true
	default:
		return false
	}
}

func resourceGuardShouldRejectStart(snapshot memorySnapshot) bool {
	return snapshot.TotalBytes > 0 && snapshot.usedPercent() >= workerMemoryEmergencyPercent
}

func resourceGuardShouldStopActiveTask(hasActiveTask bool, snapshot memorySnapshot) bool {
	return hasActiveTask && resourceGuardShouldRejectStart(snapshot)
}

func (a *Agent) resourceEmergencyError() error {
	return fail("WORKER_MEMORY_EMERGENCY", fmt.Sprintf("Current Worker task was stopped because host RAM reached the hard limit of %.0f%%.", workerMemoryEmergencyPercent))
}

func taskStartMemoryError(snapshot memorySnapshot) error {
	return fail("WORKER_MEMORY_EMERGENCY", fmt.Sprintf("Worker task was not started because host RAM is %.1f%%, at or above the hard limit of %.0f%%.", snapshot.usedPercent(), workerMemoryEmergencyPercent))
}

func (a *Agent) trackWorkspaceCommand(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	a.commandMu.Lock()
	if a.commands == nil {
		a.commands = map[int]*exec.Cmd{}
	}
	a.commands[cmd.Process.Pid] = cmd
	a.commandMu.Unlock()
}

func (a *Agent) untrackWorkspaceCommand(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	a.commandMu.Lock()
	delete(a.commands, cmd.Process.Pid)
	a.commandMu.Unlock()
}

func (a *Agent) hasActiveWorkerTask() bool {
	a.commandMu.Lock()
	hasCommand := len(a.commands) > 0
	a.commandMu.Unlock()
	if hasCommand {
		return true
	}

	a.processMu.RLock()
	processes := make([]*managedProcess, 0, len(a.processes))
	for _, record := range a.processes {
		processes = append(processes, record)
	}
	a.processMu.RUnlock()
	for _, record := range processes {
		record.mu.RLock()
		running := record.exitedAt == ""
		record.mu.RUnlock()
		if running {
			return true
		}
	}

	return false
}

func (a *Agent) stopWorkerOwnedWorkloads() stoppedWorkloads {
	stopped := stoppedWorkloads{}

	a.commandMu.Lock()
	commands := make([]*exec.Cmd, 0, len(a.commands))
	for _, cmd := range a.commands {
		commands = append(commands, cmd)
	}
	a.commandMu.Unlock()
	for _, cmd := range commands {
		if cmd != nil && cmd.Process != nil {
			_ = platformTerminateWorkload(cmd, true)
			stopped.WorkspaceCommands++
		}
	}

	a.processMu.RLock()
	processes := make([]*managedProcess, 0, len(a.processes))
	for _, record := range a.processes {
		processes = append(processes, record)
	}
	a.processMu.RUnlock()
	for _, record := range processes {
		record.mu.RLock()
		running := record.exitedAt == ""
		pid := record.pid
		record.mu.RUnlock()
		if running && pid > 1 {
			_ = platformTerminateWorkload(record.cmd, true)
			stopped.ManagedProcesses++
		}
	}

	return stopped
}

func (a *Agent) sendResourceAlert(socket *safeSocket, code, severity, phase string, snapshot memorySnapshot, stopped stoppedWorkloads) {
	if socket == nil {
		return
	}
	_ = socket.sendJSON(map[string]any{
		"type":                   "resource_alert",
		"code":                   code,
		"severity":               severity,
		"phase":                  phase,
		"worker_id":              a.state.WorkerID,
		"worker_name":            a.state.Name,
		"memory_used_percent":    snapshot.usedPercent(),
		"memory_total_bytes":     snapshot.TotalBytes,
		"memory_available_bytes": snapshot.AvailableBytes,
		"threshold_percent":      workerMemoryEmergencyPercent,
		"stopped":                stopped,
		"at":                     time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func (a *Agent) guardTaskStart(socket *safeSocket, operation string) error {
	if !resourceGuardBlocksOperation(operation) {
		return nil
	}
	snapshot, err := platformMemorySnapshot()
	if err != nil || snapshot.TotalBytes == 0 {
		return nil
	}
	if resourceGuardShouldRejectStart(snapshot) {
		fmt.Fprintf(a.logOutput(), "[WORKER] task rejected by RAM guard operation=%s used=%.1f%% threshold=%.0f%%\n", operation, snapshot.usedPercent(), workerMemoryEmergencyPercent)
		a.sendResourceAlert(socket, "WORKER_MEMORY_EMERGENCY", "critical", "task_start", snapshot, stoppedWorkloads{})
		return taskStartMemoryError(snapshot)
	}
	// A previous task may have been killed while memory was high. Once a new
	// task passes the real-time preflight, there is no persistent hysteresis.
	a.resourceEmergency.Store(false)
	return nil
}

func (a *Agent) monitorMemoryPressure(socket *safeSocket, done <-chan struct{}) {
	check := func() {
		hasActiveTask := a.hasActiveWorkerTask()
		if !hasActiveTask {
			// High host RAM while the Worker is idle is intentionally ignored.
			a.resourceEmergency.Store(false)
			return
		}
		snapshot, err := platformMemorySnapshot()
		if err != nil || snapshot.TotalBytes == 0 {
			return
		}
		if resourceGuardShouldStopActiveTask(true, snapshot) {
			if a.resourceEmergency.CompareAndSwap(false, true) {
				stopped := a.stopWorkerOwnedWorkloads()
				fmt.Fprintf(a.logOutput(), "[WORKER] MEMORY EMERGENCY active_task used=%.1f%% threshold=%.0f%% stopped_workspace=%d stopped_process=%d\n", snapshot.usedPercent(), workerMemoryEmergencyPercent, stopped.WorkspaceCommands, stopped.ManagedProcesses)
				a.sendResourceAlert(socket, "WORKER_MEMORY_EMERGENCY", "critical", "task_running", snapshot, stopped)
			}
			return
		}
		// No hysteresis: below 90% is immediately eligible for the next task.
		a.resourceEmergency.Store(false)
	}

	ticker := time.NewTicker(workerMemorySampleInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			check()
		case <-done:
			return
		}
	}
}
