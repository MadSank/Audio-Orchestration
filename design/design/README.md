# Infinite Radio — app design reference

These are the source files of the design canvas the owner approved. Each `screens/*.dc.html` file is one phone screen (390×844), apart from `08`, which is a 1330×844 reference board.

**How to read them:** they are HTML with inline styles, and the inline styles are the spec. Exact colours, sizes, spacing and radii are on each element. Ignore the scaffolding:
- `<x-dc>`, `<helmet>`, `<sc-for>`, `<sc-if>` and `{{holes}}` are a design-tool templating format;
- `./support.js` is that tool's runtime and is not included.

The `<script type="text/x-dc">` block at the bottom of each file holds the sample data and the small interactions, such as the version picker and the play toggle. In `02-now-playing`, it also holds the record visualiser's geometry math.

The text is placeholder copy. "Monsoon Static", "Neon Highway", "Sample Artist" and `[n]` stand in for real library data.

"Infinite Radio" is a working name the owner may change.

## Screens
| File | Screen | Notes |
|---|---|---|
| `01-home-stations` | Home / Stations | Ride mode CTA, Infinite Ride hero, 4 station tiles, library and set-aside card, mini player, bottom nav |
| `02-now-playing` | Now Playing (hands-on) | **Record visualiser** (`renderVals`):<br>• 96 bars as a ring of tick marks; section arcs on the outer ring (chorus = brown-amber, other = grey);<br>• played portion in amber, stylus = current bar;<br>• jump candidates as cyan chords, the next scheduled jump highlighted;<br>• label shows BPM and Camelot key.<br>Below it: section strip, "Next · Blend in N bars" card with Cut now, version chips, transport. |
| `03-versions-sheet` | Versions bottom sheet | 8 versions, single select, "keep for the whole station" switch |
| `04-library` | Library | Search (title, artist, key, BPM), filter chips, "mixes well after" suggestions with match %, A–Z list with a NOT ANALYSED badge |
| `05-set-aside-review` | Set-aside review | Grouped by triage class (sound effects, duplicates, speech), preview, per-file Restore, Restore all / Looks right |
| `06-ride-mode` | Ride mode | Pure black, giant targets: huge play/pause area, BACK / NEXT MIX, Vinyl / Forever / Like toggles, bar countdown to the next mix |
| `07-ride-mode-mixing` | Ride mode mid-transition | Outgoing → incoming title, crossfade balance bar, BASS SWAPPED / VINYL ON chips, UNDO MIX / CUT NOW |
| `08-helmet-controls-map` | On the ride (reference) | Cardo button mapping with audio feedback, automatic behaviours, voice. Must match the helmet spec in `PLAN.md`; if they disagree, `PLAN.md` wins. |

## Design tokens (put these in `app/src/theme/tokens.ts`)
**Colours**
| Token | Value | Use |
|---|---|---|
| `bg` | `#0A0A0C` | App background |
| `bgRide` | `#000000` | Ride mode background |
| `surface` | `#141417` | Cards, buttons |
| `surfaceRaised` | `#1C1C21` | Mini player, nested surfaces |
| `ride.surface` | `#121214` | Ride mode big targets |
| `border` | `#2A2A31` | 1 px borders, dividers |
| `divider` | `#222228` / `#1C1C21` | List separators |
| `text` | `#F3EFE7` | Primary text |
| `textMuted` | `#A9A6AE` | Secondary text |
| `textFaint` | `#85828A` | Tertiary, hints |
| `amber` | `#FFB547` | Playback, primary action, selected |
| `amberInk` | `#1A1206` | Text and icons on amber |
| `amberTint` | `#2A1C0A` | Selected-row background |
| `amberDim` | `#7A5A2A` | Chorus sections |
| `cyan` | `#6FD3FF` | Jumps, transitions, "next" info |
| `cyanTint` | `#0B1A21` / `#102A35` | Transition panels and chips |
| `cyanDim` | `#1F3A47` | Unfilled bar-countdown segments |
| `pink` | `#FF8FA3` | Like |
| `lilac` | `#C9B8FF` | Late Night station |

**Type**
- **Archivo** (variable, width 62–125): display text uses `font-stretch: 125%` at weights 800–900. Headings are uppercase for stations and screen titles.
- **IBM Plex Mono** 400–600: data readouts (BPM, key, bars, counts), small caps labels with 0.1–0.16 em letter spacing.
- **Sizes used:** 11, 12, 13, 14, 15, 16, 18, 20, 22, 26, 30, 42 px.

**Shape and spacing**
- **Radii:** pill = height/2; cards 20–24; big ride targets 28–32; sheet top 28; list art 12.
- **Touch targets:** at least 44 px in hands-on screens, 64–190 px in Ride mode.
- **Screen padding:** 16–20 px; gaps 8 / 12 / 14 / 16.

**Icons:** simple 2 px stroke line icons (see the inline SVGs). Use one consistent icon set in the app, e.g. Lucide.

**Motion:**
- the record sheen rotates slowly (6 s per turn), switched off when reduced motion is on;
- the stylus advances with playback;
- the next-jump chord pulses as it approaches.

## Revision 2 (song groups + cross-song portals)
- **Now Playing:**
  - a version chip under the artist ("VERSION 7 OF 19 · Slowed") opens the Versions sheet;
  - the status line shows "FOREVER · N JUMPS" when Forever is on;
  - the next-event card now describes a **portal** (a cross-song jump): "PORTAL IN 6 BARS · CHORUS → CHORUS", the target song, its BPM and key, and the landing bar;
  - the card's button is **Stay**, which skips this portal and keeps the current song.
  - The record visualiser already built on the phone (spinning disc, tonearm swinging back on jumps, cyan flash) supersedes the static record drawn here. Keep the phone's version, restyled with these tokens.
- **Library:**
  - it lists song **groups**, with a version-count badge per row ("19 VERSIONS"); tapping a row opens its versions;
  - the header shows song and version counts;
  - the top section is "PORTALS FROM <current song>" with the portal count and the section pairing ("chorus → chorus", "break → intro").
- **Not drawn, but needed:** a Song groups review screen in the same style. It's a list of groups, each expandable to its versions, with Merge and Split actions and per-version "not loopable" toggles.
