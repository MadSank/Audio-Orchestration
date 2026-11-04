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

export const upper = (s: string) => s.toUpperCase();
