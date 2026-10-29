# SAICS v6 — A0 Audit and overnight run log

## Summary: done / needs me
_(filled in at the end of the run)_

---

## A0 audit (2026-10-30)

The local repo at `C:\saics` is GitHub `main` plus one unpushed commit (`987ae60`, which removes committed `.pyc` files). Otherwise the code is identical to GitHub, so the draft defect list largely holds. Full defect table with line references: `PLAN.md` §0.

### Headline findings
1. **The web Infinite Jukebox never jumps (D14).**
   - `InfiniteJukebox.jsx:174` calls `/analyze`, which returns no `jump_schedule` and no `min_beats_between_jumps`.
   - In `useJukeboxEngine.js:138` the cooldown test `x >= undefined` is always false, so no jump ever triggers.
   - Verified in a browser: *Electrified* played past its jump sources at 49, 55 and 63 s with **0 jumps**, and "Cooldown" showed `--`. The page only restarts the song at its end (with the dip + filter-sweep of D9).
2. **Sample-rate bug in transitions (D15).**
   - `librosa.load(sr=None)` keeps each file's native rate, but `synthesise_full_mix` writes the whole mix at track A's rate.
   - Verified: *Electrified* (44.1 kHz) → *On & On* (48 kHz) produced a **320.7 s** preview instead of ≈308 s. Track B plays **8.8% slow and ≈1.5 semitones flat**.
   - 91 MP3s in the library are 48 kHz.
3. **The offline renderer breaks every beat (D8, worse than the draft said).**
   - Test: a steady 440 Hz tone, 120 BPM, contiguous path, no jumps.
   - The output is **14.5% shorter** than the input, with a **−30 dB dip on every beat**.
   - Cause: the tail is written `xp` samples early with `=`, so it never overlaps the next fade-in.
4. **The jump graph is badly distributed (D2, D4, D5).**
   - *Dancin (KRONO Remix)*: 55 edges from 17 sources, **none between 26 s and 95 s**; 29/55 edges come from the last 25%, where the "desperation" gate relaxes.
   - *Electrified*: 17/25 edges are in the last 25%.
   - MFCC cosine similarity has a median of **0.94–0.95 over all pairs**, so it carries almost no information.
   - The HPSS "vocal saver" penalises **62–69% of beats**.
5. **The two "vinyl" sounds differ (D17).**
   - The Library page's live vinyl (Tone.js: 3 kHz band-pass + Freeverb + brown noise) is a different chain from the downloadable render in `version_renderer.py` (200 Hz–8 kHz band-pass 70/30 + pops/hiss + wow + 12 kHz LP).
6. **Loudness:** only peak normalisation (−1 dBFS) everywhere; there is no LUFS levelling (D18).
7. **Cue points:** the mix-in can land 60+ s into track B (D19). Phrase starts are often 1–2 bars apart (D16).

### Music library (`C:\Users\ASUS\Music\songs`)
- **370 files**, not "200+": 363 `.mp3`, 5 `.ogg`, 2 `.mpeg`.
- **50 of the ".mp3" files are really AAC** (mislabelled container/extension).
- Codecs: 221 MP3 @ 44.1 kHz, **91 MP3 @ 48 kHz**, 5 Vorbis @ 44.1 kHz. Sample rates are mixed.
- **3 corrupt files**: 2-byte downloads containing `{}` (all `Y2meta.app - …`).
- **10 files under 45 s**: ringtones, BGM clips, a 0.16 s `au_uu_…` file. Another 23 files are 45–120 s.
- **Many duplicates and variants** of the same song. Example: *Dancin (KRONO Remix)* as original, 8D, Bass Boosted and Lyrics video.
- See `triage_report.csv` for the per-file result of the overnight triage run.

### Environment
- ffmpeg/ffprobe 8.1 are on PATH. **`fpcalc` (Chromaprint) is not installed.**
- The old venv `backend/venv` uses Python 3.13. `uv` is available.
- An NVIDIA RTX 4070 Laptop GPU is present. The owner chose **CPU PyTorch** for tonight; CUDA can be added later.
- There is **no `design/` folder** in the repo, and none was found on disk.

### Decisions taken overnight (owner asleep, so the PLAN.md defaults were applied)
- **Q1 (design):** unresolved. It doesn't block P0/P1.
- **Q2 (reference vinyl):** golden tests freeze `version_renderer.py` (what CLAUDE.md names). The Tone.js chains are treated as non-reference. **Revisit if the live vinyl is the one you love.**
- **Q3 (variants):** triage only reports them; it is report-only tonight anyway.
- **Q4 (Python):** the new `engine/.venv` uses Python 3.12 via `uv`.

---

## Overnight run log
_(appended per step)_

## Blocked
_(none yet)_
