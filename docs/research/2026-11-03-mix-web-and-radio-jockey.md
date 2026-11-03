# Research: cross-song transitions (Mix Web) and a virtual radio jockey

Owner's brief (2026-11-03):

1. **Transitions between songs.** Each song has points that resemble points in other songs. Map those points into a directed graph of jumps between songs, then wander through it seamlessly. Dead ends can loop in the song (Forever) and leave by the edge they came in on, or by something else.
2. **"Next next" phase: a virtual radio jockey (RJ).** It knows the time of day and the traffic and talks like a DJ who is looping songs by hand. Ideally it sings along to show excitement. The aim is a personal host that keeps the rider awake, especially in the morning.

This note collects what exists (papers, tools, licences, platform limits, connectors) and turns it into a plan. The plan itself lives in `PLAN.md` (P4 revised, new P9).

---

## 1. What we already have that carries over

| Built in P3/P6 | Reused for the Mix Web / RJ |
|---|---|
| Structural jump finder (`jumps.py`): 4-bar context matching on beat-synchronous chroma, vocal chroma, onsets; rated 4.79 / 4.45 by the owner | The same matcher, run **across** songs, finds "portals" (owner's "similar points") |
| Feature cache `.saics/features/<id>.npz` (beat_feats, vchroma, vonset, chroma) | Cross-song matching runs from the cache, with no re-decoding |
| Bundles: beats, downbeats, sections, breaks, vocal activity, outro bar, gain | Exit and entry candidates, the "post" (instrumental intro before the vocals) for the RJ |
| Engine `Instruction(from slot, at frame → to slot, frame, crossfade, rho)` with sample-exact execution across slots | A cross-song jump is the same instruction with a different `toSlot`. **The engine already supports it.** |
| `ForeverWalk` (one bar ahead) | Generalises to a `MixWalk` over the graph |
| Rating feedback (keep/ban), regression tests, eval page with seam clips and full renders | Same loop for portal clips and 20-minute mix renders (hard rule 6) |
| Record visualiser with jump flash | Shows portals (cyan) and song changes |

---

## 2. Cross-song transitions: prior work

| Work | What it contributes | Licence / usable? |
|---|---|---|
| **Infinite / Eternal Jukebox** (Lamere 2012; Eternal Jukebox): beat graph of similar beats *within* one song ([Music Machinery](https://musicmachinery.com/2012/11/12/the-infinite-jukebox/), [algorithm port](https://github.com/rigdern/InfiniteJukeboxAlgorithm)) | The idea we already run per song (P3). Every public version is single-song; none jumps across songs. | Ideas only |
| **AutoMashUpper** (Davies, Hamel, Yoshii, Goto, IEEE/ACM TASLP 2014; ISMIR 2013) ([paper](https://staff.aist.go.jp/m.goto/PAPER/IEEETASLP201412davies.pdf), [ISMIR 2013](https://staff.aist.go.jp/m.goto/PAPER/ISMIR2013davies.pdf)) | **"Mashability"** between phrase sections of *different* songs: harmonic similarity of beat-synchronous chroma **after key-shifting**, rhythmic similarity, spectral balance, with tempo modification. This is the closest published model of the owner's "points similar to each other across songs". | Method, implement ourselves |
| **Vande Veire & De Bie 2018**, "From raw audio to a seamless mix", EURASIP JASMP ([paper](https://asmp-eurasipjournals.springeropen.com/track/pdf/10.1186/s13636-018-0134-8)) | A complete auto-DJ: beats, downbeats, structure, cue points at phrase boundaries, three transition types. 91% of songs annotated fully correctly; 18 D&B fans rated the mixes highly. Shows that phrase-level structure is what makes a mix sound "human". | Code [dnb-autodj-3](https://github.com/lenvdv/dnb-autodj-3) is **AGPL-3.0**: ideas only, never copy (hard rule 11) |
| **Zehren, Alunno, Bientinesi**, "Automatic Detection of Cue Points for DJ Mixing" (ISMIR 2020; Computer Music Journal 2022) ([arXiv](https://arxiv.org/abs/2007.08411), [CMJ](https://direct.mit.edu/comj/article/46/3/67/117159/Automatic-Detection-of-Cue-Points-for-the)) | Rule-based cue points from DJ interviews; ~96% judged usable. The rules are phrase boundaries, energy changes, and avoiding vocals. | Method |
| **CUE-DETR**, "Cue Point Estimation using Object Detection" (2024) ([arXiv](https://arxiv.org/pdf/2407.06823)) | Learned cue points (already listed in P4 as an optional second source) | Code MIT; confirm the base model of the weights |
| **Chen et al.**, "Automatic DJ Transitions with Differentiable Audio Effects and GANs" (DJtransGAN, ICASSP 2022) ([arXiv](https://arxiv.org/pdf/2110.06525)) | Learns EQ and fader curves for two-song blends from real DJ mixes. Takeaway: human transitions are **EQ-band handovers** (bass swap), not plain crossfades. | Use as a rule (P4 already has "bass swap") |
| **Kim et al.**, "A computational analysis of real-world DJ mixes using mix-to-track subsequence alignment" (ISMIR 2020) ([paper](https://archives.ismir.net/ismir2020/paper/000352.pdf)) | Statistics from 1001Tracklists mixes: where DJs cue in and out, how long transitions last | Use as priors (blend lengths, cue positions) |
| **Nam et al.**, "Automatic DJ Mix Generation Using Highlight Detection" (ISMIR 2017 LBD) ([ResearchGate](https://www.researchgate.net/publication/322007163_Automatic_DJ_Mix_Generation_Using_Highlight_Detection)); **"Automatic playlist sequencing and transitions"** (ISMIR 2017) ([paper](https://archives.ismir.net/ismir2017/paper/000086.pdf)) | Highlight-centred mixes; sequencing songs by compatibility | Ideas |
| **All-In-One structure analyzer** (Kim & Nam, WASPAA 2023) ([repo](https://github.com/mir-aidj/all-in-one)) | Beats, downbeats **and functional labels** (intro/verse/chorus/bridge/outro). Would let entries target real choruses and let the RJ say "here comes the chorus". | Code **MIT**; weights' licence not stated. PC-side only, and check before use |
| Music embeddings (**MERT**) | Could help similarity | **CC-BY-NC**: not for a shipped product. Avoid; our own features already work. |

**Gap in the literature:** nobody publishes a **library-wide graph of seamless mid-song portals** (Infinite-Jukebox-style jumps *between* songs), walked live with loops in dead ends. Mashup systems layer songs; auto-DJs hand over at song ends. The owner's idea is novel. It is also a natural extension of our tested within-song jump finder.

---

## 3. Design: the Mix Web as the owner described it

**Nodes** are songs (each version is its own node; versions are already linked by song groups).

**Edges** are directed `(song A, bar a) → (song B, bar b)`, in four kinds, best first:

1. **Portal (seamless):** the 4 bars before `a` in A sound like the 4 bars before `b` in B, *after* allowed transforms (tempo within ±2% in phase 1, up to ±6% with stretching in phase 2; key equal or ±1 semitone, Camelot-compatible). Scored like our jump finder plus AutoMashUpper's mashability terms: key-shifted beat-chroma, onset/rhythm pattern, spectral balance, vocal state (never cut mid-line; the lyric-continuity term from P3), energy continuity. Executed exactly like a Forever jump (15–60 ms correlation-aware crossfade) or as a 1–2-bar EQ-band handover.
2. **Blend:** a DJ-style 8–32-bar overlap with a bass swap at phrase boundaries (P4 as written).
3. **Cut into a break:** the silence carries the change, so tempo and key matter little.
4. **Version switch:** already shipped in P6.

**Finding portals cheaply:** 376 songs × ~80 bars ≈ 30k bars. Instead of comparing every pair (≈ 450M), bucket bars by tempo (±2%) and key class (12 rotations), then rank candidates on a compact 4-bar fingerprint from the feature cache. Only the top-K go through the full jump scorer. This is an offline GPU job of minutes, like `saics jumps`.

**Graph rules (owner's dead ends):**
- Compute strongly connected components. A song with no outgoing portal **loops with Forever** until a fallback exit is due:
  - (a) the **reverse of the edge it came in on**. Portal matches are checked in both directions, so a two-way portal is common;
  - (b) a blend or a cut into a break;
  - (c) a version switch.
- Every song gets at least one fallback exit, so the walk can never get stuck. A song with no possible exit at all is reported, like "no loop found" in P3.
- Store the top-K out-edges per song in `library.json` (schema bump `saics.library/8` and the app type, hard rule 8). The phone never computes pairwise analysis.

**Walking (`MixWalk`, a generalisation of `ForeverWalk`):**
- Dwell 60–120 s or one chorus per song. Inside a song, Forever jumps continue as now.
- Decide the next song **≥ 30 s ahead**, so its PCM is decoded (≈ 25× real time) before the portal bar. Prefer portal > blend > break > version.
- Use a song-group no-repeat window and the station's energy target. Likes and skips from the helmet weight edges.
- Next ×1 means "take the best exit at the next phrase"; Next ×2 means "cut now". This matches the existing spec.

**Engine work:**
- Phase 1 (portals within ±2% tempo, no stretch): **no engine change**. A cross-slot `Instruction` already exists and is tested.
- Phase 2 (blends, ±6% portals): a real-time **Signalsmith Stretch** stage per slot (MIT, NDK), a 3-band EQ per slot for the bass swap, and tempo ramps. This is the biggest engineering item. It must stay allocation-free (hard rule 9).

**Evaluation (hard rule 6):** portal seam clips (15 s context, reveal after rating), blend clips, and **20-minute Infinite Ride renders** with "felt wrong" marks. Pass: mean ≥ 4.0 and 0% jittery, as in P3/P4.

---

## 4. The virtual radio jockey: prior work and platform facts

**Spotify DJ** (2023–): music picks plus spoken commentary. The voice is synthetic, built by Spotify's acquired Sonantic team from a real host (Xavier "X" Jernigan); the commentary is reported to be generated with OpenAI ([Spotify newsroom](https://newsroom.spotify.com/2023-02-22/spotify-debuts-a-new-ai-dj-right-in-your-pocket/), [Engadget](https://www.engadget.com/spotifys-new-ai-dj-will-talk-you-through-its-recommendations-140052560.html)). It proves the format works. What it doesn't do: time-of-day or traffic awareness, and talking *inside* a seamless, looping mix.

**Radio craft to copy: "hitting the post".** A DJ talks over a song's instrumental intro and stops exactly when the vocals start ([background](https://en.wikipedia.org/wiki/Voice-tracking), [Hospital Radio](https://hospitalradio.ie/?p=356)). Our bundles have per-beat **vocal activity**, so the post (the first vocal downbeat) is known to the beat. Our engine can start the voice so it ends on that downbeat, which human DJs need practice to do. The same goes for a Forever loop's instrumental bars and for breaks.

**Where the words come from (language model):**
- **On-device Gemini Nano** (ML Kit GenAI Prompt API): runs **only while the app is the top foreground app** and returns an error in the background ([ML Kit GenAI](https://developers.google.com/ml-kit/genai), [Android blog](https://developer.android.com/blog/posts/ml-kit-s-prompt-api-unlock-custom-on-device-gemini-nano-experiences)). **This rules it out** for a phone in a bag with the screen off. Device support is also limited, and the owner's vivo V2515 isn't confirmed.
- **Claude API (cloud)**, called 1–2 songs ahead over mobile data from the foreground service, with **template lines as the offline fallback**. Cost estimate: one segment is ~2k cached tokens (persona + rules) + ~0.4k fresh context + ~0.3k output.
  - **Claude Opus 5.5** (`claude-opus-5-5`, the default; $4 / $20 per M tokens, cache reads $0.20): about **$0.30 per hour** at 40 segments/hour.
  - **Claude Haiku 5.5** ($0.10 / $0.50): about **$0.01 per hour**. The model choice is the owner's call.
  - **Prompt caching** keeps the fixed persona cheap. The **Batch API** (50% off, asynchronous) suits pre-generating evergreen lines on the PC (song intros, back-announces, loop banter).

**Where the voice comes from (speech):**
- **Android `TextToSpeech`** (used already for confirmations): free, offline, adequate, not "radio" quality.
- **On-device neural TTS: sherpa-onnx** (Apache-2.0, [repo](https://github.com/k2-fsa/sherpa-onnx)) with **Kokoro-82M** (Apache-2.0 weights, [model](https://huggingface.co/hexgrad/Kokoro-82M); ~310 MB model + voices, [sherpa page](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html)) or Piper voices. Much better voices and offline.
  - **Licence catch:** these models phonemize with **espeak-ng, which is GPL-3.0** (sherpa ships `espeak-ng-data` with Kokoro and Piper; see the [piper-phonemize discussion](https://github.com/rhasspy/piper-phonemize/issues/17)). Under hard rule 11 that needs the owner's OK.
  - Permissive alternatives exist but would need retrained voices: MIT [@piper-plus/g2p](https://cdn.jsdelivr.net/npm/@piper-plus/g2p@0.4.1/README.md), BSD [OpenPhonemizer](https://github.com/NeuralVox/OpenPhonemizer) (unmaintained).
- **Cloud TTS:** the best voices, but adds cost and network dependence. Pre-rendering on the PC suits evergreen lines.
- **Mixing:** synthesise to PCM, then **mix it in the engine** with sidechain ducking (music −8 dB), sample-accurately on a downbeat. This keeps ducking smooth and lets the line hit the post. It stays real-time-safe: the PCM is ready before the render thread touches it.

**Context it talks about:**

| Signal | Source | Notes |
|---|---|---|
| Time of day, day of week | Phone clock | "Morning run", "Friday evening" |
| Weather | **Open-Meteo**: free, no key, **non-commercial use only**, CC BY 4.0 data ([terms](https://open-meteo.com/en/terms)) | Fine for a personal project |
| ETA, next turn, delay | **Google Maps navigation notification** via `NotificationListenerService` (user-granted; examples [GMapsParser](https://github.com/3v1n0/GMapsParser), [gmaps_nav_hud_frame](https://github.com/CitizenOneX/gmaps_nav_hud_frame)) | Free, works offline, no API key. Unofficial: the layout can change, and it updates roughly every minute. |
| Traffic on the route | **Google Routes API** with `TRAFFIC_AWARE` (Pro SKU; third-party sources cite ~5k free calls/month, then ~$10/1k; to verify on [Google's pricing page](https://developers.google.com/maps/billing-and-pricing/pricing)) | Needs a key, billing and a destination. Optional upgrade. |
| What is playing, what's coming, loops taken | The engine itself | "Running that chorus back", "jumping into …" |
| Likes and skips | Helmet buttons | Personalises picks and banter |

**Connectors checked** (MCP registry, 2026-11-03): weather (AccuWeather, Vaisala Xweather, Tomorrow.io), Spotify, music-chart data. No Maps or traffic connector. These connect *Claude* to data, which is useful if scripts are written by a Claude call with an MCP toolset. On the phone, calling Open-Meteo directly is simpler and cheaper. **Skills:** `claude-api` (for building the script generator). No other relevant skill or plugin.

**Singing along.** Real singing needs lyrics and melody alignment plus a singing-voice model:
- Open models exist (DiffSinger code is Apache-2.0), but **voicebanks carry mixed or restrictive licences** and per-voice terms ([DiffSinger](https://github.com/hrukalive/DiffSinger)). The DiffSinger README also forbids generating a person's voice without consent.
- Lyrics are copyrighted, and quality on arbitrary songs is unreliable.
- **Recommendation:** don't sing. Get excitement through timing instead:
  - hype ad-libs and drops ("here we go!") placed on break returns (`ramp_up`) and chorus entries;
  - shout-outs over Forever loops;
  - short hype stingers rendered once on the PC.
- Revisit singing as a research item only if the owner wants it after using the RJ.

**Safety rules for the RJ** (extends "Riding and safety rules"):
- Lines ≤ 12 s.
- Never ask a question that needs an answer.
- Never speak over a navigation prompt (check `AudioManager` active playback for `USAGE_ASSISTANCE_NAVIGATION_GUIDANCE`).
- Never speak during a call.
- A helmet toggle (RJ on/off) with audio confirmation.
- Rate-limit by default: about one segment every 3–5 songs, plus the top of the hour and ETA milestones.

---

## 5. Recommended order

1. **P4a: Portals (no stretch).** Cross-song portal finder + `MixWalk` + fallback exits; uses the existing engine. Eval: portal clips + 20-minute renders. *This is the owner's idea at its purest, and it reuses the most-tested code.*
2. **P4b: Blends + stretch.** Signalsmith Stretch NDK, 3-band EQ, bass swap, ±6% tempo. Eval: blend clips.
3. **P9a: RJ v1.**
   - Time, weather and Maps-notification ETA as context.
   - Claude-written lines with offline templates.
   - Android TTS first; neural TTS once the espeak-ng licence question is answered.
   - Hitting the post, and talking over loops and breaks.
   - A helmet toggle.
4. **P9b: RJ v2.** Routes API traffic (optional), a personal memory (likes, routes, habits), hype stingers.

Decisions needed from the owner:
- (1) espeak-ng (GPL-3.0) for on-device neural voices: yes, or stay on Android TTS / cloud TTS?
- (2) The model for RJ lines: Opus 5.5 (~$0.30/h) or Haiku 5.5 (~$0.01/h).
- (3) OK to read the Maps navigation notification (a notification-access permission)?
- (4) Skip real singing in favour of hype ad-libs?
