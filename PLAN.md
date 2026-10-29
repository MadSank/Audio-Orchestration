# Audio-Orchestration v6 — Upgrade Plan

> **Status: revised after the A0 audit (2026-10-30) of the local project at `C:\saics`.**
> Audit narrative: `AUDIT.md`. Overnight (owner asleep) the defaults below were applied and work continued on branch **`v6`** (P0 + P1 setup + report-only triage); see `AUDIT.md` for status.
> The local repo is GitHub `main` plus one unpushed commit (`987ae60`, which removes committed `.pyc` files). Its code is otherwise identical to GitHub, so the draft's defect list mostly holds. The audit confirmed D1–D13, found that D8 is worse than described, and added D14–D21. It also found facts about the real music folder that change P1. **Open questions for the owner are in §A0.3, with the default applied for each.**

**Goal:** turn SAICS into an Android music app for **riding a motorbike**. The phone sits in a bag with the screen off, and audio plays through a **Cardo helmet intercom** over Bluetooth. The ride experience is controlled entirely by the Cardo's physical buttons (play/pause, next, previous) and voice. A rich hands-on mode is used when stopped. Infinite single-song playback and DJ-style transitions must sound seamless, and the vinyl, slowed and other versions stay.

**Priorities:**
1. **Helmet-button control works reliably.** If the Cardo buttons don't drive the app, nothing else matters.
2. The analysis and transition algorithm.
3. The hands-on app UI.
4. The website (later, secondary).

**Platform decisions (fixed; the audit found no reason to change any):**
- **Phone:** Android only. No iOS or CarPlay work.
- **Music source:** a local folder of audio files on the phone. The real folder is `C:\Users\ASUS\Music\songs`, with **370 files** (see §A0.2). No streaming services.
- **Where analysis runs:** heavy analysis runs on the PC as a one-time batch per song. The phone receives a small analysis bundle and does all playback, mixing and effects on-device, fully offline.
- **Primary interface:** Bluetooth media buttons via the Cardo (AVRCP), routed to the app's Media3 `MediaSession`. Android Auto is optional.

---

## A0. Audit results ✅

### A0.1 What exists locally

| Path | What it is |
|------|------------|
| `backend/audio_processor.py` (657 lines) | `AudioContinuityProcessor` (beats → similarity graph → jump schedule → offline render) and `TrackTransitionProcessor` (A→B cue search + `smooth`/`cut`/`edm` mix render) |
| `backend/library_analyzer.py` | Pairwise track scoring (BPM incl. half/double, circle-of-fifths key, mean-MFCC cosine, energy correlation) |
| `backend/version_renderer.py` | Offline version chains: normal, sped_up, 8d_audio, lofi_vhs, slowed_reverb, nightcore, bass_boost, vinyl_crackle, underwater → 320 kbps MP3 |
| `backend/models.py` | Dataclasses (`Beat`, `TransitionEdge`, `TrackFingerprint` …) |
| `backend/main.py` | FastAPI: `/upload`, `/analyze`, `/analyze-full`, `/analyze-meta`, `/transition`, `/library-scores`, `/render-version`, `/preview/{f}`, `/health` |
| `backend/venv/` | Python **3.13.14** venv (librosa 0.11, numpy 2.4.4); not tracked |
| `frontend/` | Vite 8 + React 19 + Tone.js 15 + WaveSurfer + Tailwind 4. Pages: Library (upload + live versions), Infinite Jukebox, Track Transitions |

- **Git:** `main` is 1 commit ahead of `origin/main`. `frontend/.vite/deps/` is still tracked. `frontend/dist/` exists on disk but is ignored. There are no tests, CI or `pyproject.toml`.
- **Not in the draft but present:** `/library-scores` pair ranking already handles half/double tempo. There's a live Tone.js version player on the Library page, plus `lofi_vhs` and `underwater` modes.
- **In the draft but missing:** **the `design/` export is not in the repo**, nor anywhere obvious on disk (see Q1). There's also no `CLAUDE.md` or `PLAN.md` in the repo; this file is the first.
- **Environment:**
  - ffmpeg 8.1 is on PATH; **`fpcalc` is not installed**.
  - **NVIDIA RTX 4070 Laptop GPU** is present, so CUDA PyTorch is used for Beat This! and Demucs (much faster than the CPU estimate).
  - Node is installed; Android tooling was not checked yet (P5).
- **Older copies:** several `saics*.zip` snapshots in `Downloads` (Apr 7–30) are older than this repo; nothing in them is newer.

### A0.2 What running it showed

Run on 2026-10-30 against real songs from the music folder.

- **Analysis speed (CPU, librosa):** 28–61 s per ~3-min song. This is dominated by `chroma_cqt` (computed twice) and HPSS.
- **Jump graph:**
  - *Dancin (KRONO Remix)*: 55 edges from 17 sources. There are **no sources between 26 s and 95 s**, and **29/55 edges** come from the last 25% of the song, where the gate is relaxed.
  - *Electrified*: 25 edges from 11 sources, with 17/25 in the last 25%.
  - MFCC cosine similarity has a median of 0.94–0.95 across all bar pairs, which confirms D2.
  - The "vocal saver" penalises 62–69% of all beats (D4).
- **Offline render, synthetic test:** a steady 440 Hz tone at 120 BPM with **no jumps** comes out **14.5% shorter** and has a **−30 dB dip on every beat** (D8).
- **Web Infinite Jukebox, driven in a browser:** Electrified was analysed and played past jump sources at 49, 55 and 63 s with **0 jumps**, and "Cooldown" shows `--`. The page calls `/analyze`, which returns no `jump_schedule`/`min_beats_between_jumps` (D14). **The live jukebox never jumps**; it only restarts at the end with the dip-and-sweep.
- **Transition, Electrified (44.1 kHz) → On & On (48 kHz), `smooth`:** the preview lasted **320.7 s** instead of ~308 s. Track B is written at A's sample rate, so it plays **8.8% slow and ~1.5 semitones flat** (D15). The mix-in landed **62 s into track B** (D19).
- **Version renderer:** speed is fine (Schroeder reverb ≈ 0.6 s per 10 s of mono). Vinyl is deterministic under `np.random.seed`, so golden tests are feasible.
- **Music folder (370 files):**
  - **Formats:** 363 `.mp3`, 5 `.ogg`, 2 `.mpeg`. **50 of the ".mp3" files are actually AAC**, 221 are MP3 at 44.1 kHz, **91 are MP3 at 48 kHz**, and 5 are Vorbis.
  - **Broken files:** 3 are 2-byte broken downloads (`{}`), e.g. `Y2meta.app - NIGHT DANCER - imase [ speed up ]`.
  - **Durations:** 10 files are under 45 s (ringtones, BGM clips, a 0.16 s file), and 23 are 45–120 s.
  - **Variants:** there are many version variants of the same song, e.g. four *Dancin* files (original, 8D, Bass Boosted, Lyrics) plus "sped up" copies.

### A0.3 Open questions for the owner (defaults applied overnight, marked ⇒)

- **Q1 — Design export.** `design/` is not in `C:\saics`. Where is it? *Blocks P5 screens; tokens in CLAUDE.md are enough to start P5's native work.* ⇒ unresolved.
- **Q2 — Which "vinyl" is the reference?** The live Library page (Tone.js) and the downloadable render (`version_renderer.py`) are *different chains* (D17). CLAUDE.md freezes `versions.py`, i.e. the renderer. Is that the vinyl you love, or the one you hear when clicking Vinyl in the Library page? *Blocks the P0 golden tests' scope and the P6 port.* ⇒ `versions.py` (the renderer) frozen; revisit if the live one is preferred.
- **Q3 — Version variants in the library.** Should 8D, bass-boosted, sped-up and lyric-video copies of songs you already have be **flagged for review** (proposed) or **set aside automatically**? The app makes those versions itself. ⇒ flag for review only.
- **Q4 — Python version.** CLAUDE.md says 3.12; the existing venv is 3.13. Proposal: create `engine/.venv` on **3.12** for Beat This!/Demucs/CUDA wheel compatibility and drop `backend/venv` after P0. ⇒ 3.12 via `uv`, **CPU PyTorch** (owner's instruction; CUDA later is optional).

---

## 0. Known defects (verified against local code)

References are to local `backend/` and `frontend/` at `987ae60`.

| # | Status | Where | Problem | Fix (phase) |
|---|--------|-------|---------|-------------|
| D1 | **confirmed** | `audio_processor.py:62-68`, `:109-121` | `librosa.beat.beat_track` beats; downbeat = loudest of 4 offsets, 4/4 assumed. Electrified got phase offset 1. All edges require downbeat + phrase start, so a wrong guess shifts the whole graph. | Beat This! beats and downbeats; meter from the downbeats (P1) |
| D2 | **confirmed, measured** | `:74-82`, `:166-169`; also `extract_fingerprint` `:318-321` → `library_analyzer.py:53` | MFCC includes MFCC0 and is L2-normalised per beat. Cosine similarity has a median of 0.94–0.95 over all pairs, so the MFCC half of the score is ~constant. The library's "spectral similarity" uses the same vectors and is ~1 for every pair. | Drop MFCC0, standardise per track, multi-bar windows; new timbre descriptor for pair scoring (P3, P4) |
| D3 | **confirmed** | `:228-239`, `:188-189` | Context = mean of the SSM diagonal over ±3 beats (symmetric, beat-level, edge-padded). | Bar-aligned windows: the bars leading into source vs. target, and the continuation after (P3) |
| D4 | **confirmed, measured** | `:85-92`, `:191-195` | HPSS harmonic RMS used as "vocal" proxy; it penalises 62–69% of beats in the test songs. | Vocal activity from a separated vocal stem (P1, P3) |
| D5 | **confirmed, measured** | `:197-206` (`JUMP_SCORE_GATE` at `:35` is unused) | Fixed 0.92 gate with a quadratic "desperation" ramp in the last 25%. Measured: 53–68% of edges sit in the last 25%; Dancin has no sources in 26–95 s. | Per-track adaptive selection by percentile and rank, plus a coverage constraint (P3) |
| D6 | **confirmed** | `:260` | `max_r` is recomputed from the partially filled `reach` dict, so the normalisation depends on edge order. | Compute reachability for all targets first, then normalise once (P3) |
| D7 | **confirmed** | `:273` | `0.6*score + 0.2*reach + 0.2*score` counts the score twice. | Explicit, documented weights (P3) |
| D8 | **confirmed, worse than drafted** | `synthesise` `:402-459` | Every beat boundary gets a "crossfade" even without a jump, but the tail (`:446-451`) is written `xp` samples early with `=` and never overlaps the next fade-in. Result: fade-out then fade-in (−30 dB dip every beat), and each beat loses `xp` samples, so **renders run 14.5% short and the groove is broken**. `/upload` output and transition previews are unusable as a baseline. | Copy contiguous runs; crossfade only at real jumps (P3) |
| D9 | **confirmed** | `frontend/src/hooks/useJukeboxEngine.js:69-109`, `:111-171` | A jump ramps the gain to 0 over 25 ms, starts a new player and sweeps a low-pass from 800 Hz to 20 kHz (whoosh-dip). Triggers come from rAF polling within a 50 ms window, plus 25 ms of scheduling, so the target lands 25–75 ms off the beat grid. | Native engine with sample-accurate scheduled equal-power crossfades (P6) |
| D10 | **confirmed, wider** | `:522-525`, `:322`; `models.py:89-96` | Key = argmax of mean chroma (root only). `camelot_key` **always returns a "B" (major) code**. | Real key detection with major/minor and Camelot (P1) |
| D11 | **confirmed** | `synthesise_full_mix` `:569-600` | 16 beats of A's end fade against B's start at different tempos, with no time-stretch and no bass management. Unused `src_start`/`tgt_end`. | Beatmatch with time-stretch, phrase-aligned cue points, EQ bass swap (P4) |
| D12 | **confirmed** | `process` `:643` | `auto` picks `smooth` vs `cut` 80/20 at random. | Choose the style from the pair's tempo, key, energy and vocals (P4) |
| D13 | **partly fixed** | repo | `__pycache__` removed locally (`987ae60`, not pushed). **`frontend/.vite/deps/` is still tracked.** `.gitignore` lacks `venv/`, `.vite/` and audio patterns. No tests, no eval. | P0, P2 |
| D14 | **new, verified live** | `frontend/src/pages/InfiniteJukebox.jsx:174` → `useJukeboxEngine.js:138` | The page calls `/analyze` (no `jump_schedule`, no `min_beats_between_jumps`) instead of `/analyze-full`. `x >= undefined` is false, so **the web jukebox never jumps**. | Superseded by the app (P5/P6); web fix in P8 (one-line fix possible earlier on request) |
| D15 | **new, verified** | `:58` (`sr=None`), `synthesise_full_mix` `:565` | Tracks load at their native rate, but the mix is written at A's rate, so a 48 kHz B under a 44.1 kHz A plays 8.8% slow and ~1.5 semitones low. This affects 91+ files in the folder. | Decode everything to one engine rate (44.1 kHz) with stored native rate (P1); the phone resamples on decode (P6) |
| D16 | **new** | `_detect_phrase_boundaries` `:123-157` | Phrase starts are the union of "every 4th guessed downbeat" and agglomerative boundaries (`k = n/16`) snapped within ±3 beats. Result: "phrase" sources 1–2 bars apart (Dancin: 5, 9, 10, 13 s), so phrase gating means little. | Sections and repeat groups from the bar-level SSM on true downbeats (P1) |
| D17 | **new, needs owner (Q2)** | `frontend/src/hooks/useLibraryPlayer.js:78-158` vs `version_renderer.py` | The live web versions are different chains from the renderer. E.g. vinyl live = 3 kHz band-pass + Freeverb + brown noise; rendered = 200 Hz–8 kHz band-pass 70/30 + pops/hiss + wow + 12 kHz LP. Lo-fi live adds a 4-bit crusher; the renderer doesn't. | Pick one reference (Q2); freeze it with golden tests (P0); port that one (P6) |
| D18 | **new** | `:455-457`, `:625-627`, `version_renderer.py:463-469` | Peak normalisation to −1 dBFS everywhere, with no loudness normalisation. Versions and tracks differ by several LU (violates hard rule 10). | Per-track LUFS gain in the bundle (P1); per-version loudness compensation measured offline and applied on-device (P6) |
| D19 | **new** | `find_best_crossfade_point` `:495-521` | Cue search is "most similar beat pair" within A's last 40% × B's first 40%, so B can enter 60+ s in (skipping intro and verse), and A can exit mid-section. Tempo penalty `|Δbpm|/20` ignores half/double time (unlike `library_analyzer`). | Phrase/section-aware cue points (P4) |
| D20 | **new, minor** | `find_playback_path` `:369`; `useJukeboxEngine.js:124-127` | Reaching the last beat wraps hard to beat 0 (offline), or restarts at 0 with the dip-and-sweep (web). | Graph must guarantee a good exit before the end (P3) |
| D22 | **new, minor** | `legacy/audio_processor.py:91` | `load_and_extract` crashes (`np.max` of empty array) when librosa finds 0 beats (sparse clicks, sound effects). Left as-is in `legacy/`. | Moot after P1 (Beat This! + triage) |
| D21 | **new, minor** | `TrackTransitionProcessor.find_best_crossfade_point` `:488-491`; `load_and_extract` `:72`, `:132` | A transition analyses both tracks fully, including unused jump graphs; `chroma_cqt` is computed twice per track. | Moot after P1 (bundles are cached per `track_id`) |

**Keep as-is: the version renderer** (`backend/version_renderer.py` → `engine/saics/versions.py`). Freeze its output with golden tests (seeded via `np.random.seed`) before any refactor, then port it to real-time native DSP (P6).

Corrections to the draft's description of the chains:
- `_apply_speed_change` (`:108-110`) is varispeed (resample), not a time-stretch. Fix the docstring only.
- **Nightcore** is pure 1.3× varispeed plus a +15% high-passed (6 kHz) blend; there is no separate pitch shift.
- **Vinyl's** "pink noise" is actually band-passed (800 Hz–5 kHz) white hiss plus pops, generated independently per channel.
- **8D** folds to mono before panning.

---

## Target repository layout (revised to the local code)

```
saics/                          (repo: MadSank/Audio-Orchestration)
├── CLAUDE.md                   ← copy in from Downloads at P0
├── PLAN.md
├── engine/                     ← Python package "saics"; venv at engine/.venv (3.12, see Q4)
│   ├── pyproject.toml
│   ├── saics/
│   │   ├── io.py               ← ffmpeg decode → float32 @ 44.1 kHz, codec sniffing, track_id, loudness
│   │   ├── triage.py           ← music / sfx / short / unreadable / duplicate / variant
│   │   ├── analysis.py         ← beats/downbeats, key, sections, vocals, energy
│   │   ├── jumps.py            ← single-track jump graph (v6)
│   │   ├── transitions.py      ← cue points + pair scoring (absorbs library_analyzer.py)
│   │   ├── sequencer.py        ← station walks
│   │   ├── render.py           ← offline renderer (eval clips, exports)
│   │   ├── versions.py         ← = backend/version_renderer.py, behaviour frozen
│   │   ├── schema.py           ← pydantic bundle models
│   │   ├── cli.py              ← saics triage | analyze | render | eval
│   │   └── legacy/             ← backend/audio_processor.py + models.py, verbatim (P2 baseline)
│   └── tests/
├── server/main.py              ← = backend/main.py, imports from engine; same endpoints
├── eval/                       ← listening-test page + results (results/ git-ignored)
├── app/                        ← Expo / React Native Android app
│   ├── src/theme/tokens.ts
│   └── modules/saics-player/   ← Kotlin: Media3 service + audio engine
└── web/                        ← = frontend/, untouched until P8
```

---

## Analysis bundle contract (schema `saics.analysis/6`)

This is the single contract between the PC analyser and the phone. Version it, validate it with pydantic on write and with a TS/Kotlin type on read. The analyser writes it into a hidden folder beside the songs:

```
<MusicFolder>/
├── song1.mp3
├── ...
├── _set_aside/                ← triage moves flagged files here (reversible)
└── .saics/
    ├── library.json           ← index: tracks, neighbours, triage results, schema version
    └── tracks/<track_id>.json ← one per track
```

`track_id` = SHA-1 of the decoded audio's first 30 s (at the 44.1 kHz engine rate) plus the duration. It is stable across renames and re-tags.

Per-track JSON (fields are required unless marked optional):

```jsonc
{
  "schema": "saics.analysis/6",
  "track": { "id": "…", "file": "relative/path.mp3", "title": "…", "artist": "…",
             "duration_s": 213.4,
             "codec": "mp3",                       // actual codec, not extension (50 ".mp3" files are AAC)
             "native_sample_rate": 48000,          // all times below are in seconds, rate-independent
             "decoder_offset_ms": 0.0 },           // see R1
  "triage": { "class": "music", "reasons": [], "variant_of": null },
                                                  // music | sfx | speech | short | unreadable | duplicate | variant
  "loudness": { "integrated_lufs": -9.2, "gain_db": -4.8 },   // gain to reach -14 LUFS
  "tempo": { "bpm": 96.0, "stable": true, "confidence": 0.93 },
  "meter": { "beats_per_bar": 4, "confidence": 0.9 },
  "key": { "tonic": "A", "mode": "minor", "camelot": "8A", "confidence": 0.71 },
  "beats": [0.512, 1.137, …],                     // seconds
  "downbeats": [0, 4, 8, …],                      // indices into beats
  "sections": [ { "start_bar": 0, "end_bar": 8, "label": "intro", "group": 0 }, … ],
  "bar_energy": [0.41, 0.44, …],                  // per bar, 0..1
  "vocal_activity": [0.0, 0.8, …],                // per beat, 0..1
  "jumps": [ { "from_beat": 132, "to_beat": 36, "score": 0.91,
               "kind": "repeat", "xfade_ms": 30 }, … ],
  "cues": {
    "out": [ { "beat": 520, "score": 0.88, "reason": "outro phrase, no vocals" } ],
    "in":  [ { "beat": 16,  "score": 0.92, "reason": "intro ends, drums enter" } ]
  }
}
```

`library.json` holds the track list, triage results (including `variant_of` groups), and each track's top-K compatible neighbours with a score breakdown (tempo, key, energy, timbre). The phone never computes pairwise analysis itself.

---

## Helmet / Bluetooth control spec (primary interface)

*Unchanged from the draft; nothing in the local code touches this yet.*

**How it works:**
- The Cardo's buttons send AVRCP commands, which Android delivers as media key events (`KEYCODE_MEDIA_PLAY_PAUSE` / `PLAY` / `PAUSE` / `NEXT` / `PREVIOUS`, sometimes `HEADSETHOOK`) to the **active media session**.
- The app owns a Media3 `MediaSession` inside a `MediaLibraryService` that is a foreground service while playing, and overrides `MediaSession.Callback.onMediaButtonEvent`.
- Cardo voice commands arrive as the same AVRCP commands.

**Button mapping (single source of truth; timings configurable in Settings):**

| Cardo input | Action |
|-------------|--------|
| Play/Pause ×1 | Pause on the next beat (100 ms fade); resume in sync |
| Next ×1 | Mix into the next song at the next phrase (the station's transition style) |
| Next ×2 within 700 ms | Hard cut to the next song on the next downbeat |
| Previous ×1 | Restart the current song from its first downbeat (within 5 s of the start: go to the previous song) |
| Previous ×2 within 700 ms | Toggle **Forever** (loop the current song seamlessly) |
| Play/Pause ×2 within 700 ms | Toggle **Vinyl** |
| Play/Pause ×3 within 1 s | Cycle station: Infinite Ride → Vinyl Ride → Late Night → Liked |

A single press waits for the multi-press window (≤ 700 ms), which is acceptable on a bike. The windows are configurable and defaulted from the Button test.

**Audio feedback:**
- Every mode change plays an earcon, optionally followed by a short TTS line ducked over the music ("Forever on", "Vinyl off", "Late Night", optionally "Next: <title>").
- Both are toggles in Settings, and TTS can be fully off.

**Robustness:**
- Foreground service with `foregroundServiceType="mediaPlayback"`.
- Battery-optimisation exemption prompt with OEM-specific steps.
- Media3 playback resumption.
- **Audio focus:** duck for navigation prompts; pause and auto-resume for calls and intercom; pause when another media app starts.
- **Bluetooth disconnect:** pause immediately, and never fall back to the phone speaker.

**Button test screen** (Settings → Button test) shows and speaks every received key event with its interpretation and inter-press timing.

**Testability:** `adb shell input keyevent KEYCODE_MEDIA_*` and `adb shell cmd media_session dispatch next|previous|play-pause`, with controlled delays for multi-press. All mappings get instrumented tests.

---

## Phases

Each phase lists deliverables and the acceptance check that closes it. P5 does not depend on P3/P4 and can run in parallel with them.

### P0 — Repo cleanup and foundations
- [x] Copy `CLAUDE.md` into the repo root.
- [x] Fix `.gitignore`:
  - add `venv/`, `.venv/`, `.vite/`, `__pycache__/`, `node_modules/`, `dist/`;
  - add `*.wav`, `*.mp3`, `*.flac`, `*.ogg`, `*.m4a`;
  - add `.saics/`, `_set_aside/`, `eval/results/`, `triage_report.csv`.
- [x] `git rm -r --cached frontend/.vite`.
- [x] Restructure into the layout above **without behaviour changes**:
  - `frontend/` → `web/`;
  - `backend/main.py` → `server/`;
  - `version_renderer.py` → `engine/saics/versions.py`;
  - `audio_processor.py` + `models.py` → `engine/saics/legacy/` verbatim; `library_analyzer.py` → `engine/saics/legacy/` for now.
- [x] Create `engine/.venv` (Python 3.12) with CPU PyTorch (owner's choice; CUDA optional later).
- [x] Add `pyproject.toml` with pinned dependencies, pytest + ruff, and the `saics` CLI skeleton.
- [x] Golden tests for `versions.py` (scope per Q2):
  - render 10 s of a fixed test signal (sine sweep + click track + noise burst, stereo, 44.1 and 48 kHz) through every mode under `np.random.seed(1234)`;
  - store SHA-256 of the float output plus a coarse spectral fingerprint (1/3-octave band energies) with a tolerance.
- [x] Smoke test: the server's endpoints respond on a short synthetic file.
- [x] ~~Install `fpcalc`~~ not needed: ffmpeg 8.1 has `--enable-chromaprint`; triage uses `ffmpeg -f chromaprint`.

**Done when:**
- pytest and ruff pass;
- `uvicorn server.main:app` serves the old endpoints and `web/` still works against it;
- no caches or venvs are tracked.

### P1 — Library triage and analysis v6
- [x] `engine/.venv` set up: Python 3.12, torch CPU, beat-this, demucs, librosa, pyloudnorm (smoke-tested).
- [x] `saics triage` **report-only**: real-codec probing, fixed-rate decode, Chromaprint duplicates with keep recommendation, unreadable/short/sfx/speech/variant, review notes. Run on the real folder → `triage_report.csv` (see `AUDIT.md`).
- [ ] Owner reviews the CSV; then `--apply`/`--undo` with manifest.
- [ ] `saics analyze` and the bundle schema.

**Triage (`saics triage <folder>`).** It classifies every file. Classes and rules:
- **`unreadable`:** ffprobe/ffmpeg fails, or the decoded length is under 1 s (catches the three 2-byte `Y2meta.app …` files and the 0.16 s `au_uu_…` file).
- **`short`:** under 45 s (10 files today: ringtones, BGM clips, meme snippets).
- **`sfx`:** no confident beat grid, or mostly non-tonal/noise-like content (high spectral flatness, low chroma clarity).
- **`speech`:** mostly speech (optional).
- **`duplicate`:** a Chromaprint (`fpcalc`) match of the same recording; keep the higher-bitrate copy.
- **`variant`:** the same song in a derived version, found by filename tokens ("8D", "bass boosted", "sped up", "slowed", "nightcore", "lyrics") plus a fuzzy fingerprint/chroma match. It records `variant_of`. **Report-only by default (Q3).**

Also:
- It records the actual codec and sample rate per file (50 ".mp3" files are AAC; R1).
- It writes `triage_report.csv` (file, class, reasons, keep recommendation, variant_of, codec, container, sr, duration, bpm) **outside the music folder** by default (`--out`). Report-only runs never write inside the music folder.
- Only with `--apply` does it **move** flagged files into `_set_aside/<class>/`, with a manifest so `--undo` restores everything. **It never deletes.** The owner reviews the CSV first.

**Analysis (`saics analyze <folder>`):**
- **Decoding:** ffmpeg to float32 **at 44.1 kHz for every file** (fixes the D15 class of bug), recording the native rate, codec and encoder delay/priming (MP3 LAME/Xing header, AAC 2112-sample priming) as `decoder_offset_ms` (R1).
- **Beats and downbeats:** Beat This! (`dbn=False`; CPU torch for now). Meter comes from the downbeat spacing; never assume 4/4.
- **Tempo:** median inter-beat interval plus a stability measure.
- **Key:** chroma with Krumhansl/EDMA major+minor profiles, mapped to Camelot, with a confidence (fixes D10).
- **Vocal activity:** Demucs `htdemucs` on GPU (fallback `audio-separator`), per-beat RMS of the vocal stem with hysteresis. Stems are not kept.
- **Sections and repeat groups:** bar-level SSM (standardised chroma + MFCC1–13 + onset), novelty boundaries snapped to downbeats, and clustering into repeat groups. This replaces D16's phrase heuristic.
- **Loudness:** BS.1770 integrated loudness (`pyloudnorm`) → `gain_db` to −14 LUFS (D18).
- **Performance:**
  - idempotent and cached by `track_id`, parallel across files, with a progress bar;
  - CPU torch for now (owner's choice): a full 370-file first run with Demucs may take hours; measure and record it here. CUDA on the RTX 4070 is the fallback if it's too slow.

**Done when:**
- On 10 hand-labelled songs (mix of 44.1 kHz/48 kHz, MP3/AAC, at least one non-4/4 or swung track), beat and downbeat F-measure ≥ 0.9.
- The triage CSV on the real folder flags all `unreadable`/`short`/`sfx` files with **no false positives on real songs**, confirmed by the owner's review.
- Every remaining song has a valid bundle.

### P2 — Evaluation harness (before touching jump logic)
- [ ] `saics eval build <folder> --set eval/set.txt`: for 15–20 songs, render ~10 jump clips per song (5 s each side of the seam) and 5 transition clips per pair, for these variants:
  - **legacy-as-is:** `legacy/` graph + legacy renderer; documents D8, expected to rate badly;
  - **baseline:** the legacy jump graph and legacy transition cue points, rendered by the **new clean renderer** (contiguous runs, equal-power crossfade at seams only, common sample rate). This is the bar that P3/P4 must beat, because it isolates *selection* quality from D8/D15 rendering bugs;
  - **current:** the new algorithm.
- [ ] `eval/` static page served by `server/`: blind, randomised, 1–5 ratings → `eval/results/*.json`.
- [ ] Automatic seam metrics per clip: spectral-flux spike, chroma discontinuity, loudness step (LU), and beat-phase error (ms, against Beat This! on the rendered clip).
- [ ] `saics eval report`: mean rating and metric deltas per variant.

**Done when:** legacy-as-is and baseline are rated and the report renders. Every later algorithm change must beat **baseline** here.

### P3 — Single-track infinite loop (jumps v6)
- **Candidate pool:** downbeat-to-downbeat pairs only, |from − to| ≥ 8 bars.
- **Score:**
  - similarity of the 2 bars leading into the source vs. into the target, and of the 2 bars after the target vs. after the source (standardised features, no MFCC0; fixes D2, D3);
  - a bonus for the same bar offset inside two segments of the same repeat group;
  - a penalty for vocal activity in the beat before and after the seam on either side, with no jump while a vocal phrase spans the seam (D4);
  - a penalty for a large loudness or energy step.
- **Selection:**
  - per track, top-N by score (N ≈ 1 per 20 s), with a floor taken from that track's score distribution (D5);
  - **coverage constraint:** no stretch longer than ~25% of the song without a source, and at least one cycle covering most of the song with no dead end before the final bars (D20).
- **Reachability and probabilities:** compute reachability for all targets, then normalise once, with explicit weights (D6, D7). The walk avoids recently played regions and keeps ≥ 8 bars between jumps.
- **Seam:** the cut lands on the downbeat transient, with an equal-power crossfade of 15–60 ms chosen per jump to minimise the seam metrics.
- **Renderer:** `render.py` copies contiguous runs and crossfades only at jumps (D8), at the 44.1 kHz engine rate.

**Done when:**
- the mean blind jump rating is ≥ 1.0 above **baseline**;
- ≥ 80% of clips are rated ≥ 4;
- no clip has a beat-phase error above 10 ms;
- the coverage constraint holds on every bundled song.

### P4 — Cross-track transitions and stations (transitions v6)
- **Pair scoring:** tempo compatibility with half/double time (reuse `library_analyzer.bpm_compatibility`, which is sound), Camelot distance with major/minor, energy continuity, a timbre descriptor without MFCC0 (D2), and a no-recent-artist rule. Store the top-K neighbours in `library.json`. Variants of the same song are never neighbours.
- **Cue points (D19):**
  - **Mix-out:** a section boundary in A's last third, preferring outro or low-vocal sections.
  - **Mix-in:** B's first section boundary after the intro, or its first strong downbeat. Never deeper than the end of B's first chorus.
  - Both are downbeats and align phrase-to-phrase.
- **Beatmatch:** Signalsmith Stretch (MIT; `python-stretch` on the PC, NDK on Android). B is stretched to A's tempo through the overlap, then ramped back over 8–16 bars (D11).
- **Styles, chosen from the pair's features rather than at random (D12):**
  - **Blend:** 8–32 bars with an EQ bass swap. Used when tempo is within 6% and keys are compatible.
  - **Cut on the one:** a downbeat cut with a 5–10 ms crossfade. Used for big tempo or key gaps.
  - **Build:** a filter or echo-out of A on a phrase end, then B lands on a downbeat. Used for energy jumps.
- **Loudness:** both tracks play at their bundle `gain_db` through the overlap (D18).
- **Sequencer (stations):** a weighted walk over the neighbour graph with a target energy curve, a no-repeat window, and likes/skips as weights.
  - **Infinite Ride:** the whole library as a continuous set.
  - **This Song Forever:** the single-track infinite loop.
  - **Vinyl Ride:** Infinite Ride with the vinyl chain on.
  - **Late Night:** lower energy, slowed+reverb.
  - **Liked:** liked songs only.

**Done when:**
- the mean transition rating is ≥ 4.0;
- no train-wrecks (beat-phase error under 10 ms through the whole overlap);
- 44.1 kHz↔48 kHz and MP3↔AAC pairs are in the eval set and pass;
- a 60-minute Infinite Ride render has no short-term loudness jump above 2 LU.

### P5 — Android app, milestone A: shell, library, helmet controls (parallel with P3/P4)
**Stack:** Expo (latest SDK) **development build**, TypeScript, Expo Router, Reanimated, React Native Skia, Zustand, `expo-sqlite`.

**Native module `app/modules/saics-player` (Expo Modules API, Kotlin):**
- A Media3 `MediaLibraryService` (`foregroundServiceType="mediaPlayback"`), using ExoPlayer for plain gapless playback in this milestone, with per-track `gain_db` applied.
- The full helmet / Bluetooth spec above: mapping, multi-press, earcons + TTS, focus and ducking, disconnect pause, resumption, battery prompt, and the Button test screen.
- Voice: `onSearch`/`onGetSearchResult`. Android Auto browse tree kept, but not a gate.
- **Folder access:** SAF folder pick with a persisted permission. The app reads `.saics/`, plays tracks without a bundle (or with an older schema) as plain tracks, and skips `unreadable` files.

**Screens** follow the design canvas (Q1): Home/Stations, Library, Now Playing (record visualiser), Versions sheet, Ride mode (+ mid-transition variant), Set-aside review, Settings (+ Button test, helmet controls map). Tokens go in `app/src/theme/tokens.ts` first:
- colours: `#0A0A0C` background, `#000` in Ride mode, text `#F3EFE7`, amber `#FFB547`, cyan `#6FD3FF`;
- type: Archivo + IBM Plex Mono.

**Done when:**
- **With the real Cardo:** every row of the mapping works with the screen off in a closed bag for 30 minutes, after first confirming with the Button test.
- Navigation prompts duck and resume, and a call pauses and resumes.
- Turning the helmet off pauses; turning it on and pressing Play resumes.
- Without the helmet, all mappings pass `adb`-driven instrumented tests.
- Screens match the design export in emulator screenshots.

### P6 — Android app, milestone B: native SAICS engine
- **Player:** a custom Media3 `Player` (`SimpleBasePlayer`) drives `SaicsEngine`, so the session, buttons and focus handling from P5 stay unchanged.
- **Decoding:** `MediaExtractor` + `MediaCodec` → float PCM, **resampled to the engine rate** (D15), decoding ahead the current and next track into ring buffers. Apply `decoder_offset_ms` (per codec; R1) and `gain_db`.
- **Jump scheduler:** decide ≥ 1 bar ahead and execute sample-accurately with an equal-power crossfade. `AudioTrack` (float) on a real-time thread, with no allocations, locks, logging or JNI in the loop.
- **Transitions:** P4's Blend / Cut / Build, with Signalsmith Stretch (NDK) and a 3-band EQ.
- **Button actions are engine-aware:**
  - Next schedules a transition at the next phrase;
  - Next ×2 cuts on the next downbeat;
  - pause and resume land on beats;
  - Forever and Vinyl switch on the next bar.
- **Live versions:** a port of the reference chains chosen in Q2. If that is `versions.py`:
  - **Vinyl:** 200 Hz–8 kHz band-pass (3rd-order Butterworth) blended 70/30 with dry, pops (~8/s, 0.5–2 ms bursts) + 800 Hz–5 kHz hiss at 0.03, wow 0.5 Hz ±1.5 ms, 12 kHz 2nd-order LP.
  - **Slowed+reverb:** 0.8× varispeed, Schroeder (4 combs 29.7/37.1/41.1/43.7 ms + 2 allpasses, decay 0.7, mix 0.4), chorus 0.8 Hz / 4 ms / 0.25.
  - **Nightcore:** 1.3× varispeed + 6 kHz HP blend at 0.15.
  - **Sped-up:** 1.25× varispeed.
  - **Lo-fi VHS, bass boost, 8D, underwater:** exactly as in `versions.py`.
  - **Switching:** on the next bar, with a 200 ms dry/wet crossfade.
  - **Loudness:** each version gets an offline-measured loudness compensation so switching stays within 1–2 LU (D18).
  - A parity check renders through both the native chain and `versions.py` and compares the spectra.
- **Events to JS** (~30 Hz, only while the UI is visible): beat and bar, next jump or transition, active version.
- **Tests:**
  - Kotlin unit tests: crossfade power, sample-exact jump positions, no allocations in the render loop;
  - an instrumented click-track test on the device, including one AAC and one 48 kHz file.

**Done when:**
- A 2-hour Cardo ride has no glitches, dropouts or volume jumps, and every button works throughout.
- On-device quality matches the P3/P4 ratings.
- CPU stays under 10% with the screen off on a mid-range device.

### P7 — Hands-on mode polish
- **Record visualiser:** jump arcs; tap an arc to queue that jump, long-press for "jump now".
- **Mix queue:** shows "Mixing into <B> in 4 bars · Blend"; tap to switch the style or skip.
- **Version carousel** with a live preview.
- **Set-aside review:** reads the triage manifest and shows `variant_of` groups; listen, then restore or keep aside.
- **Ratings:** likes and skips from the helmet are logged for the sequencer, and an optional "rate this seam" prompt feeds the P2 dataset.

### P8 — Website overhaul (secondary, later)
- Rebuild `web/` on the same engine and API with a proper design pass (frontend-design plugin + Playwright screenshots).
- Fix D14 (or replace the page) and remove the Tone.js version chains in favour of the reference chains.
- Out of scope until P6 is done.

---

## Riding and safety rules
- The ride experience must be fully usable with only the three Cardo buttons and voice. Nothing important may require the screen.
- Every mode change has audio confirmation (earcon, optional TTS).
- Loudness-normalise to −14 LUFS; transitions and versions change perceived loudness by no more than 1–2 LU.
- When Bluetooth drops, pause; never route audio to the phone speaker.
- Ride mode on screen uses only giant targets: no text input, no lists.

## Risks
- **R1 — Decoder offset.** ffmpeg and MediaCodec can disagree on encoder delay or padding by tens of ms. **The library mixes MP3 (LAME delay) and AAC-in-".mp3" (2112-sample priming)**, so the offset is per codec.
  - Mitigation: record codec and delay at analysis time; run a device click-track calibration per codec.
  - If a codec can't be calibrated reliably, re-encode those files (owner approval required; files are never modified in place).
- **R2 — Vocal separation runtime.** CPU torch for now; the RTX 4070 (CUDA) is available if needed. Cached per `track_id`.
- **R3 — Cardo button behaviour varies** by model, firmware and mode. Mitigation: the Button test, all play/pause variants handled, configurable windows.
- **R4 — Background kills** on Android 14+ and OEM skins. Mitigation: correct FGS type, battery exemption, playback resumption.
- **R5 — Another app stealing the media session.** Documented: start playback from our app once per ride.
- **R6 — Licensing.** MIT/BSD/Apache/LGPL only; ask before any GPL dependency.
- **R7 — Library hygiene (new).** 370 files with variants, broken downloads and misleading extensions. Mitigation: triage is report-first, and the owner reviews before `--apply`.

## Claude Code tooling (install at the phase where it's needed)
- **P0/P1:** `fpcalc` (Chromaprint) on PATH; CPU PyTorch in `engine/.venv`.
- **P5+:** the Expo MCP server (`claude mcp add --transport http expo https://mcp.expo.dev/mcp`), `npx expo install expo-mcp --dev`, and `EXPO_UNSTABLE_MCP_SERVER=1 npx expo start`. Media-button behaviour is tested with `adb` key events.
- **P8:** the frontend-design plugin plus Playwright.
