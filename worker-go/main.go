package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/term"
)

var (
	version = "dev"
	commit  = "unknown"
)

const (
	connectPath     = "/worker/v1/connect"
	defaultMaxJobMS = 300000
	maxPayloadBytes = 4 * 1024 * 1024
)

var defaultCapabilities = []string{
	"shell.inspect", "shell.send", "shell.read", "shell.interrupt", "shell.attach",
	"workspace.exec", "artifact.collect", "file.write",
	"process.start", "process.status", "process.logs", "process.stop",
}

type workerError struct {
	Code    string
	Message string
}

func (e *workerError) Error() string  { return e.Message }
func fail(code, message string) error { return &workerError{Code: code, Message: message} }
func errorCode(err error) string {
	var target *workerError
	if errors.As(err, &target) && target.Code != "" {
		return target.Code
	}
	return "WORKER_JOB_FAILED"
}

type Config struct {
	ServerURL           string   `json:"server_url"`
	WorkerName          string   `json:"worker_name"`
	ProfileName         string   `json:"profile_name"`
	TmuxSession         string   `json:"tmux_session"`
	TmuxCreatedByWorker bool     `json:"tmux_created_by_worker"`
	AllowedRoots        []string `json:"allowed_roots"`
	AllowShell          bool     `json:"allow_shell"`
	AllowInsecureHTTP   bool     `json:"allow_insecure_http"`
	MaxJobMS            int      `json:"max_job_ms"`
	UpdatedAt           string   `json:"updated_at"`
}

type State struct {
	PrivateKey string `json:"private_key"`
	PublicKey  string `json:"public_key"`
	WorkerID   string `json:"worker_id"`
	Name       string `json:"name"`
	ServerURL  string `json:"server_url"`
	EnrolledAt string `json:"enrolled_at"`
}

type EnrollmentResponse struct {
	WorkerID     string   `json:"worker_id"`
	Name         string   `json:"name"`
	Capabilities []string `json:"capabilities"`
	Profile      *struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		TmuxSession string `json:"tmux_session"`
	} `json:"profile"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type cliOptions map[string]string

func workerHome() string {
	if value := strings.TrimSpace(os.Getenv("BOT_REPORT_WORKER_HOME")); value != "" {
		if abs, err := filepath.Abs(value); err == nil {
			return abs
		}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".bot-report-worker")
}
func configPath() string        { return filepath.Join(workerHome(), "config.json") }
func statePath() string         { return filepath.Join(workerHome(), "state.json") }
func pidPath() string           { return filepath.Join(workerHome(), "worker.pid") }
func logPath() string           { return filepath.Join(workerHome(), "worker.log") }
func defaultServerPath() string { return filepath.Join(workerHome(), "default-server") }
func serviceModePath() string   { return filepath.Join(workerHome(), "service-mode") }
func serviceManaged() bool      { return readText(serviceModePath()) == "systemd" }

func ensureWorkerHome() error {
	if err := os.MkdirAll(workerHome(), 0700); err != nil {
		return err
	}
	_ = os.Chmod(workerHome(), 0700)
	return nil
}

func writeJSONAtomic(path string, value any) error {
	if err := ensureWorkerHome(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	tmp := fmt.Sprintf("%s.%d.%s.tmp", path, os.Getpid(), randomHex(4))
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	_ = os.Chmod(path, 0600)
	return nil
}

func readJSON(path string, out any) (bool, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(data, out); err != nil {
		return false, err
	}
	return true, nil
}
func readText(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func randomHex(n int) string {
	buf := make([]byte, n)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func parseArgs(args []string) (string, cliOptions, error) {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		return "help", cliOptions{}, nil
	}
	command := args[0]
	if strings.HasPrefix(command, "-") {
		return "", nil, fail("CLI_COMMAND_UNKNOWN", fmt.Sprintf("Unknown command '%s'. Run systemtd help.", command))
	}
	options := cliOptions{}
	flags := map[string]bool{"allow-shell": true, "no-start": true, "insecure-http": true}
	for i := 1; i < len(args); i++ {
		arg := args[i]
		if !strings.HasPrefix(arg, "--") {
			return "", nil, fail("CLI_ARGUMENT_INVALID", fmt.Sprintf("Unexpected argument '%s'.", arg))
		}
		key := strings.TrimPrefix(arg, "--")
		if flags[key] {
			options[key] = "true"
			continue
		}
		if i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
			return "", nil, fail("CLI_ARGUMENT_INVALID", fmt.Sprintf("Option '--%s' requires a value.", key))
		}
		options[key] = args[i+1]
		i++
	}
	return command, options, nil
}

func validateServerURL(value string, allowInsecure bool) (string, error) {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", fail("WORKER_SERVER_URL_INVALID", "Server URL must be a valid HTTP(S) URL.")
	}
	if u.Scheme != "https" && !allowInsecure {
		return "", fail("WORKER_TLS_REQUIRED", "HTTPS is required. Use --insecure-http only for trusted local development.")
	}
	u.Path, u.RawQuery, u.Fragment = "", "", ""
	return strings.TrimRight(u.String(), "/"), nil
}

func validateName(value, label string) (string, error) {
	name := strings.TrimSpace(value)
	if len(name) < 1 || len(name) > 100 {
		return "", fail("WORKER_NAME_INVALID", fmt.Sprintf("%s must be 1-100 safe characters.", label))
	}
	for i, r := range name {
		ok := (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '.' || r == '-' || r == ' '
		if !ok || (i == 0 && r == ' ') {
			return "", fail("WORKER_NAME_INVALID", fmt.Sprintf("%s must be 1-100 safe characters.", label))
		}
	}
	return name, nil
}

func validateTmuxSession(value string) (string, error) {
	value = strings.TrimSpace(value)
	if len(value) < 1 || len(value) > 80 {
		return "", fail("INVALID_TMUX_SESSION", "tmux session may contain only letters, numbers, underscore, dot, and hyphen.")
	}
	for _, r := range value {
		if !((r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '.' || r == '-') {
			return "", fail("INVALID_TMUX_SESSION", "tmux session may contain only letters, numbers, underscore, dot, and hyphen.")
		}
	}
	return value, nil
}

func normalizeRoots(value string) ([]string, error) {
	seen := map[string]bool{}
	roots := []string{}
	for _, raw := range strings.Split(value, ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		abs, err := filepath.Abs(raw)
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(abs)
		if err != nil {
			return nil, fail("WORKER_ROOT_NOT_FOUND", fmt.Sprintf("Allowed root does not exist: %s", abs))
		}
		if !info.IsDir() {
			return nil, fail("WORKER_ROOT_INVALID", fmt.Sprintf("Allowed root is not a directory: %s", abs))
		}
		real, err := filepath.EvalSymlinks(abs)
		if err == nil {
			abs = real
		}
		if !seen[abs] {
			seen[abs] = true
			roots = append(roots, abs)
		}
	}
	if len(roots) == 0 {
		return nil, fail("WORKER_ALLOWED_ROOTS_REQUIRED", "At least one allowed workspace root is required.")
	}
	return roots, nil
}

func prompt(reader *bufio.Reader, question, def string) (string, error) {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", fail("CLI_INPUT_REQUIRED", question+" must be supplied as a command option in non-interactive mode.")
	}
	suffix := ""
	if def != "" {
		suffix = " [" + def + "]"
	}
	fmt.Printf("%s%s: ", question, suffix)
	line, err := reader.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	line = strings.TrimSpace(line)
	if line == "" {
		line = def
	}
	return line, nil
}

func hiddenPrompt(question string) (string, error) {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", fail("CLI_INPUT_REQUIRED", question+" must be supplied as a command option in non-interactive mode.")
	}
	fmt.Printf("%s: ", question)
	value, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	return strings.TrimSpace(string(value)), err
}

func yesNo(reader *bufio.Reader, question string, def bool) (bool, error) {
	suffix := " [y/N]"
	if def {
		suffix = " [Y/n]"
	}
	value, err := prompt(reader, question+suffix, "")
	if err != nil {
		return false, err
	}
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return def, nil
	}
	return value == "y" || value == "yes", nil
}

func generateIdentity() (string, string, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	privDER, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return "", "", err
	}
	pubDER, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return "", "", err
	}
	privPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privDER})
	pubPEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubDER})
	return string(privPEM), string(pubPEM), nil
}

func parsePrivateKey(text string) (ed25519.PrivateKey, error) {
	block, _ := pem.Decode([]byte(text))
	if block == nil {
		return nil, fail("WORKER_PRIVATE_KEY_INVALID", "Worker private key is invalid.")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fail("WORKER_PRIVATE_KEY_INVALID", "Worker private key is invalid.")
	}
	priv, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, fail("WORKER_PRIVATE_KEY_INVALID", "Worker private key is not Ed25519.")
	}
	return priv, nil
}

func commandExists(name string) bool { _, err := exec.LookPath(name); return err == nil }

func ensureTmuxSession(session, cwd string) (bool, bool, error) {
	if !commandExists("tmux") {
		return false, false, nil
	}
	if exec.Command("tmux", "has-session", "-t", "="+session).Run() == nil {
		return true, false, nil
	}
	cmd := exec.Command("tmux", "new-session", "-d", "-s", session, "-c", cwd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return true, false, fail("TMUX_CREATE_FAILED", strings.TrimSpace(string(out)))
	}
	return true, true, nil
}

func processAlive(pid int) bool {
	if pid <= 1 {
		return false
	}
	return platformProcessAlive(pid)
}
func readPID() int {
	value, err := strconv.Atoi(strings.TrimSpace(readText(pidPath())))
	if err != nil || value <= 1 {
		return 0
	}
	return value
}
func clearStalePID() int {
	pid := readPID()
	if processAlive(pid) {
		return pid
	}
	_ = os.Remove(pidPath())
	return 0
}

func tailLog(maxBytes int64) string {
	if maxBytes <= 0 {
		return ""
	}
	var result []byte
	for i := 0; i <= daemonLogGenerations && int64(len(result)) < maxBytes; i++ {
		name := logPath()
		if i > 0 {
			name = fmt.Sprintf("%s.%d", name, i)
		}
		if regularLog(name) != nil {
			continue
		}
		f, err := os.Open(name)
		if err != nil {
			continue
		}
		info, err := f.Stat()
		if err != nil {
			f.Close()
			continue
		}
		n := maxBytes - int64(len(result))
		if n > info.Size() {
			n = info.Size()
		}
		buf := make([]byte, n)
		read, _ := f.ReadAt(buf, info.Size()-n)
		f.Close()
		result = append(buf[:read], result...)
	}
	return string(result)
}

func waitForConnected(pid int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			return fail("WORKER_START_FAILED", "Worker exited during startup.\n"+tailLog(12*1024))
		}
		if strings.Contains(tailLog(12*1024), fmt.Sprintf("[WORKER] connected pid=%d worker_id=", pid)) {
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fail("WORKER_CONNECT_TIMEOUT", fmt.Sprintf("Worker started but did not confirm connection within %d ms.\n%s", timeout.Milliseconds(), tailLog(12*1024)))
}

func startDetached(wait bool) (int, error) {
	var cfg Config
	var state State
	ok1, err := readJSON(configPath(), &cfg)
	if err != nil {
		return 0, err
	}
	ok2, err := readJSON(statePath(), &state)
	if err != nil {
		return 0, err
	}
	if !ok1 || !ok2 || state.WorkerID == "" {
		return 0, fail("WORKER_NOT_LOGGED_IN", "Run systemtd login first.")
	}
	if pid := clearStalePID(); pid != 0 {
		fmt.Printf("[bot-report-worker] already running pid=%d profile=%s\n", pid, cfg.ProfileName)
		return pid, nil
	}
	if err := ensureWorkerHome(); err != nil {
		return 0, err
	}
	logFile, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		return 0, err
	}
	exe, err := os.Executable()
	if err != nil {
		_ = logFile.Close()
		return 0, err
	}
	cmd := exec.Command(exe, "__agent")
	if len(cfg.AllowedRoots) > 0 {
		cmd.Dir = cfg.AllowedRoots[0]
	}
	cmd.Stdin = nil
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	configureDetachedProcess(cmd)
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return 0, err
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	_ = logFile.Close()
	if err := os.WriteFile(pidPath(), []byte(fmt.Sprintf("%d\n", pid)), 0600); err != nil {
		return 0, err
	}
	if wait {
		if err := waitForConnected(pid, 8*time.Second); err != nil {
			_ = terminatePID(pid, false)
			_ = os.Remove(pidPath())
			return 0, err
		}
	}
	fmt.Printf("[bot-report-worker] connected profile=%s pid=%d\n", cfg.ProfileName, pid)
	return pid, nil
}

func stopWorker() error {
	pid := clearStalePID()
	if pid == 0 {
		fmt.Println("[bot-report-worker] not running")
		return nil
	}
	_ = terminatePID(pid, false)
	deadline := time.Now().Add(3 * time.Second)
	for processAlive(pid) && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if processAlive(pid) {
		_ = terminatePID(pid, true)
	}
	_ = os.Remove(pidPath())
	fmt.Printf("[bot-report-worker] stopped pid=%d\n", pid)
	return nil
}

func login(options cliOptions) error {
	var existing State
	if ok, _ := readJSON(statePath(), &existing); ok && existing.WorkerID != "" {
		return fail("WORKER_ALREADY_LOGGED_IN", "This machine is already enrolled as worker "+existing.WorkerID+".")
	}
	reader := bufio.NewReader(os.Stdin)
	insecure := options["insecure-http"] == "true" || os.Getenv("BOT_REPORT_WORKER_ALLOW_INSECURE_HTTP") == "true"
	serverInput := options["server"]
	if serverInput == "" {
		serverInput = os.Getenv("BOT_REPORT_WORKER_SERVER_URL")
	}
	if serverInput == "" {
		serverInput = readText(defaultServerPath())
	}
	if serverInput == "" {
		var err error
		serverInput, err = prompt(reader, "mcp_worker server URL", "")
		if err != nil {
			return err
		}
	}
	serverURL, err := validateServerURL(serverInput, insecure)
	if err != nil {
		return err
	}
	token := options["token"]
	if token == "" {
		token = os.Getenv("BOT_REPORT_WORKER_ENROLLMENT_TOKEN")
	}
	if token == "" {
		token, err = hiddenPrompt("One-time enrollment token")
		if err != nil {
			return err
		}
	}
	if !strings.HasPrefix(token, "br_enroll_") {
		return fail("WORKER_ENROLLMENT_INVALID", "Enrollment token must start with br_enroll_.")
	}
	rootInput := options["roots"]
	if rootInput == "" {
		rootInput = os.Getenv("BOT_REPORT_WORKER_ALLOWED_ROOTS")
	}
	if rootInput == "" {
		cwd, _ := os.Getwd()
		rootInput, err = prompt(reader, "Allowed workspace root(s), comma-separated", cwd)
		if err != nil {
			return err
		}
	}
	roots, err := normalizeRoots(rootInput)
	if err != nil {
		return err
	}
	host, _ := os.Hostname()
	workerName := options["name"]
	if workerName == "" {
		workerName = os.Getenv("BOT_REPORT_WORKER_NAME")
	}
	if workerName == "" {
		workerName = host
	}
	workerName, err = validateName(workerName, "Worker name")
	if err != nil {
		return err
	}
	profileName := options["profile"]
	if profileName == "" {
		profileName = workerName
	}
	profileName, err = validateName(profileName, "Profile name")
	if err != nil {
		return err
	}
	allowShell := options["allow-shell"] == "true" || os.Getenv("BOT_REPORT_WORKER_ALLOW_SHELL") == "true"
	if !allowShell && options["allow-shell"] == "" && os.Getenv("BOT_REPORT_WORKER_ALLOW_SHELL") == "" {
		allowShell, err = yesNo(reader, "Allow mcp_worker to execute shell commands as this OS user?", false)
		if err != nil {
			return err
		}
	}
	if err := ensureWorkerHome(); err != nil {
		return err
	}
	privPEM, pubPEM, err := generateIdentity()
	if err != nil {
		return err
	}
	requestBody := map[string]any{"token": token, "name": workerName, "public_key": pubPEM, "capabilities": defaultCapabilities, "create_profile": true, "profile_name": profileName}
	body, _ := json.Marshal(requestBody)
	req, _ := http.NewRequest(http.MethodPost, serverURL+"/worker/v1/enroll", bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respData, _ := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	var payload EnrollmentResponse
	_ = json.Unmarshal(respData, &payload)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if payload.Message == "" {
			payload.Message = fmt.Sprintf("Enrollment failed with HTTP %d.", resp.StatusCode)
		}
		if payload.Code == "" {
			payload.Code = "WORKER_ENROLLMENT_FAILED"
		}
		return fail(payload.Code, payload.Message)
	}
	if payload.WorkerID == "" || payload.Profile == nil || payload.Profile.Name == "" {
		return fail("WORKER_ENROLLMENT_INCOMPLETE", "Server did not return a Worker Profile.")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	cfg := Config{ServerURL: serverURL, WorkerName: payload.Name, ProfileName: payload.Profile.Name, AllowedRoots: roots, AllowShell: allowShell, AllowInsecureHTTP: insecure, MaxJobMS: defaultMaxJobMS, UpdatedAt: now}
	state := State{PrivateKey: privPEM, PublicKey: pubPEM, WorkerID: payload.WorkerID, Name: payload.Name, ServerURL: serverURL, EnrolledAt: now}
	if err := writeJSONAtomic(configPath(), &cfg); err != nil {
		return err
	}
	if err := writeJSONAtomic(statePath(), &state); err != nil {
		return err
	}
	fmt.Printf("[bot-report-worker] enrolled worker=%s id=%s\n", state.Name, state.WorkerID)
	fmt.Printf("[bot-report-worker] execution profile=%s roots=%s\n", cfg.ProfileName, strings.Join(roots, ","))
	fmt.Printf("[bot-report-worker] shell execution=%s\n", map[bool]string{true: "ENABLED", false: "disabled"}[allowShell])
	if options["no-start"] == "true" {
		fmt.Println("[systemtd] enrollment complete; run systemtd start to connect.")
		return nil
	}
	if serviceManaged() {
		return platformStartManagedService()
	}
	_, err = startDetached(true)
	return err
}

func printStatus() error {
	var cfg Config
	var state State
	ok1, err := readJSON(configPath(), &cfg)
	if err != nil {
		return err
	}
	ok2, err := readJSON(statePath(), &state)
	if err != nil {
		return err
	}
	if !ok1 || !ok2 || state.WorkerID == "" {
		fmt.Println("status: NOT_LOGGED_IN")
		return nil
	}
	pid := clearStalePID()
	status := "STOPPED"
	if pid != 0 {
		status = "RUNNING"
	}
	fmt.Println("status:", status)
	fmt.Println("worker_id:", state.WorkerID)
	fmt.Println("worker_name:", state.Name)
	fmt.Println("profile:", cfg.ProfileName)
	fmt.Println("server:", cfg.ServerURL)
	fmt.Println("roots:", strings.Join(cfg.AllowedRoots, ","))
	if cfg.AllowShell {
		fmt.Println("shell: enabled")
	} else {
		fmt.Println("shell: disabled")
	}
	if pid != 0 {
		fmt.Println("pid:", pid)
	}
	fmt.Println("log:", logPath())
	fmt.Printf("runtime: go %s (%s/%s)\n", runtime.Version(), runtime.GOOS, runtime.GOARCH)
	fmt.Printf("worker_version: %s commit=%s\n", version, commit)
	if serviceManaged() {
		fmt.Println("service: systemtd.service")
	}
	fmt.Println("workload_isolation:", platformWorkloadIsolationStatus())
	return nil
}

func printHelp() {
	fmt.Printf(`mcp_worker System Task Daemon %s (standalone Go runtime)

Usage:
  systemtd login [options]
  systemtd start
  systemtd stop
  systemtd restart
  systemtd status
  systemtd logs
  systemtd run
  systemtd uninstall
  systemtd version

Login options:
  --server <url>       mcp_worker base URL (installer provides a default)
  --token <token>      One-time enrollment token; omitted = hidden prompt
  --roots <paths>      Comma-separated allowed workspace roots
  --name <name>        Worker display name; default = hostname
  --profile <name>     Execution alias; default = worker name
  --allow-shell        Allow interactive shell/workspace/git/check/process execution
  --insecure-http      Permit HTTP only for trusted local development
  --no-start           Enroll only; do not connect the worker

No Node.js, npm, Python, Docker, or other language runtime is required.
`, version)
}

func canonicalBoundaryPath(input string) string {
	input = filepath.Clean(input)
	if real, err := filepath.EvalSymlinks(input); err == nil {
		return real
	}
	current := input
	parts := []string{}
	for {
		if real, err := filepath.EvalSymlinks(current); err == nil {
			for i := len(parts) - 1; i >= 0; i-- {
				real = filepath.Join(real, parts[i])
			}
			return filepath.Clean(real)
		}
		parent := filepath.Dir(current)
		if parent == current {
			return input
		}
		parts = append(parts, filepath.Base(current))
		current = parent
	}
}

func isWithinRoot(candidate, root string) bool {
	candidate = canonicalBoundaryPath(candidate)
	root = canonicalBoundaryPath(root)
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && !filepath.IsAbs(rel))
}

func nearestExistingAncestor(target string) (string, error) {
	current := target
	for {
		real, err := filepath.EvalSymlinks(current)
		if err == nil {
			return real, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", err
		}
		current = parent
	}
}

func assertAllowedPath(input string, roots []string, mustExist bool) (string, error) {
	input = strings.TrimSpace(input)
	if input == "" || strings.ContainsRune(input, '\x00') {
		return "", fail("WORKER_PATH_INVALID", "Path is invalid.")
	}
	resolved, err := filepath.Abs(input)
	if err != nil {
		return "", err
	}
	allowed := false
	for _, root := range roots {
		if isWithinRoot(resolved, root) {
			allowed = true
			break
		}
	}
	if !allowed {
		return "", fail("WORKER_PATH_DENIED", fmt.Sprintf("Path '%s' is outside worker allowed roots.", resolved))
	}
	verified, err := filepath.EvalSymlinks(resolved)
	if err != nil {
		if mustExist || !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		verified, err = nearestExistingAncestor(filepath.Dir(resolved))
		if err != nil {
			return "", err
		}
	}
	allowed = false
	for _, root := range roots {
		if isWithinRoot(verified, root) {
			allowed = true
			break
		}
	}
	if !allowed {
		return "", fail("WORKER_PATH_DENIED", "Resolved path escapes worker allowed roots.")
	}
	return resolved, nil
}

type cappedBuffer struct {
	buf       bytes.Buffer
	size      int64
	limit     int64
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	original := len(p)
	remaining := c.limit - int64(c.buf.Len())
	if remaining > 0 {
		take := int64(len(p))
		if take > remaining {
			take = remaining
		}
		_, _ = c.buf.Write(p[:take])
	}
	c.size += int64(original)
	if c.size > c.limit {
		c.truncated = true
	}
	return original, nil
}
func (c *cappedBuffer) String() string { return c.buf.String() }
func (c *cappedBuffer) Bytes() []byte  { return c.buf.Bytes() }

type commandResult struct {
	code                             int
	stdout, stderr                   []byte
	stdoutTruncated, stderrTruncated bool
}

func runFile(name string, args []string, input []byte, timeout time.Duration, maxBytes int64) (commandResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	if input != nil {
		cmd.Stdin = bytes.NewReader(input)
	}
	out := &cappedBuffer{limit: maxBytes}
	er := &cappedBuffer{limit: maxBytes}
	cmd.Stdout = out
	cmd.Stderr = er
	err := cmd.Run()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return commandResult{}, fail("WORKER_COMMAND_TIMEOUT", name+" timed out.")
	}
	code := 0
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		} else {
			return commandResult{}, err
		}
	}
	return commandResult{code: code, stdout: append([]byte(nil), out.Bytes()...), stderr: append([]byte(nil), er.Bytes()...), stdoutTruncated: out.truncated, stderrTruncated: er.truncated}, nil
}

func (a *Agent) runShell(command, cwd string, timeout time.Duration, maxBytes int64) (map[string]any, error) {
	if a.shutting.Load() {
		return nil, fail("WORKER_SHUTTING_DOWN", "Worker is shutting down.")
	}
	if a.resourceEmergency.Load() {
		return nil, a.resourceEmergencyError()
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := platformShellCommandContext(ctx, command, "workspace")
	// CommandContext's default Cancel only kills the immediate child.
	// Kill the workload group before Wait can block on inherited output pipes.
	cmd.Cancel = func() error { return platformTerminateWorkload(cmd, true) }
	cmd.WaitDelay = 2 * time.Second
	cmd.Dir = cwd
	out := &cappedBuffer{limit: maxBytes}
	er := &cappedBuffer{limit: maxBytes}
	cmd.Stdout = out
	cmd.Stderr = er
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	a.trackWorkspaceCommand(cmd)
	defer a.untrackWorkspaceCommand(cmd)
	if a.shutting.Load() {
		_ = platformTerminateWorkload(cmd, true)
		_ = cmd.Wait()
		return nil, fail("WORKER_SHUTTING_DOWN", "Worker is shutting down.")
	}
	if a.resourceEmergency.Load() {
		_ = platformTerminateWorkload(cmd, true)
		_ = cmd.Wait()
		return nil, a.resourceEmergencyError()
	}
	err := cmd.Wait()
	if a.resourceEmergency.Load() && err != nil {
		return nil, a.resourceEmergencyError()
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		_ = platformTerminateWorkload(cmd, true)
		return nil, fail("WORKER_JOB_TIMEOUT", "Local worker command timed out.")
	}
	code := 0
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		} else {
			return nil, err
		}
	}
	return map[string]any{"exit_code": code, "stdout": out.String(), "stderr": er.String(), "duration_ms": time.Since(started).Milliseconds(), "stdout_truncated": out.truncated, "stderr_truncated": er.truncated}, nil
}

func payloadString(p map[string]any, key string) string {
	if v, ok := p[key].(string); ok {
		return v
	}
	return ""
}
func payloadBool(p map[string]any, key string, def bool) bool {
	if v, ok := p[key].(bool); ok {
		return v
	}
	return def
}
func payloadInt(p map[string]any, key string, def int) int {
	switch v := p[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case json.Number:
		n, _ := v.Int64()
		return int(n)
	}
	return def
}
func clamp(v, min, max int) int {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

func inspectTmux(session string) (map[string]any, error) {
	if _, err := validateTmuxSession(session); err != nil {
		return nil, err
	}
	version, err := runFile("tmux", []string{"-V"}, nil, 10*time.Second, 2*1024*1024)
	if err != nil || version.code != 0 {
		return nil, fail("TMUX_NOT_AVAILABLE", "tmux is not available on the worker host.")
	}
	exists, err := runFile("tmux", []string{"has-session", "-t", "=" + session}, nil, 10*time.Second, 2*1024*1024)
	if err != nil || exists.code != 0 {
		return nil, fail("TMUX_SESSION_NOT_FOUND", "Configured tmux session was not found.")
	}
	list, err := runFile("tmux", []string{"list-panes", "-t", "=" + session, "-F", "#{pane_id}\t#{pane_current_command}"}, nil, 10*time.Second, 2*1024*1024)
	if err != nil || list.code != 0 {
		return nil, fail("TMUX_INSPECTION_FAILED", "Unable to inspect tmux session.")
	}
	panes := []map[string]any{}
	for _, line := range strings.Split(strings.TrimSpace(string(list.stdout)), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		id := parts[0]
		if !strings.HasPrefix(id, "%") {
			return nil, fail("TMUX_INSPECTION_FAILED", "tmux returned an invalid pane identifier.")
		}
		current := any(nil)
		if len(parts) > 1 && parts[1] != "" {
			current = parts[1]
		}
		panes = append(panes, map[string]any{"id": id, "current_command": current})
	}
	if len(panes) == 0 {
		return nil, fail("TMUX_TARGET_MISSING", "Configured tmux session has no target pane.")
	}
	var target any = nil
	var current any = nil
	if len(panes) == 1 {
		target = panes[0]["id"]
		current = panes[0]["current_command"]
	}
	return map[string]any{"pane_count": len(panes), "panes": panes, "target_pane": target, "pane_current_command": current}, nil
}
func singlePane(info map[string]any) (string, error) {
	if s, ok := info["target_pane"].(string); ok && s != "" {
		return s, nil
	}
	return "", fail("TMUX_MULTIPLE_PANES", "Terminal control requires exactly one tmux pane.")
}

var ansiEscapeRE = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)

type shellTerminal interface {
	io.Reader
	io.Writer
	Close() error
	Resize(cols, rows int) error
}

type shellSession struct {
	mu          sync.Mutex
	key         string
	cmd         *exec.Cmd
	terminal    shellTerminal
	pid         int
	shell       string
	cwd         string
	buffer      []byte
	subscribers map[string]*safeSocket
	closed      bool
}

func validateShellKey(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 200 || strings.ContainsRune(value, '\x00') {
		return "", fail("SHELL_SESSION_INVALID", "Shell session key is invalid.")
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return "", fail("SHELL_SESSION_INVALID", "Shell session key is invalid.")
		}
	}
	return value, nil
}

func (s *shellSession) info() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := "RUNNING"
	if s.closed {
		state = "CLOSED"
	}
	return map[string]any{
		"session_key": s.key, "pid": s.pid, "shell": s.shell, "cwd": s.cwd, "state": state,
		"pane_count": 1, "target_pane": "shell", "pane_current_command": filepath.Base(s.shell),
	}
}

func (s *shellSession) appendOutput(chunk []byte) map[string]*safeSocket {
	s.mu.Lock()
	defer s.mu.Unlock()
	const maxHistory = 1024 * 1024
	s.buffer = append(s.buffer, chunk...)
	if len(s.buffer) > maxHistory {
		s.buffer = append([]byte(nil), s.buffer[len(s.buffer)-maxHistory:]...)
	}
	copySubs := make(map[string]*safeSocket, len(s.subscribers))
	for id, socket := range s.subscribers {
		copySubs[id] = socket
	}
	return copySubs
}

func (s *shellSession) broadcast(chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	subs := s.appendOutput(chunk)
	data := base64.StdEncoding.EncodeToString(chunk)
	for streamID, socket := range subs {
		_ = socket.sendJSON(map[string]any{"type": "stream_output", "stream_id": streamID, "data": data})
	}
}

func (s *shellSession) finish(a *Agent, reason string) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	subs := make(map[string]*safeSocket, len(s.subscribers))
	for id, socket := range s.subscribers {
		subs[id] = socket
	}
	s.subscribers = map[string]*safeSocket{}
	_ = s.terminal.Close()
	s.mu.Unlock()
	a.shellMu.Lock()
	if a.shells[s.key] == s {
		delete(a.shells, s.key)
	}
	a.shellMu.Unlock()
	for streamID, socket := range subs {
		_ = socket.sendJSON(map[string]any{"type": "stream_closed", "stream_id": streamID, "reason": reason})
	}
}

func (a *Agent) getOrCreateShell(key string, cols, rows int) (*shellSession, error) {
	if err := a.requireShell(); err != nil {
		return nil, err
	}
	var err error
	key, err = validateShellKey(key)
	if err != nil {
		return nil, err
	}
	cols = clamp(cols, 2, 500)
	rows = clamp(rows, 2, 200)
	a.shellMu.Lock()
	if existing := a.shells[key]; existing != nil {
		a.shellMu.Unlock()
		return existing, nil
	}
	if len(a.shells) >= 64 {
		a.shellMu.Unlock()
		return nil, fail("SHELL_SESSION_LIMIT", "Worker shell session limit reached.")
	}
	cmd, terminal, shellPath, err := startInteractiveShell(a.roots[0], cols, rows, "shell")
	if err != nil {
		a.shellMu.Unlock()
		return nil, fail("SHELL_START_FAILED", "Unable to start an interactive worker shell.")
	}
	session := &shellSession{key: key, cmd: cmd, terminal: terminal, pid: cmd.Process.Pid, shell: shellPath, cwd: cmd.Dir, subscribers: map[string]*safeSocket{}}
	a.shells[key] = session
	a.shellMu.Unlock()
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, readErr := terminal.Read(buf)
			if n > 0 {
				session.broadcast(append([]byte(nil), buf[:n]...))
			}
			if readErr != nil {
				return
			}
		}
	}()
	go func() {
		_ = cmd.Wait()
		session.finish(a, "shell-exited")
	}()
	return session, nil
}

func (a *Agent) shellInspect(p map[string]any) (any, error) {
	session, err := a.getOrCreateShell(payloadString(p, "session_key"), 80, 24)
	if err != nil {
		return nil, err
	}
	return session.info(), nil
}

func (a *Agent) shellSend(p map[string]any) (any, error) {
	session, err := a.getOrCreateShell(payloadString(p, "session_key"), 80, 24)
	if err != nil {
		return nil, err
	}
	text := payloadString(p, "text")
	if text == "" || len([]byte(text)) > 64*1024 {
		return nil, fail("INVALID_INPUT", "Terminal input must be 1 byte to 64 KiB.")
	}
	if payloadBool(p, "submit", true) {
		text += "\n"
	}
	session.mu.Lock()
	_, err = session.terminal.Write([]byte(text))
	session.mu.Unlock()
	if err != nil {
		return nil, fail("SHELL_INPUT_FAILED", "Unable to write to the worker shell.")
	}
	return map[string]any{"code": "INPUT_SENT", "target_pane": "shell", "pane_current_command": filepath.Base(session.shell)}, nil
}

func (a *Agent) shellRead(p map[string]any) (any, error) {
	session, err := a.getOrCreateShell(payloadString(p, "session_key"), 80, 24)
	if err != nil {
		return nil, err
	}
	session.mu.Lock()
	data := append([]byte(nil), session.buffer...)
	session.mu.Unlock()
	text := ansiEscapeRE.ReplaceAllString(string(data), "")
	text = strings.ReplaceAll(text, "\r", "")
	rows := strings.Split(text, "\n")
	if len(rows) > 0 && rows[len(rows)-1] == "" {
		rows = rows[:len(rows)-1]
	}
	lines := clamp(payloadInt(p, "lines", 200), 1, 10000)
	count := len(rows)
	start := 0
	if count > lines {
		start = count - lines
	}
	return map[string]any{"text": strings.Join(rows[start:], "\n"), "lines": minInt(count, lines), "truncated": count > lines, "target_pane": "shell", "pane_current_command": filepath.Base(session.shell)}, nil
}

func (a *Agent) shellInterrupt(p map[string]any) (any, error) {
	session, err := a.getOrCreateShell(payloadString(p, "session_key"), 80, 24)
	if err != nil {
		return nil, err
	}
	session.mu.Lock()
	_, err = session.terminal.Write([]byte{3})
	session.mu.Unlock()
	if err != nil {
		return nil, fail("SHELL_INTERRUPT_FAILED", "Unable to interrupt the worker shell.")
	}
	return map[string]any{"code": "INTERRUPT_SENT", "target_pane": "shell", "pane_current_command": filepath.Base(session.shell)}, nil
}

type managedProcess struct {
	mu        sync.RWMutex
	id        string
	cmd       *exec.Cmd
	pid       int
	logPath   string
	startedAt string
	exitedAt  string
	exitCode  *int
	signal    *string
	logFile   *os.File
	logWriter *boundedProcessLog
	done      chan struct{}
}

func (p *managedProcess) snapshot(lines int) (map[string]any, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	text, truncated := managedLogTail(p.logPath, lines)
	state := "RUNNING"
	if p.exitedAt != "" {
		state = "EXITED"
	}
	return map[string]any{"process_id": p.id, "pid": p.pid, "state": state, "exit_code": p.exitCode, "signal": p.signal, "started_at": p.startedAt, "exited_at": nullableString(p.exitedAt), "output_tail": text, "output_tail_truncated": truncated, "log_limit_reached": p.logLimitReached()}, nil
}
func nullableString(v string) any {
	if v == "" {
		return nil
	}
	return v
}

type cleanupPlan struct {
	installRoot, workerHome, binPath, tmuxSession string
	removeBin                                     bool
}

func unsafeDir(target string) bool {
	if target == "" {
		return true
	}
	resolved := filepath.Clean(target)
	home, _ := os.UserHomeDir()
	return resolved == string(os.PathSeparator) || resolved == filepath.Clean(home) || resolved == filepath.Dir(filepath.Clean(home))
}
func buildCleanupPlan() (cleanupPlan, error) {
	exe, err := os.Executable()
	if err != nil {
		return cleanupPlan{}, err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return cleanupPlan{}, err
	}
	return buildCleanupPlanFor(filepath.Dir(exe), workerHome())
}

func buildCleanupPlanFor(runtimeDir, home string) (cleanupPlan, error) {
	runtimeDir = filepath.Clean(runtimeDir)
	home = filepath.Clean(home)
	if filepath.Base(runtimeDir) != "current" {
		return cleanupPlan{}, fail("WORKER_UNINSTALL_UNSAFE", "Remote uninstall is allowed only for a verified installer-managed current directory.")
	}
	installRoot := filepath.Dir(runtimeDir)
	if unsafeDir(installRoot) || unsafeDir(home) {
		return cleanupPlan{}, fail("WORKER_UNINSTALL_UNSAFE", "Refusing to remove an unsafe worker directory.")
	}
	recordedRoot := readText(filepath.Join(home, "install-root"))
	if recordedRoot != "" && filepath.Clean(recordedRoot) != filepath.Clean(installRoot) {
		return cleanupPlan{}, fail("WORKER_UNINSTALL_UNSAFE", "Recorded install root does not match the running worker installation.")
	}
	recordedBin := readText(filepath.Join(home, "bin-path"))
	userHome, _ := os.UserHomeDir()
	binPath := recordedBin
	if binPath == "" {
		binPath = filepath.Join(userHome, ".local", "bin", "bot-report-worker")
	}
	removeBin := false
	if info, err := os.Lstat(binPath); err == nil && info.Mode()&os.ModeSymlink != 0 {
		if target, err := filepath.EvalSymlinks(binPath); err == nil {
			removeBin = isWithinRoot(target, installRoot)
		}
	}
	var cfg Config
	_, _ = readJSON(filepath.Join(home, "config.json"), &cfg)
	tmux := ""
	if cfg.TmuxCreatedByWorker {
		tmux = cfg.TmuxSession
	}
	return cleanupPlan{installRoot: installRoot, workerHome: home, binPath: binPath, removeBin: removeBin, tmuxSession: tmux}, nil
}
func applyCleanupPlan(plan cleanupPlan) (map[string]any, error) {
	if plan.tmuxSession != "" {
		_, _ = runFile("tmux", []string{"kill-session", "-t", "=" + plan.tmuxSession}, nil, 5*time.Second, 1024*1024)
	}
	if plan.removeBin {
		// Remove only verified compatibility aliases pointing into this installation.
		for _, name := range []string{"systemtd", "bot-report-worker"} {
			alias := filepath.Join(filepath.Dir(plan.binPath), name)
			if alias == plan.binPath {
				continue
			}
			if info, err := os.Lstat(alias); err == nil && info.Mode()&os.ModeSymlink != 0 {
				if target, err := filepath.EvalSymlinks(alias); err == nil && isWithinRoot(target, plan.installRoot) {
					if err := os.Remove(alias); err != nil {
						return nil, err
					}
				}
			}
		}
		if err := os.Remove(plan.binPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	if err := os.RemoveAll(plan.workerHome); err != nil {
		return nil, err
	}
	if err := platformPrepareUninstall(plan.installRoot); err != nil {
		return nil, err
	}
	if err := platformRemoveInstallRoot(plan.installRoot); err != nil {
		return nil, err
	}
	return map[string]any{"code": "UNINSTALLED", "installation_removed": true, "local_state_removed": true, "bin_removed": plan.removeBin, "tmux_removed": plan.tmuxSession != ""}, nil
}

type Agent struct {
	logger            io.Writer
	processLogDir     string
	cfg               Config
	state             State
	roots             []string
	maxJob            time.Duration
	privateKey        ed25519.PrivateKey
	processMu         sync.RWMutex
	processes         map[string]*managedProcess
	commandMu         sync.Mutex
	commands          map[int]*exec.Cmd
	shellMu           sync.Mutex
	shells            map[string]*shellSession
	resourceEmergency atomic.Bool
	shutting          atomic.Bool
	activeMu          sync.Mutex
	active            *websocket.Conn
}

func newAgent() (*Agent, error) {
	var cfg Config
	var state State
	ok1, err := readJSON(configPath(), &cfg)
	if err != nil {
		return nil, err
	}
	ok2, err := readJSON(statePath(), &state)
	if err != nil {
		return nil, err
	}
	if !ok1 || !ok2 || state.WorkerID == "" {
		return nil, fail("WORKER_NOT_LOGGED_IN", "Run systemtd login first.")
	}
	if cfg.ServerURL == "" || len(cfg.AllowedRoots) == 0 {
		return nil, fail("WORKER_CONFIG_INVALID", "Worker config is incomplete.")
	}
	roots, err := normalizeRoots(strings.Join(cfg.AllowedRoots, ","))
	if err != nil {
		return nil, err
	}
	priv, err := parsePrivateKey(state.PrivateKey)
	if err != nil {
		return nil, err
	}
	maxMS := cfg.MaxJobMS
	if maxMS <= 0 {
		maxMS = defaultMaxJobMS
	}
	maxMS = clamp(maxMS, 1000, defaultMaxJobMS)
	return &Agent{cfg: cfg, state: state, roots: roots, maxJob: time.Duration(maxMS) * time.Millisecond, privateKey: priv, processes: map[string]*managedProcess{}, commands: map[int]*exec.Cmd{}, shells: map[string]*shellSession{}}, nil
}
func (a *Agent) requireShell() error {
	if !a.cfg.AllowShell {
		return fail("WORKER_SHELL_DISABLED", "Shell execution is disabled by local worker policy.")
	}
	return nil
}
func rejectRunAs(payload map[string]any) error {
	if v, ok := payload["run_as"]; ok && v != nil && fmt.Sprint(v) != "" {
		return fail("WORKER_RUN_AS_UNSUPPORTED", "worker transport executes as the local worker OS user; run_as is not supported.")
	}
	return nil
}

func (a *Agent) executeOperation(operation string, p map[string]any) (any, error) {
	switch operation {
	case "shell.inspect":
		return a.shellInspect(p)
	case "shell.send":
		return a.shellSend(p)
	case "shell.read":
		return a.shellRead(p)
	case "shell.interrupt":
		return a.shellInterrupt(p)
	case "tmux.inspect":
		return inspectTmux(payloadString(p, "tmux_session"))
	case "tmux.send":
		info, err := inspectTmux(payloadString(p, "tmux_session"))
		if err != nil {
			return nil, err
		}
		target, err := singlePane(info)
		if err != nil {
			return nil, err
		}
		text := fmt.Sprint(p["text"])
		if text == "<nil>" {
			text = ""
		}
		if text == "" || len([]byte(text)) > 64*1024 {
			return nil, fail("INVALID_INPUT", "Terminal input must be 1 byte to 64 KiB.")
		}
		bufferName := "brw-" + randomHex(8)
		r, err := runFile("tmux", []string{"load-buffer", "-b", bufferName, "-"}, []byte(text), 10*time.Second, 2*1024*1024)
		if err != nil || r.code != 0 {
			return nil, fail("TMUX_INPUT_FAILED", "Unable to load tmux input buffer.")
		}
		r, err = runFile("tmux", []string{"paste-buffer", "-b", bufferName, "-t", target, "-d"}, nil, 10*time.Second, 2*1024*1024)
		if err != nil || r.code != 0 {
			return nil, fail("TMUX_INPUT_FAILED", "Unable to paste tmux input.")
		}
		if payloadBool(p, "submit", true) {
			r, err = runFile("tmux", []string{"send-keys", "-t", target, "Enter"}, nil, 10*time.Second, 2*1024*1024)
			if err != nil || r.code != 0 {
				return nil, fail("TMUX_INPUT_FAILED", "Unable to submit tmux input.")
			}
		}
		return map[string]any{"code": "INPUT_SENT", "target_pane": target, "pane_current_command": info["pane_current_command"]}, nil
	case "tmux.read":
		info, err := inspectTmux(payloadString(p, "tmux_session"))
		if err != nil {
			return nil, err
		}
		target, err := singlePane(info)
		if err != nil {
			return nil, err
		}
		lines := clamp(payloadInt(p, "lines", 200), 1, 10000)
		r, err := runFile("tmux", []string{"capture-pane", "-p", "-J", "-t", target, "-S", "-"}, nil, 10*time.Second, 2*1024*1024)
		if err != nil || r.code != 0 {
			return nil, fail("CAPTURE_FAILED", "Unable to read tmux history.")
		}
		text := strings.ReplaceAll(string(r.stdout), "\r\n", "\n")
		rows := strings.Split(text, "\n")
		if len(rows) > 0 && rows[len(rows)-1] == "" {
			rows = rows[:len(rows)-1]
		}
		count := len(rows)
		start := 0
		if count > lines {
			start = count - lines
		}
		return map[string]any{"text": strings.Join(rows[start:], "\n"), "lines": minInt(count, lines), "truncated": count > lines, "target_pane": target, "pane_current_command": info["pane_current_command"]}, nil
	case "tmux.interrupt":
		info, err := inspectTmux(payloadString(p, "tmux_session"))
		if err != nil {
			return nil, err
		}
		target, err := singlePane(info)
		if err != nil {
			return nil, err
		}
		r, err := runFile("tmux", []string{"send-keys", "-t", target, "C-c"}, nil, 10*time.Second, 2*1024*1024)
		if err != nil || r.code != 0 {
			return nil, fail("TMUX_INTERRUPT_FAILED", "Unable to send interrupt to tmux.")
		}
		return map[string]any{"code": "INTERRUPT_SENT", "target_pane": target, "pane_current_command": info["pane_current_command"]}, nil
	case "workspace.exec":
		if err := rejectRunAs(p); err != nil {
			return nil, err
		}
		if err := a.requireShell(); err != nil {
			return nil, err
		}
		command := payloadString(p, "command")
		if strings.TrimSpace(command) == "" || len(command) > 32000 || strings.ContainsRune(command, '\x00') {
			return nil, fail("INVALID_COMMAND", "Command is invalid.")
		}
		cwd := payloadString(p, "cwd")
		if cwd == "" {
			cwd = a.roots[0]
		}
		cwd, err := assertAllowedPath(cwd, a.roots, true)
		if err != nil {
			return nil, err
		}
		timeoutMS := clamp(payloadInt(p, "timeout_ms", 30000), 100, int(a.maxJob.Milliseconds()))
		maxBytes := int64(clamp(payloadInt(p, "max_output_bytes", 1024*1024), 1, 10*1024*1024))
		return a.runShell(command, cwd, time.Duration(timeoutMS)*time.Millisecond, maxBytes)
	case "artifact.collect":
		if err := rejectRunAs(p); err != nil {
			return nil, err
		}
		target, err := assertAllowedPath(payloadString(p, "path"), a.roots, true)
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(target)
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() {
			return nil, fail("ARTIFACT_NOT_FILE", "Artifact path is not a regular file.")
		}
		maxBytes := int64(clamp(payloadInt(p, "max_bytes", 2*1024*1024), 1, 10*1024*1024))
		if info.Size() > maxBytes {
			return nil, fail("ARTIFACT_TOO_LARGE", fmt.Sprintf("Artifact exceeds max_bytes (%d > %d).", info.Size(), maxBytes))
		}
		data, err := os.ReadFile(target)
		if err != nil {
			return nil, err
		}
		real, _ := filepath.EvalSymlinks(target)
		mimeType := mime.TypeByExtension(filepath.Ext(target))
		if mimeType == "" {
			mimeType = http.DetectContentType(data)
		}
		isText := strings.HasPrefix(mimeType, "text/") || strings.Contains(mimeType, "json") || strings.Contains(mimeType, "javascript") || strings.Contains(mimeType, "xml") || !bytes.Contains(data, []byte{0})
		sum := sha256.Sum256(data)
		var text any = nil
		if isText {
			text = string(data)
		}
		return map[string]any{"path": payloadString(p, "path"), "real_path": real, "size": info.Size(), "mime_type": mimeType, "sha256": hex.EncodeToString(sum[:]), "is_text": isText, "text": text}, nil
	case "file.write":
		if err := rejectRunAs(p); err != nil {
			return nil, err
		}
		target, err := assertAllowedPath(payloadString(p, "path"), a.roots, false)
		if err != nil {
			return nil, err
		}
		content := payloadString(p, "content")
		if len([]byte(content)) > 2*1024*1024 {
			return nil, fail("FILE_TOO_LARGE", "File content exceeds 2 MiB.")
		}
		dir := filepath.Dir(target)
		if payloadBool(p, "create_dirs", false) {
			if err := os.MkdirAll(dir, 0755); err != nil {
				return nil, err
			}
			if _, err := assertAllowedPath(dir, a.roots, true); err != nil {
				return nil, err
			}
		} else {
			if _, err := assertAllowedPath(dir, a.roots, true); err != nil {
				return nil, err
			}
		}
		tmp := filepath.Join(dir, "."+filepath.Base(target)+".brw-"+randomHex(6))
		if err := os.WriteFile(tmp, []byte(content), 0644); err != nil {
			return nil, err
		}
		if err := os.Rename(tmp, target); err != nil {
			_ = os.Remove(tmp)
			return nil, err
		}
		return map[string]any{"path": target}, nil
	case "process.start":
		return a.startManagedProcess(p)
	case "process.status":
		return a.processStatus(p)
	case "process.logs":
		return a.processLogs(p)
	case "process.stop":
		return a.processStop(p)
	case "worker.self_uninstall":
		if serviceManaged() {
			return nil, fail("WORKER_SERVICE_MANAGED", "Remote uninstall is refused while systemtd.service manages this Worker.")
		}
		if payloadString(p, "confirm") != "REMOVE_THIS_WORKER" {
			return nil, fail("WORKER_UNINSTALL_CONFIRMATION_REQUIRED", "Remote uninstall requires the fixed REMOVE_THIS_WORKER confirmation.")
		}
		plan, err := buildCleanupPlan()
		if err != nil {
			return nil, err
		}
		return applyCleanupPlan(plan)
	default:
		return nil, fail("WORKER_OPERATION_UNSUPPORTED", fmt.Sprintf("Unsupported worker operation '%s'.", operation))
	}
}
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (a *Agent) startManagedProcess(p map[string]any) (any, error) {
	if a.resourceEmergency.Load() {
		return nil, a.resourceEmergencyError()
	}
	if err := rejectRunAs(p); err != nil {
		return nil, err
	}
	if err := a.requireShell(); err != nil {
		return nil, err
	}
	cwd := payloadString(p, "cwd")
	if cwd == "" {
		cwd = a.roots[0]
	}
	var err error
	cwd, err = assertAllowedPath(cwd, a.roots, true)
	if err != nil {
		return nil, err
	}
	command := payloadString(p, "command")
	if strings.TrimSpace(command) == "" || len(command) > 32000 || strings.ContainsRune(command, '\x00') {
		return nil, fail("INVALID_COMMAND", "Command is invalid.")
	}
	a.processMu.Lock()
	defer a.processMu.Unlock()
	if a.shutting.Load() {
		return nil, fail("WORKER_SHUTTING_DOWN", "Worker is shutting down.")
	}
	if err := a.reserveManagedProcess(); err != nil {
		return nil, err
	}
	id := "brproc-" + randomHex(8)
	logDir := a.processLogDir
	if logDir == "" {
		logDir = filepath.Join(os.TempDir(), "bot-report-worker-process")
	}
	if err := os.MkdirAll(logDir, 0700); err != nil {
		return nil, err
	}
	logFilePath := filepath.Join(logDir, id+".log")
	logFile, err := os.OpenFile(logFilePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	cmd := platformShellCommand(command, "process")
	cmd.Dir = cwd
	cmd.Stdin = nil
	logWriter := &boundedProcessLog{file: logFile, limit: managedProcessLogBytes}
	cmd.Stdout = logWriter
	cmd.Stderr = logWriter
	// A child inheriting the output pipe must not block process reaping forever.
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		_ = os.Remove(logFilePath)
		return nil, err
	}
	record := &managedProcess{id: id, cmd: cmd, pid: cmd.Process.Pid, logPath: logFilePath, startedAt: time.Now().UTC().Format(time.RFC3339Nano), logFile: logFile, logWriter: logWriter, done: make(chan struct{})}
	a.processes[id] = record
	go func() {
		err := cmd.Wait()
		record.mu.Lock()
		defer record.mu.Unlock()
		code := 0
		if cmd.ProcessState != nil {
			code = cmd.ProcessState.ExitCode()
		}
		if err != nil && code == 0 {
			code = 1
		}
		record.exitCode = &code
		if s, ok := platformProcessSignal(cmd.ProcessState); ok {
			record.signal = &s
		}
		record.exitedAt = time.Now().UTC().Format(time.RFC3339Nano)
		_ = logFile.Close()
		close(record.done)
	}()
	if a.resourceEmergency.Load() {
		_ = platformTerminateWorkload(record.cmd, true)
		return nil, a.resourceEmergencyError()
	}
	return map[string]any{"process_id": id, "pid": record.pid, "state": "RUNNING", "started_at": record.startedAt}, nil
}
func (a *Agent) getProcess(id string) (*managedProcess, error) {
	a.processMu.RLock()
	record := a.processes[id]
	a.processMu.RUnlock()
	if record == nil {
		return nil, fail("PROCESS_NOT_FOUND", "Managed process not found on this worker.")
	}
	return record, nil
}
func (a *Agent) processStatus(p map[string]any) (any, error) {
	record, err := a.getProcess(payloadString(p, "process_id"))
	if err != nil {
		return nil, err
	}
	return record.snapshot(clamp(payloadInt(p, "lines", 200), 1, 1000))
}
func (a *Agent) processLogs(p map[string]any) (any, error) {
	record, err := a.getProcess(payloadString(p, "process_id"))
	if err != nil {
		return nil, err
	}
	cursor := int64(payloadInt(p, "cursor", 0))
	if cursor < 0 {
		cursor = 0
	}
	maxBytes := int64(clamp(payloadInt(p, "max_bytes", 64*1024), 1, 512*1024))
	f, err := os.Open(record.logPath)
	if err != nil && errors.Is(err, os.ErrNotExist) {
		return map[string]any{"process_id": record.id, "cursor": cursor, "next_cursor": cursor, "text": "", "eof": true, "truncated": false}, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := info.Size()
	if cursor > size {
		cursor = size
	}
	end := cursor + maxBytes
	if end > size {
		end = size
	}
	buf := make([]byte, end-cursor)
	if len(buf) > 0 {
		_, _ = f.ReadAt(buf, cursor)
	}
	return map[string]any{"process_id": record.id, "cursor": cursor, "next_cursor": end, "text": string(buf), "eof": end >= size, "truncated": end < size, "log_limit_reached": record.logLimitReached()}, nil
}
func (a *Agent) processStop(p map[string]any) (any, error) {
	record, err := a.getProcess(payloadString(p, "process_id"))
	if err != nil {
		return nil, err
	}
	record.mu.RLock()
	exited := record.exitedAt != ""
	record.mu.RUnlock()
	if exited {
		status, err := record.snapshot(clamp(payloadInt(p, "lines", 200), 1, 1000))
		if err == nil {
			status["forced"] = false
		}
		return status, err
	}
	_ = platformTerminateWorkload(record.cmd, false)
	grace := clamp(payloadInt(p, "grace_ms", 1000), 0, 30000)
	if grace > 0 {
		timer := time.NewTimer(time.Duration(grace) * time.Millisecond)
		select {
		case <-record.done:
		case <-timer.C:
		}
		timer.Stop()
	}
	record.mu.RLock()
	exited = record.exitedAt != ""
	record.mu.RUnlock()
	forced := false
	if !exited && payloadBool(p, "force", true) {
		forced = true
		_ = platformTerminateWorkload(record.cmd, true)
		time.Sleep(20 * time.Millisecond)
	}
	status, err := record.snapshot(clamp(payloadInt(p, "lines", 200), 1, 1000))
	if err == nil {
		status["forced"] = forced
	}
	return status, err
}

func (a *Agent) connectionHeaders() (http.Header, error) {
	priv := a.privateKey
	if len(priv) == 0 {
		return nil, fail("WORKER_PRIVATE_KEY_INVALID", "Worker private key is invalid.")
	}
	timestamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
	nonceBytes := make([]byte, 24)
	_, _ = rand.Read(nonceBytes)
	nonce := base64.RawURLEncoding.EncodeToString(nonceBytes)
	canonical := a.state.WorkerID + "\n" + timestamp + "\n" + nonce + "\n" + connectPath
	signature := ed25519.Sign(priv, []byte(canonical))
	headers := http.Header{}
	headers.Set("x-br-worker-id", a.state.WorkerID)
	headers.Set("x-br-worker-timestamp", timestamp)
	headers.Set("x-br-worker-nonce", nonce)
	headers.Set("x-br-worker-signature", base64.StdEncoding.EncodeToString(signature))
	headers.Set("x-br-worker-version", version)
	headers.Set("x-br-worker-runtime", "go")
	headers.Set("x-br-worker-platform", runtime.GOOS+"/"+runtime.GOARCH)
	headers.Set("x-br-worker-protocol", "1")
	return headers, nil
}
func (a *Agent) websocketURL() (string, error) {
	u, err := url.Parse(a.cfg.ServerURL)
	if err != nil {
		return "", err
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else if u.Scheme == "http" {
		u.Scheme = "ws"
	} else {
		return "", fail("WORKER_SERVER_URL_INVALID", "Server URL must use HTTP or HTTPS.")
	}
	u.Path = connectPath
	u.RawQuery = ""
	u.Fragment = ""
	return u.String(), nil
}

type safeSocket struct {
	ws *websocket.Conn
	mu sync.Mutex
}

func (s *safeSocket) sendJSON(value any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return s.ws.WriteJSON(value)
}
func (s *safeSocket) close(code int, reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
	_ = s.ws.Close()
}

func (a *Agent) handleJob(socket *safeSocket, message map[string]any) {
	jobID := payloadString(message, "job_id")
	operation := payloadString(message, "operation")
	if jobID == "" || operation == "" {
		return
	}
	if err := a.guardTaskStart(socket, operation); err != nil {
		_ = socket.sendJSON(map[string]any{"type": "result", "job_id": jobID, "ok": false, "error": map[string]any{"code": errorCode(err), "message": err.Error()}})
		return
	}
	payload, _ := message["payload"].(map[string]any)
	if payload == nil {
		payload = map[string]any{}
	}
	timeout := clamp(payloadInt(message, "timeout_ms", int(a.maxJob.Milliseconds())), 100, int(a.maxJob.Milliseconds()))
	type outcome struct {
		result any
		err    error
	}
	ch := make(chan outcome, 1)
	go func() { result, err := a.executeOperation(operation, payload); ch <- outcome{result, err} }()
	var out outcome
	select {
	case out = <-ch:
	case <-time.After(time.Duration(timeout) * time.Millisecond):
		out.err = fail("WORKER_JOB_TIMEOUT", "Worker job exceeded local timeout.")
	}
	if out.err != nil {
		_ = socket.sendJSON(map[string]any{"type": "result", "job_id": jobID, "ok": false, "error": map[string]any{"code": errorCode(out.err), "message": out.err.Error()}})
		return
	}
	_ = socket.sendJSON(map[string]any{"type": "result", "job_id": jobID, "ok": true, "result": out.result})
	if operation == "worker.self_uninstall" {
		a.shutting.Store(true)
		socket.close(websocket.CloseNormalClosure, "remote-uninstall")
		time.Sleep(80 * time.Millisecond)
		os.Exit(0)
	}
}

func (a *Agent) findShellByStream(streamID string) *shellSession {
	a.shellMu.Lock()
	sessions := make([]*shellSession, 0, len(a.shells))
	for _, session := range a.shells {
		sessions = append(sessions, session)
	}
	a.shellMu.Unlock()
	for _, session := range sessions {
		session.mu.Lock()
		_, ok := session.subscribers[streamID]
		session.mu.Unlock()
		if ok {
			return session
		}
	}
	return nil
}

func (a *Agent) streamError(socket *safeSocket, streamID string, err error) {
	_ = socket.sendJSON(map[string]any{"type": "stream_error", "stream_id": streamID, "error": map[string]any{"code": errorCode(err), "message": err.Error()}})
}

func (a *Agent) handleStreamOpen(socket *safeSocket, message map[string]any) {
	streamID := payloadString(message, "stream_id")
	operation := payloadString(message, "operation")
	if streamID == "" || operation != "shell.attach" {
		if streamID != "" {
			a.streamError(socket, streamID, fail("WORKER_OPERATION_UNSUPPORTED", "Only shell.attach streaming is supported."))
		}
		return
	}
	payload, _ := message["payload"].(map[string]any)
	if payload == nil {
		payload = map[string]any{}
	}
	cols := clamp(payloadInt(payload, "cols", 80), 2, 500)
	rows := clamp(payloadInt(payload, "rows", 24), 2, 200)
	session, err := a.getOrCreateShell(payloadString(payload, "session_key"), cols, rows)
	if err != nil {
		a.streamError(socket, streamID, err)
		return
	}
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		a.streamError(socket, streamID, fail("SHELL_CLOSED", "Worker shell is closed."))
		return
	}
	session.subscribers[streamID] = socket
	_ = session.terminal.Resize(cols, rows)
	history := append([]byte(nil), session.buffer...)
	if len(history) > 64*1024 {
		history = history[len(history)-64*1024:]
	}
	session.mu.Unlock()
	_ = socket.sendJSON(map[string]any{"type": "stream_state", "stream_id": streamID, "state": "CONNECTED"})
	if len(history) > 0 {
		_ = socket.sendJSON(map[string]any{"type": "stream_output", "stream_id": streamID, "data": base64.StdEncoding.EncodeToString(history)})
	}
}

func (a *Agent) handleStreamInput(socket *safeSocket, message map[string]any) {
	streamID := payloadString(message, "stream_id")
	if err := a.guardTaskStart(socket, "shell.send"); err != nil {
		a.streamError(socket, streamID, err)
		return
	}
	session := a.findShellByStream(streamID)
	if session == nil {
		a.streamError(socket, streamID, fail("SHELL_STREAM_NOT_FOUND", "Shell stream not found."))
		return
	}
	data, err := base64.StdEncoding.DecodeString(payloadString(message, "data"))
	if err != nil || len(data) == 0 || len(data) > 64*1024 {
		a.streamError(socket, streamID, fail("INVALID_INPUT", "Shell input must be 1 byte to 64 KiB."))
		return
	}
	session.mu.Lock()
	_, err = session.terminal.Write(data)
	session.mu.Unlock()
	if err != nil {
		a.streamError(socket, streamID, fail("SHELL_INPUT_FAILED", "Unable to write to the worker shell."))
	}
}

func (a *Agent) handleStreamResize(socket *safeSocket, message map[string]any) {
	streamID := payloadString(message, "stream_id")
	session := a.findShellByStream(streamID)
	if session == nil {
		return
	}
	cols := clamp(payloadInt(message, "cols", 80), 2, 500)
	rows := clamp(payloadInt(message, "rows", 24), 2, 200)
	session.mu.Lock()
	err := session.terminal.Resize(cols, rows)
	session.mu.Unlock()
	if err != nil {
		a.streamError(socket, streamID, fail("SHELL_RESIZE_FAILED", "Unable to resize the worker shell."))
	}
}

func (a *Agent) handleStreamClose(socket *safeSocket, message map[string]any) {
	streamID := payloadString(message, "stream_id")
	session := a.findShellByStream(streamID)
	if session != nil {
		session.mu.Lock()
		delete(session.subscribers, streamID)
		session.mu.Unlock()
	}
	_ = socket.sendJSON(map[string]any{"type": "stream_closed", "stream_id": streamID, "reason": "detached"})
}

func (a *Agent) connectOnce() (bool, error) {
	wsURL, err := a.websocketURL()
	if err != nil {
		return false, err
	}
	headers, err := a.connectionHeaders()
	if err != nil {
		return false, err
	}
	dialer := websocket.Dialer{HandshakeTimeout: 12 * time.Second}
	ws, resp, err := dialer.Dial(wsURL, headers)
	if err != nil {
		if resp != nil {
			return false, fmt.Errorf("websocket handshake failed HTTP %d: %w", resp.StatusCode, err)
		}
		return false, err
	}
	ws.SetReadLimit(maxPayloadBytes)
	socket := &safeSocket{ws: ws}
	a.activeMu.Lock()
	a.active = ws
	a.activeMu.Unlock()
	fmt.Fprintf(a.logOutput(), "[WORKER] connected pid=%d worker_id=%s server=%s runtime=go version=%s platform=%s/%s\n", os.Getpid(), a.state.WorkerID, a.cfg.ServerURL, version, runtime.GOOS, runtime.GOARCH)
	_ = socket.sendJSON(map[string]any{"type": "heartbeat", "at": time.Now().UTC().Format(time.RFC3339Nano), "runtime": "go", "version": version, "platform": runtime.GOOS + "/" + runtime.GOARCH, "capabilities": defaultCapabilities})
	heartbeatDone := make(chan struct{})
	resourceGuardDone := make(chan struct{})
	go a.monitorMemoryPressure(socket, resourceGuardDone)
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if a.shutting.Load() {
					return
				}
				_ = socket.sendJSON(map[string]any{"type": "heartbeat", "at": time.Now().UTC().Format(time.RFC3339Nano), "runtime": "go", "version": version, "platform": runtime.GOOS + "/" + runtime.GOARCH, "capabilities": defaultCapabilities})
			case <-heartbeatDone:
				return
			}
		}
	}()
	removed := false
	for !a.shutting.Load() {
		_, data, err := ws.ReadMessage()
		if err != nil {
			var closeErr *websocket.CloseError
			if errors.As(err, &closeErr) && closeErr.Code == 4004 && closeErr.Text == "worker-removed" {
				removed = true
				a.shutting.Store(true)
				fmt.Fprintln(a.logOutput(), "[WORKER] identity removed by server; worker stopped.")
			}
			break
		}
		var msg map[string]any
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		switch payloadString(msg, "type") {
		case "job":
			go a.handleJob(socket, msg)
		case "stream_open":
			go a.handleStreamOpen(socket, msg)
		case "stream_input":
			go a.handleStreamInput(socket, msg)
		case "stream_resize":
			go a.handleStreamResize(socket, msg)
		case "stream_close":
			go a.handleStreamClose(socket, msg)
		}
	}
	close(heartbeatDone)
	close(resourceGuardDone)
	a.activeMu.Lock()
	if a.active == ws {
		a.active = nil
	}
	a.activeMu.Unlock()
	_ = ws.Close()
	return removed, nil
}

func (a *Agent) run() error {
	fmt.Fprintf(a.logOutput(), "[WORKER] starting name=%s roots=%s shell=%s runtime=go version=%s\n", a.state.Name, strings.Join(a.roots, ","), map[bool]string{true: "enabled", false: "disabled"}[a.cfg.AllowShell], version)
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, platformShutdownSignals()...)
	go func() {
		sig := <-signals
		fmt.Fprintf(a.logOutput(), "[WORKER] shutdown %s\n", sig.String())
		a.shutdown()
	}()
	attempt := 0
	for !a.shutting.Load() {
		removed, err := a.connectOnce()
		if removed || a.shutting.Load() {
			return nil
		}
		if err != nil {
			fmt.Fprintf(a.logOutput(), "[WORKER] websocket error: %v\n", err)
		} else {
			attempt = 0
		}
		attempt++
		power := attempt - 1
		if power > 5 {
			power = 5
		}
		delay := time.Second*time.Duration(1<<power) + time.Duration(time.Now().UnixNano()%500)*time.Millisecond
		fmt.Fprintf(a.logOutput(), "[WORKER] disconnected; reconnecting in %s\n", delay.Round(time.Millisecond))
		time.Sleep(delay)
	}
	return nil
}
func (a *Agent) shutdown() {
	if a.shutting.Swap(true) {
		return
	}
	// Shutdown must include one-shot jobs, not only persistent process records.
	a.stopWorkerOwnedWorkloads()
	a.shellMu.Lock()
	shells := make([]*shellSession, 0, len(a.shells))
	for _, session := range a.shells {
		shells = append(shells, session)
	}
	a.shellMu.Unlock()
	for _, session := range shells {
		session.mu.Lock()
		if !session.closed {
			_ = platformTerminateWorkload(session.cmd, false)
			_ = session.terminal.Close()
		}
		session.mu.Unlock()
	}
	a.activeMu.Lock()
	ws := a.active
	a.activeMu.Unlock()
	if ws != nil {
		_ = ws.Close()
	}
}

func uninstallLocal() error {
	if serviceManaged() {
		return fail("WORKER_SERVICE_MANAGED", "systemtd is managed by systemtd.service; service-managed uninstall requires an explicit administrative service removal flow.")
	}
	if err := stopWorker(); err != nil {
		return err
	}
	plan, err := buildCleanupPlan()
	if err != nil {
		return err
	}
	result, err := applyCleanupPlan(plan)
	if err != nil {
		return err
	}
	fmt.Printf("[bot-report-worker] uninstalled local_state=%s installation=%s\n", boolWord(result["local_state_removed"]), boolWord(result["installation_removed"]))
	return nil
}
func boolWord(v any) string {
	if b, ok := v.(bool); ok && b {
		return "removed"
	}
	return "kept"
}

func (a *Agent) logOutput() io.Writer {
	if a.logger != nil {
		return a.logger
	}
	return os.Stderr
}

func runForeground(detached bool) (runErr error) {
	if err := ensureWorkerHome(); err != nil {
		return err
	}
	owner, err := openLogOwner(workerHome())
	if err != nil {
		return err
	}
	defer owner.Close()
	var logger io.Writer = os.Stderr
	if serviceManaged() || detached {
		logFile, err := newRotatingDaemonLog(logPath(), daemonLogBytes)
		if err != nil {
			return err
		}
		defer logFile.Close()
		logger = logFile
		defer func() {
			if runErr != nil {
				fmt.Fprintf(logger, "[WORKER] startup/runtime error: %v\n", runErr)
			}
		}()
	}
	sessionDir, err := prepareProcessSession(workerHome(), time.Now())
	if err != nil {
		return err
	}
	pid := os.Getpid()
	if err := os.WriteFile(pidPath(), []byte(fmt.Sprintf("%d\n", pid)), 0600); err != nil {
		return err
	}
	defer func() {
		if readText(pidPath()) == strconv.Itoa(pid) {
			_ = os.Remove(pidPath())
		}
	}()
	agent, err := newAgent()
	if err != nil {
		return err
	}
	agent.logger = logger
	agent.processLogDir = sessionDir
	return agent.run()
}

func main() {
	command, options, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "[bot-report-worker] %s: %s\n", errorCode(err), err.Error())
		os.Exit(1)
	}
	switch command {
	case "help":
		printHelp()
		return
	case "version":
		fmt.Printf("systemtd %s commit=%s runtime=%s %s/%s\n", version, commit, runtime.Version(), runtime.GOOS, runtime.GOARCH)
		return
	case "login":
		err = login(options)
	case "start":
		if serviceManaged() {
			err = platformStartManagedService()
		} else {
			_, err = startDetached(true)
		}
	case "stop":
		if serviceManaged() {
			err = fail("WORKER_SERVICE_MANAGED", "systemtd is managed by systemtd.service; manual stop is refused to prevent accidental shutdown.")
		} else {
			err = stopWorker()
		}
	case "restart":
		if serviceManaged() {
			err = platformRestartManagedService()
		} else {
			if stopErr := stopWorker(); stopErr != nil {
				err = stopErr
			} else {
				_, err = startDetached(true)
			}
		}
	case "status":
		err = printStatus()
	case "logs":
		fmt.Print(tailLog(64 * 1024))
		return
	case "run", "__agent":
		err = runForeground(command == "__agent")
	case "uninstall":
		err = uninstallLocal()
	default:
		err = fail("CLI_COMMAND_UNKNOWN", fmt.Sprintf("Unknown command '%s'. Run systemtd help.", command))
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "[bot-report-worker] %s: %s\n", errorCode(err), err.Error())
		os.Exit(1)
	}
}
