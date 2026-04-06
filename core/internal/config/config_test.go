package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefault(t *testing.T) {
	cfg := Default()
	if cfg.Daemon.Port != 4590 {
		t.Errorf("expected default port 4590, got %d", cfg.Daemon.Port)
	}
	if cfg.Daemon.Host != "0.0.0.0" {
		t.Errorf("expected default host 0.0.0.0, got %s", cfg.Daemon.Host)
	}
}

func TestLoadFromEnv_Missing(t *testing.T) {
	// Point HOME to a temp dir that has no config.env
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatal("missing config.env should return defaults, not error:", err)
	}
	if cfg.Daemon.Port != 4590 {
		t.Errorf("expected default port 4590, got %d", cfg.Daemon.Port)
	}
}

func TestLoadFromEnv_Values(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	cfgDir := filepath.Join(dir, ".tlive")
	if err := os.MkdirAll(cfgDir, 0755); err != nil {
		t.Fatal(err)
	}
	content := "TL_PORT=9090\nTL_TOKEN=my-token\nTL_HOST=127.0.0.1\n"
	if err := os.WriteFile(filepath.Join(cfgDir, "config.env"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Daemon.Port != 9090 {
		t.Errorf("expected port 9090, got %d", cfg.Daemon.Port)
	}
	if cfg.Daemon.Token != "my-token" {
		t.Errorf("expected token 'my-token', got %q", cfg.Daemon.Token)
	}
	if cfg.Daemon.Host != "127.0.0.1" {
		t.Errorf("expected host '127.0.0.1', got %q", cfg.Daemon.Host)
	}
}

func TestLoadFromEnv_QuotedValues(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	cfgDir := filepath.Join(dir, ".tlive")
	os.MkdirAll(cfgDir, 0755)
	content := `TL_TOKEN="quoted-token"` + "\n"
	os.WriteFile(filepath.Join(cfgDir, "config.env"), []byte(content), 0644)

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Daemon.Token != "quoted-token" {
		t.Errorf("expected 'quoted-token', got %q", cfg.Daemon.Token)
	}
}

func TestLoadFromEnv_Comments(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	cfgDir := filepath.Join(dir, ".tlive")
	os.MkdirAll(cfgDir, 0755)
	content := "# This is a comment\nTL_PORT=3000\n# Another comment\n"
	os.WriteFile(filepath.Join(cfgDir, "config.env"), []byte(content), 0644)

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Daemon.Port != 3000 {
		t.Errorf("expected port 3000, got %d", cfg.Daemon.Port)
	}
}
