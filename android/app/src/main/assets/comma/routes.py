# The drives recorded on the comma for the Comma tab (CommaManager /app/comma/routes), after prelude.sh: one
# JSON object {routes: [{name, segments, start, end, size, files: {kind: count}, preserved}], root, freeGB},
# newest first. A segment is a directory <route>--<n> under realdata; its files are the logs and the videos.
import json
import os
import re

ROOT = "/data/media/0/realdata"
SEG = re.compile(r"^(?P<route>.+)--(?P<n>\d+)$")
routes = {}
try:
  entries = list(os.scandir(ROOT))
except OSError:
  entries = []
for e in entries:
  m = SEG.match(e.name)
  if not m or not e.is_dir():
    continue
  r = routes.setdefault(m["route"], {"name": m["route"], "segments": [], "size": 0, "start": None, "end": None, "files": {}, "preserved": False})
  n = int(m["n"])
  r["segments"].append(n)
  try:
    st = e.stat()
    r["start"] = st.st_mtime if r["start"] is None else min(r["start"], st.st_mtime)
    r["end"] = st.st_mtime if r["end"] is None else max(r["end"], st.st_mtime)
    for f in os.scandir(e.path):
      if f.is_file():
        r["size"] += f.stat().st_size
        kind = f.name.split(".")[0]
        r["files"][kind] = r["files"].get(kind, 0) + 1
  except OSError:
    pass
  try:
    if b"1" in os.getxattr(e.path, "user.preserve"):
      r["preserved"] = True
  except (OSError, AttributeError):
    pass
out = sorted(routes.values(), key=lambda r: r["end"] or 0, reverse=True)[:150]
for r in out:
  r["segments"].sort()
st = os.statvfs("/data") if os.path.isdir("/data") else None
print(json.dumps({"root": ROOT, "routes": out, "freeGB": round(st.f_bavail * st.f_frsize / 1e9, 1) if st else None}))
