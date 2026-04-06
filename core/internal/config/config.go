package config

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Config is the top-level configuration for TermLive.
type Config struct {
	Daemon DaemonConfig
}

// DaemonConfig holds settings for the background daemon process.
type DaemonConfig struct {
	Port  int
	Token string
	Host  string
}

// Default returns a Config with sensible defaults.
func Default() *Config {
	return &Config{
		Daemon: DaemonConfig{
			Port: 4590,
			Host: "0.0.0.0",
		},
	}
}

// LoadFromEnv reads ~/.tlive/config.env (KEY=VALUE format) and returns a Config.
// Missing keys fall back to defaults. If the file does not exist, defaults are returned.
// Supported keys: TL_PORT, TL_TOKEN, TL_HOST.
func LoadFromEnv() (*Config, error) {
	cfg := Default()

	home, err := os.UserHomeDir()
	if err != nil {
		return cfg, nil
	}
	path := filepath.Join(home, ".tlive", "config.env")

	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return nil, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.IndexByte(line, '=')
		if idx < 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		val := strings.TrimSpace(line[idx+1:])
		// Strip optional surrounding quotes
		if len(val) >= 2 && val[0] == '"' && val[len(val)-1] == '"' {
			val = val[1 : len(val)-1]
		}
		switch key {
		case "TL_PORT":
			if p, err := strconv.Atoi(val); err == nil {
				cfg.Daemon.Port = p
			}
		case "TL_TOKEN":
			cfg.Daemon.Token = val
		case "TL_HOST":
			cfg.Daemon.Host = val
		}
	}
	return cfg, scanner.Err()
}
