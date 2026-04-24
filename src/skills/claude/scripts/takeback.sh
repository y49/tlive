#!/usr/bin/env bash
# ~/.claude/skills/tlive/scripts/takeback.sh
#
# Ask the tlive daemon to take ownership of a session (resume it as a
# LocalSession inside the daemon process). Intended to be followed by the
# local user exiting their `claude` CLI so the daemon is the sole driver.
#
# Usage:
#   takeback.sh <alias>
#
# Transport: unix-domain socket at ${TLIVE_DAEMON_SOCK:-$HOME/.tlive/daemon.sock}.

set -euo pipefail

SOCK="${TLIVE_DAEMON_SOCK:-$HOME/.tlive/daemon.sock}"
ALIAS="${1:-}"

if [ -z "$ALIAS" ]; then
  echo "Usage: /tlive takeback <alias>" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  if command -v tlive >/dev/null 2>&1; then
    exec tlive takeback "$ALIAS"
  fi
  echo "curl not found; install curl or run 'tlive takeback $ALIAS'." >&2
  exit 1
fi

RESPONSE=$(curl -sS --unix-socket "$SOCK" \
  -X POST "http://localhost/handoff/take" \
  -H 'content-type: application/json' \
  -d "{\"sdkId\":\"$ALIAS\"}")

if command -v jq >/dev/null 2>&1; then
  echo "$RESPONSE" | jq -r '.sdkId // .message // "taken"'
else
  echo "$RESPONSE"
fi

echo "Daemon now owns $ALIAS. Exit this claude session so the daemon is sole driver."
