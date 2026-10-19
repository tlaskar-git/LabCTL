#!/bin/bash
# LabCTL Agent Setup - Run on each Linux machine (Debian/Ubuntu)
set -e

SERVER_URL="${1:?Usage: ./setup-linux.sh ws://SERVER_IP:7700/ws/agent}"

echo "=== LabCTL Agent Setup (Linux) ==="
echo "Server: $SERVER_URL"

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "Installing Python3..."
    apt-get update && apt-get install -y python3 python3-pip
fi

# Install dependency
pip3 install websocket-client --break-system-packages 2>/dev/null || pip3 install websocket-client

# Deploy agent
mkdir -p /opt/labctl/agent
cp "$(dirname "$0")/labctl-agent.py" /opt/labctl/agent/labctl-agent.py
chmod +x /opt/labctl/agent/labctl-agent.py

# Install as systemd service
python3 /opt/labctl/agent/labctl-agent.py --server "$SERVER_URL" --install-service

echo ""
echo "=== LabCTL Agent installed ==="
echo "Status: systemctl status labctl-agent"
echo "Logs:   journalctl -u labctl-agent -f"
