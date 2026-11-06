"""Search, then Now Playing's motion. Presses Next only once the vermilion strip is on screen."""
import io
import os
import re
import subprocess
import sys
import time

from PIL import Image

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
A = r"C:\Users\ASUS\AppData\Local\Android\Sdk\platform-tools\adb.exe"
H = os.path.dirname(os.path.abspath(__file__))


def sh(c):
    return subprocess.run([A, "shell", c], capture_output=True).stdout.decode("utf-8", "replace")


def png():
    return subprocess.run([A, "exec-out", "screencap -p"], capture_output=True).stdout


def shot(n):
    open(os.path.join(H, n + ".png"), "wb").write(png())


def must():
    if "com.saics.app" not in sh("dumpsys activity activities | grep topResumedActivity | head -1"):
        print("SAICS isn't in front: stopping", flush=True)
        sys.exit(0)


def texts():
    sh("uiautomator dump /sdcard/ui.xml")
    x = subprocess.run([A, "exec-out", "cat /sdcard/ui.xml"], capture_output=True).stdout.decode("utf-8", "replace")
    return re.findall(r'text="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', x)


def tap_text(label):
    must()
    for t, a, b, c, d in texts():
        if t == label:
            sh(f"input tap {(int(a) + int(c)) // 2} {(int(b) + int(d)) // 2}")
            return True
    return False


def strip_on():
    r, g, b, *_ = Image.open(io.BytesIO(png())).convert("RGB").getpixel((1150, 1500))
    return abs(r - 232) < 30 and abs(g - 69) < 40 and abs(b - 42) < 40


def trace():
    return sh("dumpsys activity service com.saics.app/com.saics.player.PlaybackService")


sh("monkey -p com.saics.app -c android.intent.category.LAUNCHER 1")
time.sleep(5)
must()
names = [t for t, *_ in texts()]
print("first screen has Tune in:", "Tune in" in names, flush=True)
shot("w_home")
sh("input swipe 1100 250 100 250 200")
time.sleep(1.5)
print("search field:", tap_text("Search songs"), flush=True)
time.sleep(1)
sh("input text racing%snight")
time.sleep(2)
shot("w_search")
print([t for t, *_ in texts() if t][:12], flush=True)
sh("input keyevent KEYCODE_BACK")
time.sleep(0.8)
tap_text("×")
time.sleep(1)
sh("input swipe 100 250 1100 250 200")
time.sleep(1.5)
print("tuned name:", tap_text("Infinite Ride"), flush=True)
time.sleep(1.5)
if not strip_on():
    print("second tap:", tap_text("Infinite Ride"), flush=True)
    time.sleep(2)
if not strip_on():
    print("Now Playing isn't on screen: stopping", flush=True)
    shot("w_lost")
    sys.exit(0)
time.sleep(20)  # let the song decode, so the walk has it
must()
shot("w_playing")
print("strip:", strip_on(), trace().splitlines()[1][:100], flush=True)
if strip_on():
    before = trace().count(" playing ")
    sh("input tap 786 2336; input tap 786 2336")
    t0 = time.time()
    while time.time() - t0 < 30 and trace().count(" playing ") <= before:
        time.sleep(0.05)
    print("song changed after %.1f s" % (time.time() - t0), flush=True)
    for i in range(10):
        shot(f"w_portal{i}")
    print("\n".join(l.strip()[:110] for l in trace().splitlines() if re.match(r"\s*\d+\.\d (cut|portal|MOVE|HARD)", l))[-360:], flush=True)
time.sleep(22)
base = len(re.findall(r"\d jump ", trace()))
t0 = time.time()
while time.time() - t0 < 200:
    must()
    if len(re.findall(r"\d jump ", trace())) > base:
        print("jump scheduled after %.0f s" % (time.time() - t0), flush=True)
        for i in range(12):
            shot(f"w_jump{i}")
        break
    time.sleep(0.1)
else:
    print("no jump in time", flush=True)
sh("input keyevent KEYCODE_MEDIA_PAUSE")
