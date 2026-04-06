package daemon

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLockFile_WriteAndRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "daemon.json")

	info := LockInfo{Port: 4590, Token: "abc123", Pid: 12345}
	if err := WriteLockFile(path, info); err != nil {
		t.Fatalf("WriteLockFile: %v", err)
	}

	got, err := ReadLockFile(path)
	if err != nil {
		t.Fatalf("ReadLockFile: %v", err)
	}
	if got.Port != 4590 || got.Token != "abc123" || got.Pid != 12345 {
		t.Errorf("unexpected lock info: %+v", got)
	}
}

func TestLockFile_ReadMissing(t *testing.T) {
	_, err := ReadLockFile("/nonexistent/path/daemon.json")
	if err == nil {
		t.Fatal("expected error for missing lock file")
	}
}

func TestLockFile_Remove(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "daemon.json")

	info := LockInfo{Port: 4590, Token: "t", Pid: 1}
	WriteLockFile(path, info)
	RemoveLockFile(path)

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("expected lock file to be removed")
	}
}
