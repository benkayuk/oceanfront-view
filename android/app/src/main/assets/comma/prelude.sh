# Run first in every script the app sends to the comma over SSH (CommaManager): the openpilot checkout, the
# AGNOS venv's python on the PATH, stderr into stdout, and how openpilot is stopped and started.
exec 2>&1
OP=/data/openpilot
BACKUP=/data/openpilot.bak
export PATH=/usr/local/venv/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH
export PYTHONPATH=$OP
cd "$OP" 2>/dev/null || cd /data

op_running() { tmux has-session -t comma 2>/dev/null; }

# openpilot's manager exits cleanly on SIGTERM (it stops its processes first); then the launch script's tmux
# session goes, and comma.service with it if AGNOS runs one, so nothing starts it again behind our back.
op_stop() {
  if pgrep -f 'system/manager/manager.py|selfdrive/manager/manager.py' >/dev/null; then
    echo "stopping openpilot's manager"
    pkill -TERM -f 'system/manager/manager.py|selfdrive/manager/manager.py'
    for _ in $(seq 1 30); do
      pgrep -f 'system/manager/manager.py|selfdrive/manager/manager.py' >/dev/null || break
      sleep 0.5
    done
  fi
  if systemctl is-active --quiet comma 2>/dev/null; then sudo systemctl stop comma; fi
  tmux kill-session -t comma 2>/dev/null
  op_running && echo "openpilot's tmux session is still there" && return 1
  echo "openpilot stopped"
}

# AGNOS's own way first (comma.service), else the launch script in the tmux session it would have made
op_start() {
  if op_running; then echo "openpilot is already running"; return 0; fi
  if systemctl cat comma >/dev/null 2>&1; then
    sudo systemctl start comma
    for _ in $(seq 1 10); do op_running && break; sleep 0.5; done
  fi
  if ! op_running; then
    if [ -x /data/continue.sh ]; then launch=/data/continue.sh; else launch="$OP/launch_openpilot.sh"; fi
    tmux new-session -s comma -d "bash -lc 'exec $launch'"
  fi
  sleep 1
  op_running && echo "openpilot started" || { echo "openpilot did not start"; return 1; }
}
