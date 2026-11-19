import { parseBundle, type Bundle } from "../core/bundle";
import { parseGraph, type PortalGraph } from "../core/mixWalk";
import type { Source } from "./source";

/** One file in the music folder, with what the laptop's analysis knows about it. */
export interface Track {
  file: string; // relative to the folder holding .saics
  title: string;
  id: string; // the analysis id ("" when the laptop hasn't analysed it)
  group: string;
  groupName: string;
  version: string;
  notLoopable: boolean;
}

export interface SongGroup {
  id: string;
  name: string;
  versions: Track[];
}

export interface Library {
  tracks: Track[];
  graph: PortalGraph | null;
  source: Source;
  bundle(t: Track): Promise<Bundle | null>;
}

const stem = (f: string) => f.split("/").pop()!.replace(/\.[^.]+$/, "");

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q && c === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (c === '"') q = !q;
    else if (!q && c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Reads the folder: library.json, the portal graph, the owner's overrides, and every audio file. */
export async function loadLibrary(source: Source): Promise<Library> {
  const lib = JSON.parse((await source.text(".saics/library.json")) ?? '{"tracks":[],"groups":{}}');
  const graph = parseGraph((await source.text(".saics/portals.json")) ?? "");
  const names: Record<string, { name?: string }> = lib.groups ?? {};
  const meta = new Map<string, { id: string; group: string; version: string; cls: string }>();
  for (const t of lib.tracks ?? []) meta.set(t.file, { id: t.id, group: t.group, version: t.version, cls: t.class });

  const notLoopable = new Set(
    ((await source.text(".saics/forever_overrides.csv")) ?? "")
      .split(/\r?\n/)
      .filter((l) => !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf(",")).trim().toLowerCase(), l.slice(l.indexOf(",") + 1).trim()])
      .filter(([a]) => a === "not_loopable")
      .map(([, f]) => f.replace(/\\/g, "/")),
  );

  const files = (await source.listAudio()).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  let tracks: Track[] = files
    .filter((f) => (meta.get(f)?.cls ?? "music") === "music")
    .map((f) => {
      const m = meta.get(f);
      return {
        file: f, title: stem(f), id: m?.id ?? "", group: m?.group ?? "", groupName: (m && names[m.group]?.name) || "",
        version: m?.version ?? "original", notLoopable: notLoopable.has(f),
      };
    });

  // The owner's group fixes (groups_overrides.csv), the same rows the phone replays.
  for (const line of ((await source.text(".saics/groups_overrides.csv")) ?? "").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [action, file, value] = parseCsvLine(line);
    if (action === "split") tracks = tracks.map((t) => (t.file === file ? { ...t, group: `split:${file}`, groupName: t.title } : t));
    if (action === "merge") {
      const target = tracks.find((t) => t.file === value);
      if (target) tracks = tracks.map((t) => (t.file === file ? { ...t, group: target.group, groupName: target.groupName } : t));
    }
  }

  const cache = new Map<string, Promise<Bundle | null>>();
  return {
    tracks,
    graph,
    source,
    bundle(t: Track) {
      if (!t.id) return Promise.resolve(null);
      if (!cache.has(t.id)) cache.set(t.id, source.text(`.saics/tracks/${t.id}.json`).then((s) => (s ? parseBundle(s) : null)));
      return cache.get(t.id)!;
    },
  };
}

/** One row per song: a track's group, or the track itself when it has none. */
export function groupTracks(tracks: Track[]): SongGroup[] {
  const map = new Map<string, SongGroup>();
  for (const t of tracks) {
    const id = t.group || t.file;
    const g = map.get(id) ?? { id, name: t.groupName || t.title, versions: [] };
    g.versions.push(t);
    map.set(id, g);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}
