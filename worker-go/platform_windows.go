//go:build windows

package main

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

type windowsTerminal struct {
	reader *io.PipeReader
	writer *io.PipeWriter
	stdin  io.WriteCloser
	once   sync.Once
}

func (t *windowsTerminal) Read(p []byte) (int, error)  { return t.reader.Read(p) }
func (t *windowsTerminal) Write(p []byte) (int, error) { return t.stdin.Write(p) }
func (t *windowsTerminal) Resize(cols, rows int) error { return nil }
func (t *windowsTerminal) Close() error {
	var err error
	t.once.Do(func() {
		_ = t.stdin.Close()
		_ = t.writer.Close()
		err = t.reader.Close()
	})
	return err
}

func platformProcessAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	status, err := windows.WaitForSingleObject(h, 0)
	return err == nil && status == uint32(windows.WAIT_TIMEOUT)
}
func configureDetachedProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS}
}
func terminatePID(pid int, force bool) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}
func terminateProcess(process *os.Process, force bool) error {
	if process == nil {
		return nil
	}
	return process.Kill()
}
func platformTerminateProcessTree(pid int) error {
	if pid <= 1 {
		return nil
	}
	if err := exec.Command("taskkill.exe", "/PID", strconv.Itoa(pid), "/T", "/F").Run(); err == nil {
		return nil
	}
	return terminatePID(pid, true)
}
func platformProcessSignal(state *os.ProcessState) (string, bool) { return "", false }
func platformShutdownSignals() []os.Signal                        { return []os.Signal{os.Interrupt} }

func windowsShell() (string, []string) {
	if p, err := exec.LookPath("powershell.exe"); err == nil {
		return p, []string{"-NoLogo", "-NoProfile"}
	}
	if p, err := exec.LookPath("pwsh.exe"); err == nil {
		return p, []string{"-NoLogo", "-NoProfile"}
	}
	comspec := strings.TrimSpace(os.Getenv("ComSpec"))
	if comspec == "" {
		comspec = `C:\\Windows\\System32\\cmd.exe`
	}
	return comspec, []string{"/D", "/Q"}
}
func platformShellCommand(command, workloadKind string) *exec.Cmd {
	shell, base := windowsShell()
	name := strings.ToLower(filepath.Base(shell))
	if strings.Contains(name, "powershell") || name == "pwsh.exe" {
		args := append(append([]string{}, base...), "-NonInteractive", "-Command", command)
		return exec.Command(shell, args...)
	}
	return exec.Command(shell, append(base, "/S", "/C", command)...)
}
func platformShellCommandContext(ctx context.Context, command, workloadKind string) *exec.Cmd {
	shell, base := windowsShell()
	name := strings.ToLower(filepath.Base(shell))
	if strings.Contains(name, "powershell") || name == "pwsh.exe" {
		args := append(append([]string{}, base...), "-NonInteractive", "-Command", command)
		return exec.CommandContext(ctx, shell, args...)
	}
	return exec.CommandContext(ctx, shell, append(base, "/S", "/C", command)...)
}
func preferredShell() string { shell, _ := windowsShell(); return shell }
func startInteractiveShell(cwd string, cols, rows int, workloadKind string) (*exec.Cmd, shellTerminal, string, error) {
	shellPath, base := windowsShell()
	cmd := exec.Command(shellPath, base...)
	cmd.Dir = cwd
	cmd.Env = os.Environ()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, "", err
	}
	reader, writer := io.Pipe()
	cmd.Stdout = writer
	cmd.Stderr = writer
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = reader.Close()
		_ = writer.Close()
		return nil, nil, "", err
	}
	return cmd, &windowsTerminal{reader: reader, writer: writer, stdin: stdin}, shellPath, nil
}

func platformPrepareUninstall(installRoot string) error {
	key, err := registry.OpenKey(registry.CURRENT_USER, `Environment`, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return nil
	}
	defer key.Close()
	value, _, err := key.GetStringValue("Path")
	if err != nil {
		return nil
	}
	current := filepath.Clean(filepath.Join(installRoot, "current"))
	parts := strings.Split(value, ";")
	kept := make([]string, 0, len(parts))
	changed := false
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" && strings.EqualFold(filepath.Clean(trimmed), current) {
			changed = true
			continue
		}
		kept = append(kept, part)
	}
	if changed {
		_ = key.SetStringValue("Path", strings.Join(kept, ";"))
	}
	return nil
}
func platformRemoveInstallRoot(installRoot string) error {
	firstErr := os.RemoveAll(installRoot)
	if firstErr == nil {
		return nil
	}
	currentExe, err := os.Executable()
	if err != nil {
		return firstErr
	}
	currentExe = filepath.Clean(currentExe)
	if !isWithinRoot(currentExe, installRoot) {
		return firstErr
	}
	tempExe := filepath.Join(os.TempDir(), "bot-report-worker-delete-"+randomHex(8)+".exe")
	from, err := windows.UTF16PtrFromString(currentExe)
	if err != nil {
		return firstErr
	}
	to, err := windows.UTF16PtrFromString(tempExe)
	if err != nil {
		return firstErr
	}
	if err := windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING); err != nil {
		return firstErr
	}
	if err := os.RemoveAll(installRoot); err != nil {
		return err
	}
	deletePath, err := windows.UTF16PtrFromString(tempExe)
	if err == nil {
		_ = windows.MoveFileEx(deletePath, nil, windows.MOVEFILE_DELAY_UNTIL_REBOOT)
	}
	return nil
}
