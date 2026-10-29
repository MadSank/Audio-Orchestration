# CLAUDE.md — Audio-Orchestration (SAICS v6)

## What this project is
SAICS (Structure-Aware Intelligent Audio Continuity System) analyses a local music library and plays it as:
- **infinite single-song loops** — seamless jumps between musically equivalent bars;
- **DJ-style continuous mixes** — beatmatched, phrase-aligned transitions between songs;
- **versions** — vinyl (the owner's favourite), slowed+reverb, nightcore, etc.

v6 turns it into an **Android app for riding a motorbike**:
- The phone is in a bag with the screen off, and audio plays through a **Cardo helmet intercom** over Bluetooth.
- The ride is controlled **only** by the Cardo's physical buttons (play/pause, next, previous, which arrive as standard Bluetooth media key events) and voice.
- A rich hands-on UI is for when the owner is stopped.
- The website is secondary and comes last.

## Start here: `PLAN.md` is a draft — audit before building
`PLAN.md` was written from the **GitHub** copy of this repo (`MadSank/Audio-Orchestration`, `main`). **The local project may differ.**

Your first task is **Phase A0** in `PLAN.md`: inventory this local project, check every defect (D1–D13) against the actual code, run the app if feasible, and rewrite `PLAN.md` to match reality. Then summarise the differences for the owner and **wait for a go-ahead** before Phase P0.

After A0, `PLAN.md` is the source of truth for phases, defects, the analysis bundle schema, the helmet control spec and acceptance criteria. Work one phase at a time and tick its checkboxes as items land.

## Architecture in one paragraph
A Python package (`engine/saics`) runs once per song on the PC. It triages sound effects out of the music folder and writes an analysis bundle (`<MusicFolder>/.saics/`) with beats, downbeats, key, sections, vocal activity, loudness, jump candidates and mix cue points. The Android app (`app/`, Expo + a Kotlin native module) reads that bundle from the same folder and does all playback, jumping, mixing and version effects **on-device and offline**. That runs inside a Media3 `MediaLibraryService` whose `MediaSession` receives the helmet's button presses. `server/` is a thin FastAPI wrapper used by the evaluation page and, later, the website.

## Repository layout
The target layout is in `PLAN.md` and gets revised during A0 to fit the local code. Until P0 restructures the repo, follow whatever layout actually exists. Don't modify the old web frontend until phase P8.

## Environment
- The owner develops on **Windows** with an **Android** phone. Give PowerShell-friendly commands, and don't assume macOS or iOS tooling.
- Python 3.12 in a venv (e.g. `engine/.venv`). PyTorch is CPU-only unless a CUDA GPU is detected; check, don't assume.
- `ffmpeg` and `fpcalc` (Chromaprint) must be on PATH for decoding and duplicate detection.
- Android Studio with an emulator and `adb`. Helmet buttons are emulated with `adb shell input keyevent KEYCODE_MEDIA_NEXT` / `KEYCODE_MEDIA_PREVIOUS` / `KEYCODE_MEDIA_PLAY_PAUSE` and `adb shell cmd media_session dispatch next|previous|play-pause`.

## Commands (once P0 has created them)
```powershell
# engine
cd engine; .\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
pytest -q
ruff check . ; ruff format --check .
saics triage "<MusicFolder>"            # report only (triage_report.csv)
saics triage "<MusicFolder>" --apply    # moves flagged files to _set_aside/ (reversible: --undo)
saics analyze "<MusicFolder>"           # writes <MusicFolder>/.saics/
saics eval build "<MusicFolder>" --set eval/set.txt ; saics eval report

# server (eval page)
uvicorn server.main:app --reload

# app
cd app
npx expo install
npx expo run:android                     # development build on device/emulator
$env:EXPO_UNSTABLE_MCP_SERVER=1; npx expo start   # enables Expo MCP local tools
cd android; .\gradlew :saics-player:testDebugUnitTest
adb shell cmd media_session dispatch next          # emulate a helmet "next" press
```

## Hard rules
1. **Helmet buttons are the primary interface.** Every ride feature must be reachable with play/pause, next and previous (single and multi-press, per the mapping in `PLAN.md`) and must give audio feedback (earcon, optional TTS). Never ship a ride feature that needs the screen. Own the mapping in `MediaSession.Callback.onMediaButtonEvent`, and handle all play/pause key variants (`PLAY_PAUSE`, `PLAY`, `PAUSE`, `HEADSETHOOK`).
2. **Never lose the buttons in the background.** Use a foreground service with `foregroundServiceType="mediaPlayback"`, playback resumption, and audio focus: duck for navigation prompts, pause/resume for calls. Pause on Bluetooth disconnect, and never fall back to the phone speaker.
3. **Never delete or modify the user's audio files.** Triage only *moves* files into `_set_aside/` and writes a manifest so `--undo` restores them. Analysis writes only inside `.saics/`. Before `--apply`, show the owner the triage report.
4. **Never commit audio, analysis bundles, eval clips or caches** (`*.mp3`, `*.wav`, `.saics/`, `_set_aside/`, `eval/results/`, `.vite/`, `__pycache__/`).
5. **The version chains' sound is frozen.** `versions.py` (the existing version renderer) must pass its golden tests unchanged. When porting a chain to Kotlin, match the Python chain's parameters exactly.
6. **No algorithm change merges without evaluation.** Changes to jump finding or transitions must come with an `saics eval report` showing they don't regress against the previous ratings and seam metrics.
7. **Never assume 4/4.** Meter comes from detected downbeats. Jumps and cuts land on downbeats only.
8. **The analysis bundle schema is a contract.** Any change bumps `schema` (`saics.analysis/6` → `/7`) and updates the pydantic model and the app-side type in the same change. The app must degrade gracefully (plain playback) when a bundle is missing or has an older schema.
9. **The audio render thread on Android is real-time.** No allocations, locks, logging or JNI calls inside the render loop; decode on separate threads into ring buffers.
10. **Loudness:** everything is normalised to -14 LUFS. Transitions and version switches must not jump perceived loudness by more than 1–2 LU, because helmet listening at speed makes jumps painful.
11. **Licences:** MIT/BSD/Apache/LGPL only. Ask before adding any GPL dependency (e.g. Rubber Band).

## Key libraries
- **Analysis:** `beat-this` (beats and downbeats, MIT), `librosa`, `numpy`, `scipy`, `pyloudnorm`, `demucs` (vocal activity only; fallback `audio-separator`), `python-stretch` (Signalsmith Stretch wrapper, MIT), `pydantic`.
- **App:** Expo (latest SDK, dev build), Expo Router, TypeScript, Reanimated, `@shopify/react-native-skia`, Zustand, `expo-sqlite`; AndroidX Media3 (`media3-session`, `media3-exoplayer`), Signalsmith Stretch via NDK, Android `TextToSpeech` for spoken confirmations.

## Design
The owner shares the app's visual design as a design canvas. Its screens are:
- Home/Stations
- Now Playing with the record visualiser
- Versions sheet
- Library
- Set-aside review
- Ride mode, plus a mid-transition variant
- the helmet controls map

The look is a black background (#0A0A0C, pure #000 in Ride mode) with warm off-white text (#F3EFE7). Amber (#FFB547) marks playback and primary actions, and cyan (#6FD3FF) marks jumps and transitions. Type is Archivo (expanded width for display) with IBM Plex Mono for data readouts.

Put the design tokens (colours, type scale, spacing, radii) in `app/src/theme/tokens.ts` before building any screen. Implement the screens faithfully, and check UI work with Expo MCP screenshots on the emulator against the design before calling a screen done.

## Working style
- Work phase by phase and keep changes scoped to the current phase.
- Write tests alongside code. For DSP, prefer synthetic signals with known answers (click tracks at a known BPM, sine sweeps, looped bars). For buttons, use `adb`-driven instrumented tests, including multi-press timing.
- When a phase finishes, summarise what changed, the eval numbers if relevant, and anything deferred, then tick the boxes in `PLAN.md`.
