package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
)

var port int
var token string

var rootCmd = &cobra.Command{
	Use:   "tlive",
	Short: "TLive - Terminal live monitoring",
	Long:  "Wrap terminal commands for remote monitoring via Web UI.",
	Args:  cobra.ArbitraryArgs,
	RunE:  runCommand,
}

func init() {
	rootCmd.PersistentFlags().IntVarP(&port, "port", "p", 4590, "Web server port")
	rootCmd.PersistentFlags().StringVar(&token, "token", "", "Auth token")
	rootCmd.Flags().StringVar(&publicIP, "ip", "", "Override auto-detected LAN IP address")
	// Stop parsing flags after the first positional arg (the wrapped command).
	// This ensures flags like -r, --help, -p intended for the wrapped command
	// are NOT intercepted by cobra. TLive flags must come before the command:
	//   tlive --port 9000 claude -r    ✓ (--port is tlive's, -r goes to claude)
	//   tlive claude --port 9000       ✓ (--port passes through to claude)
	rootCmd.Flags().SetInterspersed(false)
	rootCmd.PersistentFlags().SetInterspersed(false)
	rootCmd.AddCommand(stopCmd)
}

func setupLogFile() *os.File {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	dir := filepath.Join(home, ".tlive")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil
	}
	f, err := os.OpenFile(filepath.Join(dir, "tlive.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil
	}
	log.SetOutput(f)
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)
	return f
}

func main() {
	if f := setupLogFile(); f != nil {
		defer f.Close()
	}
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
