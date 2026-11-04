/**
 * Analysis bundle contract: app-side mirror of engine/saics/schema.py.
 *
 * CLAUDE.md hard rule 8: any schema change bumps ANALYSIS_SCHEMA and updates this file and
 * the pydantic models in the same change. Bundles with another schema are not trusted:
 * the app falls back to plain playback for that track.
 */

export const ANALYSIS_SCHEMA = "saics.analysis/9" as const;
export const LIBRARY_SCHEMA = "saics.library/7" as const;
export const PORTALS_SCHEMA = "saics.portals/1" as const;

/** `.saics/portals.json` (engine/saics/schema.py PortalGraph): the Mix Web. */
export interface PortalEdge {
  from_bar: number;
  to: string; // track id
  to_bar: number;
  score: number;
  pair: string; // "chorus → chorus"
  context: number;
  harmony: number;
  same_group: boolean; // only used when Forever is on
  two_way: boolean;
}

export interface PortalTrack {
  file: string;
  group: string;
  bpm: number;
  camelot: string;
  sections: string[]; // kind per bundle section
  bars: number;
  entries: number[]; // fallback landing bars, best first
  break_exits: number[];
  portals: PortalEdge[];
}

export type TriageClass =
  | "music" | "sfx" | "speech" | "short" | "unreadable" | "duplicate" | "not_audio";

export interface Track {
  id: string;
  file: string; // relative to the music folder, forward slashes
  title: string;
  artist: string;
  duration_s: number;
  codec: string;
  native_sample_rate: number;
  decoder_offset_ms: number; // ffmpeg stream start (encoder delay / AAC priming); see PLAN R1
}

export interface Group {
  id: string; // song id shared by every version of the song
  version: string; // "original", "slowed+reverb", "nightcore", "english", ...
  evidence: string; // "name" | "audio" | "name+audio" | "override" | ""
}

export interface Section {
  start_bar: number;
  end_bar: number; // exclusive
  label: string | null;
  group: number; // repeat class
}

export interface Break {
  start_beat: number;
  end_beat: number;
  start_s: number;
  end_s: number;
  depth_db: number; // negative, relative to the track's typical level
  kind: "silence" | "breakdown";
  ramp_up: boolean; // the music comes back after the break
  return_db: number;
}

/** Instead of playing bar from_bar, continue at bar to_bar (both on downbeats). Since /8;
 * targets are directly aligned and there are no song-end jumps since /9. */
export interface Jump {
  from_beat: number;
  to_beat: number;
  from_bar: number;
  to_bar: number;
  score: number;
  kind: "repeat" | "break";
  xfade_ms: number;
  label: string; // e.g. "B2:5 → B1:5"
  context: number;
  lyric: number;
  distance_s: number;
}

export interface Cue {
  beat: number;
  score: number;
  reason: string;
}

export interface TrackBundle {
  schema: typeof ANALYSIS_SCHEMA;
  track: Track;
  triage: { class: TriageClass; reasons: string[] };
  group: Group;
  loudness: { integrated_lufs: number; gain_db: number }; // gain to -14 LUFS
  tempo: { bpm: number; stable: boolean; confidence: number };
  meter: { beats_per_bar: number; confidence: number };
  key: { tonic: string; mode: "major" | "minor"; camelot: string; confidence: number };
  beats: number[]; // seconds
  downbeats: number[]; // indices into beats
  sections: Section[];
  bar_energy: number[]; // per bar, 0..1
  vocal_activity: number[]; // per beat, 0..1
  breaks: Break[];
  jumps: Jump[];
  /** Since /9. Forever ending, in order: the last backward repeat jump before outro_bar,
   * else a break loop, else another version of the group, else repeat-one (outro, short
   * gap, restart). loopable=false (owner override) skips straight to version/repeat-one. */
  outro_bar: number;
  loopable: boolean;
  cues: { out: Cue[]; in: Cue[] };
}

export interface LibraryTrack {
  id: string;
  file: string;
  size: number;
  mtime_ns: number;
  group: string;
  version: string;
  class: TriageClass;
}

export interface Library {
  schema: typeof LIBRARY_SCHEMA;
  track_schema: string;
  generated: string;
  tracks: LibraryTrack[];
  groups: Record<string, { name: string; tracks: { id: string; version: string }[] }>;
  neighbours: Record<string, unknown[]>; // P4 / Mix Web
}

/** Use a bundle only if it has the schema this build understands (else plain playback). */
export function isCurrentBundle(x: unknown): x is TrackBundle {
  return typeof x === "object" && x !== null && (x as { schema?: unknown }).schema === ANALYSIS_SCHEMA;
}
