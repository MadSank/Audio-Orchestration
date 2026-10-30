# SAICS v6 — A0 Audit and overnight run log

## Night (2026-10-30): baseline report, P3 structural jumps, eval round 2
- **Baseline report** (`eval/baseline_report.md`), all 294 clips rated:
  - **D8 confirmed:** the old renderer was jittery on 98–100% of clips; the clean renderer on 0–3%.
  - The clean renderer with the old jump choices averaged 2.38. Short jumps (< 10 s) rated worst, at 2.20.
  - The only 5 was *Biri Biri*, bar 25 → bar 12 (−25.8 s, different section groups).
- **D23–D25 fixed**; details in PLAN P1. D23 was a chroma bin-count bug introduced by the earlier speed-up.
- **P3 implemented:**
  - structural jumps between repeat instances, with 4 bars matching on each side of the seam;
  - minimum distance of one section and 16 bars;
  - vocal-stem lyric continuity;
  - break and end → post-intro anchors;
  - the Forever walk with 60–120 s pacing.
  - Schema is now `saics.analysis/8` (richer jumps; app type + contract test). 107 tests pass.
- **Re-analysis:** the 19 eval songs are on /8. The rest of the library is still /7 (plain playback in the app) until the full re-analysis runs.
- **Eval round 2 built:** 75 seam clips with 15 s context + reveal, and a 5-song full-song Forever test (P3 acceptance) at http://localhost:8000/eval/full/.

## Evening (2026-10-30): long files set aside, full analysis done
- **Long class:** new triage class for files over 15 minutes. The owner approved the list; the 11 files were moved to `Music\songs\_set_aside\long\` (undo: `saics triage "C:\Users\ASUS\Music\songs" --undo`). Files of 8–15 minutes stay in the library.
- **Library now:** 370 music + 6 short, 290 song groups, 6 duplicates, 4 unreadable (still in place; nothing else was moved).
- **Analysis complete:** 376 bundles, schema `/7`, 0 errors. 323 cached bundles were upgraded in place with breaks, 53 songs analysed fresh, 10 stale bundles from the long files removed.
- **Spot-check:**
  - *Racing into the Night* gap found (190.7–191.3 s, silence, music returns).
  - 817 breaks in total: 192 silences and 625 breakdowns; 147 songs have none.
  - Decoder offsets: 25.1 ms (LAME MP3) on 223 tracks, 0 on AAC.
  - Three weak spots are logged as D23–D25 in PLAN P1: a minor-key bias (307 of 376 minor), low-confidence and impossible meters (97 below 0.7, 4 reporting "1 beat per bar"), and a too-strict tempo-stability flag (178 of 376 stable).
- **Housekeeping:** `song_groups_review.csv` and `groups_overrides.example.csv` (generated reports) had been committed by mistake. They're now git-ignored and untracked; the files stay on disk.

## Late afternoon (2026-10-30): rating scale, breaks, Mix Web plan, Context7
- **Vinyl blind pair:** `listen/vinyl_racing_1.wav` / `listen/vinyl_racing_2.wav`. Same 30 s (60–90 s) of *Racing into the Night*, original, through the live Library-page chain and the download renderer, loudness-matched. Which is which is recorded outside the repo until the owner picks.
- **Library finding:** the "1 HOUR LOOP" *Racing into the Night* file repeats only the first 190 s of the song; it cuts at the silent gap and never plays the final section. The full original is in the "Split Audio (Japanese vs English)" file (L = Japanese).
- **Rating page:**
  - the owner's 1–5 labels and a separate jittery flag (also in `eval/README.md`);
  - the report shows the jittery rate per variant; new ratings are tagged `scale: v2`;
  - the server was restarted twice around 15:23 to load these changes, so a rating clicked at that moment may have failed.
- **Ratings so far:** 122, all made before the labels changed. The old renderer got 60 of 61 rated 1; the clean renderer got 0 of 61 rated 1 (35 rated 2, 18 rated 3, 8 rated 4). If those ratings already followed the new scale, that confirms the D8 per-beat crossfade as the jitter.
- **Breaks:**
  - `saics analyze` detects silences and near-silent breakdowns; schema bumped to `saics.analysis/7`; app type in `app/src/types/analysis.ts`, kept in sync by a test.
  - *Racing into the Night* gap: 190.7–191.3 s, −70.8 dB, silence, music returns at −4.9 dB.
  - Cached /6 bundles are upgraded in place; this runs once the current analysis finishes.
- **PLAN:**
  - the Mix Web replaces P4 (exit/entry points, scored edges with a transition style, spacing rules, Infinite Ride, `saics mix`, rated transition clips);
  - breaks get a bonus in P3 and P4;
  - CUE-DETR licence: code MIT, weights MIT, base model unnamed; optional only.
- **Context7:** `npx ctx7 setup --claude -y` configured the MCP server in `C:\Users\ASUS\.claude.json`, plus a rule (`~\.claude\rules\context7.md`) and a skill. It authenticated via Context7's device flow and needed nothing from the owner. It's available in new sessions.

## Afternoon (2026-10-30): consolidation, analyze, P2 started
- **Downloads consolidated:** all 27 approved files moved to `Music\songs\from-downloads\`, each verified by size + SHA-256.
  - Undo: `engine\.venv\Scripts\saics.exe undo-moves "C:\Users\ASUS\Music\songs\.saics\moves_from_downloads.json"`.
  - The 14 skipped files (9 transition previews, 5 videos) are still in Downloads.
- **Re-triage** (report-only): 397 files, 380 music, 304 song groups (43 with several versions), 6 duplicates, 6 short, 4 unreadable, 1 sfx. *Racing into the Night* now has 19 versions.
- **`saics analyze`** is implemented and running on the GPU (single worker; ~2 h for 386 songs; cached afterwards).
- **P2 started:**
  - clean renderer + eval harness;
  - the 18-song set in `eval/set.txt`;
  - blind rating page at `/eval/`;
  - seam metrics and `saics eval report`.
  - Jump clips are being built (legacy + baseline variants). Transition clips come with P4's baseline.

## Morning status (2026-10-30): waiting on you for 3 things
1. **Approve the Downloads move.** See `reports/downloads_inventory.csv`: 27 to move, 14 to skip. Nothing has moved yet. `saics analyze` and P2 run on the consolidated folder, so they wait for this.
2. **Pick the vinyl by ear:** `listen/vinyl_A.wav` (live Library-page chain) vs `listen/vinyl_B.wav` (download renderer), plus `listen/vinyl_dry_reference.wav`. All are loudness-matched to −14 LUFS.
3. **Review the song groups:** `song_groups_review.csv` (largest groups first; the `check` column flags weak or chained groups). Fix anything with `<MusicFolder>/.saics/groups_overrides.csv`; the template is `groups_overrides.example.csv`.

The overnight summary below is kept for history. Its "variant" class and the CPU-vs-GPU item are superseded: versions are now groups, and CUDA torch is installed.

## Summary: done / needs me (overnight)

### Done (branch `v6`, 8 commits, not pushed; `main` untouched)
- **A0:** audit written (below) and `PLAN.md` rewritten to match the local code.
- **P0:**
  - repo cleaned (`.gitignore`, `.vite` untracked) and restructured into `engine/`, `server/`, `web/`;
  - `saics` package + CLI skeleton, pytest + ruff;
  - **golden tests freeze all 9 version chains**;
  - smoke tests for the old server endpoints;
  - **52 tests pass**, and ruff is clean.
- **P1 setup:** `engine/.venv` on Python 3.12 with **CPU** torch, beat-this, demucs, librosa and pyloudnorm, all working. ffmpeg/ffprobe are OK. `fpcalc` is missing but not needed: ffmpeg has Chromaprint built in.
- **`saics triage` (report-only):**
  - probes the real codec with ffprobe;
  - decodes every file at one fixed rate;
  - uses Chromaprint for duplicates, with a keep recommendation;
  - flags unreadable, short, sound-effect, speech and variant files;
  - refuses to write inside the music folder; `--apply`/`--undo` are refused.
- **Ran it on `C:\Users\ASUS\Music\songs`:** 370 files in ~2.5 min → **`C:\saics\triage_report.csv`** (git-ignored, outside the music folder).
  - Result: **347 music, 11 duplicate, 1 variant, 6 short, 4 unreadable, 1 sfx, 0 speech.**
  - **The music folder is verified unchanged:** all 371 entries have identical sizes and modification times before and after both runs. Nothing was moved, renamed, deleted or modified.

### Needs me
1. **Review `triage_report.csv`** before any `--apply` (which isn't built yet anyway). Sort by `class` and read the `notes` column. Specifically:
   - **Two "duplicate" pairs may be language versions** sharing an instrumental, which Chromaprint can't tell apart:
     - *YOASOBI Biri Biri English Version* ↔ *Biri Biri Official*;
     - *YOASOBI 勇者 Official* ↔ *The Brave 勇者 English Ver.*
   - **Borderline match:** *WhatsApp Audio …9.43.03 PM* ↔ *…9.43.01 PM* (BER 0.19, just under the 0.20 threshold).
   - **Check the keep choice** for *Dilbara* (keep the 309 s copy over the 246 s one?) and *Rick Astley DJ Barbecue Remix* (keep the full copy over the `mp3cut` one).
   - **24 rows have `review:` notes:**
     - 16 long files (1-hour loops, playlists, compilations such as the 40-min YOASOBI playlist and the 66-min Johan Liebert playlist). Decide whether they belong in a ride library.
     - 9 "contains/overlaps" notes for excerpts and compilations.
2. **Q2 — which vinyl is "the" vinyl?** The golden tests froze `versions.py` (the downloadable render), not the Library page's live Tone.js vinyl, which sounds different. Tell me if it's the live one.
3. **Q1 — design export:** `design/` still isn't in the repo.
4. **Q3 — variants:** 45 files carry a variant tag (8D, slowed, nightcore, sped up …). Only 1 matched its original exactly (the 8D *Dancin*); the rest are separate renders and stay `music` with the hint column filled. Should they stay in the library?
5. **CPU vs GPU:** CPU Demucs is roughly real-time, so `saics analyze` over ~350 songs ≈ **15–20 h on CPU**. Installing CUDA torch for the RTX 4070 (a ~2.5 GB download) would make it well under an hour. You asked for CPU, so I left it.
6. **Old venv:** `backend/` now holds only the old `venv/` and `__pycache__/` (untracked). It's safe to delete once you're happy with `engine/.venv`. I didn't delete it.
7. **Not verified tonight:** the old `web/` app against the moved server in a browser (you asked me to close it). The endpoints pass the smoke tests, and `web/` is unchanged except for the folder rename.

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
All work is on branch **`v6`**. Nothing was pushed, and `main` was not touched.

1. **A0** (`83264f5`): `AUDIT.md` + revised `PLAN.md`.
2. **P0 cleanup** (`dc73c8b`):
   - rewrote `.gitignore` (venvs, caches, audio, `.saics/`, `_set_aside/`, `eval/results/`, `triage_report.csv`);
   - untracked `frontend/.vite`;
   - added `CLAUDE.md`.
3. **P0 restructure** (`703c87a`):
   - `frontend/` → `web/`;
   - `backend/main.py` → `server/main.py`;
   - `version_renderer.py` → `engine/saics/versions.py`;
   - `audio_processor.py`, `models.py`, `library_analyzer.py` → `engine/saics/legacy/` (verbatim, P2 baseline).
   - Only import lines changed.
   - Two orphaned Vite `node` processes from the A0 run were locking `frontend/`; I killed them.
4. **P0 engine** (`ec89d96`):
   - `engine/pyproject.toml`, `requirements.lock`, the `saics` CLI skeleton, ruff.
   - Golden tests for all 9 version chains at 44.1 and 48 kHz (exact hash + 1/3-octave fingerprint, `np.random.seed(1234)`). A mutation check (vinyl blend 0.70 → 0.68) made them fail as intended.
   - Smoke tests for `/health`, `/analyze`, `/render-version`.
   - Docstring fix in `_apply_speed_change`; the golden tests still pass.
   - **41 tests pass**, and `ruff check` / `ruff format --check` are clean.
   - **New legacy defect D22:** `load_and_extract` crashes (`np.max` of an empty array, `legacy/audio_processor.py:91`) when librosa finds 0 beats, e.g. on sparse clicks or sound effects. It is left unfixed in `legacy/` on purpose.
5. **P1 setup:**
   - `engine/.venv`: Python **3.12.13** (via `uv`), **torch 2.15.0+cpu**, torchaudio 2.11.1+cpu, beat-this, demucs 4.1.0, librosa 0.11.0, pyloudnorm, numpy 2.3.5, scipy 1.18.1.
   - **Tools:** ffmpeg/ffprobe 8.1 OK. **`fpcalc` is not installed**, but this ffmpeg build has `--enable-chromaprint`, so triage computes real Chromaprint fingerprints via `ffmpeg -f chromaprint`. Nothing needed installing.
   - **Smoke run:** Beat This! (`final0`, CPU) found the correct 0.5 s beat period on a synthetic 120 BPM clip (≈10 s including model load). Demucs `htdemucs` separated 10 s of audio in 17.6 s including load.
   - ⇒ **CPU Demucs is roughly real-time, so a full first analysis of ~370 songs is ~15–20 h on CPU.** The RTX 4070 with CUDA torch would cut this to well under an hour. Your call (see "needs me").
   - Model weights are cached under the user profile; HF hub warns that symlinks need Developer Mode. This is harmless; it just uses more disk.

6. **Triage** (`2181ac7`, tuned in `cb79cad`): `saics.io` + `saics.triage`, 11 tests on a synthetic library (AAC-in-.mp3, 48 kHz, corrupt, short, white/brown noise, duplicates, excerpt, 8D variant, folder byte-identical afterwards).
   - **First real run** produced bad keep choices:
     - a 40-min YOASOBI playlist was chosen as the copy to keep over single songs;
     - the 8D *Dancin* was counted as a duplicate;
     - a "Lyrics" copy beat the clean name.
     - The white-noise track (brown/pink, not spectrally flat) was missed.
   - **Fixes:**
     - a duplicate now needs a ≥ 75% duration ratio; otherwise the match is a note;
     - an effect-named copy becomes `variant`;
     - the keep rule ranks bitrate, then clean name, then length;
     - a "noise bed" rule (pulse < 0.04 and chroma < 0.15; the minimum among songs was 0.079 / 0.166).
7. **Real run #2:** 145 s with 8 workers. Codecs confirmed: 221 MP3 @ 44.1 kHz, 91 MP3 @ 48 kHz, **50 AAC inside `.mp3` (MP4 container)**, 5 Vorbis, 3 unreadable 2-byte files plus a 0.16 s file. 6 short clips: the ringtone, meme snippets, `Monster 3(mp3cut.net)` and the 45.0 s `Jabardasth bgm`.

## Morning of 2026-10-30 (owner's corrections)
- **Folder scanned last night:** exactly `C:\Users\ASUS\Music\songs` (all 370 files there, no subfolders). Nothing in `C:\Users\ASUS\Downloads` was scanned.
- **Downloads inventory:** `reports/downloads_inventory.csv` lists 41 media files.
  - 27 audio files recommended to move. Most are old-app renders ("(Lofi VHS)", "(Vinyl Crackle)", "(Sped Up)") of library songs, plus ~9 songs not yet in the library: Arctic Monkeys *505*, B.o.B *Nothin' On You*, Bruno Mars *24K Magic*, Lady Gaga *Bad Romance* / *Poker Face*, *Lovedrug x Headlock*, *Écoute chérie*, the kompa x frozy slowed edit.
  - 14 to skip: 9 `transition_*.wav` mix previews made by the old app (with the D8/D15 bugs) and 5 videos (assignments, a phone clip).
  - **Waiting for the owner's approval** before anything moves into `Music\songs\from-downloads\`.
- **Vinyl A/B:** same 30 s of *Fujii Kaze – Kirari* (60–90 s), loudness-matched to −14 LUFS so the louder one doesn't win:
  - `listen/vinyl_A.wav`: the **live Library-page chain**, rendered by the web app's own Tone.js 15.1.22 offline;
  - `listen/vinyl_B.wav`: the **download renderer** (`versions.py`);
  - `listen/vinyl_dry_reference.wav`: the untouched clip.
  - Unmatched, A was 2.5 LU quieter than B.
- **CUDA:** `nvidia-smi` shows the driver supports CUDA 13.3. `engine/.venv` now has **torch 2.14.1+cu130**, verified on the RTX 4070.
- **Song groups:** `saics.groups` + triage integration, with 30 tests. Versions are no longer duplicates, and the `variant` class is gone.
  - Calibration on the real library: the *Racing into the Night* core versions (original, slowed+reverb, sped up, 0.8×, Miku, Michael Jackson AI, Mickey, covers) score 0.4–1.0 against each other, and random pairs score 0.
  - Re-arranged covers (solo guitar, a cappella, bass cover) share no audio and must be grouped by name; the review CSV flags them.

## Blocked
Nothing blocked the run. Two points to note:
- `fpcalc` isn't installed; I used ffmpeg's built-in Chromaprint muxer instead (same algorithm, raw fingerprints).
- The speech detector is a heuristic with no real speech file in the library to validate against. It flagged nothing, and on this library's features no song comes close to its thresholds.
