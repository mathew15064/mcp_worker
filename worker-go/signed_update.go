package main

// Signed updates deliberately require an exact, owner-reviewed target. We never
// trust "latest", a server-provided executable, or a caller-supplied signing key.

import (
	"bytes"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

var canonicalReleaseFiles = []string{
	"worker_mcp-darwin-amd64", "worker_mcp-darwin-arm64",
	"worker_mcp-linux-386", "worker_mcp-linux-amd64",
	"worker_mcp-linux-arm64", "worker_mcp-linux-armv7",
	"worker_mcp-windows-amd64.exe", "worker_mcp-windows-arm64.exe",
	"WORKER_RELEASE",
}
var releaseSemver = regexp.MustCompile("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$")
var releaseSHA = regexp.MustCompile("^[0-9a-f]{64}$")
var releaseCommit = regexp.MustCompile("^[0-9a-f]{40}$")

func compareReleaseVersion(a, b string) (int, error) {
	if !releaseSemver.MatchString(a) || !releaseSemver.MatchString(b) {
		return 0, fail("WORKER_RELEASE_VERSION_INVALID", "Release version must be canonical semver.")
	}
	x, y := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < 3; i++ {
		if len(x[i]) != len(y[i]) {
			if len(x[i]) < len(y[i]) {
				return -1, nil
			}
			return 1, nil
		}
		if x[i] < y[i] {
			return -1, nil
		}
		if x[i] > y[i] {
			return 1, nil
		}
	}
	return 0, nil
}

func releaseArtifactName() (string, error) {
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "linux/amd64":
		return "worker_mcp-linux-amd64", nil
	case "linux/arm64":
		return "worker_mcp-linux-arm64", nil
	case "linux/386":
		return "worker_mcp-linux-386", nil
	case "linux/arm":
		return "worker_mcp-linux-armv7", nil
	case "darwin/amd64":
		return "worker_mcp-darwin-amd64", nil
	case "darwin/arm64":
		return "worker_mcp-darwin-arm64", nil
	case "windows/amd64":
		return "worker_mcp-windows-amd64.exe", nil
	case "windows/arm64":
		return "worker_mcp-windows-arm64.exe", nil
	default:
		return "", fail("WORKER_UPDATE_ARCH_UNSUPPORTED", "Unsupported native release platform.")
	}
}

func parseReleaseManifest(data []byte) (map[string]string, error) {
	if !bytes.HasSuffix(data, []byte("\n")) || bytes.Contains(data, []byte("\r")) {
		return nil, fail("WORKER_RELEASE_MANIFEST_INVALID", "Noncanonical checksum line endings.")
	}
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	if len(lines) != len(canonicalReleaseFiles) {
		return nil, fail("WORKER_RELEASE_MANIFEST_INVALID", "Signed release must have exactly nine entries.")
	}
	result := map[string]string{}
	for i, line := range lines {
		expected := canonicalReleaseFiles[i]
		if len(line) != 66+len(expected) || line[64:66] != "  " || line[66:] != expected || !releaseSHA.MatchString(line[:64]) {
			return nil, fail("WORKER_RELEASE_MANIFEST_INVALID", "Signed release inventory is not canonical.")
		}
		result[expected] = line[:64]
	}
	return result, nil
}

func readUpdateRecord(name string) (string, error) {
	path := filepath.Join(workerHome(), name)
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fail("WORKER_UPDATE_TRUST_INVALID", "Unsafe or missing signed release record: "+name)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func pinnedReleaseKey() (*rsa.PublicKey, error) {
	keyPath := filepath.Join(workerHome(), "release-public-key.pem")
	info, err := os.Lstat(keyPath)
	if os.IsNotExist(err) {
		return nil, fail("WORKER_UPDATE_TRUST_MISSING", "No installed verified public key. Use the separately approved signed installer first.")
	}
	if err != nil || !info.Mode().IsRegular() {
		return nil, fail("WORKER_UPDATE_TRUST_INVALID", "Unsafe installed public key.")
	}
	keyData, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, err
	}
	block, trailing := pem.Decode(keyData)
	if block == nil || len(bytes.TrimSpace(trailing)) != 0 || block.Type != "PUBLIC KEY" {
		return nil, fail("WORKER_UPDATE_TRUST_INVALID", "Invalid pinned RSA public key PEM.")
	}
	keyAny, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fail("WORKER_UPDATE_TRUST_INVALID", "Cannot parse signed release public key.")
	}
	key, ok := keyAny.(*rsa.PublicKey)
	if !ok || key.N.BitLen() < 2048 {
		return nil, fail("WORKER_UPDATE_TRUST_INVALID", "Invalid RSA release key.")
	}
	fingerprint := fmt.Sprintf("%x", sha256.Sum256(block.Bytes))
	recorded, err := readUpdateRecord("release-key-sha256")
	if err != nil || !releaseSHA.MatchString(recorded) || recorded != fingerprint {
		return nil, fail("WORKER_UPDATE_TRUST_INVALID", "Signing key differs from the installed trusted fingerprint.")
	}
	return key, nil
}

func newSignedReleaseClient() *http.Client {
	return &http.Client{
		Timeout: 45 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 5 || req.URL.Scheme != "https" {
				return fail("WORKER_UPDATE_REDIRECT_UNTRUSTED", "Release redirect must remain HTTPS (maximum five redirects).")
			}
			return nil
		},
	}
}

func downloadReleaseFile(client *http.Client, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fail("WORKER_UPDATE_DOWNLOAD_FAILED", fmt.Sprintf("Release HTTP %d", resp.StatusCode))
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fail("WORKER_UPDATE_SIZE_INVALID", "Release asset exceeds size limit.")
	}
	return data, nil
}

func sha256Text(data []byte) string { hash := sha256.Sum256(data); return hex.EncodeToString(hash[:]) }

func verifySignedRelease(client *http.Client, base string, version, commit, manifestPin string, key *rsa.PublicKey, filename string) ([]byte, error) {
	sums, err := downloadReleaseFile(client, base+"/SHA256SUMS", 4096)
	if err != nil {
		return nil, err
	}
	if sha256Text(sums) != manifestPin {
		return nil, fail("WORKER_UPDATE_MANIFEST_MISMATCH", "Signed manifest differs from independently approved digest.")
	}
	hashes, err := parseReleaseManifest(sums)
	if err != nil {
		return nil, err
	}
	signature, err := downloadReleaseFile(client, base+"/SHA256SUMS.sig", 8192)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(sums)
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], signature); err != nil {
		return nil, fail("WORKER_UPDATE_SIGNATURE_INVALID", "Release manifest signature is not trusted.")
	}
	metadata, err := downloadReleaseFile(client, base+"/WORKER_RELEASE", 512)
	if err != nil {
		return nil, err
	}
	if sha256Text(metadata) != hashes["WORKER_RELEASE"] ||
		!bytes.Equal(metadata, []byte("version="+version+"\ncommit="+commit+"\n")) {
		return nil, fail("WORKER_UPDATE_METADATA_INVALID", "Release metadata does not match approved source and signed checksum.")
	}
	binary, err := downloadReleaseFile(client, base+"/"+filename, 150*1024*1024)
	if err != nil {
		return nil, err
	}
	if sha256Text(binary) != hashes[filename] {
		return nil, fail("WORKER_UPDATE_BINARY_INVALID", "Platform binary checksum mismatch.")
	}
	return binary, nil
}

func updateSignedRelease(options cliOptions) error {
	versionTarget := options["version"]
	commitTarget := options["commit"]
	manifestPin := options["manifest-sha256"]
	if !releaseSemver.MatchString(versionTarget) || !releaseCommit.MatchString(commitTarget) || !releaseSHA.MatchString(manifestPin) {
		return fail("WORKER_UPDATE_APPROVAL_REQUIRED", "Exact approved --version, full --commit and --manifest-sha256 are required.")
	}
	for key := range options {
		if key != "version" && key != "commit" && key != "manifest-sha256" {
			return fail("CLI_ARGUMENT_INVALID", "Unsupported update option: "+key)
		}
	}
	// The CLI has no base-URL override: only owner-reviewed GitHub source releases.
	base := "https://github.com/mathew15064/mcp_worker/releases/download/v" + versionTarget
	return performSignedUpdate(newSignedReleaseClient(), base, versionTarget, commitTarget, manifestPin)
}

func performSignedUpdate(client *http.Client, releaseBase, versionTarget, commitTarget, manifestPin string) error {
	if runtime.GOOS == "windows" {
		return fail("WORKER_UPDATE_NATIVE_INSTALLER_REQUIRED", "Windows requires the owner-reviewed signed PowerShell installer; self-replacing a running .exe is unsafe.")
	}
	if !releaseSemver.MatchString(versionTarget) || !releaseCommit.MatchString(commitTarget) || !releaseSHA.MatchString(manifestPin) {
		return fail("WORKER_UPDATE_APPROVAL_REQUIRED", "Exact owner-reviewed release pins are required.")
	}
	if serviceManaged() || clearStalePID() != 0 {
		return fail("WORKER_UPDATE_RUNNING", "Stop the Worker and use an approved service installer for managed installations.")
	}
	oldVersion, err := readUpdateRecord("release-version")
	if err != nil {
		return fail("WORKER_UPDATE_TRUST_MISSING", "Missing signed install release-version.")
	}
	oldCommit, err := readUpdateRecord("release-commit")
	if err != nil || !releaseCommit.MatchString(oldCommit) {
		return fail("WORKER_UPDATE_TRUST_INVALID", "Invalid installed source commit.")
	}
	oldManifest, err := readUpdateRecord("release-manifest-sha256")
	if err != nil || !releaseSHA.MatchString(oldManifest) {
		return fail("WORKER_UPDATE_TRUST_INVALID", "Invalid installed manifest digest.")
	}
	relation, err := compareReleaseVersion(versionTarget, oldVersion)
	if err != nil {
		return err
	}
	if relation <= 0 {
		return fail("WORKER_UPDATE_DOWNGRADE", "Update requires strictly higher signed version; manual downgrade is forbidden.")
	}
	key, err := pinnedReleaseKey()
	if err != nil {
		return err
	}
	filename, err := releaseArtifactName()
	if err != nil {
		return err
	}
	root, err := readUpdateRecord("install-root")
	if err != nil || !filepath.IsAbs(root) {
		return fail("WORKER_UPDATE_TRUST_INVALID", "Missing or invalid signed install root.")
	}
	binaryPath := filepath.Join(root, "current", "worker_mcp")
	for _, path := range []string{workerHome(), root, filepath.Join(root, "current"), binaryPath} {
		info, statErr := os.Lstat(path)
		if statErr != nil || info.Mode()&os.ModeSymlink != 0 {
			return fail("WORKER_UPDATE_TRUST_INVALID", "Missing or symlinked installed binary path.")
		}
	}
	lock := filepath.Join(root, ".install-lock")
	if err := os.Mkdir(lock, 0700); err != nil {
		return fail("WORKER_UPDATE_LOCKED", "Another installer is active or stale lock exists.")
	}
	defer os.Remove(lock)
	// A checked-in or dev runtime cannot silently modify unrelated installation paths.
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	runningInfo, err := os.Stat(exe)
	if err != nil {
		return err
	}
	targetInfo, err := os.Stat(binaryPath)
	if err != nil || !os.SameFile(runningInfo, targetInfo) {
		return fail("WORKER_UPDATE_PATH_MISMATCH", "Run update from the installed verified Worker binary.")
	}
	binary, err := verifySignedRelease(client, releaseBase, versionTarget, commitTarget, manifestPin, key, filename)
	if err != nil {
		return err
	}
	stage, err := os.CreateTemp(filepath.Dir(binaryPath), ".mcp_worker.update-")
	if err != nil {
		return err
	}
	stagePath := stage.Name()
	defer os.Remove(stagePath)
	if _, err := stage.Write(binary); err != nil {
		_ = stage.Close()
		return err
	}
	if err := stage.Chmod(0755); err != nil {
		_ = stage.Close()
		return err
	}
	if err := stage.Close(); err != nil {
		return err
	}
	output, err := exec.Command(stagePath, "version").CombinedOutput()
	if err != nil || len(output) > 512 || bytes.Count(output, []byte("\n")) != 1 ||
		!bytes.HasPrefix(output, []byte("worker_mcp "+versionTarget+" commit="+commitTarget+" runtime=")) {
		return fail("WORKER_UPDATE_RUNTIME_INVALID", "Downloaded binary identity does not match approved signed release.")
	}
	// Stage all release records first so disk/storage errors never replace a valid runtime.
	recordNames := []string{"release-version", "release-commit", "release-manifest-sha256"}
	oldData := [][]byte{}
	for _, name := range recordNames {
		content, err := os.ReadFile(filepath.Join(workerHome(), name))
		if err != nil {
			return err
		}
		oldData = append(oldData, content)
	}
	// Validate backup destination before mutation (including symlinked previous).
	previous := filepath.Join(root, "previous")
	if info, statErr := os.Lstat(previous); statErr == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fail("WORKER_UPDATE_TRUST_INVALID", "Unsafe previous release directory.")
		}
	} else if !os.IsNotExist(statErr) {
		return statErr
	} else if err := os.Mkdir(previous, 0700); err != nil {
		return err
	}
	backup := binaryPath + ".recovery-" + randomHex(8)
	oldExecutable, err := os.Open(binaryPath)
	if err != nil {
		return err
	}
	defer oldExecutable.Close()
	backupFile, err := os.OpenFile(backup, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0700)
	if err != nil {
		return err
	}
	if _, err := io.Copy(backupFile, oldExecutable); err != nil {
		_ = backupFile.Close()
		_ = os.Remove(backup)
		return err
	}
	if err := backupFile.Sync(); err != nil {
		_ = backupFile.Close()
		_ = os.Remove(backup)
		return err
	}
	if err := backupFile.Close(); err != nil {
		_ = os.Remove(backup)
		return err
	}
	// One atomic rename replaces the target; until then the old executable stays available.
	restore := func(cause error) error {
		_ = os.Remove(binaryPath)
		if err := os.Rename(backup, binaryPath); err != nil {
			return fmt.Errorf("%w; CRITICAL: previous executable remains at %s: %v", cause, backup, err)
		}
		for i, name := range recordNames {
			if err := os.WriteFile(filepath.Join(workerHome(), name), oldData[i], 0600); err != nil {
				return fmt.Errorf("%w; CRITICAL: restoring %s failed: %v", cause, name, err)
			}
		}
		return cause
	}
	if err := os.Rename(stagePath, binaryPath); err != nil {
		_ = os.Remove(backup)
		return err
	}
	// Verify the executable in its final location before committing metadata.
	out, err := exec.Command(binaryPath, "version").CombinedOutput()
	if err != nil || !bytes.Equal(out, output) {
		return restore(fail("WORKER_UPDATE_RUNTIME_INVALID", "Installed binary failed verification; restored previous executable."))
	}
	for i, name := range recordNames {
		content := []byte([]string{versionTarget + "\n", commitTarget + "\n", manifestPin + "\n"}[i])
		if err := writeReleaseRecordAtomic(filepath.Join(workerHome(), name), content); err != nil {
			return restore(err)
		}
	}
	if err := os.Rename(backup, filepath.Join(previous, "worker_mcp")); err != nil {
		return restore(err)
	}
	fmt.Printf("[mcp_worker] signed release updated to %s commit=%s. Worker remains stopped; run mcp_worker start.\n", versionTarget, commitTarget)
	return nil
}

func writeReleaseRecordAtomic(path string, content []byte) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return fail("WORKER_UPDATE_TRUST_INVALID", "Unsafe existing update metadata.")
	}
	tmp := path + "." + randomHex(8) + ".tmp"
	if err := os.WriteFile(tmp, content, 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
