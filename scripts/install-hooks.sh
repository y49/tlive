#!/usr/bin/env bash
# scripts/install-hooks.sh
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
echo "tlive: git hooks installed (.githooks/)"
