"""PNG export of each diagram's <svg> only (as diagram-design's export does), at 2x, via headless Edge."""
import re
import subprocess
from pathlib import Path

SRC = Path(__file__).parent  # docs/architecture: the diagrams sit beside this script
OUT = SRC / "png"
TMP = Path(__import__("tempfile").gettempdir()) / "saics_png_tmp"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
OUT.mkdir(exist_ok=True)
TMP.mkdir(exist_ok=True)

for f in sorted(SRC.glob("saics-*.html")):
    text = f.read_text(encoding="utf-8")
    svg = re.search(r"<svg .*?</svg>", text, re.S).group(0)
    fonts = re.search(r'<link href="([^"]+)" rel="stylesheet">', text).group(1)
    _, _, w, h = (float(v) for v in re.search(r'viewBox="([^"]+)"', svg).group(1).split())
    w, h = int(w), int(h)
    wrap = TMP / f.name
    wrap.write_text(
        f'<!DOCTYPE html><html><head><meta charset="utf-8"><link href="{fonts}" rel="stylesheet">'
        f"<style>html,body{{margin:0;background:#0E0C0A}}svg{{display:block;width:{w}px;height:{h}px}}</style>"
        f"</head><body>{svg}</body></html>", encoding="utf-8")
    png = OUT / (f.stem + "@2x.png")
    png.unlink(missing_ok=True)
    subprocess.run([EDGE, "--headless=new", f"--user-data-dir={TMP / ('profile-' + f.stem)}", "--no-first-run", "--disable-gpu", "--hide-scrollbars", f"--window-size={w},{h}",
                    "--force-device-scale-factor=2", "--virtual-time-budget=6000", f"--screenshot={png}",
                    wrap.as_uri()], check=True, capture_output=True, timeout=120)
    for _ in range(100):  # Edge returns before it has written the file
        if png.exists() and png.stat().st_size > 0:
            break
        __import__("time").sleep(0.1)
    print(png.name, png.stat().st_size)
