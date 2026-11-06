"""Press Next many times at uneven gaps and look for duplicated engine decisions in the trace."""
import collections
import random
import re
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ADB = r"C:\Users\ASUS\AppData\Local\Android\Sdk\platform-tools\adb.exe"
N = int(sys.argv[1]) if len(sys.argv) > 1 else 40


def sh(*a):
    return subprocess.run([ADB, "shell", *a], capture_output=True).stdout.decode("utf-8", "replace")


def trace():
    return sh("dumpsys activity service com.saics.app/com.saics.player.PlaybackService")


def tap(label):
    subprocess.run([ADB, "shell", "uiautomator dump /sdcard/ui.xml"], capture_output=True)
    x = subprocess.run([ADB, "exec-out", "cat /sdcard/ui.xml"], capture_output=True).stdout.decode("utf-8", "replace")
    for t, a, b, c, d in re.findall(r'text="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', x):
        if t == label:
            sh(f"input tap {(int(a) + int(c)) // 2} {(int(b) + int(d)) // 2}")
            return True
    return False


if "playing=true" not in trace():
    print("tapped play:", tap("Play"))
    time.sleep(4)
print(trace().splitlines()[1][:120])
seen = collections.OrderedDict()
rng = random.Random(7)
for i in range(N):
    if rng.random() < 0.35:
        sh("input keyevent KEYCODE_MEDIA_NEXT; input keyevent KEYCODE_MEDIA_NEXT")
    else:
        sh("input keyevent KEYCODE_MEDIA_NEXT")
    time.sleep(rng.choice([0.25, 0.6, 1.0, 1.8, 3.0]))
    for line in trace().splitlines():
        if re.match(r"\s*\d+\.\d ", line):
            seen[line.strip()] = 1
    if i % 10 == 0:
        print(i, flush=True)
lines = list(seen)
print("trace lines", len(lines))
print(collections.Counter(re.sub(r"^\S+ ", "", x).split(" ")[0] for x in lines).most_common(14))
# The same instruction issued twice within 3 s, or several jumps close together.
ev = []
for x in lines:
    m = re.match(r"([\d.]+) (\S+) (.*)", x)
    ev.append((float(m[1]), m[2], m[3][:70]))
print("repeats within 3 s:")
for (t0, k0, d0), (t1, k1, d1) in zip(ev, ev[1:]):
    if k0 == k1 and k0 in ("TRACK", "HARD_NEXT", "NEXT", "VERSION", "PREVIOUS", "RESTART", "jump", "playing") and t1 - t0 < 3 and d0.split(" at ")[0] == d1.split(" at ")[0]:
        print(f"  {t0} -> {t1}  {k0} {d0}")
print("errors:", [x[:110] for x in lines if "error" in x or "can't play" in x][:10])
print("\n".join(x[:130] for x in lines[-25:]))
sh("input keyevent KEYCODE_MEDIA_PAUSE")
