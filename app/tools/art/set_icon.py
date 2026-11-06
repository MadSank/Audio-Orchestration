"""Makes one of the icon options the app's icon, at every size. Usage: set_icon.py <option png>"""
import re
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageDraw

S = Path(__file__).parent
ASSETS = Path(r"C:\saics\app\assets")
RES = Path(r"C:\saics\app\android\app\src\main\res")
RED = "#E8452A"

# Every option stays in the project, so that swapping later is one step.
keep = ASSETS / "icon-options"
keep.mkdir(exist_ok=True)
for name in ("f_finger", "a_forever"):
    shutil.copy(S / "icons" / f"{name}.png", keep / f"{name}.png")

full = Image.open(sys.argv[1]).convert("RGBA")
back = Image.new("RGBA", (1024, 1024), RED)
# A themed icon only uses a silhouette: the record and its label.
mono = Image.new("RGBA", (1024 * 2, 1024 * 2), (0, 0, 0, 0))
d = ImageDraw.Draw(mono)
d.ellipse((2 * 212, 2 * 212, 2 * 812, 2 * 812), outline="white", width=2 * 34)
d.ellipse((2 * 392, 2 * 392, 2 * 632, 2 * 632), fill="white")
mono = mono.resize((1024, 1024), Image.LANCZOS)

full.convert("RGB").save(ASSETS / "icon.png")
full.save(ASSETS / "android-icon-foreground.png")
back.convert("RGB").save(ASSETS / "android-icon-background.png")
mono.save(ASSETS / "android-icon-monochrome.png")
full.resize((48, 48), Image.LANCZOS).convert("RGB").save(ASSETS / "favicon.png")
for dpi, s in (("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)):
    d = RES / f"mipmap-{dpi}"
    legacy, adaptive = int(48 * s), int(108 * s)
    full.resize((legacy, legacy), Image.LANCZOS).save(d / "ic_launcher.webp", quality=95)
    m = Image.new("L", (legacy * 4, legacy * 4), 0)
    ImageDraw.Draw(m).ellipse((0, 0, legacy * 4, legacy * 4), fill=255)
    rnd = full.resize((legacy, legacy), Image.LANCZOS)
    rnd.putalpha(m.resize((legacy, legacy), Image.LANCZOS))
    rnd.save(d / "ic_launcher_round.webp", quality=95)
    full.resize((adaptive, adaptive), Image.LANCZOS).save(d / "ic_launcher_foreground.webp", quality=95)
    back.resize((adaptive, adaptive)).save(d / "ic_launcher_background.webp", quality=95)
    mono.resize((adaptive, adaptive), Image.LANCZOS).save(d / "ic_launcher_monochrome.webp", quality=95)
colors = RES / "values" / "colors.xml"
t = colors.read_text(encoding="utf-8")
colors.write_text(re.sub(r'(name="iconBackground">)[^<]+', r"\g<1>" + RED, t), encoding="utf-8")
print("set", Path(sys.argv[1]).name)
