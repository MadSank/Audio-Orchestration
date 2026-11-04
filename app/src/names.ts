/**
 * Display names from file names (bundles carry no tags). Removes downloader noise and splits
 * "Artist - Title" when that's what the name looks like.
 */
export function displayName(raw: string): { title: string; artist: string } {
  let s = raw
    .replace(/^y2(meta\.app|mate\.is)\s*-\s*/i, "")
    .replace(/\s*\(\d+\s*kbps\)/gi, "")
    .replace(/\s*\[[A-Za-z0-9_-]{11}\]/g, "") // YouTube id
    .replace(/\s*[([](official\s*(music\s*)?(video|audio|lyric video)|lyrics?|audio|hd|4k)[)\]]/gi, "")
    .trim();
  s = s.replace(/\s+/g, " ");
  const m = s.match(/^(.{2,40}?)\s+-\s+(.+)$/);
  return m ? { artist: m[1], title: m[2] } : { title: s, artist: "" };
}

/** "slowed+reverb" -> "Slowed + reverb" (design: version labels start with a capital). */
export function versionLabel(v: string): string {
  const s = v.replace(/\+/g, " + ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The artist line, unless the song's name already starts with it. */
export function artistLine(name: string, artist: string): string {
  const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return artist && !norm(name).startsWith(norm(artist).slice(0, 10)) ? artist : "";
}
