import { EventSubscription, NativeModule, requireNativeModule } from "expo";

export type HelmetButton = "PLAY_PAUSE" | "NEXT" | "PREVIOUS";

export interface Track {
  uri: string;
  title: string;
  path: string;
  group: string;
  version: string;
  /** Gain to -14 LUFS from the track's analysis bundle (0 when missing). */
  gainDb: number;
  /** Bundle id ("" = not analysed). */
  trackId: string;
  /** Relative to the folder holding .saics (the key in override files). */
  file: string;
  groupName: string;
  bpm: number;
  camelot: string;
  notLoopable: boolean;
}

export interface SectionInfo {
  bars: number;
  /** "intro" | "verse" | "chorus" | "break" | "inst" | "outro" | "section" (no portal data). */
  kind: string;
}

/** The next cross-song move, as shown on Now Playing. */
export interface Timeline {
  id: string;
  bars: number[] | null;
  duration: number;
  /** False while still decoding: the last bar's end and the length are provisional. */
  complete: boolean;
}

export interface NextPortal {
  /** "portal": a matched jump; "back": back through the portal we came in on; "cut": fallback. */
  kind: "portal" | "back" | "cut";
  title: string;
  inBars: number;
  /** e.g. "chorus → chorus". */
  pair: string;
  bpm: number;
  camelot: string;
  landBar: number;
}

/** "Portals from" row: one target song. */
export interface PortalGroup {
  trackId: string;
  title: string;
  count: number;
  pair: string;
  bpm: number;
  camelot: string;
}

export interface PlayerState {
  isPlaying: boolean;
  title: string | null;
  version: string | null;
  group: string | null;
  forever: boolean;
  vinyl: boolean;
  station: string;
  stationIndex: number;
  queueLength: number;
  position: number;
  duration: number;
  libraryCount: number;
  liked: boolean;
  versionIndex: number;
  versionCount: number;
  versions: { uri: string; title: string; version: string }[];
  trackId?: string;
  bpm?: number;
  camelot?: string;
  bar?: number;
  sections?: SectionInfo[];
  sectionKind?: string;
  /** Songs waiting to be analysed on the phone, and the one in progress. */
  analysing?: number;
  analysingTitle?: string | null;
  /** The phone's analysis, by file name: who's waiting, who's being read and how far, who can't be. */
  analysis?: Analysis;
  /** The playing song's file, relative to its folder. */
  path?: string | null;
  /** Loop points in the playing song's analysis; null when it hasn't been analysed. */
  jumpPoints?: number | null;
  /** Forever jumps taken in this song. */
  jumps?: number;
  nextPortal?: NextPortal | null;
}

export interface Analysis {
  queue: string[];
  current: string | null;
  /** How far the current song has got, 0 to 1. */
  progress: number;
  unreadable: Record<string, string>;
}

/** Where a song's analysis stands, in words: Crate and Now Playing say the same thing. */
export function readingNote(path: string | null | undefined, a: Analysis | undefined): string {
  const name = (path ?? "").split("/").pop() ?? "";
  if (a && name) {
    if (a.current === name) return `Reading now · ${Math.round(a.progress * 100)}%`;
    const i = a.queue.indexOf(name);
    if (i >= 0) return `Waiting to be read · ${i + 1} in line`;
    if (a.unreadable[name]) return "Can't be read on the phone";
  }
  return "Not read yet";
}

export interface ButtonEvent {
  type: "press" | "action";
  button: HelmetButton;
  count: number;
  keyCode?: number;
  keyName?: string;
  sinceLastMs?: number | null;
  at: number;
}

export interface PlayerSettings {
  tts: boolean;
  earcons: boolean;
  announceTitles: boolean;
  multiWindowMs: number;
  tripleWindowMs: number;
}

type Events = {
  onButton(e: ButtonEvent): void;
  onState(s: PlayerState): void;
  /** Button actions and engine events: "jump-soon" | "jump" | "portal" | "version" | "track" | "repeat" | "error" | ... */
  onAction(a: { action: string; detail?: string; version?: string }): void;
};

declare class SaicsPlayerModule extends NativeModule<Events> {
  pickFolder(): Promise<string | null>;
  getFolder(): string | null;
  scanLibrary(): Promise<Track[]>;
  refreshAnalysis(): Promise<void>;
  /** What the laptop set aside, from .saics/set_aside_manifest.json (empty if it isn't on the phone). */
  getSetAside(): Promise<{ source: string; dest: string }[]>;
  /** The last scan's result, without walking the folder again. */
  getLibrary(): Promise<Track[]>;
  canWriteOverrides(): boolean;
  /** Group review; each resolves false when the override file can't be written. */
  setNotLoopable(uri: string, notLoopable: boolean): Promise<boolean>;
  mergeGroups(from: string, into: string): Promise<boolean>;
  splitTrack(uri: string): Promise<boolean>;
  toggleLike(uri: string): Promise<void>;
  /** Switch to this version of the playing song on the next bar. */
  pickVersion(uri: string): Promise<void>;
  /** Skip the portal shown on Now Playing and keep the current song. */
  stayPortal(): Promise<void>;
  /** The playing song's downbeats in seconds (null: not analysed) and its length, for the record. */
  getTimeline(): Promise<Timeline | null>;
  /** Play on from this many seconds into the song playing, on the nearest downbeat. */
  seek(seconds: number): Promise<void>;
  /** A hand on the record: the sound fades out and nothing new is decided until it lets go. */
  hold(on: boolean): Promise<void>;
  getPortalsFrom(trackId: string): Promise<PortalGroup[]>;
  startStation(index: number): Promise<void>;
  playTrack(uri: string): Promise<void>;
  togglePlay(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  toggleForever(): Promise<void>;
  toggleVinyl(): Promise<void>;
  getState(): Promise<PlayerState>;
  simulatePress(button: HelmetButton): Promise<void>;
  getButtonLog(): Promise<ButtonEvent[]>;
  getSettings(): Promise<PlayerSettings>;
  setSettings(values: Partial<PlayerSettings>): Promise<PlayerSettings>;
  speak(text: string): Promise<void>;
  isIgnoringBatteryOptimizations(): boolean;
  requestIgnoreBatteryOptimizations(): void;
}

const SaicsPlayer = requireNativeModule<SaicsPlayerModule>("SaicsPlayer");
export default SaicsPlayer;

export const STATIONS = ["Infinite Ride", "Vinyl Ride", "Late Night", "Liked"] as const;

export function addListener<K extends keyof Events>(name: K, fn: Events[K]): EventSubscription {
  return SaicsPlayer.addListener(name, fn);
}
