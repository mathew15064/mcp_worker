package main

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestDaemonRotationAndRestart(t *testing.T) {
	p := filepath.Join(t.TempDir(), "worker.log")
	for i := 0; i < 2; i++ {
		w, e := newRotatingDaemonLog(p, 64)
		if e != nil {
			t.Fatal(e)
		}
		payload := bytes.Repeat([]byte("abcdefgh"), 40)
		if n, e := w.Write(payload); e != nil || n != len(payload) {
			t.Fatal(n, e)
		}
		if e = w.Close(); e != nil {
			t.Fatal(e)
		}
	}
	for _, suffix := range []string{"", ".1", ".2", ".3"} {
		s, e := os.Stat(p + suffix)
		if e != nil || s.Size() > 64 {
			t.Fatal(s, e)
		}
	}
	if _, e := os.Stat(p + ".4"); !os.IsNotExist(e) {
		t.Fatal("unexpected fourth archive")
	}
}
func TestWorkerLogOwnerExclusiveAndReleased(t *testing.T) {
	home := t.TempDir()
	first, e := openLogOwner(home)
	if e != nil {
		t.Fatal(e)
	}
	if second, e := openLogOwner(home); e == nil {
		second.Close()
		first.Close()
		t.Fatal("second owner admitted")
	}
	first.Close()
	second, e := openLogOwner(home)
	if e != nil {
		t.Fatal(e)
	}
	second.Close()
}
func TestProcessSessionRetentionAndUnknownEntries(t *testing.T) {
	home := t.TempDir()
	now := time.Now()
	lock, e := openLogOwner(home)
	if e != nil {
		t.Fatal(e)
	}
	defer lock.Close()
	var sessions []string
	for i := 0; i < 5; i++ {
		s, e := prepareProcessSession(home, now.Add(time.Duration(i)*time.Minute))
		if e != nil {
			t.Fatal(e)
		}
		sessions = append(sessions, s)
		if e = os.WriteFile(filepath.Join(s, "brproc-0123456789abcdef.log"), []byte("log"), 0600); e != nil {
			t.Fatal(e)
		}
		if e = os.Chtimes(s, now.Add(time.Duration(i)*time.Minute), now.Add(time.Duration(i)*time.Minute)); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := os.Stat(sessions[0]); !os.IsNotExist(e) {
		t.Fatal("old session retained")
	}
	for _, s := range sessions[2:] {
		if _, e := os.Stat(s); e != nil {
			t.Fatal(e)
		}
	}
	unknown := filepath.Join(sessions[2], "unexpected.txt")
	if e = os.WriteFile(unknown, []byte("keep"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := prepareProcessSession(home, now.Add(8*24*time.Hour)); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(unknown); e != nil {
		t.Fatal("unknown file removed", e)
	}
	if _, e := os.Stat(sessions[3]); !os.IsNotExist(e) {
		t.Fatal("expired session retained")
	}
}
func TestRetentionRejectsSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink privilege")
	}
	home := t.TempDir()
	target := filepath.Join(t.TempDir(), "target")
	if e := os.WriteFile(target, []byte("untouched"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.Symlink(target, filepath.Join(home, "worker.log")); e != nil {
		t.Fatal(e)
	}
	if w, e := newRotatingDaemonLog(filepath.Join(home, "worker.log"), 64); e == nil {
		w.Close()
		t.Fatal("symlink followed")
	}
	if e := os.Symlink(target, filepath.Join(home, "process-logs-v1")); e != nil {
		t.Fatal(e)
	}
	if _, e := prepareProcessSession(home, time.Now()); e == nil {
		t.Fatal("symlink directory followed")
	}
	if b, e := os.ReadFile(target); e != nil || !strings.EqualFold(string(b), "untouched") {
		t.Fatal("target changed")
	}
}
