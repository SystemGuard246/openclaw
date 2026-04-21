#!/usr/bin/env bash
# stop.sh — Stop background OpenClaw process
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/data/openclaw.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    rm "$PID_FILE"
    echo "OpenClaw stopped (PID $PID)"
  else
    echo "Process $PID not running"
    rm "$PID_FILE"
  fi
else
  echo "No PID file found. OpenClaw may not be running."
fi
