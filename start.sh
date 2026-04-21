#!/usr/bin/env bash
# start.sh — Start OpenClaw (without systemd, useful for testing)
# Usage: bash start.sh [--background]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GOLD='\033[38;5;178m'
GRN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GOLD}OpenClaw v1.0 — Starting${NC}"

# Check .env
if [ ! -f ".env" ]; then
  echo -e "${RED}✗ .env not found. Copy .env.example and fill in tokens.${NC}"
  exit 1
fi

# Run doctor check
echo -e "  Running health check..."
bun run doctor.ts || true

# Start in background if requested
if [ "$1" = "--background" ]; then
  mkdir -p logs data
  nohup bun index.ts >> logs/openclaw.log 2>&1 &
  echo $! > data/openclaw.pid
  echo -e "${GRN}✓ OpenClaw started in background (PID: $(cat data/openclaw.pid))${NC}"
  echo -e "  Logs: tail -f logs/openclaw.log"
else
  echo -e "${GRN}✓ Starting OpenClaw (foreground)...${NC}"
  bun index.ts
fi
