import { useMemo, useState } from "react";
import { groupTracks, type Track } from "../audio/library";
import { STATIONS, type Player } from "../audio/player";
import { displayName, versionLabel } from "./names";

type Tab = "crate" | "stations" | "keys";

/** The side panel: the Crate (every song, searchable), the Stations, and the keys. */
export function Side({ player, tracks, current }: { player: Player; tracks: Track[]; current: Track | null }) {
  const [tab, setTab] = useState<Tab>("crate");
  return (
    <aside className="side" aria-label="Library">
      <nav className="side-head">
        {(["crate", "stations", "keys"] as Tab[]).map((t) => (
          <button key={t} className={`word${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
            {t === "crate" ? "Crate" : t === "stations" ? "Stations" : "Keys"}
          </button>
        ))}
      </nav>
      <div className="side-body">
        {tab === "crate" ? <Crate player={player} tracks={tracks} current={current} /> : null}
        {tab === "stations" ? <Stations player={player} /> : null}
        {tab === "keys" ? <Keys /> : null}
      </div>
    </aside>
  );
}

function Crate({ player, tracks, current }: { player: Player; tracks: Track[]; current: Track | null }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(() => groupTracks(tracks), [tracks]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return groups;
    return groups.filter((g) => g.name.toLowerCase().includes(needle) || g.versions.some((v) => v.title.toLowerCase().includes(needle)));
  }, [groups, q]);
  return (
    <>
      <p className="mono">{groups.length} SONGS · {tracks.length} VERSIONS</p>
      <label className="search">
        <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="8.5" cy="8.5" r="6" fill="none" stroke="var(--vermilion)" strokeWidth="2" />
          <path d="M13 13l5 5" stroke="var(--vermilion)" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search songs" aria-label="Search songs" />
      </label>
      {shown.map((g) => {
        const main = g.versions.find((v) => v.version === "original") ?? g.versions[0];
        const analysed = g.versions.some((v) => v.id);
        const playingHere = g.versions.some((v) => v === current);
        const n = g.versions.length;
        return (
          <div key={g.id}>
            <button className="row" onClick={() => (n > 1 ? setOpen(open === g.id ? null : g.id) : player.playTrack(main))} aria-expanded={n > 1 ? open === g.id : undefined}>
              <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
                <circle cx="22" cy="22" r="21" fill="var(--vinyl)" stroke="var(--groove)" />
                <circle cx="22" cy="22" r="8" fill={playingHere ? "var(--vermilion)" : analysed ? "var(--paper-dim)" : "var(--unread)"} />
              </svg>
              <span>
                <div className="row-title">{displayName(g.name || main.title).title}</div>
                <div className={`row-note${analysed ? "" : " unread"}`}>{analysed ? (n > 1 ? `${n} versions` : versionLabel(main.version)) : "Not analysed: plays straight through"}</div>
              </span>
            </button>
            {open === g.id
              ? g.versions.map((v) => (
                  <button key={v.file} className="version" onClick={() => player.playTrack(v)} title={v.file}>
                    <div className="row-title" style={{ fontSize: 16 }}>{versionLabel(v.version)}</div>
                    <div className="row-note">{v.title}</div>
                  </button>
                ))
              : null}
          </div>
        );
      })}
    </>
  );
}

function Stations({ player }: { player: Player }) {
  const s = player.state();
  return (
    <div className="stations">
      <p className="mono">EVERY SONG, ONE LONG WALK THROUGH PORTALS</p>
      {STATIONS.map((name, i) => (
        <button key={name} className={`word${s.station === name ? " on" : ""}`} onClick={() => player.startStation(i)}>
          {name}
        </button>
      ))}
    </div>
  );
}

function Keys() {
  const rows: [string, string][] = [
    ["Space", "Play or pause"],
    ["→  or  Next key", "Next portal, or a new song"],
    ["→ → or Shift+→", "A new song now"],
    ["←  or  Prev key", "From the top, or the song before"],
    ["← ←", "Forever on or off"],
    ["F", "Forever on or off"],
  ];
  return (
    <div className="keys">
      {rows.map(([k, v]) => (
        <span key={k} style={{ display: "contents" }}>
          <span className="mono">{k}</span>
          <span className="serif" style={{ fontSize: 18 }}>{v}</span>
        </span>
      ))}
      <p className="mono" style={{ gridColumn: "1 / -1", marginTop: 16 }}>
        THE MEDIA KEYS ON YOUR KEYBOARD AND HEADPHONES WORK TOO, EVEN WITH THE WINDOW IN THE BACKGROUND.
      </p>
      <a className="word" href="../" target="_blank" rel="noopener" style={{ gridColumn: "1 / -1", fontSize: 18, textDecoration: "none" }}>
        How the jumping works
      </a>
    </div>
  );
}
