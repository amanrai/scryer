#!/usr/bin/env bash
# restart.sh — stop and restart all Scryer services
set -e

REPO="$(cd "$(dirname "$0")" && pwd)"
TMUX=/opt/homebrew/bin/tmux

echo "==> Stopping existing services…"

# Kill named tmux sessions if they exist
for session in scryer-ui scryer-tmux; do
  if $TMUX has-session -t "$session" 2>/dev/null; then
    $TMUX kill-session -t "$session"
    echo "    killed tmux session: $session"
  fi
done

# Free any processes still holding the ports
for port in 3000 7654 5055; do
  pids=$(lsof -ti tcp:$port 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "    killing pids on :$port → $pids"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
done

sleep 0.5

echo ""
echo "==> Starting services…"

# UI — Express (7654) + Vite (3000)
$TMUX new-session -d -s scryer-ui -c "$REPO/ui" 'npm run dev'
echo "    scryer-ui    │ npm run dev        │ :3000 (Vite), :7654 (Express)"

# Terminal streaming server
$TMUX new-session -d -s scryer-tmux -c "$REPO/tmux_test" 'python server.py'
echo "    scryer-tmux  │ python server.py   │ :5055"

echo ""
echo "All services running."
echo ""
echo "  UI:       http://localhost:3000"
echo "  API:      http://localhost:7654"
echo "  Terminal: http://localhost:5055"
echo ""
echo "  Attach to logs:"
echo "    tmux attach -t scryer-ui"
echo "    tmux attach -t scryer-tmux"
