#!/bin/bash
# Grammaria — Development startup (Vite + Bun)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.bun/bin:$PATH"

G='\033[0;32m'
N='\033[0m'
log() { echo -e "${G}[$(date '+%H:%M:%S')]${N} $*"; }

cd "$SCRIPT_DIR"

# Start Bun server (API, grammar checker, LLM relay) in background
log "Starting Bun server on port 25000..."
bun run server.ts &
BUN_PID=$!

# Cleanup on exit
trap "kill $BUN_PID 2>/dev/null" EXIT

sleep 1

# Start Vite dev server (HMR)
log "Starting Vite dev server on port 25001..."
npm run dev
