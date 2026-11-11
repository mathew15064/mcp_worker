//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

type workloadScopeMode int

const (
	workloadScopeNone workloadScopeMode = iota
	workloadScopeDirect
	workloadScopeSudo
)

var (
	workloadScopeOnce       sync.Once
	workloadScopeModeCached workloadScopeMode
	workloadSystemdRunPath  string
	workloadSudoPath        string
)

var workloadKindRE = regexp.MustCompile(`[^a-z0-9-]+`)

func sanitizeWorkloadKind(kind string) string {
	kind = strings.ToLower(strings.TrimSpace(kind))
	kind = workloadKindRE.ReplaceAllString(kind, "-")
	kind = strings.Trim(kind, "-")
	if kind == "" {
		return "task"
	}
	if len(kind) > 24 {
		kind = kind[:24]
	}
	return kind
}

func scopeProbeArgs(unit string) []string {
	return []string{"--scope", "--quiet", "--collect", "--unit=" + unit, "/bin/true"}
}

func detectWorkloadScopeMode() {
	if os.Getenv("BOT_REPORT_WORKER_DISABLE_SYSTEMD_SCOPES") == "1" || !serviceManaged() {
		return
	}
	systemdRun, err := exec.LookPath("systemd-run")
	if err != nil {
		return
	}
	workloadSystemdRunPath = systemdRun
	if os.Geteuid() == 0 {
		workloadScopeModeCached = workloadScopeDirect
		return
	}
	probe := "systemtd-scope-probe-" + randomHex(4)
	if exec.Command(systemdRun, scopeProbeArgs(probe)...).Run() == nil {
		workloadScopeModeCached = workloadScopeDirect
		return
	}
	sudoPath, err := exec.LookPath("sudo")
	if err != nil {
		return
	}
	args := []string{"-n", "-E", systemdRun}
	args = append(args, "--scope", "--quiet", "--collect", "--unit="+probe+"-sudo", "--uid="+strconv.Itoa(os.Getuid()), "--gid="+strconv.Itoa(os.Getgid()), "/bin/true")
	if exec.Command(sudoPath, args...).Run() == nil {
		workloadSudoPath = sudoPath
		workloadScopeModeCached = workloadScopeSudo
	}
}

func workloadScopeConfig() (workloadScopeMode, string, string) {
	workloadScopeOnce.Do(detectWorkloadScopeMode)
	return workloadScopeModeCached, workloadSystemdRunPath, workloadSudoPath
}

func essentialScopeEnvironmentArgs() []string {
	keys := []string{"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM"}
	args := make([]string, 0, len(keys))
	for _, key := range keys {
		if value := os.Getenv(key); value != "" {
			args = append(args, "--setenv="+key+"="+value)
		}
	}
	return args
}

func platformWorkloadInvocation(kind, target string, targetArgs []string) (string, []string) {
	mode, systemdRun, sudoPath := workloadScopeConfig()
	if mode == workloadScopeNone {
		return target, targetArgs
	}
	unit := fmt.Sprintf("systemtd-%s-%s", sanitizeWorkloadKind(kind), randomHex(6))
	scopeArgs := []string{"--scope", "--quiet", "--collect", "--unit=" + unit}
	if mode == workloadScopeSudo {
		scopeArgs = append(scopeArgs, "--uid="+strconv.Itoa(os.Getuid()), "--gid="+strconv.Itoa(os.Getgid()))
		scopeArgs = append(scopeArgs, essentialScopeEnvironmentArgs()...)
		args := []string{"-n", "-E", systemdRun}
		args = append(args, scopeArgs...)
		args = append(args, target)
		args = append(args, targetArgs...)
		return sudoPath, args
	}
	scopeArgs = append(scopeArgs, target)
	scopeArgs = append(scopeArgs, targetArgs...)
	return systemdRun, scopeArgs
}

func workloadUnitFromCommand(cmd *exec.Cmd) string {
	if cmd == nil {
		return ""
	}
	for _, arg := range cmd.Args {
		if strings.HasPrefix(arg, "--unit=systemtd-") {
			return strings.TrimPrefix(arg, "--unit=") + ".scope"
		}
	}
	return ""
}

func systemctlWorkloadKill(unit, signalName string) error {
	if unit == "" {
		return fmt.Errorf("missing workload unit")
	}
	args := []string{"kill", "--kill-who=all", "--signal=" + signalName, unit}
	if err := exec.Command("systemctl", args...).Run(); err == nil {
		return nil
	}
	if sudoPath, err := exec.LookPath("sudo"); err == nil {
		if err := exec.Command(sudoPath, append([]string{"-n", "systemctl"}, args...)...).Run(); err == nil {
			return nil
		}
	}
	return fmt.Errorf("unable to signal workload scope %s", unit)
}

func platformTerminateWorkload(cmd *exec.Cmd, force bool) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	if unit := workloadUnitFromCommand(cmd); unit != "" {
		signalName := "TERM"
		if force {
			signalName = "KILL"
		}
		if err := systemctlWorkloadKill(unit, signalName); err == nil {
			return nil
		}
	}
	if force {
		return platformTerminateProcessTree(cmd.Process.Pid)
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM); err == nil || err == syscall.ESRCH {
		return nil
	}
	return terminateProcess(cmd.Process, false)
}

func platformWorkloadIsolationStatus() string {
	mode, _, _ := workloadScopeConfig()
	switch mode {
	case workloadScopeDirect:
		return "systemd-scope"
	case workloadScopeSudo:
		return "systemd-scope-sudo"
	default:
		return "process-group-fallback"
	}
}
