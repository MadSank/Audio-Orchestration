# SAICS on the PC

The phone app's player for Windows (and any desktop): an installable web app for Chrome or Edge.
It reads the same `.saics` analysis the laptop writes, from the music folder you pick, and plays it
offline. Your songs are only ever read, never changed.

## What it does

- **Forever** — loops a song by jumping between matching bars, on the downbeat (30 ms seams).
- **Stations** — Infinite Ride, Late Night and Liked walk your library through portals, with the
  phone's rules: the 29 ms early portal seam, each jump at most once a visit, Next within two bars.
- **Crate** — every song, searchable, versions grouped (the owner's `groups_overrides.csv` applies).
- **Media keys** — keyboard and headset buttons: Next x1 the next portal or song, x2 a new song now;
  Previous x1 from the top, x2 Forever on or off. Space, the arrow keys and F work in the window.

Not yet: the Vinyl version, Ride mode, analysing new songs on the PC (the laptop does that).

## Use it

Open the app's address in Chrome or Edge, click **Choose folder**, pick the music folder (the one
with the hidden `.saics` folder inside), then install it from the address bar's install button. It
then has its own window and Start-menu entry and opens offline.

## Develop

```powershell
cd desktop
npm install
npm test            # the walk rules, ported from the phone's tests
npm run dev         # http://localhost:5190
npm run build       # dist/: a static site, works from any address
```

For development without the folder picker, put `SAICS_MUSIC=C:\path\to\songs` in `desktop/.env.local`
(not committed): the dev server then serves that folder read-only and the app opens it by itself.

The walk logic in `src/core/` is a port of the phone's `ForeverWalk.kt` and `MixWalk.kt` (themselves
ports of `engine/saics/jumps.py` and `mixwalk.py`): keep all of them in step.
