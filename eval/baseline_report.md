# Baseline rating report (2026-10-30)

294 clips, all rated by the owner (122 before the scale labels existed, 172 with them). Sections below come from the /7 analysis bundles; they are automatic, not hand-labelled.

```
legacy    n=147 mean=1.01 dist 1:146 2:1 3:0 4:0 5:0
    v1: n=61 jittery=98% mean=1.02
    v2: n=86 jittery=100% mean=1.00
baseline  n=147 mean=2.38 dist 1:3 2:96 3:38 4:9 5:1
    v1: n=61 jittery=0% mean=2.56
    v2: n=86 jittery=3% mean=2.26

baseline (clean renderer) by |jump distance|:
     0-10 s n= 51 mean=2.20 >=4: 2%
    10-20 s n= 28 mean=2.36 >=4: 4%
    20-40 s n= 12 mean=2.67 >=4: 8%
    40-80 s n= 26 mean=2.54 >=4: 12%
    80-400s n= 30 mean=2.47 >=4: 13%
   median |distance| = 16.8 s; <10 s: 35%
baseline by section relation:
   same section instance              n= 58 mean=2.26
   same repeat group, other instance  n= 29 mean=2.17
   different repeat group             n= 60 mean=2.60
baseline by beat-phase error: 
   0-10 ms n=53 mean=2.40
   10-30 ms n=46 mean=2.35
   30-1000 ms n=48 mean=2.40

THE 5: clip 5b5e524afc8d (baseline) y2mate.is - YOASOBI Biri Biri Official Music Video-shZyg5VFI1Y-192k-1702529958.mp3
   from 44.5s (bar 25, section #3 group 2) -> to 18.7s (bar 12, section #1 group 0); jump -25.8s
   sections: #0:0-5g0, #1:5-17g0, #2:17-23g1, #3:23-27g2, #4:27-31g3, #5:31-45g4, #6:45-61g1, #7:61-78g3, #8:78-85g1, #9:85-89g5, #10:89-93g6, #11:93-98g7, #12:98-102g8, #13:102-117g6, #14:117-121g5```
