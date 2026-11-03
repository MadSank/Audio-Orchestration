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
  /** Button actions and engine events: "jump" | "version" | "track" | "repeat" | "error" | ... */
  onAction(a: { action: string; detail?: string; version?: string }): void;
};

declare class SaicsPlayerModule extends NativeModule<Events> {
  pickFolder(): Promise<string | null>;
  getFolder(): string | null;
  scanLibrary(): Promise<Track[]>;
  /** The last scan's result, without walking the folder again. */
  getLibrary(): Promise<Track[]>;
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
