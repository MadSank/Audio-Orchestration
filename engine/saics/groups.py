"""Song groups: every version of the same song (original, slowed, nightcore, 8D, lyric
video, covers, language versions …) gets one `group` id and a `version` label.

Versions are never duplicates. Grouping combines two kinds of evidence:

* **names** — titles/tags normalised by stripping download-site junk and version
  markers ("slowed + reverb", "nightcore", "English ver.", "(Lyrics)" …), and
* **audio** — beat-synchronous 36-bin chroma compared under all 36 transpositions
  (⅓-semitone steps). Beat-synchronous frames make it tempo-invariant, so slowed and
  nightcore versions still line up; matching passages show up as long diagonals in the
  cross-similarity matrix.

Mashups, compilations and long loops contain several songs, so they never *bridge*
two groups; they only join a group through their own name.
Manual `merge` / `split` / `group` / `name` / `version` overrides are applied last.
"""

import csv
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# ── names ─────────────────────────────────────────────────────────────────────

SITE_PREFIX = re.compile(
    r"^\s*(?:y2mate\.(?:com|is)|y2meta\.app|x2mate\.com|onlymp3\.to|yt5s\.io|savefrom\.net|"
    r"ytmp3\.\w+|audioalter_)\s*[-_]?\s*",
    re.I,
)
JUNK = [
    r"\(\s*\d+\s*kbps\s*\)",  # (320 kbps)
    r"-[A-Za-z0-9_-]{11}-\d+k-\d+",  # y2mate.is/onlymp3: -<yt id>-192k-1701161519
    r"-\d+k-\d{6,}",  # bare bitrate/timestamp suffix
    r"\[[A-Za-z0-9_-]{11}\]",  # [yt id]
    r"\(\s*getmp3\.pro\s*\)|\(\s*mp3cut\.net\s*\)|\bmp3cut\.net\b",
    r"\s-\s*copy$",
    r"\s\(\d\)$",  # " (1)"
    r"\.mp3$",
]
# (label, pattern). Order = order in the combined label, e.g. "sped up+lofi".
VERSION_MARKERS = [
    ("slowed", r"slow(?:ed)?(?:\s*down)?|slower|slowed\s+to\s+perfection|0\.\d+\s*倍速"),
    ("reverb", r"reverb(?:ed)?"),
    ("sped up", r"sped\s*up|speed\s*up|spedup|[1-9](?:\.\d+)?\s*倍速"),
    ("nightcore", r"nightcore"),
    ("8d", r"8\s*d(?:\s*audio)?"),
    ("bass boosted", r"bass\s*boost(?:ed)?|bassboosted"),
    ("lofi", r"lo-?fi(?:\s*vhs)?"),
    ("vinyl", r"vinyl\s*crackle"),
    ("underwater", r"underwater"),
    ("english", r"english\s*(?:ver(?:sion|\.)?|cover)|\(english\)|\beng\.?\s*ver"),
    ("japanese", r"japanese\s*ver(?:sion|\.)?"),
    ("cover", r"(?:self[\s-]*)?cover|covered\s+by"),
    ("remix", r"remix|bootleg|edit\b"),
    ("instrumental", r"instrumental|karaoke|off\s*vocal"),
    ("acoustic", r"acoustic|piano\s*ver(?:sion)?|on\s+one\s+guitar"),
    ("extended", r"extended|1\s*hour(?:\s*loop)?|\bloop\b|10\s*hours"),
    ("lyrics", r"lyrics?(?:\s*video)?|letra"),
    ("ringtone", r"ringtone|着信音"),
    ("ai cover", r"\bai\b"),
]
FILLER = re.compile(
    r"official\s*(?:music\s*)?(?:video|audio|mv|lyric\s*video)?|music\s*video|full\s*(?:song|ver(?:sion)?\.?)|"
    r"\bmv\b|\bhq\b|\bhd\b|\b4k\b|\baudio\b|\bvideo\b|\bver\b\.?|\bversion\b|\btopic\b|"
    r"\bfeat\b\.?.*?(?=[\(\[\-]|$)|\bft\b\.?.*?(?=[\(\[\-]|$)|tiktok(?:\s*(?:version|original))?|"
    r"\bperfectly\b|\bto perfection\b|\bbut\b.*$|\bfrom\b.*$|\bost\b|\bsong\b|\bbgm\b",
    re.I,
)
# Only true function words: titles like "No No No" or "Stay With Me" must keep their words,
# otherwise an artist name ends up as a file's only token and links unrelated songs.
STOP = {"the", "a", "an", "of", "and", "x", "vs", "by", "in", "on", "to", "ni", "wo", "s", "n"}
UNTITLED = re.compile(r"whatsapp audio|^(?:audio|track|recording)[\s_-]*\d", re.I)
MASHUP = re.compile(r"\bmashup\b|\s[x×]\s|\bvs\.?\s|transitions?\s+into|\bmedley\b", re.I)
_CJK = r"぀-ヿ㐀-鿿가-힯"
TOKEN = re.compile(rf"[{_CJK}]+|[a-z0-9]+")


@dataclass
class NameInfo:
    version: str
    tokens: frozenset
    clean: str
    mashup: bool


def clean_stem(stem: str) -> str:
    s = unicodedata.normalize("NFKC", stem)  # 𝖼𝗈𝗏𝖾𝗋 -> cover, full-width -> ascii
    s = SITE_PREFIX.sub("", s)
    for pat in JUNK:
        s = re.sub(pat, "", s, flags=re.I)
    return re.sub(r"\s+", " ", s.replace("_", " ")).strip(" -")


def parse_name(stem: str, tag_title: str = "") -> NameInfo:
    """Version label + title tokens from a filename (and optional tag title)."""
    s = clean_stem(stem)
    found = []
    rest = s
    for label, pat in VERSION_MARKERS:
        rx = re.compile(rf"(?<![a-z0-9]){pat}", re.I)
        if rx.search(rest):
            found.append(label)
            rest = rx.sub(" ", rest)
    if "slowed" in found and "reverb" in found:
        found.remove("reverb")
        found[found.index("slowed")] = "slowed+reverb"
    rest = FILLER.sub(" ", rest)
    words = TOKEN.findall(rest.lower())
    if tag_title:
        words += TOKEN.findall(FILLER.sub(" ", clean_stem(tag_title)).lower())
    tokens = frozenset(w for w in words if w not in STOP and (len(w) > 1 or not w.isascii()))
    clean = re.sub(r"[\s\-_()\[\]【】「」|]+", " ", rest).strip()
    return NameInfo(
        version="+".join(found) if found else "original",
        tokens=tokens,
        clean=clean,
        mashup=bool(MASHUP.search(s)),
    )


def name_similarity(a: NameInfo, b: NameInfo) -> float:
    """Containment of the smaller token set in the larger (0..1), weighted by length."""
    if not a.tokens or not b.tokens:
        return 0.0
    shared = a.tokens & b.tokens
    small = min((a.tokens, b.tokens), key=lambda t: sum(map(len, t)))
    return sum(map(len, shared)) / max(1, sum(map(len, small)))


def name_weight(a: NameInfo, b: NameInfo) -> int:
    """Characters of shared title text (guards against one-word coincidences)."""
    return sum(len(t) * (3 if not t.isascii() else 1) for t in a.tokens & b.tokens)


# ── audio ─────────────────────────────────────────────────────────────────────

BINS = 36  # ⅓-semitone chroma
MAX_FRAMES = 512  # beats compared per file (first 512 beats ≈ 4 min at 120 BPM)
RUN_MIN = 12  # aligned beats needed for a matching passage (3 bars of 4/4)


def audio_signature(y: np.ndarray, sr: int, beats: np.ndarray | None = None) -> np.ndarray:
    """Beat-synchronous 36-bin chroma, (36, <=512) float16, columns L2-normalised."""
    import librosa

    hop = 512
    if beats is None:
        _, beats = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop)
    chroma = librosa.feature.chroma_cqt(
        y=y, sr=sr, hop_length=hop, n_chroma=BINS, bins_per_octave=BINS, n_octaves=6
    )
    if len(beats) < 8:
        return np.zeros((BINS, 0), np.float16)
    sync = librosa.util.sync(chroma, beats, aggregate=np.median)[:, :MAX_FRAMES]
    sync /= np.linalg.norm(sync, axis=0, keepdims=True) + 1e-9
    return sync.astype(np.float16)


# Beat trackers often lock to 2x, 1/2x or 3:2 of the real tempo (especially on nightcore and
# slowed versions), which breaks beat-synchronous alignment. Compare at those frame ratios.
FRAME_RATIOS = (1.0, 2.0, 0.5, 1.5, 2 / 3)


def _rescale(x: np.ndarray, factor: float) -> np.ndarray:
    """Linearly resample a (bins, frames) sequence to round(frames * factor) frames."""
    if factor == 1.0:
        return x
    n = x.shape[1]
    m = max(2, round(n * factor))
    pos = np.linspace(0, n - 1, m)
    lo = np.floor(pos).astype(int)
    hi = np.minimum(lo + 1, n - 1)
    w = (pos - lo)[None, :]
    y = x[:, lo] * (1 - w) + x[:, hi] * w
    return y / (np.linalg.norm(y, axis=0, keepdims=True) + 1e-9)


def _coverage(sim: np.ndarray, run_min: int = RUN_MIN) -> float:
    """Fraction of the shorter sequence covered by diagonal runs >= run_min."""
    n, m = sim.shape
    if n < run_min or m < run_min:
        return 0.0
    # Keep cells that are among the top 10% of both their row and their column.
    kr, kc = int(0.9 * (m - 1)), int(0.9 * (n - 1))
    thr_r = np.partition(sim, kr, axis=1)[:, kr : kr + 1]
    thr_c = np.partition(sim, kc, axis=0)[kc : kc + 1, :]
    hit = (sim >= thr_r) & (sim >= thr_c)
    # Skew so each diagonal becomes a column, then run lengths down axis 0.
    rows = np.arange(n)[:, None]
    cols = np.arange(m)[None, :] - rows + (n - 1)
    z = np.zeros((n + 1, n + m - 1), bool)
    z[np.broadcast_to(rows, (n, m)), cols] = hit
    idx = np.arange(n + 1)[:, None]
    last_zero = np.maximum.accumulate(np.where(z, -1, idx), axis=0)
    run = np.where(z, idx - last_zero, 0)
    ends = z[:-1] & ~z[1:] & (run[:-1] >= run_min)
    ei, ec = np.nonzero(ends)
    length = run[:-1][ei, ec]
    # Rows (in A) and columns (in B) covered by each run.
    cov_a = np.zeros(n + 1)
    np.add.at(cov_a, ei - length + 1, 1)
    np.add.at(cov_a, ei + 1, -1)
    bj = ec - (n - 1) + ei  # B index at the run end
    cov_b = np.zeros(m + 1)
    np.add.at(cov_b, bj - length + 1, 1)
    np.add.at(cov_b, bj + 1, -1)
    fa = float((np.cumsum(cov_a)[:n] > 0).mean())
    fb = float((np.cumsum(cov_b)[:m] > 0).mean())
    return fa if n <= m else fb


COARSE = 4  # beats per frame in the prefilter (about one bar)
COARSE_GATE = 0.25  # ~90th pct of all pairs; missed 1 of 97 name-matched pairs (2026-10-30)


def audio_similarity(a: np.ndarray, b: np.ndarray, coarse: bool = False) -> float:
    """Tempo- and key-invariant similarity of two signatures (0..1).

    coarse=True compares bar-level sequences (~16x cheaper); used as a prefilter."""
    if a.shape[1] < RUN_MIN or b.shape[1] < RUN_MIN:
        return 0.0
    a32, b32 = a.astype(np.float32), b.astype(np.float32)
    run_min = RUN_MIN
    if coarse:
        a32, b32 = _rescale(a32, 1 / COARSE), _rescale(b32, 1 / COARSE)
        run_min = max(2, RUN_MIN // COARSE)
    # Candidate transpositions from the mean profiles (optimal transposition index).
    pa, pb = a32.mean(axis=1), b32.mean(axis=1)
    corr = np.array([pa @ np.roll(pb, r) for r in range(BINS)])
    rots = np.argsort(corr)[-3:]
    best = 0.0
    for f in FRAME_RATIOS:
        bx = _rescale(b32, f)
        for r in rots:
            best = max(best, _coverage(a32.T @ np.roll(bx, r, axis=0), run_min))
    return best


def gated_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Full similarity only for pairs that pass the coarse prefilter."""
    if audio_similarity(a, b, coarse=True) < COARSE_GATE:
        return 0.0
    return audio_similarity(a, b)


# ── grouping ──────────────────────────────────────────────────────────────────

NAME_FULL = 0.999  # name-only links: one title fully contained in the other …
NAME_STRONG = 0.85  # … or 85% contained, when the audio also agrees
NAME_STRONG_WEIGHT = 8  # and at least this much shared title text
NAME_WEAK = 0.5  # name evidence that needs audio support
AUDIO_STRONG = 0.25  # audio alone groups (true versions >= 0.26, noise <= 0.21 on the library)
AUDIO_SUPPORT = 0.12  # audio that confirms a weak name match
NON_BRIDGING_S = 600.0  # compilations / loops


@dataclass
class Link:
    a: int
    b: int
    name: float
    audio: float
    kind: str  # "name", "audio", "name+audio"


@dataclass
class Grouping:
    group: list  # group id per file
    version: list  # version label per file
    names: dict  # group id -> display name
    links: list = field(default_factory=list)
    evidence: list = field(default_factory=list)  # per file: strongest link text
    notes: list = field(default_factory=list)  # per file: review notes


def _slug(text: str) -> str:
    s = re.sub(r"[^\w]+", "-", unicodedata.normalize("NFKC", text).lower()).strip("-")
    return s[:48] or "song"


def decide_link(na: NameInfo, nb: NameInfo, audio: float, bridge_a: bool, bridge_b: bool):
    """Return the link kind, or None. Non-bridging files link only through names."""
    ns, nw = name_similarity(na, nb), name_weight(na, nb)
    name_ok = ns >= NAME_STRONG and nw >= NAME_STRONG_WEIGHT
    name_weak = ns >= NAME_WEAK and nw >= 4
    if name_ok and audio >= AUDIO_SUPPORT:
        return "name+audio"
    if ns >= NAME_FULL and nw >= NAME_STRONG_WEIGHT:
        return "name"  # covers re-arranged beyond audio recognition (guitar, a cappella …)
    if not (bridge_a and bridge_b):
        return None
    if name_weak and audio >= AUDIO_SUPPORT:
        return "name+audio"
    if audio >= AUDIO_STRONG:
        return "audio"
    return None


def build_groups(files: list, names: list, sigs: list, durations: list, audio_fn=None,
                 overrides: list | None = None) -> Grouping:  # fmt: skip
    """files: display paths; names: NameInfo; sigs: signatures; durations: seconds."""
    n = len(files)
    audio_fn = audio_fn or (lambda i, j: audio_similarity(sigs[i], sigs[j]))
    bridge = [not names[i].mashup and durations[i] <= NON_BRIDGING_S for i in range(n)]
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    links = []
    single: dict = {}  # non-bridging file -> its one best link (it must not join two groups)
    for i in range(n):
        for j in range(i + 1, n):
            audio = audio_fn(i, j)
            kind = decide_link(names[i], names[j], audio, bridge[i], bridge[j])
            if not kind:
                continue
            lk = Link(i, j, name_similarity(names[i], names[j]), audio, kind)
            nb = [x for x in (i, j) if not bridge[x]]
            # Versions of the same mashup/compilation (same full title) always join each other.
            same_title = len(nb) == 2 and lk.name >= NAME_FULL
            if not nb or same_title:
                links.append(lk)
                parent[find(j)] = find(i)
                continue
            for x in nb:
                cur = single.get(x)
                if cur is None or (lk.name + lk.audio) > (cur.name + cur.audio):
                    single[x] = lk
    for lk in {id(v): v for v in single.values()}.values():
        # Both ends non-bridging: only keep it if it is each end's best link.
        if all(single.get(x) is lk for x in (lk.a, lk.b) if not bridge[x]):
            links.append(lk)
            parent[find(lk.b)] = find(lk.a)
    version = [nm.version for nm in names]
    evidence = [""] * n
    notes: list = [[] for _ in range(n)]
    for lk in sorted(links, key=lambda x: -(x.audio + x.name)):
        for x, y in ((lk.a, lk.b), (lk.b, lk.a)):
            if not evidence[x]:
                evidence[x] = f"{lk.kind}: {files[y]} (name {lk.name:.2f}, audio {lk.audio:.2f})"
    for i in range(n):
        if not bridge[i]:
            notes[i].append("mashup/compilation/loop: joins a group only by name")

    _apply_overrides(overrides or [], files, parent, find, version, notes)

    roots: dict = {}
    for i in range(n):
        roots.setdefault(find(i), []).append(i)
    group = [""] * n
    display: dict = {}
    used: set = set()
    for members in roots.values():
        # Name the group after its most audio-central plain version.
        def central(k, members=members):
            return sum(audio_fn(min(k, o), max(k, o)) for o in members if o != k)

        canon = max(members, key=lambda k: (version[k] == "original", bridge[k],
                                            not UNTITLED.search(files[k]), central(k),
                                            -len(names[k].clean)))  # fmt: skip
        gid = _slug(names[canon].clean or Path(files[canon]).stem)
        base, k = gid, 2
        while gid in used:
            gid, k = f"{base}-{k}", k + 1
        used.add(gid)
        display[gid] = names[canon].clean or Path(files[canon]).stem
        for m in members:
            group[m] = gid
    for _kind, gid, value in (o for o in overrides or [] if o[0] == "name"):
        if gid in display:
            display[gid] = value
    return Grouping(group, version, display, links, evidence, notes)


def _apply_overrides(overrides, files, parent, find, version, notes) -> None:
    index = {f: i for i, f in enumerate(files)}
    by_name = {Path(f).name: i for i, f in enumerate(files)}

    def lookup(f):
        return index.get(f, by_name.get(Path(f).name))

    for action, a, b in overrides:
        ia = lookup(a)
        if action in ("name",):
            continue
        if ia is None:
            continue
        if action == "merge" and (ib := lookup(b)) is not None:
            parent[find(ia)] = find(ib)
            notes[ia].append(f"override: merged with {files[ib]}")
        elif action == "split":
            # Detach: point every other member at a new root.
            members = [k for k in range(len(parent)) if find(k) == find(ia) and k != ia]
            for k in members:
                parent[k] = k
            if members:
                for k in members[1:]:
                    parent[k] = members[0]
            parent[ia] = ia
            notes[ia].append("override: split into its own group")
        elif action == "version":
            version[ia] = b
            notes[ia].append(f"override: version = {b}")


def read_overrides(path: Path) -> list:
    """CSV lines `action,file_or_group,value` (# comments allowed).

    merge,<file>,<other file>   put <file> in <other file>'s group
    split,<file>,               give <file> its own group
    name,<group id>,<name>      display name for a group
    version,<file>,<label>      fix a version label
    """
    if not path or not Path(path).exists():
        return []
    out = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.reader(f):
            if not row or row[0].strip().startswith("#"):
                continue
            row = [c.strip() for c in row] + ["", ""]
            out.append((row[0].lower(), row[1], row[2]))
    return out


# ── all-pairs audio similarity (parallel) ─────────────────────────────────────

_SIGS: list = []


def _init_worker(sigs):
    global _SIGS
    _SIGS = sigs
    try:  # one BLAS thread per process; the pool already uses every core
        from threadpoolctl import threadpool_limits

        threadpool_limits(1)
    except ImportError:
        pass


def _row(i):
    return i, [gated_similarity(_SIGS[i], _SIGS[j]) for j in range(i + 1, len(_SIGS))]


def similarity_matrix(sigs: list, workers: int = 4, log=None) -> np.ndarray:
    """Symmetric (n, n) audio-similarity matrix; ~45 ms per pair, spread over processes."""
    from concurrent.futures import ProcessPoolExecutor

    n = len(sigs)
    m = np.zeros((n, n), np.float32)
    if n < 2:
        return m
    with ProcessPoolExecutor(workers, initializer=_init_worker, initargs=(sigs,)) as ex:
        for done, (i, vals) in enumerate(ex.map(_row, range(n), chunksize=4), 1):
            m[i, i + 1 :] = vals
            if log and (done % 50 == 0 or done == n):
                log(f"  audio similarity {done}/{n} rows")
    m = m + m.T
    np.fill_diagonal(m, 1.0)
    return m
