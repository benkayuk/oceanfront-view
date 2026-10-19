# The comma's state for the Comma tab (CommaManager /app/comma/info), run with the AGNOS venv's python after
# prelude.sh. Prints one JSON object: openpilot's processes (managerState, with CPU and memory from /proc), the
# device (deviceState, temperatures, memory, disk, uptime), the install (git), the updater's params and a few
# identifying params. Every part is best effort: what can't be read is left out.
import json
import os
import subprocess
import time

OP = "/data/openpilot"
out = {"t": time.time()}


def sh(*cmd, timeout=5):
  try:
    return subprocess.run(cmd, cwd=OP, capture_output=True, text=True, timeout=timeout).stdout.strip()
  except Exception:
    return ""


def param(key):
  for root in ("/data/params/d", "/dev/shm/params/d"):
    try:
      with open(os.path.join(root, key), "rb") as f:
        return f.read().decode("utf-8", "replace").strip()
    except OSError:
      pass
  return None


out["params"] = {k: param(k) for k in (
  "DongleId", "HardwareSerial", "Version", "GitBranch", "GitCommit", "GitRemote", "IsOnroad", "IsEngaged", "SshEnabled",
  "UpdaterState", "UpdateAvailable", "UpdaterFetchAvailable", "UpdaterCurrentDescription", "UpdaterNewDescription",
  "UpdaterTargetBranch", "UpdaterAvailableBranches", "UpdateFailedCount", "LastUpdateTime",
)}

out["git"] = {
  "remote": sh("git", "config", "--get", "remote.origin.url"),
  "branch": sh("git", "rev-parse", "--abbrev-ref", "HEAD"),
  "commit": sh("git", "rev-parse", "--short", "HEAD"),
  "subject": sh("git", "log", "-1", "--format=%s"),
  "date": sh("git", "log", "-1", "--format=%cI"),
  "dirty": bool(sh("git", "status", "--porcelain", "--untracked-files=no")),
  "upstream": sh("git", "rev-list", "--left-right", "--count", "HEAD...@{u}"),   # "ahead behind" of the last fetch
  "prebuilt": os.path.exists(os.path.join(OP, "prebuilt")),
  "backup": sh("git", "-C", "/data/openpilot.bak", "log", "-1", "--format=%D %h %s") if os.path.isdir("/data/openpilot.bak/.git") else None,
}

out["running"] = subprocess.run(["tmux", "has-session", "-t", "comma"], capture_output=True).returncode == 0


def jiffies(pid):
  try:
    with open(f"/proc/{pid}/stat") as f:
      parts = f.read().rsplit(")", 1)[1].split()
    return int(parts[11]) + int(parts[12])
  except (OSError, IndexError, ValueError):
    return None


def rss_mb(pid):
  try:
    with open(f"/proc/{pid}/status") as f:
      for line in f:
        if line.startswith("VmRSS:"):
          return round(int(line.split()[1]) / 1024, 1)
  except OSError:
    pass
  return None


try:
  try:
    from openpilot.cereal import messaging
  except ImportError:
    import cereal.messaging as messaging
  sm = messaging.SubMaster(["managerState", "deviceState"])
  deadline = time.monotonic() + 2.5
  while time.monotonic() < deadline and not (sm.updated["managerState"] or sm.recv_frame["managerState"]):
    sm.update(100)
  if sm.recv_frame["managerState"]:
    procs = [{"name": p.name, "running": p.running, "shouldBeRunning": p.shouldBeRunning, "pid": p.pid, "exitCode": p.exitCode}
             for p in sm["managerState"].processes]
    before = {p["pid"]: jiffies(p["pid"]) for p in procs if p["running"] and p["pid"]}
    t0 = time.monotonic()
    time.sleep(0.5)
    hz, dt = os.sysconf("SC_CLK_TCK"), time.monotonic() - t0
    for p in procs:
      if p["pid"] in before and before[p["pid"]] is not None:
        after = jiffies(p["pid"])
        if after is not None:
          p["cpu"] = round((after - before[p["pid"]]) / hz / dt * 100, 1)
        p["memMB"] = rss_mb(p["pid"])
    out["processes"] = sorted(procs, key=lambda p: p["name"])
  if sm.recv_frame["deviceState"]:
    ds = sm["deviceState"]
    out["deviceState"] = {
      "started": ds.started, "freeSpacePercent": round(ds.freeSpacePercent, 1), "memoryUsagePercent": ds.memoryUsagePercent,
      "cpuUsagePercent": list(ds.cpuUsagePercent), "maxTempC": round(ds.maxTempC, 1), "thermalStatus": str(ds.thermalStatus),
      "networkType": str(ds.networkType), "fanSpeedPercentDesired": ds.fanSpeedPercentDesired,
    }
except Exception as e:  # openpilot not running, or another layout: the process list stays empty
  out["messagingError"] = f"{type(e).__name__}: {e}"

try:
  with open("/proc/uptime") as f:
    out["uptime"] = float(f.read().split()[0])
  out["load"] = os.getloadavg()
  mem = {}
  with open("/proc/meminfo") as f:
    for line in f:
      k, v = line.split(":", 1)
      mem[k] = int(v.split()[0])
  out["memory"] = {"totalMB": mem["MemTotal"] // 1024, "availableMB": mem.get("MemAvailable", 0) // 1024}
  st = os.statvfs("/data")
  out["disk"] = {"totalGB": round(st.f_blocks * st.f_frsize / 1e9, 1), "freeGB": round(st.f_bavail * st.f_frsize / 1e9, 1)}
  temps = []
  for z in sorted(os.listdir("/sys/class/thermal")):
    try:
      with open(f"/sys/class/thermal/{z}/temp") as f:
        temps.append(int(f.read()) / 1000)
    except (OSError, ValueError):
      pass
  if temps:
    out["maxThermalC"] = round(max(temps), 1)
except Exception:
  pass

try:
  with open("/VERSION") as f:
    out["agnos"] = f.read().strip()
except OSError:
  pass
out["ips"] = sh("hostname", "-I").split()

print(json.dumps(out))
