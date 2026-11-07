"""Measurements for cross-song seams (P4a round 3 fixes), cached in `.saics/seams/<id>.npz`.

Round 3 showed two things the bar features can't see: the level step at a seam (song-level gain
leaves sections unlevelled) and the beat phase (Beat This! reports on a 20 ms grid). So per song:

* `level_out`, `level_in`: the plain level in dB of the second before and after each downbeat,
  after the song's gain_db. Of the windows and weightings tried, this is the one that predicts the
  owner's round 3 ratings (r = -0.34; K-weighted levels at 0.5 s to 2 bars: about 0);
* `beats_fine`: every beat snapped to its onset at ~1.5 ms;
* `env`: the onset envelope, for lining up two songs' attacks directly.

A portal then gets a landing nudge (`landing_offset_ms`, in the graph) and a landing trim that
glides back to the song's own level (`seam_trim_db`, computed where the move is made so that
fallback cuts get it as well: mixwalk.py and MixWalk.kt implement the same rule).

The nudge needs two independent estimates to agree (the beats' local grid, and correlating the
onsets around the seam). Alone, neither predicts the ratings: they scatter on pairs with no clear
attack, and a wrong nudge is worse than none. Where they agree the shifts are real.
"""

import json
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

SR = 22050
ENV_HOP = 64  # ~2.9 ms
WINDOW_S = 0.04  # how far a beat may snap to its onset
FIT_BEATS = 8  # beats either side of a seam that the local grid is fitted on
FIT_MAX_MAD_S = 0.015  # a looser fit than this means no clear beat here: no correction
OFFSET_MAX_MS = 80.0
AGREE_MS = 15.0  # the two timing estimates must be this close for a nudge
XCORR_MIN = 0.2  # ... and the onsets must actually correlate
XCORR_BEATS = 2  # beats either side of the seam (a tempo difference cancels around the centre)
LEVEL_S = 1.0
TRIM_MAX_DB = 6.0
TRIM_DEADBAND_DB = 0.5
GLIDE_BARS = 4  # bars over which a trim returns to the song's own level
# Tracked beats sit ~11 ms after the attack, so a 30 ms fade centred on them has both songs'
# attacks inside it: A's next hit leaks through while B's is still fading in. So a portal's seam
# moves earlier in both songs (11 ms + half the fade + 3 ms), which keeps them aligned. Round 3c:
# 3.95 against 3.85, better on 7 portals and worse on 4. Not proof, but no regression.
EARLY_MS = -29.0
# Round 3c: portals trimmed by 1 dB or more fell from 4.11 to 3.67, against 4.14 to 4.00 where the
# audio hadn't changed. So the trim is off, on the owner's call. Earlier rounds' clips still use it.
LANDING_TRIM = False
FLOOR_DB = -70.0


def seam_levels(y: np.ndarray, sr: int, bar_t: np.ndarray, gain_db: float = 0.0) -> tuple:
    """(level_out, level_in) in dB after `gain_db`: the second before / after each time."""
    cum = np.r_[0.0, np.cumsum(y.astype(np.float64) ** 2)]
    n, w = len(y), int(LEVEL_S * sr)
    at = np.clip((np.asarray(bar_t) * sr).astype(int), 0, n)

    def level(a, b):
        p = (cum[b] - cum[a]) / np.maximum(b - a, 1)
        return np.maximum(10 * np.log10(p + 1e-12) + gain_db, FLOOR_DB)

    return level(np.maximum(at - w, 0), at), level(at, np.minimum(at + w, n))


def onset_env(y: np.ndarray, sr: int = SR) -> np.ndarray:
    """Onset strength at ENV_HOP as uint8 (0..255 of the song's own peak)."""
    import librosa

    e = librosa.onset.onset_strength(y=y, sr=sr, hop_length=ENV_HOP, n_fft=1024)
    return np.round(255 * e / (e.max() + 1e-9)).astype(np.uint8)


def snap_beats(y: np.ndarray, sr: int, beats: np.ndarray, win_s: float = WINDOW_S) -> np.ndarray:
    """Each beat moved to the strongest onset within +-win_s (unchanged where there is none)."""
    import librosa

    hop = max(1, sr // 700)
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, n_fft=1024)
    out = np.asarray(beats, float).copy()
    for i, b in enumerate(out):
        lo, hi = max(int((b - win_s) * sr / hop), 0), min(int((b + win_s) * sr / hop) + 1, len(env))
        if hi - lo >= 3 and env[lo:hi].max() > 0:
            out[i] = (lo + int(np.argmax(env[lo:hi]))) * hop / sr
    return out


def _grid_at(idx: np.ndarray, t: np.ndarray, at: int) -> float | None:
    """Robust line through (beat index, time), read at beat `at`; None if there's no clear grid."""
    if len(idx) < 4:
        return None
    i, j = np.triu_indices(len(idx), 1)
    slope = float(np.median((t[j] - t[i]) / (idx[j] - idx[i])))
    icpt = float(np.median(t - slope * idx))
    if np.median(np.abs(t - (icpt + slope * idx))) > FIT_MAX_MAD_S:
        return None
    return icpt + slope * at


def grid_error_out(beats: np.ndarray, fine: np.ndarray, b: int) -> float | None:
    """Seconds from beat `b` as tracked to where the beats BEFORE it say it should fall."""
    idx = np.arange(max(0, b - FIT_BEATS), b)
    g = _grid_at(idx, fine[idx], b) if b < len(beats) else None
    return None if g is None else g - float(beats[b])


def grid_error_in(beats: np.ndarray, fine: np.ndarray, b: int) -> float | None:
    """Seconds from beat `b` as tracked to where the beats FROM it on actually run."""
    idx = np.arange(b, min(len(beats), b + FIT_BEATS))
    g = _grid_at(idx, fine[idx], b)
    return None if g is None else g - float(beats[b])


def onset_lag_ms(env_a, t_a: float, env_b, t_b: float, half_s: float) -> tuple:
    """(ms into B that best line its onsets up with A's around the seam, the correlation there)."""
    h = int(half_s * SR / ENV_HOP)
    ca, cb = int(t_a * SR / ENV_HOP), int(t_b * SR / ENV_HOP)
    ml = int(OFFSET_MAX_MS / 1000 * SR / ENV_HOP)
    if h <= 0 or ca - h < 0 or cb - h - ml < 0 or ca + h > len(env_a) or cb + h + ml > len(env_b):
        return 0.0, 0.0
    a = np.asarray(env_a[ca - h : ca + h], float)
    a = a - a.mean()
    best, peak = 0, -1.0
    for lag in range(-ml, ml + 1):
        b = np.asarray(env_b[cb + lag - h : cb + lag + h], float)
        b = b - b.mean()
        c = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))
        if c > peak:
            best, peak = lag, c
    return best * ENV_HOP / SR * 1000, peak


def landing_offset_ms(err_out, err_in, lag_ms: float, peak: float) -> float:
    """Shift of the landing so that B's first beat falls on A's grid, in ms; 0 unless sure.

    Cutting at A's tracked downbeat, A's grid has the beat err_out later. Landing at L, B's beat
    plays (tracked + err_in - L) later, so L = tracked + err_in - err_out. That estimate and the
    onset lag must agree."""
    if err_out is None or err_in is None or peak < XCORR_MIN:
        return 0.0
    grid = (err_in - err_out) * 1000
    if abs(grid - lag_ms) > AGREE_MS:
        return 0.0
    return float(np.clip((grid + lag_ms) / 2, -OFFSET_MAX_MS, OFFSET_MAX_MS))


def seam_trim_db(level_out, exit_bar: int, level_in, land_bar: int) -> float:
    """Gain on B at the landing, gliding to 0 over GLIDE_BARS. 0 for the top of a song: a fresh
    start is allowed to start like one."""
    if land_bar <= 0 or exit_bar <= 0 or exit_bar >= len(level_out) or land_bar >= len(level_in):
        return 0.0
    d = float(level_out[exit_bar]) - float(level_in[land_bar])
    if abs(d) < TRIM_DEADBAND_DB:
        return 0.0
    return float(np.clip(d, -TRIM_MAX_DB, TRIM_MAX_DB))


def _measure(job: tuple) -> str:
    from saics.io import decode

    src, out, gain_db, beats, down = job
    beats, down = np.asarray(beats, float), np.asarray(down, int)
    y = decode(Path(src), sr=SR, mono=True)
    lo, li = seam_levels(y, SR, beats[down], gain_db)
    np.savez_compressed(
        out,
        level_out=lo.astype(np.float32),
        level_in=li.astype(np.float32),
        beats_fine=snap_beats(y, SR, beats),
        env=onset_env(y),
    )
    return Path(src).name


def measure_folder(folder: Path, workers: int = 4, log=print) -> int:
    """Fill `.saics/seams/` for every analysed song that lacks it. Returns how many were new."""
    folder = Path(folder).resolve()
    sd = folder / ".saics"
    (sd / "seams").mkdir(exist_ok=True)
    lib = json.loads((sd / "library.json").read_text(encoding="utf-8"))
    jobs = []
    for t in lib["tracks"]:
        bp, out = sd / "tracks" / f"{t['id']}.json", sd / "seams" / f"{t['id']}.npz"
        if t.get("class", "music") != "music" or not bp.exists() or out.exists():
            continue
        d = json.loads(bp.read_text(encoding="utf-8"))
        if d["downbeats"]:
            jobs.append((str(folder / t["file"]), str(out), d["loudness"]["gain_db"], d["beats"],
                         d["downbeats"]))  # fmt: skip
    log(f"seams: measuring {len(jobs)} songs")
    done = 0
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for fut in [pool.submit(_measure, j) for j in jobs]:
            try:
                fut.result()
                done += 1
            except Exception as e:
                log(f"seams: skipped one song: {e}")
            if done and done % 50 == 0:
                log(f"seams: {done}/{len(jobs)}")
    log(f"seams: {done} measured")
    return done
