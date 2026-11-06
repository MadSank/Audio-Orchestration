"""Six app icon ideas, rendered at 1024 by a real browser, ready to use as they are."""
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

S = Path(__file__).parent
OUT = S / "icons"
OUT.mkdir(exist_ok=True)
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
NIGHT, VINYL, GROOVE, PAPER, RED = "#0E0C0A", "#1A1612", "#3A332A", "#EEE5D3", "#E8452A"
FONT = (Path(r"C:\saics\app\assets\fonts") / "ShipporiMincho-ExtraBold.ttf").as_uri()


def rings(cx, cy, radii, stroke=GROOVE, w=7):
    return "".join(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{stroke}" stroke-width="{w}"/>' for r in radii)


OPTIONS = {
    # A: type only. 永 means "forever".
    "a_forever": f'<rect width="1024" height="1024" fill="{RED}"/><text x="512" y="745" text-anchor="middle" font-family="Shippori" font-size="680" fill="{NIGHT}">永</text>',
    # B: one bold record on vermilion.
    "b_record": f'<rect width="1024" height="1024" fill="{RED}"/><circle cx="512" cy="512" r="410" fill="{NIGHT}"/>' + rings(512, 512, (230, 280, 330, 380)) + f'<circle cx="512" cy="512" r="150" fill="{RED}"/><circle cx="512" cy="512" r="30" fill="{PAPER}"/>',
    # C: the groove is an infinity sign, with one record label on the loop.
    "c_loop": f'<rect width="1024" height="1024" fill="{NIGHT}"/><path d="M512 512 C410 340 300 300 220 340 C110 395 110 629 220 684 C300 724 410 684 512 512 C614 340 724 300 804 340 C914 395 914 629 804 684 C724 724 614 684 512 512Z" fill="none" stroke="{PAPER}" stroke-width="58" stroke-linejoin="round"/><circle cx="262" cy="512" r="84" fill="{RED}"/><circle cx="262" cy="512" r="16" fill="{NIGHT}"/>',
    # D: a record sliding out of a paper sleeve with its strip.
    "d_sleeve": f'<rect width="1024" height="1024" fill="{NIGHT}"/><circle cx="640" cy="512" r="330" fill="{VINYL}"/>' + rings(640, 512, (170, 220, 270)) + f'<circle cx="640" cy="512" r="110" fill="{RED}"/><circle cx="640" cy="512" r="20" fill="{NIGHT}"/><rect x="0" y="0" width="560" height="1024" fill="{PAPER}"/><rect x="120" y="0" width="150" height="1024" fill="{RED}"/>',
    # E: the initial, on a record's label.
    "e_monogram": f'<rect width="1024" height="1024" fill="{NIGHT}"/>' + rings(512, 512, (440, 490)) + f'<circle cx="512" cy="512" r="390" fill="{RED}"/><text x="512" y="705" text-anchor="middle" font-family="Shippori" font-size="560" fill="{NIGHT}">S</text>',
    # F: the app's own moment, the pencil finger on the record.
    "f_finger": f'<rect width="1024" height="1024" fill="{RED}"/><circle cx="390" cy="400" r="370" fill="{NIGHT}"/>' + rings(390, 400, (190, 240, 290, 340)) + f'<circle cx="390" cy="400" r="130" fill="{RED}"/><circle cx="390" cy="400" r="24" fill="{NIGHT}"/><g transform="translate(420 290) scale(1.75) translate(-50 -40)" id="hand"></g>',
}

for name, svg in OPTIONS.items():
    page = S / f"opt_{name}.html"
    script = ""
    if name == "f_finger":
        script = """<script src="hand_sketch.js"></script><script>
document.getElementById('hand').innerHTML = handFrame(11).map((p) => `<path d="${p.d}" fill="${p.fill}" stroke="${p.stroke}" stroke-width="${p.w}" opacity="${p.o}" stroke-linecap="round"/>`).join('');
</script>"""
    page.write_text(f"""<!doctype html><meta charset="utf-8"><style>@font-face{{font-family:Shippori;src:url({FONT})}}
html,body{{margin:0;background:#000}}svg{{display:block}}</style>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">{svg}</svg>{script}""", encoding="utf-8")
    png = OUT / f"{name}.png"
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
                    f"--screenshot={png}", "--window-size=1024,1024", "--virtual-time-budget=4000", page.as_uri()], capture_output=True, timeout=120)
    print(name, png.exists())

# A preview sheet, for checking before anyone else sees them.
names = list(OPTIONS)
sheet = Image.new("RGB", (6 * 190, 300), (70, 110, 170))
for i, name in enumerate(names):
    im = Image.open(OUT / f"{name}.png").convert("RGBA")
    for size, y in ((170, 10), (72, 200)):
        t = im.resize((size, size), Image.LANCZOS)
        m = Image.new("L", (size * 4, size * 4), 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), size, fill=255)
        t.putalpha(m.resize((size, size), Image.LANCZOS))
        sheet.paste(t, (10 + i * 190, y), t)
sheet.save(S / "icons_sheet.png")
