#!/usr/bin/env bash
# install_service.sh — Install OpenClaw as a systemd service (auto-start on boot)
# Run: bash install_service.sh
# Requires: sudo access

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/openclaw.service"
SYSTEMD_PATH="/etc/systemd/system/openclaw.service"

if [ ! -f "$SERVICE_FILE" ]; then
    echo "ERROR: $SERVICE_FILE not found"
    exit 1
fi

echo "Installing OpenClaw systemd service..."
sudo cp "$SERVICE_FILE" "$SYSTEMD_PATH"
sudo systemctl daemon-reload
sudo systemctl enable openclaw
sudo systemctl start openclaw

echo ""
echo "OpenClaw service installed."
echo "  Status:   sudo systemctl status openclaw"
echo "  Logs:     sudo journalctl -u openclaw -f"
echo "  Stop:     sudo systemctl stop openclaw"
echo "  Restart:  sudo systemctl restart openclaw"
echo "  Disable:  sudo systemctl disable openclaw"
