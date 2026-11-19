import { useCallback, useEffect, useRef, useState } from "react";
import { bindKeys } from "../audio/keys";
import { loadLibrary, type Library } from "../audio/library";
import { Player, type PlayerEvent } from "../audio/player";
import { canRead, DevSource, FolderSource, pickFolder, rememberedFolder, rememberFolder, type Source } from "../audio/source";
import { displayName, versionLabel } from "./names";
import { Record } from "./Record";
import { Side } from "./Side";

const player = new Player();
if (import.meta.env.DEV) (window as unknown as { saics: Player }).saics = player; // for checking from the console

export function App() {
  const [lib, setLib] = useState<Library | null>(null);
  const [remembered, setRemembered] = useState<FileSystemDirectoryHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [jumpKey, setJumpKey] = useState(0);
  const [crossing, setCrossing] = useState<{ title: string; pair: string; key: number } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef(0);

  const open = useCallback(async (source: Source) => {
    setBusy(true);
    setError(null);
    try {
      const l = await loadLibrary(source);
      if (!l.tracks.length) throw new Error("No songs in that folder.");
      player.setLibrary(l);
      setLib(l);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // First run: a remembered folder, or (in development) the dev server's folder.
  useEffect(() => {
    void (async () => {
      if (import.meta.env.DEV) {
        const r = await fetch("/__music/.saics/library.json", { method: "GET" }).catch(() => null);
        if (r?.ok) return void open(new DevSource());
      }
      const h = await rememberedFolder();
      if (h && (await canRead(h, false))) return void open(new FolderSource(h));
      setRemembered(h);
    })();
  }, [open]);

  useEffect(() => bindKeys(player), []);

  useEffect(
    () =>
      player.on((e: PlayerEvent | null) => {
        setTick((t) => t + 1);
        if (!e) return;
        if (e.type === "jump-soon") setJumpKey((k) => k + 1);
        if (e.type === "portal") setCrossing({ title: e.title, pair: e.pair, key: Date.now() });
        if (e.type === "error") {
          setFlash(e.message);
          clearTimeout(flashTimer.current);
          flashTimer.current = window.setTimeout(() => setFlash(null), 4000);
        }
      }),
    [],
  );
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 500); // the position readout
    return () => clearInterval(id);
  }, []);

  if (!lib) {
    return (
      <main className="welcome">
        <div className="welcome-inner">
          <h1>Pick the music folder</h1>
          <p>The folder your laptop analysed: the one with the hidden .saics folder inside. SAICS only reads it; your songs are never changed.</p>
          <div style={{ display: "flex", gap: 30 }}>
            {remembered ? (
              <button className="word on" disabled={busy} onClick={async () => (await canRead(remembered, true)) && open(new FolderSource(remembered))}>
                Open {remembered.name}
              </button>
            ) : null}
            <button
              className={`word${remembered ? "" : " on"}`}
              disabled={busy}
              onClick={async () => {
                const h = await pickFolder();
                if (!h) return setError("This browser can't open folders. Use Chrome or Edge.");
                await rememberFolder(h);
                void open(new FolderSource(h));
              }}
            >
              {remembered ? "Another folder" : "Choose folder"}
            </button>
          </div>
          <p className="mono" aria-live="polite">{busy ? "READING THE FOLDER…" : (error ?? "")}</p>
        </div>
      </main>
    );
  }

  const s = player.state();
  const t = s.track;
  const name = t ? displayName(t.groupName && t.version !== "original" ? t.groupName : t.title) : { title: "SAICS", artist: "" };
  const status =
    flash ??
    (s.loading ? "Loading…"
      : s.next ? `${s.next.kind === "portal" ? "Portal" : s.next.kind === "back" ? "Back" : "Cut"} in ${s.next.inBars} ${s.next.inBars === 1 ? "bar" : "bars"}: ${displayName(s.next.title).title}`
      : t && s.jumpPoints == null ? "Not analysed · plays straight through"
      : s.forever && s.jumpPoints === 0 ? "Forever · no loop points in this song"
      : s.forever ? `Forever · ${s.jumps} ${s.jumps === 1 ? "jump" : "jumps"}`
      : s.station ?? "");

  return (
    <div className="shell">
      <main className="np">
        <div className="np-record">
          <Record title={name.title} playing={s.playing} />
        </div>
        {jumpKey ? <img key={jumpKey} className="finger go" src="hand/hand1.webp" alt="" /> : null}
        <button className="heart" onClick={() => player.toggleLike(t)} aria-pressed={!!t && player.liked.has(t.file)} aria-label="Like this song">
          <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 20s-7-4.4-9.2-8.6C1.3 8.3 3.1 5 6.4 5c2 0 3.3 1.1 4.1 2.3h3c.8-1.2 2.1-2.3 4.1-2.3 3.3 0 5.1 3.3 3.6 6.4C19 15.6 12 20 12 20z" transform="translate(0 -.5)"
              fill={t && player.liked.has(t.file) ? "var(--vermilion)" : "none"} stroke={t && player.liked.has(t.file) ? "var(--vermilion)" : "var(--paper)"} strokeWidth="1.8" />
          </svg>
        </button>
        <div className="np-text">
          <h1 className="np-title">{name.title}</h1>
          <div className="np-sub">{[name.artist, t ? versionLabel(t.version) : ""].filter(Boolean).join(" · ") || "Pick a song or a station"}</div>
          <div className="mono status" aria-live="polite">{status}</div>
          <div className="np-words">
            <button className={`word${s.forever ? " on" : ""}`} onClick={() => player.toggleForever()} aria-pressed={s.forever}>
              Forever
            </button>
            <button className="word" disabled title="Vinyl comes to the PC next">
              Vinyl
            </button>
          </div>
          <div className="transport">
            <button className="skip" onClick={() => player.previous()} aria-label="Previous">
              <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 4L7 12l12 8zM4 4h3v16H4z" fill="currentColor" /></svg>
            </button>
            <button className="round" onClick={() => void player.togglePlay()} aria-label={s.playing ? "Pause" : "Play"}>
              {s.playing ? (
                <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor" /></svg>
              ) : (
                <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4l13 8-13 8z" fill="currentColor" /></svg>
              )}
            </button>
            <button className="skip" onClick={() => player.next(false)} aria-label="Next">
              <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4l12 8-12 8zM17 4h3v16h-3z" fill="currentColor" /></svg>
            </button>
          </div>
        </div>
        {crossing ? (
          <div key={crossing.key} className="crossing" onAnimationEnd={(e) => e.target === e.currentTarget && setCrossing(null)}>
            <img src="hand/grip0.webp" alt="" />
            <img src="hand/grip1.webp" alt="" />
            <div className="what">
              <div className="serif" style={{ fontSize: 40 }}>{crossing.pair ? "Same beat. New song." : "New song."}</div>
              <div className="np-sub">{displayName(crossing.title).title}</div>
            </div>
          </div>
        ) : null}
      </main>
      <Side player={player} tracks={lib.tracks} current={t} />
      <aside className="obi" aria-hidden="true">
        <div className="obi-title">{name.title}</div>
        <div className="mono">
          {s.bpm ? Math.round(s.bpm) : ""}
          <br />
          {s.camelot}
        </div>
      </aside>
    </div>
  );
}
