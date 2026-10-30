# Evaluation (P2)

Blind listening tests plus automatic seam metrics. Every algorithm change to jumps or
transitions must beat the **baseline** here (CLAUDE.md hard rule 6).

## Run it

```powershell
cd C:\saics
engine\.venv\Scripts\saics.exe eval build "C:\Users\ASUS\Music\songs" --set eval\set.txt
engine\.venv\Scripts\python.exe -m uvicorn server.main:app --port 8000   # then open http://localhost:8000/eval/
engine\.venv\Scripts\saics.exe eval report                                # writes eval\report.md
```

- `clips/`: rendered clips (random ids) + `manifest.json` (variant, seam position, metrics). Git-ignored.
- `results/`: your ratings, one JSON per day. Git-ignored.
- `set.txt`: the songs to evaluate.

## Rating scale

| | Meaning |
|---|---|
| **1** | Jittery playback: stutter/flutter, regardless of the seam |
| **2** | Not jittery, but the transition is bad |
| **3** | Right idea, wrong spot: another part of the song would work |
| **4** | Almost perfect, off by a beat or two |
| **5** | Perfect |

**Jittery flag.** Tick it whenever the clip stutters or flutters anywhere, whatever the rating. A rating of 1 always counts as jittery. The report shows the jittery rate per variant: the **legacy** renderer (old per-beat crossfade, D8) vs the **clean** renderer used by **baseline** and later variants.

## Variants

| Variant | Jump choice | Renderer |
|---|---|---|
| `legacy` | old algorithm (librosa beats, v5 graph) | old renderer (crossfade on every beat, D8) |
| `baseline` | old algorithm | clean renderer (crossfade only at the jump) |
| `current` | new algorithm (P3) | clean renderer |

## Automatic metrics (per clip, at the seam)

- **flux spike**: onset strength at the seam ÷ the clip's median. Clicks and thumps show up here.
- **chroma jump**: harmonic change across the seam beyond the clip's typical change.
- **loudness step**: level change between the second before and the second after (dB).
- **beat-phase error**: how far the beats after the seam sit from the grid before it (ms), using Beat This! beats refined to onset peaks. The target is < 10 ms.
