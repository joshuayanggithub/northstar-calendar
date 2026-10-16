"""Copy the everyday (release) app's saved UI settings into the sandboxed
debug app, so it renders what the user sees (seam style, hidden weekends,
reconcile marks, stars...). Reads the release app's WebKit localStorage
read-only; writes only into the sandbox window via the debug hook."""
import glob, json, os, sqlite3, sys, urllib.request

HOOK = "http://127.0.0.1:14211"
pattern = os.path.expanduser(
    "~/Library/WebKit/com.joshuayang.calendar-app/WebsiteData/Default/*/*/LocalStorage/localstorage.sqlite3"
)
dbs = glob.glob(pattern)
if not dbs:
    print("no release-app settings found; sandbox keeps its own")
    sys.exit(0)
con = sqlite3.connect(f"file:{dbs[0]}?mode=ro", uri=True)
items = {k: bytes(v).decode("utf-16-le") for k, v in con.execute("SELECT key, value FROM ItemTable")}
con.close()
script = (
    "localStorage.clear();"
    + "".join(f"localStorage.setItem({json.dumps(k)}, {json.dumps(v)});" for k, v in items.items())
    + "setTimeout(() => location.reload(), 10); return Object.keys(localStorage).length;"
)
req = urllib.request.Request(HOOK, data=json.dumps({"cmd": "eval", "script": script}).encode(),
                             headers={"Content-Type": "application/json"})
import time
for attempt in range(60):  # the hook comes up a little after the window
    try:
        res = json.load(urllib.request.urlopen(req))
        break
    except OSError:
        time.sleep(1)
else:
    print("debug hook never came up; sandbox keeps its own settings")
    sys.exit(0)
print(f"mirrored {len(items)} settings from the everyday app:", ", ".join(sorted(items)), "->", res)
