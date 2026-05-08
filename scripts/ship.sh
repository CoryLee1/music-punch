#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
msg="${1:-chore: sync}"
git add -A
if git diff --cached --quiet; then
  echo "Nothing to commit."
  exit 0
fi
git commit -m "$msg"
git push
