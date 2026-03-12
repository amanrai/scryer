#!/usr/bin/env bash
# restart.sh — stop and restart all Scryer services
set -e

REPO="$(cd "$(dirname "$0")" && pwd)"
TMUX=/opt/homebrew/bin/tmux

# Load nvm so the claude binary is on PATH
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

echo "==> Ensuring MCP servers are registered…"

# Register MCP servers at user scope so they're available in any working directory.
# Remove first to avoid duplicate errors, then re-add.
for server in pm-local oracle-local; do
  claude mcp remove "$server" 2>/dev/null || true
done
claude mcp add -s user pm-local     -- /Users/amanrai/miniconda3/bin/python3 "$REPO/infra/ProjectManagement/mcp_server.py"
claude mcp add -s user oracle-local -- python3 "$REPO/oracle/mcp_server.py"
echo "    pm-local, oracle-local registered (user scope)"

echo ""
echo "==> Stopping existing services…"

# Kill named tmux sessions if they exist
for session in scryer-ui scryer-tmux scryer-bot scryer-council; do
  if $TMUX has-session -t "$session" 2>/dev/null; then
    $TMUX kill-session -t "$session"
    echo "    killed tmux session: $session"
  fi
done

# Free any processes still holding the ports
for port in 3000 7654 5055 7656; do
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

# Council API (port 7656)
$TMUX new-session -d -s scryer-council -c "$REPO" 'python3 infra/CouncilOrchestrator/api.py'
echo "    scryer-council │ python3 infra/CouncilOrchestrator/api.py │ :7656"

# Discord bot
BOT_CMD='source messaging/venv/bin/activate 2>/dev/null || true; python messaging/bot.py'
$TMUX new-session -d -s scryer-bot -c "$REPO" "$BOT_CMD"
echo "    scryer-bot   │ python messaging/bot.py"

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
echo "    tmux attach -t scryer-bot"
