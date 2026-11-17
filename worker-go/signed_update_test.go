package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSignedReleaseValidationAndDowngrade(t *testing.T) {
	for _, test := range []struct {
		a, b string
		cmp  int
	}{
		{"1.0.1", "1.0.0", 1}, {"0.9.9", "1.0.0", -1},
		{"9999999999999999999999999999.0.0", "9999999999999999999999999998.0.0", 1},
		{"1.2.3", "1.2.3", 0},
	} {
		value, err := compareReleaseVersion(test.a, test.b)
		if err != nil || value != test.cmp {
			t.Fatalf("%+v: %d %v", test, value, err)
		}
	}
	for _, bad := range []string{"1.2", "01.0.0", "1.0.0-rc", "v1.0.0"} {
		if _, err := compareReleaseVersion(bad, "1.0.0"); err == nil {
			t.Fatalf("accepted malformed semver: %s", bad)
		}
	}
	if err := updateSignedRelease(cliOptions{}); errorCode(err) != "WORKER_UPDATE_APPROVAL_REQUIRED" {
		t.Fatalf("unsigned CLI update accepted: %v", err)
	}
}

func makeSignedUpdateFixture(t *testing.T, tamper string) (func(), *http.Client, string, string, string, []byte) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	keyPem := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	version := "2.5.0"
	commit := strings.Repeat("a", 40)
	artifact, err := releaseArtifactName()
	if err != nil {
		t.Fatal(err)
	}
	binary := []byte("#!/bin/sh\nif [ \"$1\" = version ]; then echo 'worker_mcp " + version + " commit=" + commit + " runtime=go-fixture linux/amd64'; exit 0; fi\nexit 0\n")
	if tamper == "runtime_after_replace" {
		binary = []byte("#!/bin/sh\ncase \"$0\" in *update-*) echo 'worker_mcp " + version + " commit=" + commit + " runtime=go-fixture linux/amd64'; exit 0 ;; *) exit 9 ;; esac\n")
	}
	meta := []byte("version=" + version + "\ncommit=" + commit + "\n")
	parts := []string{}
	for _, name := range canonicalReleaseFiles {
		contents := []byte(name)
		if name == "WORKER_RELEASE" {
			contents = meta
		}
		if name == artifact {
			contents = binary
		}
		parts = append(parts, sha256Text(contents)+"  "+name)
	}
	sums := []byte(strings.Join(parts, "\n") + "\n")
	manifestHash := sha256Text(sums)
	digest := sha256.Sum256(sums)
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	assets := map[string][]byte{
		"SHA256SUMS": sums, "SHA256SUMS.sig": sig, "WORKER_RELEASE": meta, artifact: binary,
	}
	switch tamper {
	case "signature":
		assets["SHA256SUMS.sig"] = []byte("forged")
	case "metadata":
		assets["WORKER_RELEASE"] = []byte("different\n")
	case "binary":
		assets[artifact] = []byte("tampered executable")
	case "manifest":
		assets["SHA256SUMS"] = []byte("wrong manifest")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, ok := assets[filepath.Base(r.URL.Path)]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(b)
	}))
	t.Setenv("MCP_WORKER_WORKER_HOME", filepath.Join(t.TempDir(), "worker"))
	home := workerHome()
	if err := os.MkdirAll(home, 0700); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "install")
	if err := os.MkdirAll(filepath.Join(root, "current"), 0700); err != nil {
		t.Fatal(err)
	}
	realExec, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Link(realExec, filepath.Join(root, "current", "worker_mcp")); err != nil {
		t.Skipf("cannot hardlink current test executable: %v", err)
	}
	for name, value := range map[string]string{
		"release-version":         "1.0.0\n",
		"release-commit":          strings.Repeat("b", 40) + "\n",
		"release-manifest-sha256": strings.Repeat("c", 64) + "\n",
		"release-key-sha256":      sha256Text(der) + "\n",
		"install-root":            root + "\n",
	} {
		if err := os.WriteFile(filepath.Join(home, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(home, "release-public-key.pem"), keyPem, 0600); err != nil {
		t.Fatal(err)
	}
	return server.Close, server.Client(), server.URL, commit, manifestHash, binary
}

func TestSignedUpdateRejectsTamperedArtifactsBeforeReplacement(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows uses approved PowerShell installer")
	}
	for _, tamper := range []string{"signature", "metadata", "binary", "manifest", "runtime_after_replace"} {
		t.Run(tamper, func(t *testing.T) {
			closeServer, client, url, commit, hash, _ := makeSignedUpdateFixture(t, tamper)
			defer closeServer()
			err := performSignedUpdate(client, url, "2.5.0", commit, hash)
			if err == nil {
				t.Fatal("invalid release installed")
			}
			version, _ := readUpdateRecord("release-version")
			if version != "1.0.0" {
				t.Fatalf("existing release record changed: %s, %v", version, err)
			}
			root, _ := readUpdateRecord("install-root")
			if _, statErr := os.Stat(filepath.Join(root, "current", "worker_mcp")); statErr != nil {
				t.Fatalf("original executable lost after failed update: %v", statErr)
			}
			if tamper == "runtime_after_replace" {
				manifest, _ := readUpdateRecord("release-manifest-sha256")
				if manifest != strings.Repeat("c", 64) {
					t.Fatalf("rollback changed original manifest record: %s", manifest)
				}
			}
		})
	}
}

func TestSignedUpdateAtomicLifecycle(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows uses approved PowerShell installer")
	}
	closeServer, client, url, commit, hash, binary := makeSignedUpdateFixture(t, "")
	defer closeServer()
	if err := performSignedUpdate(client, url, "2.5.0", commit, hash); err != nil {
		t.Fatalf("approved fixture upgrade: %v", err)
	}
	version, _ := readUpdateRecord("release-version")
	if version != "2.5.0" {
		t.Fatalf("release version not committed: %s", version)
	}
	recorded, _ := readUpdateRecord("release-manifest-sha256")
	if recorded != hash {
		t.Fatalf("manifest record mismatch: %s", recorded)
	}
	root, _ := readUpdateRecord("install-root")
	actual, err := os.ReadFile(filepath.Join(root, "current", "worker_mcp"))
	if err != nil || string(actual) != string(binary) {
		t.Fatalf("wrong installed binary: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "previous", "worker_mcp")); err != nil {
		t.Fatalf("prior binary not retained: %v", err)
	}
	if err := performSignedUpdate(client, url, "1.0.0", commit, hash); errorCode(err) != "WORKER_UPDATE_DOWNGRADE" {
		t.Fatalf("downgrade was allowed: %v", err)
	}
	fmt.Fprint(os.Stdout, "approved disposable signed update, rollback record, downgrade: PASS\n")
}
