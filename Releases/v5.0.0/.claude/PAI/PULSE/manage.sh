#!/bin/bash
# PAI Pulse — Process Management
# Usage: manage.sh {start|stop|restart|status|install|uninstall}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAI_DIR="${PAI_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PAI_DATA_DIR="${PAI_DATA_DIR:-$HOME/.pai}"
PAI_FRAMEWORK_DIR="${PAI_FRAMEWORK_DIR:-$(cd "$PAI_DIR/.." && pwd)}"
PULSE_DIR="$PAI_DIR/PULSE"
PLIST_NAME="com.pai.pulse"
PLIST_SRC="$PULSE_DIR/$PLIST_NAME.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
SERVICE_NAME="com.pai.pulse.service"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_DST="$SERVICE_DIR/$SERVICE_NAME"
PID_FILE="$PULSE_DIR/state/pulse.pid"
STATE_FILE="$PULSE_DIR/state/state.json"

# Resolve bun's actual location for the launchd job. The public plist
# template ships with `__BUN_PATH__` so the job works for both brew users
# (/opt/homebrew/bin/bun) and curl-installer users (~/.bun/bin/bun).
#
# Order matters. `command -v bun` can resolve to a temporary helper shim
# inside `/private/tmp/bun-node-*/bun` when this script runs inside `bun
# install` (the child shell has its own PATH). That path is ephemeral and
# the launchd job would fail on next boot. Prefer the canonical install
# locations and fall back to `command -v bun` only if neither exists.
if [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_PATH="$HOME/.bun/bin/bun"
elif [ -x "/opt/homebrew/bin/bun" ]; then
  BUN_PATH="/opt/homebrew/bin/bun"
elif [ -x "/usr/local/bin/bun" ]; then
  BUN_PATH="/usr/local/bin/bun"
else
  BUN_PATH="$(command -v bun || echo "$HOME/.bun/bin/bun")"
fi

ensure_deps() {
  if [ -f "$PULSE_DIR/package.json" ]; then
    (cd "$PULSE_DIR" && "$BUN_PATH" install)
  fi
}

supports_systemd_user() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

write_systemd_service() {
  mkdir -p "$SERVICE_DIR" "$PULSE_DIR/state" "$PULSE_DIR/logs"
  cat > "$SERVICE_DST" <<EOF
[Unit]
Description=PAI Pulse
After=default.target

[Service]
Type=simple
WorkingDirectory=$PULSE_DIR
Environment=PAI_DIR=$PAI_DIR
Environment=PAI_FRAMEWORK_DIR=$PAI_FRAMEWORK_DIR
Environment=PAI_DATA_DIR=$PAI_DATA_DIR
Environment=PAI_FRAMEWORK=${PAI_FRAMEWORK:-codex}
ExecStart=$BUN_PATH run pulse.ts
Restart=always
RestartSec=5
StandardOutput=append:$PULSE_DIR/logs/pulse-stdout.log
StandardError=append:$PULSE_DIR/logs/pulse-stderr.log

[Install]
WantedBy=default.target
EOF
}

verify_pulse() {
  for _ in $(seq 1 20); do
    sleep 0.5
    if curl -sS --max-time 1 -o /dev/null -X POST http://localhost:31337/notify \
         -H "Content-Type: application/json" \
         -d '{"message":"","voice_enabled":false}' 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

case "$1" in
  start)
    ensure_deps
    if [ "$(uname -s)" = "Darwin" ]; then
      if [ ! -f "$PLIST_DST" ]; then
        # Substitute public template placeholders;
        # no-op on plists that already have literal paths.
        sed \
          -e "s|__HOME__|$HOME|g" \
          -e "s|__PAI_DIR__|$PAI_DIR|g" \
          -e "s|__PAI_DATA_DIR__|$PAI_DATA_DIR|g" \
          -e "s|__BUN_PATH__|$BUN_PATH|g" \
          "$PLIST_SRC" > "$PLIST_DST"
      fi
      launchctl load "$PLIST_DST" 2>/dev/null
    elif supports_systemd_user; then
      if [ ! -f "$SERVICE_DST" ]; then
        write_systemd_service
        systemctl --user daemon-reload
      fi
      systemctl --user start "$SERVICE_NAME"
    else
      mkdir -p "$PULSE_DIR/state" "$PULSE_DIR/logs"
      nohup env \
        PAI_DIR="$PAI_DIR" \
        PAI_FRAMEWORK_DIR="$PAI_FRAMEWORK_DIR" \
        PAI_DATA_DIR="$PAI_DATA_DIR" \
        PAI_FRAMEWORK="${PAI_FRAMEWORK:-codex}" \
        "$BUN_PATH" run pulse.ts > "$PULSE_DIR/logs/pulse-stdout.log" 2> "$PULSE_DIR/logs/pulse-stderr.log" &
    fi
    echo "PAI Pulse started"
    ;;

  stop)
    if [ "$(uname -s)" = "Darwin" ]; then
      launchctl unload "$PLIST_DST" 2>/dev/null
    elif supports_systemd_user && [ -f "$SERVICE_DST" ]; then
      systemctl --user stop "$SERVICE_NAME" 2>/dev/null
    fi
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      kill "$PID" 2>/dev/null
      echo "PAI Pulse stopped (PID $PID)"
    else
      echo "PAI Pulse stopped"
    fi
    ;;

  restart)
    "$0" stop
    sleep 2
    "$0" start
    ;;

  status)
    if supports_systemd_user && [ -f "$SERVICE_DST" ]; then
      systemctl --user --no-pager status "$SERVICE_NAME" 2>/dev/null || true
      echo ""
    fi
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      if ps -p "$PID" > /dev/null 2>&1; then
        UPTIME=$(ps -p "$PID" -o etime= | xargs)
        echo "PAI Pulse: RUNNING (PID $PID, uptime $UPTIME)"
      else
        echo "PAI Pulse: DEAD (stale PID $PID)"
      fi
    else
      echo "PAI Pulse: NOT RUNNING (no PID file)"
    fi

    if [ -f "$STATE_FILE" ]; then
      echo ""
      echo "Last job runs:"
      bun -e "
        const state = JSON.parse(require('fs').readFileSync('$STATE_FILE', 'utf-8'));
        for (const [name, info] of Object.entries(state.jobs)) {
          const ago = Math.round((Date.now() - info.lastRun) / 60000);
          const status = info.consecutiveFailures > 0 ? ' [FAILING x' + info.consecutiveFailures + ']' : '';
          console.log('  ' + name + ': ' + ago + ' min ago (' + info.lastResult + ')' + status);
        }
      " 2>/dev/null
    fi
    ;;

  install)
    mkdir -p "$PULSE_DIR/state" "$PULSE_DIR/logs"
    ensure_deps

    if [ "$(uname -s)" = "Darwin" ]; then
      # Substitute public template placeholders;
      # no-op on plists that already have literal paths.
      if [ -f "$PLIST_DST" ]; then
        launchctl unload "$PLIST_DST" 2>/dev/null || true
      fi
      pkill -9 -f "bun.*pulse.ts" 2>/dev/null || true
      sleep 1

      sed \
        -e "s|__HOME__|$HOME|g" \
        -e "s|__PAI_DIR__|$PAI_DIR|g" \
        -e "s|__PAI_DATA_DIR__|$PAI_DATA_DIR|g" \
        -e "s|__BUN_PATH__|$BUN_PATH|g" \
        "$PLIST_SRC" > "$PLIST_DST"
      launchctl load "$PLIST_DST"
      if verify_pulse; then
        echo "PAI Pulse installed and verified on port 31337 (bun: $BUN_PATH)"
        exit 0
      fi
    elif supports_systemd_user; then
      systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
      pkill -f "bun.*pulse.ts" 2>/dev/null || true
      write_systemd_service
      systemctl --user daemon-reload
      systemctl --user enable --now "$SERVICE_NAME"
      if verify_pulse; then
        echo "PAI Pulse installed and verified on port 31337 (systemd user service, bun: $BUN_PATH)"
        exit 0
      fi
    else
      echo "ERROR: no supported service manager found. Use '$0 start' for a foreground-compatible background launch." >&2
      exit 1
    fi

    echo "ERROR: PAI Pulse service installed but port 31337 did not bind within 10s." >&2
    echo "  Check: tail -50 $PULSE_DIR/logs/pulse-stderr.log" >&2
    exit 1
    ;;

  uninstall)
    if [ "$(uname -s)" = "Darwin" ]; then
      launchctl unload "$PLIST_DST" 2>/dev/null
    elif supports_systemd_user; then
      systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
      systemctl --user daemon-reload 2>/dev/null || true
    fi
    rm -f "$PLIST_DST"
    rm -f "$SERVICE_DST"
    echo "PAI Pulse uninstalled"
    ;;

  *)
    echo "Usage: $0 {start|stop|restart|status|install|uninstall}"
    exit 1
    ;;
esac
