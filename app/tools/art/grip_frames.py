import subprocess
from pathlib import Path

S = Path(__file__).parent
page = S / "grip_frame.html"
page.write_text("""<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}svg{display:block}</style>
<body><div id="o"></div>
<script src="hand_sketch.js"></script>
<script>
const seed = +location.hash.slice(1);
const paths = handFrame(seed, 'grip').map((p) => `<path d="${p.d}" fill="${p.fill}" stroke="${p.stroke}" stroke-width="${p.w}" opacity="${p.o}" stroke-linecap="round"/>`).join('');
document.getElementById('o').innerHTML = `<svg width="860" height="1800" viewBox="0 0 430 900">${paths}</svg>`;
</script>
""", encoding="utf-8")
out = Path(r"C:\saics\app\assets\hand")
chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
for i, seed in enumerate((11, 202, 3077)):
    png = out / f"grip{i}.png"
    r = subprocess.run([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
                        f"--screenshot={png}", "--window-size=860,1800", "--default-background-color=00000000",
                        "--virtual-time-budget=3000", f"{page.as_uri()}#{seed}"], capture_output=True, timeout=120)
    print(png.name, r.returncode, round(png.stat().st_size / 1e3), "KB")
