import { useCallback, useEffect, useMemo, useState } from "react";

import SaicsPlayer, { addListener, type PlayerState, type Track } from "../modules/saics-player";

/** Live player state from the native service (onState events + a once-a-second poll). */
export function usePlayerState(): PlayerState | null {
  const [state, setState] = useState<PlayerState | null>(null);
  useEffect(() => {
    let alive = true;
    const get = () => SaicsPlayer.getState().then((s) => alive && setState(s)).catch(() => {});
    get();
    const sub = addListener("onState", get);
    const timer = setInterval(get, 1000);
    return () => {
      alive = false;
      sub.remove();
      clearInterval(timer);
    };
  }, []);
  return state;
}

export interface SongGroup {
  id: string;
  name: string;
  versions: Track[];
}

/** One row per song: a track's group, or the track itself when it has none. */
export function groupTracks(tracks: Track[]): SongGroup[] {
  const map = new Map<string, SongGroup>();
  for (const t of tracks) {
    const id = t.group || t.uri;
    const g = map.get(id) ?? { id, name: t.groupName || t.title, versions: [] };
    g.versions.push(t);
    map.set(id, g);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The library the service holds (from the last scan); scans only if there is none yet. */
export function useLibrary() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => SaicsPlayer.getLibrary().then(setTracks).catch(() => {}), []);
  useEffect(() => {
    SaicsPlayer.getLibrary()
      .then((t) => (t.length || !SaicsPlayer.getFolder() ? t : SaicsPlayer.scanLibrary()))
      .then(setTracks)
      .catch(() => setTracks([]))
      .finally(() => setLoading(false));
  }, []);
  const groups = useMemo(() => groupTracks(tracks), [tracks]);
  return { tracks, groups, loading, reload };
}
