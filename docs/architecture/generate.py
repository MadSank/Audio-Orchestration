"""Generates SAICS's four architecture diagrams (diagram-design grammar, Obi Night skin). Run: python generate.py docs/architecture"""
import html
import os
import sys

OUT = sys.argv[1]

# ── the skin: SAICS's Obi Night design mapped onto diagram-design's semantic roles ──
PAPER = "#0E0C0A"     # night
PAPER2 = "#16130F"    # vinyl
INK = "#EEE5D3"       # paper (warm off-white text)
MUTED = "#B9AE9A"
SOFT = "#9A8F7C"
ACCENT = "#E8452A"    # vermilion, the one accent
LINK = "#6FD3FF"      # Bluetooth / external (the app's jump cyan)
INK_A = lambda a: f"rgba(238,229,211,{a})"
ACC_A = lambda a: f"rgba(232,69,42,{a})"
SERIF = "'Shippori Mincho', 'Noto Serif', serif"
SANS = "'Archivo Narrow', 'Archivo', system-ui, sans-serif"
MONO = "'IBM Plex Mono', ui-monospace, monospace"
FONTS = "https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@800&family=Archivo+Narrow:wght@500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"

KINDS = {  # node type -> (fill, stroke, tag colour)
    "focal": (ACC_A(0.12), ACCENT, ACCENT),
    "backend": (PAPER2, INK, INK),
    "store": (INK_A(0.05), MUTED, MUTED),
    "external": (INK_A(0.03), INK_A(0.30), SOFT),
}
ARROWS = {"muted": (MUTED, "arrow"), "accent": (ACCENT, "arrow-accent"), "link": (LINK, "arrow-link")}


def esc(s):
    return html.escape(s, quote=True)


def mono_w(text, size=8, track=0.06):
    return len(text) * size * (0.62 + track)


class Diagram:
    def __init__(self, slug, w, h, top=0):
        self.slug, self.w, self.h, self.top = slug, w, h, top  # the canvas starts at y=top
        self.zones, self.arrows, self.labels, self.nodes, self.legend = [], [], [], [], []

    def zone(self, x, y, w, h, label):
        lw = int(mono_w(label, 7, 0.14) + 12) // 4 * 4 + 4
        cx = x + 16 + lw // 2
        self.zones.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{INK_A(0.02)}" stroke="{INK_A(0.14)}" stroke-width="0.8"/>\n'
            f'<rect x="{x + 16}" y="{y + 4}" width="{lw}" height="12" rx="2" fill="{PAPER}"/>\n'
            f'<text x="{cx}" y="{y + 13}" fill="{SOFT}" font-size="7" font-family="{MONO}" text-anchor="middle" letter-spacing="0.14em">{esc(label)}</text>')

    def node(self, x, y, w, h, kind, tag, name, sub):
        fill, stroke, tagc = KINDS[kind]
        tw = int(mono_w(tag, 7, 0.08) + 10) // 4 * 4 + 4
        cx = x + w // 2
        tag_stroke = ACC_A(0.5) if kind == "focal" else INK_A(0.35)
        self.nodes.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{PAPER}"/>\n'
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{fill}" stroke="{stroke}" stroke-width="1"/>\n'
            f'<rect x="{x + 8}" y="{y + 6}" width="{tw}" height="12" rx="2" fill="transparent" stroke="{tag_stroke}" stroke-width="0.8"/>\n'
            f'<text x="{x + 8 + tw / 2:g}" y="{y + 15}" fill="{tagc}" font-size="7" font-family="{MONO}" text-anchor="middle" letter-spacing="0.08em">{esc(tag)}</text>\n'
            f'<text x="{cx}" y="{y + 38}" fill="{INK}" font-size="13" font-weight="600" font-family="{SANS}" text-anchor="middle">{esc(name)}</text>\n'
            + "\n".join(  # one sublabel line, or two for the detailed diagrams (h=80)
                f'<text x="{cx}" y="{y + 53 + 13 * i}" fill="{MUTED}" font-size="9" font-family="{MONO}" text-anchor="middle">{esc(s)}</text>'
                for i, s in enumerate([sub] if isinstance(sub, str) else sub)))

    def arrow(self, d, role="muted", dashed=False):
        color, marker = ARROWS[role]
        dash = ' stroke-dasharray="4,3"' if dashed else ""
        sw = "1" if dashed else "1.2"
        self.arrows.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}"{dash} marker-end="url(#{marker})"/>')

    def label(self, cx, cy, text, role="muted"):
        """A masked arrow label centred at (cx, cy); the caller keeps it 6-10px off its stroke."""
        color = ARROWS[role][0] if role != "muted" else SOFT
        w = int(mono_w(text) + 8) // 4 * 4 + 4
        self.labels.append(
            f'<rect x="{cx - w / 2:g}" y="{cy - 6}" width="{w}" height="12" rx="2" fill="{PAPER}"/>\n'
            f'<text x="{cx}" y="{cy + 3}" fill="{color}" font-size="8" font-family="{MONO}" text-anchor="middle" letter-spacing="0.06em">{esc(text)}</text>')

    def legend_strip(self, y, items):
        out = [f'<line x1="40" y1="{y}" x2="{self.w - 40}" y2="{y}" stroke="{INK_A(0.12)}" stroke-width="0.8"/>',
               f'<text x="40" y="{y + 18}" fill="{SOFT}" font-size="8" font-family="{MONO}" letter-spacing="0.18em">LEGEND</text>']
        x = 40
        for kind, text in items:
            if kind in KINDS:
                f, s, _ = KINDS[kind]
                out.append(f'<rect x="{x}" y="{y + 32}" width="14" height="10" rx="2" fill="{f}" stroke="{s}" stroke-width="1"/>')
            else:
                color, marker = ARROWS[kind.replace("dashed", "muted").replace("event", "muted")]
                marker = "arrow-open" if kind == "event" else marker
                dash = ' stroke-dasharray="4,3"' if kind in ("dashed", "event") else ""
                out.append(f'<line x1="{x}" y1="{y + 37}" x2="{x + 24}" y2="{y + 37}" stroke="{color}" stroke-width="1.2"{dash} marker-end="url(#{marker})"/>')
            out.append(f'<text x="{x + 30}" y="{y + 40}" fill="{MUTED}" font-size="9" font-family="{SANS}">{esc(text)}</text>')
            x += 30 + int(len(text) * 9 * 0.5) + 36
        self.legend = out

    def svg(self, title, desc):
        markers = "".join(
            f'<marker id="{m}" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="{c}"/></marker>'
            for c, m in ARROWS.values())
        body = "\n".join(self.zones + self.arrows + self.labels + self.nodes + self.legend)
        return (f'<svg viewBox="0 {self.top} {self.w} {self.h - self.top}" xmlns="http://www.w3.org/2000/svg" role="img" '
                f'aria-labelledby="{self.slug}-title {self.slug}-desc">\n'
                f'<title id="{self.slug}-title">{esc(title)}</title>\n<desc id="{self.slug}-desc">{esc(desc)}</desc>\n'
                f'<defs>{markers}</defs>\n<rect x="0" y="{self.top}" width="{self.w}" height="{self.h - self.top}" fill="{PAPER}"/>\n{body}\n</svg>')


def page(d, eyebrow, h1, title, desc, caption):
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{esc(title)}</title>
  <link href="{FONTS}" rel="stylesheet">
  <style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    :root {{ --paper: {PAPER}; --ink: {INK}; --muted: {MUTED}; --accent: {ACCENT}; }}
    body {{ font-family: {SANS}; background: var(--paper); color: var(--ink); min-height: 100vh;
           display: flex; align-items: center; justify-content: center; padding: 3rem 2rem; }}
    .frame {{ max-width: 1100px; width: 100%; }}
    .eyebrow {{ font-family: {MONO}; font-size: 0.66rem; font-weight: 500; letter-spacing: 0.18em;
               text-transform: uppercase; color: var(--muted); margin-bottom: 0.5rem; }}
    h1 {{ font-family: {SERIF}; font-weight: 800; font-size: clamp(1.5rem, 2.4vw + 0.75rem, 2.1rem);
         line-height: 1.15; margin-bottom: 1.5rem; }}
    .scroll {{ overflow-x: auto; }}
    svg {{ width: 100%; min-width: {d.w}px; display: block; }}
    .caption {{ font-family: {SANS}; font-size: 0.95rem; color: var(--muted); margin-top: 1.25rem; max-width: 60ch; }}
  </style>
</head>
<body>
  <div class="frame">
    <p class="eyebrow">{esc(eyebrow)}</p>
    <h1>{esc(h1)}</h1>
    <div class="scroll">
{d.svg(title, desc)}
    </div>
    <p class="caption">{esc(caption)}</p>
  </div>
</body>
</html>
"""


# ── 1. Overview ──────────────────────────────────────────────────────────────
a = Diagram("saics-architecture", 1000, 624, top=72)
a.zone(240, 112, 192, 288, "MUSIC FOLDER")
a.zone(488, 96, 272, 376, "ANDROID PHONE")
# arrows (drawn before the boxes)
a.arrow("M 256,176 H 124 Q 116,176 116,184 V 240")                    # songs -> analysis
a.arrow("M 116,304 V 344 Q 116,352 124,352 H 256", "accent")          # analysis -> bundle
a.arrow("M 416,352 H 456 Q 464,352 464,360 V 416 Q 464,424 472,424 H 528")  # bundle -> audio engine
a.arrow("M 336,384 V 464")                                            # bundle -> PC app
a.arrow("M 600,192 V 256")                                            # UI -> service
a.arrow("M 648,256 V 192", dashed=True)                               # service -> UI
a.arrow("M 624,320 V 392")                                            # service -> engine
a.arrow("M 824,288 H 720", "link")                                    # helmet -> service
a.arrow("M 720,424 H 888 Q 896,424 896,416 V 320", "link")            # engine -> helmet
# labels
a.label(188, 164, "READS")
a.label(188, 340, "WRITES", "accent")
a.label(416, 400, "SYNCED FOLDER")
a.label(384, 424, "FOLDER PICKER")
a.label(574, 224, "CALLS")
a.label(674, 224, "STATE")
a.label(656, 356, "INTENTS")
a.label(772, 272, "MEDIA KEYS", "link")
a.label(930, 368, "BT AUDIO", "link")
# boxes
a.node(40, 240, 152, 64, "backend", "LAPTOP", "Analysis engine", "Python · per song")
a.node(256, 144, 160, 64, "store", "AUDIO", "Songs", "mp3 · m4a · flac")
a.node(256, 320, 160, 64, "focal", "CONTRACT", ".saics bundle", "beats · jumps · portals")
a.node(528, 128, 192, 64, "backend", "EXPO", "Screens", "React Native · TS")
a.node(528, 256, 192, 64, "backend", "MEDIA3", "Playback service", "MediaSession · Kotlin")
a.node(528, 392, 192, 64, "focal", "REAL-TIME", "Audio engine", "walks · seams · Kotlin")
a.node(824, 256, 144, 64, "external", "BT", "Cardo helmet", "3 buttons · audio")
a.node(256, 464, 160, 64, "backend", "WEB", "PC app", "Web Audio · browser")
a.legend_strip(560, [("focal", "Focal"), ("backend", "Component"), ("store", "Store"), ("external", "External"),
                     ("accent", "Analysis output"), ("link", "Bluetooth"), ("dashed", "Events back")])

open(os.path.join(OUT, "saics-architecture.html"), "w", encoding="utf-8", newline="\n").write(page(
    a, "Architecture · SAICS", "How SAICS fits together",
    "How SAICS fits together",
    "SAICS analyses a music library once on a laptop into a .saics bundle beside the songs; the Android app and the PC app read that folder and play it as endless loops and mixes, controlled from a Cardo helmet.",
    "The laptop analyses each song once; everything after that runs offline on the device. "
    "The website and its GitHub Pages deploy (which also hosts the PC app) and the evaluation server are left out."))

# ── 2. Inside the phone ──────────────────────────────────────────────────────
p = Diagram("saics-phone", 1000, 688, top=128)
p.zone(648, 288, 176, 280, "REAL-TIME")
p.arrow("M 184,172 H 248")                                            # screens -> module
p.arrow("M 248,196 H 184", dashed=True)                               # module -> screens
p.arrow("M 392,184 H 456")                                            # module -> service
p.arrow("M 856,184 H 600", "link")                                    # helmet -> service
p.arrow("M 528,216 V 320")                                            # service -> scheduler
p.arrow("M 600,352 H 664", "accent")                                  # scheduler -> renderer
p.arrow("M 736,472 V 384")                                            # decoder -> renderer
p.arrow("M 808,352 H 912 Q 920,352 920,344 V 216", "link")            # renderer -> helmet
p.arrow("M 112,472 V 360 Q 112,352 120,352 H 456")                    # folder -> scheduler
p.arrow("M 112,536 V 600 Q 112,608 120,608 H 728 Q 736,608 736,600 V 536")  # folder -> decoder
p.arrow("M 248,504 H 184")                                            # lite -> folder
p.label(216, 160, "CALLS")
p.label(216, 208, "EVENTS")
p.label(424, 172, "CONTROL")
p.label(728, 172, "MEDIA KEYS", "link")
p.label(560, 268, "INTENTS")
p.label(632, 340, "SEAMS", "accent")
p.label(758, 428, "PCM")
p.label(954, 280, "BT AUDIO", "link")
p.label(300, 340, "BUNDLE")
p.label(440, 596, "AUDIO FILES")
p.label(216, 492, "WRITES")
p.node(40, 152, 144, 64, "backend", "EXPO", "Screens", "now playing · crate")
p.node(248, 152, 144, 64, "backend", "BRIDGE", "Native module", "Expo modules API")
p.node(456, 152, 144, 64, "focal", "MEDIA3", "Playback service", "helmet multi-press")
p.node(856, 152, 128, 64, "external", "BT", "Cardo helmet", "play · next · prev")
p.node(456, 320, 144, 64, "backend", "SCHED", "Scheduler", "Forever · Infinite Ride")
p.node(664, 320, 144, 64, "focal", "AUDIO", "Renderer", "AudioTrack · no locks")
p.node(664, 472, 144, 64, "backend", "THREADS", "Decoder", "MediaCodec → PCM")
p.node(248, 472, 144, 64, "backend", "LITE", "On-phone analyser", "ONNX · new songs")
p.node(40, 472, 144, 64, "store", "FOLDER", "Music folder", "audio + .saics")
p.legend_strip(624, [("focal", "Focal"), ("backend", "Component"), ("store", "Store"), ("external", "External"),
                     ("accent", "Next seam, sample-exact"), ("link", "Bluetooth"), ("dashed", "Events back")])

open(os.path.join(OUT, "saics-phone.html"), "w", encoding="utf-8", newline="\n").write(page(
    p, "Architecture · SAICS · Android", "Inside the phone",
    "Inside the SAICS phone app",
    "Inside the SAICS Android app: React Native screens talk through a native module to a Media3 playback service, whose scheduler hands seams to a real-time renderer fed by decoder threads, with the Cardo helmet's buttons arriving through the media session.",
    "The renderer runs on its own thread with no allocations, locks or logging; decoding and the walks' decisions happen elsewhere and reach it as ready PCM and single instructions. "
    "Helmet presses arrive as standard media keys, so every ride action works with the screen off."))

# ── 3. How a jump is found (the laptop's analysis, per song) ─────────────────
f = Diagram("saics-analysis", 1000, 640, top=112)
C0, C1, C2, C3, W, H = 40, 280, 520, 760, 176, 80
R1, R2, R3 = 144, 304, 464
# row 1, left to right
f.arrow(f"M {C0 + W},{R1 + 40} H {C1}")
f.arrow(f"M {C1 + W},{R1 + 40} H {C2}")
f.arrow(f"M {C2 + W},{R1 + 40} H {C3}")
f.arrow(f"M {C3 + 88},{R1 + H} V {R2}")                               # bars -> self-similarity
# row 2, right to left
f.arrow(f"M {C3},{R2 + 40} H {C2 + W}")
f.arrow(f"M {C2},{R2 + 40} H {C1 + W}", "accent")                     # jump finder -> bundle
f.arrow(f"M {C1},{R2 + 40} H {C0 + W}")
f.arrow(f"M {C2 + 88},{R3} V {R2 + H}")                               # vocal stem -> jump finder
f.label(248, R1 + 28, "AUDIO")
f.label(488, R1 + 28, "BEATS")
f.label(728, R1 + 28, "PER BEAT")
f.label(892, R1 + 120, "FINGERPRINT")
f.label(728, R2 + 28, "STRIPES")
f.label(488, R2 + 28, "JUMPS", "accent")
f.label(248, R2 + 28, "LIBRARY")
f.label(648, R3 - 40, "VOCAL STEM")
f.node(C0, R1, W, H, "backend", "FFMPEG", "Decode", ["44.1 kHz stereo", "+ a mono mix"])
f.node(C1, R1, W, H, "backend", "MODEL", "Beat This!", ["beats + downbeats", "meter from downbeats"])
f.node(C2, R1, W, H, "backend", "LIBROSA", "Features per beat", ["36-bin CQT chroma, bass", "MFCC 1-13, onsets"])
f.node(C3, R1, W, H, "backend", "BARS", "Bar fingerprints", ["each beat slot of a bar", "never assumes 4/4"])
f.node(C3, R2, W, H, "backend", "SSM", "Self-similarity", ["every bar vs every bar", "novelty → sections"])
f.node(C2, R2, W, H, "focal", "RULES", "Jump finder", ["4 bars each side ≥ 0.55", "≥ 16 bars apart, align ±4"])
f.node(C2, R3, W, H, "backend", "DEMUCS", "Vocal stem", ["sung line must continue", "across the seam"])
f.node(C1, R2, W, H, "focal", "JSON", ".saics bundle", ["beats, sections, jumps", "gain to −14 LUFS"])
f.node(C0, R2, W, H, "backend", "GRAPH", "Portal matcher", ["tempo ±5%, Camelot key", "4 bars of the same chords"])
f.legend_strip(576, [("focal", "Focal"), ("backend", "Step"), ("accent", "The result")])
open(os.path.join(OUT, "saics-analysis.html"), "w", encoding="utf-8", newline="\n").write(page(
    f, "Engine · SAICS · analysis", "How a jump is found",
    "How SAICS finds a jump",
    "The laptop analysis of one song: decoding, a neural beat tracker, beat-level features and bar fingerprints, a self-similarity matrix, vocal separation and the jump finder's rules, written to a .saics bundle, then matched across songs into portals.",
    "A jump is only allowed where the music repeats: the bars either side of the seam must match a "
    "stripe in the self-similarity matrix, the target is aligned to within four bars, and a sung line "
    "may not be cut. Portals use the same idea between two songs. This runs once per song; the phone "
    "only reads the result."))


# ── 4. How a jump is played (the phone engine, one bar to the next) ──────────
class Sequence(Diagram):
    """diagram-design's Sequence grammar: actors, dashed lifelines, messages top to bottom."""

    def __init__(self, slug, w, h, top, actors, life_end):
        super().__init__(slug, w, h, top)
        self.x = {}
        for key, cx, kind, tag, name, sub in actors:
            self.x[key] = cx
            self.zones.append(f'<line x1="{cx}" y1="{top + 72}" x2="{cx}" y2="{life_end}" stroke="{INK_A(0.22)}" stroke-width="1" stroke-dasharray="3,3"/>')
            self.node(cx - 80, top + 8, 160, 64, kind, tag, name, sub)

    def frame(self, x, y, w, h, op, guard):
        self.zones.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="4" fill="{INK_A(0.04)}" stroke="{INK_A(0.22)}" stroke-width="1"/>\n'
            f'<rect x="{x}" y="{y}" width="44" height="16" rx="2" fill="{PAPER}" stroke="{INK_A(0.22)}" stroke-width="1"/>\n'
            f'<text x="{x + 22}" y="{y + 12}" fill="{MUTED}" font-size="8" font-family="{MONO}" text-anchor="middle" letter-spacing="0.12em">{op}</text>\n'
            f'<text x="{x + 52}" y="{y + 12}" fill="{MUTED}" font-size="8" font-family="{MONO}" letter-spacing="0.04em">{esc(guard)}</text>')

    def active(self, key, y0, y1):
        cx = self.x[key]
        self.zones.append(f'<rect x="{cx - 4}" y="{y0}" width="8" height="{y1 - y0}" fill="{INK_A(0.06)}" stroke="{MUTED}" stroke-width="0.8"/>')

    def msg(self, a, b, y, text, kind="call"):
        """call: solid, filled head; ret: dashed, filled; async: dashed, open head; head: accent."""
        xa, xb = self.x[a], self.x[b]
        d = 1 if xb > xa else -1
        x1, x2 = xa + 4 * d, xb - 4 * d  # from and to the activation-bar edges
        stroke, marker, dash = {"call": (MUTED, "arrow", ""), "ret": (MUTED, "arrow", ' stroke-dasharray="4,3"'),
                                "async": (MUTED, "arrow-open", ' stroke-dasharray="4,3"'),
                                "head": (ACCENT, "arrow-accent", "")}[kind]
        self.arrows.append(f'<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="{stroke}" stroke-width="1.2"{dash} marker-end="url(#{marker})"/>')
        self.label((x1 + x2) / 2, y - 12, text, "accent" if kind == "head" else "muted")

    def self_msg(self, a, y, text, kind="call"):
        cx = self.x[a] + 4
        stroke, marker = (ACCENT, "arrow-accent") if kind == "head" else (MUTED, "arrow")
        self.arrows.append(f'<path d="M {cx},{y} H {cx + 28} Q {cx + 36},{y} {cx + 36},{y + 8} V {y + 12} Q {cx + 36},{y + 20} {cx + 28},{y + 20} H {cx}" '
                           f'fill="none" stroke="{stroke}" stroke-width="1.2" marker-end="url(#{marker})"/>')
        w = int(mono_w(text) + 8) // 4 * 4 + 4
        color = ACCENT if kind == "head" else SOFT
        self.labels.append(
            f'<rect x="{cx + 44}" y="{y + 4}" width="{w}" height="12" rx="2" fill="{PAPER}"/>\n'
            f'<text x="{cx + 48}" y="{y + 13}" fill="{color}" font-size="8" font-family="{MONO}" letter-spacing="0.06em">{esc(text)}</text>')

    def svg(self, title, desc):
        out = super().svg(title, desc)
        opened = f'<marker id="arrow-open" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polyline points="0 0, 8 3, 0 6" fill="none" stroke="{MUTED}" stroke-width="1.2"/></marker>'
        return out.replace("</defs>", opened + "</defs>", 1)


s = Sequence("saics-playback", 1000, 816, 112, [
    ("walks", 120, "backend", "WALKS", "Forever / Ride", "pick the next bar"),
    ("sched", 312, "backend", "SCHED", "Scheduler", "10 ms tick"),
    ("rend", 504, "focal", "AUDIO", "Renderer", "audio thread"),
    ("dec", 696, "backend", "THREADS", "Decoder", "whole song to PCM"),
    ("ui", 868, "backend", "EXPO", "Screen", "record + hand"),
], life_end=728)
s.frame(88, 272, 456, 192, "LOOP", "[every new bar]")
s.active("sched", 296, 496)
s.active("sched", 632, 688)
s.active("ui", 480, 496)
s.active("ui", 672, 724)
s.active("walks", 304, 344)
s.active("rend", 528, 616)
s.msg("dec", "rend", 232, "PCM INTO SLOT", "async")
s.msg("sched", "walks", 312, "STEP(BAR+1)")
s.msg("walks", "sched", 344, "JUMP 64 → 24", "ret")
s.self_msg("sched", 368, "MATCH SEAM")
s.msg("sched", "rend", 432, "INSTRUCTION")
s.msg("sched", "ui", 488, "JUMP-SOON, DIR, MS", "async")
s.self_msg("rend", 536, "ARM 512 AHEAD")
s.self_msg("rend", 576, "30 MS CROSSFADE", "head")
s.msg("rend", "sched", 640, "EXECUTED", "async")
s.msg("sched", "ui", 680, "JUMP", "async")
s.self_msg("ui", 696, "HAND PUSHES")
s.legend_strip(752, [("focal", "Focal"), ("backend", "Actor"), ("muted", "Call"), ("dashed", "Reply"), ("event", "One-way event"),
                     ("accent", "The seam itself")])
open(os.path.join(OUT, "saics-playback.html"), "w", encoding="utf-8", newline="\n").write(page(
    s, "Engine · SAICS · playback", "How a jump is played",
    "How SAICS plays a jump",
    "The phone engine from one bar to the next: the scheduler asks the walk for the next bar, matches the seam, hands the renderer one instruction for the downbeat, and tells the screen; the renderer arms it a block ahead and crossfades for 30 ms on the beat, then reports back.",
    "Every bar, the walk decides one bar ahead whether to jump; the jump is handed over as a single "
    "instruction for the exact downbeat frame. The renderer, the only real-time thread, takes it a block "
    "ahead and fades between the two places over 30 ms, matched by correlation so the seam doesn't dip. "
    "The screen hears about it twice: early, so the hand can reach the record, and when it happens."))
print("ok")
