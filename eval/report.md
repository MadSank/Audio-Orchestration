| variant | clips | rated | mean rating | rated ≥4 | jittery | median flux spike | median chroma jump | median loudness step (dB) | median beat-phase err (ms) | clips >10 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 147 | 147 | 2.38 | 7% | 2% | 6.71 | -0.002 | 0.90 | 15.4 | 94 |
| legacy | 147 | 147 | 1.01 | 0% | 99% | 5.75 | -0.002 | 0.86 | 30.0 | 119 |

## Round 2 (15 s context)

| variant | clips | rated | mean rating | rated ≥4 | jittery | median flux spike | median chroma jump | median loudness step (dB) | median beat-phase err (ms) | clips >10 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 18 | 18 | 2.22 | 6% | 0% | 7.00 | -0.007 | 0.82 | 10.6 | 9 |
| current | 57 | 57 | 4.79 | 95% | 0% | 5.66 | 0.014 | 0.73 | 10.7 | 31 |

## Full-song Forever test (P3 acceptance)

| song | jumps | overall | marks | marks within 5 s of a jump |
|---|---|---|---|---|
| Y2meta.app - YOASOBI - Racing Into the Night （夜に駆け | 3 | 5 | 0 | 0 |
| Maroon 5 - Memories (Lyrics) | 4 | 5 | 0 | 0 |
| Passenger - Let Her Go (Feat. Ed Sheeran - Anniver | 3 | 4 | 1 | 1 |
| Earth, Wind & Fire - September (Lyrics) | 1 | 5 | 0 | 0 |
| Lady Gaga - Bad Romance (Lyrics) | 3 | 5 | 1 | 1 |

Mean overall: **4.80** over 5 of 5 renders (target >= 4.0, none below 3).

## Round 3: portal clips (15 s each side)

| variant | clips | rated | mean rating | rated ≥4 | jittery | median flux spike | median chroma jump | median loudness step (dB) | median beat-phase err (ms) | clips >10 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 8 | 8 | 3.25 | 38% | 0% | 7.36 | 0.061 | 2.20 | 57.3 | 7 |
| current | 36 | 36 | 3.47 | 50% | 0% | 4.74 | 0.016 | 1.14 | 50.0 | 34 |

## Infinite Ride walks (P4a acceptance)

| song | jumps | overall | marks | marks within 5 s of a jump |
|---|---|---|---|---|
| walk 1 from YOASOBI - 夜に駆ける [ベース] | 14 | 4 | 4 | 4 |
| walk 2 from Aaron Smith - Dancin (Krono Remix) (Ba | 11 | 4 | 6 | 5 |

Mean overall: **4.00** over 2 of 2 renders (target >= 4.0, none below 3).

## Round 3b: seam handover styles

0 of 54 rated, 18 portals.

Measured on the plain cut, before -> after the volume and timing fixes (median): level step 1.4 -> 0.1 dB, first beats 19 -> 13 ms.

| Style | Clips rated | Mean | >=4 | Change from round 3 (same portals) | Flux spike |
|---|---|---|---|---|---|
| cut | 0 | | | | 3.90 |
| dip | 0 | | | | 3.72 |
| swap | 0 | | | | 4.47 |
