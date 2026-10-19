# What the Comma tab can do on the comma (CommaManager.ACTIONS), after prelude.sh. The app sets ACTION and,
# for some, BRANCH, URL (checked by the app: no quotes or spaces), RESTART (1: restart openpilot when done) or
# CMD. The output is streamed back to the page as it comes; the exit code is the job's.

param_put() {
  python3 - "$1" "$2" <<'PY'
import sys
try:
  from openpilot.common.params import Params
except ImportError:
  from common.params import Params
Params().put(sys.argv[1], sys.argv[2])
PY
}

finish() {   # restart openpilot after a change to its code, if asked
  if [ "$RESTART" = "1" ]; then op_stop; op_start; else echo "restart openpilot for the change to take effect"; fi
}

case "$ACTION" in
  start) op_start ;;
  stop) op_stop ;;
  restart) op_stop; op_start ;;
  reboot) echo "rebooting"; sync; sudo reboot ;;

  # openpilot's own updater (system/updated): SIGUSR1 checks for an update, SIGHUP downloads it; it is installed on
  # the next start of the device
  update_check|update_download)
    sig=USR1; [ "$ACTION" = update_download ] && sig=HUP
    if pkill -$sig -f 'updated\.updated'; then echo "asked the updater to $([ $sig = USR1 ] && echo check || echo download)"; else echo "the updater isn't running (it runs while openpilot is offroad)"; exit 1; fi ;;

  fetch) git fetch --prune origin && git status -sb | head -1 ;;

  pull)
    git status -sb | head -1
    git pull --ff-only && git submodule update --init --recursive && git log -1 --format='now at %h %s (%cr)' && finish ;;

  branches) git ls-remote --heads "${URL:-origin}" | sed 's#.*refs/heads/##' | sort ;;   # this install's, or URL's

  branch)
    [ -n "$BRANCH" ] || { echo "no branch"; exit 2; }
    git fetch origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" &&
      git checkout -f -B "$BRANCH" "origin/$BRANCH" &&
      git submodule update --init --recursive -f &&
      param_put UpdaterTargetBranch "$BRANCH" &&
      git log -1 --format="on $BRANCH at %h %s (%cr)" && finish ;;

  # a fork from scratch: cloned beside the current install, which is kept as the backup (one backup: the one before
  # it goes), then swapped in. The device reboots into it (the launch script builds it, or updates AGNOS if it
  # needs another version).
  install)
    [ -n "$URL" ] && [ -n "$BRANCH" ] || { echo "need a repository and a branch"; exit 2; }
    NEW="${OP}_new"
    rm -rf "$NEW"
    echo "cloning $URL ($BRANCH)"
    git clone --progress --depth 1 --recurse-submodules --shallow-submodules -b "$BRANCH" "$URL" "$NEW" || { rm -rf "$NEW"; echo "clone failed; nothing changed"; exit 1; }
    op_stop
    rm -rf "$BACKUP"
    mv "$OP" "$BACKUP" && mv "$NEW" "$OP" || { echo "swap failed"; [ -d "$OP" ] || mv "$BACKUP" "$OP"; op_start; exit 1; }
    cd "$OP" && param_put UpdaterTargetBranch "$BRANCH"
    echo "installed $URL $BRANCH; the previous install is kept at $BACKUP"
    if [ "$RESTART" = "1" ]; then echo "rebooting"; sync; sudo reboot; else op_start; fi ;;

  restore)
    [ -d "$BACKUP/.git" ] || { echo "no backup at $BACKUP"; exit 1; }
    op_stop
    mv "$OP" "$OP.swap" && mv "$BACKUP" "$OP" && mv "$OP.swap" "$BACKUP" || { echo "swap failed"; exit 1; }
    cd "$OP" && git log -1 --format="restored $(git rev-parse --abbrev-ref HEAD) at %h %s"
    if [ "$RESTART" = "1" ]; then echo "rebooting"; sync; sudo reboot; else op_start; fi ;;

  # the panda's firmware, as panda/board/flash.py builds it; flashing needs pandad (openpilot) out of the way
  panda_build) scons -C "$OP/panda" -j"$(nproc)" "$OP/panda/board" ;;
  panda_flash|panda_recover)
    script=flash.py; [ "$ACTION" = panda_recover ] && script=recover.py
    op_stop
    (cd "$OP/panda/board" && python3 "$script"); rc=$?
    op_start
    exit $rc ;;

  exec) bash -c "$CMD" ;;
  *) echo "unknown action $ACTION"; exit 2 ;;
esac
