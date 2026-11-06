import os
import subprocess
import sys
import urllib.request
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

S = Path(__file__).parent
A = Path(r"C:\saics\app\assets")
F = A / "fonts"
ANDROID = Path(r"C:\saics\app\android\app\src\main\assets\fonts")
print("android fonts dir exists:", ANDROID.exists(), sorted(p.name for p in ANDROID.glob("*"))[:3] if ANDROID.exists() else "")
BASE = "https://raw.githubusercontent.com/google/fonts/main/ofl/"
urllib.request.urlretrieve(BASE + "shipporimincho/ShipporiMincho-ExtraBold.ttf", F / "ShipporiMincho-ExtraBold.ttf")
raw = S / "ArchivoNarrow-var.ttf"
urllib.request.urlretrieve(BASE + "archivonarrow/ArchivoNarrow%5Bwght%5D.ttf", raw)
for name, wght in (("Regular", 400), ("SemiBold", 600), ("Bold", 700)):
    f = instantiateVariableFont(TTFont(raw), {"wght": wght})
    family = f"ArchivoNarrow-{name}"
    for rec in f["name"].names:
        if rec.nameID in (1, 4, 6, 16):
            rec.string = family
    f.save(F / f"{family}.ttf")
for p in sorted(F.glob("*.ttf")):
    if p.name.startswith(("Shippori", "ArchivoNarrow")):
        print(p.name, round(p.stat().st_size / 1e6, 2), "MB")
        if ANDROID.exists():
            (ANDROID / p.name).write_bytes(p.read_bytes())

chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
page = (S / "hand_frame.html").as_uri()
out = A / "hand"
out.mkdir(exist_ok=True)
for i, seed in enumerate((11, 202, 3077)):
    png = out / f"hand{i}.png"
    r = subprocess.run([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
                        f"--screenshot={png}", "--window-size=860,1800", "--default-background-color=00000000",
                        "--virtual-time-budget=3000", f"{page}#{seed}"], capture_output=True, timeout=120)
    print(png.name, r.returncode, round(png.stat().st_size / 1e3), "KB" if png.exists() else "missing")
