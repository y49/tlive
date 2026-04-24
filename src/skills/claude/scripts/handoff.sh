#!/usr/bin/env bash
# ~/.claude/skills/tlive/scripts/handoff.sh
#
# Ask the tlive daemon to release ownership of a session so the local
# `claude` CLI can continue driving it. Accepts an optional alias argument;
# defaults to whatever `tlive status` reports as the active session.
#
# Transport: unix-domain socket at ${TLIVE_DAEMON_SOCK:-$HOME/.tlive/daemon.sock}.
# Falls back to the `tlive handoff-to-me` CLI entry when `curl` is missing.

set -euo pipefail

SOCK="${TLIVE_DAEMON_SOCK:-$HOME/.tlive/daemon.sock}"
ALIAS="${1:-}"

if [ -z "$ALIAS" ]; then
  # Try to infer the active alias from `tlive list`.
  if command -v tlive >/dev/null 2>&1; then
    ALIAS="$(tlive list 2>/dev/null | awk 'NR>1 && $4=="running" {print $1; exit}')"
  fi
fi

if [ -z "$ALIAS" ]; then
  echo "Usage: /tlive handoff [alias]" >&2
  echo "  no active session detected; pass an alias explicitly." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  # Fallback: the tlive CLI ships a subcommand with the same semantics.
  if command -v tlive >/dev/null 2>&1; then
    exec tlive handoff-to-me "$ALIAS"
  fi
  echo "curl not found; install curl or run 'tlive handoff-to-me $ALIAS'." >&2
  exit 1
fi

RESPONSE=$(curl -sS --unix-socket "$SOCK" \
  -X POST "http://localhost/handoff/release" \
  -H 'content-type: application/json' \
  -d "{\"alias\":\"$ALIAS\"}")

if command -v jq >/dev/null 2>&1; then
  echo "$RESPONSE" | jq -r '.sdkId // .message // "released"'
else
  echo "$RESPONSE"
fi
