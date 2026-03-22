#!/bin/bash
# Restart Neuroforge server

set -e

cd /root/dev/neuroforge

# Find neuroforge process specifically (not mybot)
PID=$(pgrep -f "node src/index.js" | while read p; do
  cwd=$(readlink -f /proc/$p/cwd 2>/dev/null)
  if echo "$cwd" | grep -q "neuroforge"; then
    echo "$p"
  fi
done)

if [ -n "$PID" ]; then
  echo "Stopping Neuroforge (PID: $PID)..."
  kill $PID
  sleep 2
  # Force kill if still running
  for p in $PID; do
    if kill -0 "$p" 2>/dev/null; then
      kill -9 "$p"
    fi
  done
  echo "Neuroforge stopped."
else
  echo "Neuroforge is not running."
fi

# Start in background
echo "Starting Neuroforge..."
nohup node src/index.js > /tmp/neuroforge.log 2>&1 &

NEW_PID=$!
sleep 2

if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "Neuroforge started (PID: $NEW_PID). Logs: /tmp/neuroforge.log"
else
  echo "Neuroforge failed to start. Check /tmp/neuroforge.log"
  tail -20 /tmp/neuroforge.log
  exit 1
fi
