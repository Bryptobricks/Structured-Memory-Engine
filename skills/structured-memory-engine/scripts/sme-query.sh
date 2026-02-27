#!/bin/bash
set -euo pipefail

if [ -z "${SME_PATH:-}" ]; then
  echo "Error: SME_PATH not set. Point it at the Structured-Memory-Engine directory." >&2
  exit 1
fi

WORKSPACE="${SME_WORKSPACE:-$HOME/.openclaw/workspace}"

node "$SME_PATH/lib/index.js" query "$@" --json --workspace "$WORKSPACE"
