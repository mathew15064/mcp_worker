//go:build linux || darwin

package main

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"

	"github.com/creack/pty"
)

type unixTerminal struct{ file *os.File }

func (t *unixTerminal) Read(p []byte) (int, error)  { return t.file.Read(p) }
func (t *unixTerminal) Write(p []byte) (int, error) { return t.file.Write(p) }
func (t *unixTerminal) Close() error                { return t.file.Close() }
func (t *unixTerminal) Resize(cols, rows int) error {
	return pty.Setsize(t.file, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

func platformProcessAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
func configureDetachedProcess(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
func terminatePID(pid int, force bool) error {
	if force {
		return syscall.Kill(pid, syscall.SIGKILL)
	}
	return syscall.Kill(pid, syscall.SIGTERM)
}
func terminateProcess(process *os.Process, force bool) error {
	if process == nil {
		return nil
	}
	if force {
		return process.Kill()
	}
	return process.Signal(syscall.SIGTERM)
}
func platformTerminateProcessTree(pid int) error {
	if pid <= 1 {
		return nil
	}
	if err := syscall.Kill(-pid, syscall.SIGKILL); err == nil || errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return syscall.Kill(pid, syscall.SIGKILL)
}
func platformProcessSignal(state *os.ProcessState) (string, bool) {
	if state == nil {
		return "", false
	}
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return status.Signal().String(), true
	}
	return "", false
}
func platformShutdownSignals() []os.Signal { return []os.Signal{os.Interrupt, syscall.SIGTERM} }
func platformShellCommand(command, workloadKind string) *exec.Cmd {
	name, args := platformWorkloadInvocation(workloadKind, "/bin/sh", []string{"-lc", command})
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd
}
func platformShellCommandContext(ctx context.Context, command, workloadKind string) *exec.Cmd {
	name, args := platformWorkloadInvocation(workloadKind, "/bin/sh", []string{"-lc", command})
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd
}
func preferredShell() string {
	candidates := []string{strings.TrimSpace(os.Getenv("SHELL")), "/bin/bash", "/bin/zsh", "/bin/sh"}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if strings.Contains(candidate, string(os.PathSeparator)) {
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0111 != 0 {
				return candidate
			}
			continue
		}
		if resolved, err := exec.LookPath(candidate); err == nil {
			return resolved
		}
	}
	return "/bin/sh"
}
func startInteractiveShell(cwd string, cols, rows int, workloadKind string) (*exec.Cmd, shellTerminal, string, error) {
	shellPath := preferredShell()
	name, args := platformWorkloadInvocation(workloadKind, shellPath, []string{"-i"})
	cmd := exec.Command(name, args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, nil, "", err
	}
	return cmd, &unixTerminal{file: ptmx}, shellPath, nil
}

var _ io.ReadWriter = (*unixTerminal)(nil)

func platformPrepareUninstall(installRoot string) error  { return nil }
func platformRemoveInstallRoot(installRoot string) error { return os.RemoveAll(installRoot) }
