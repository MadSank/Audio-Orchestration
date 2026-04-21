import { useState, useRef, useEffect, useCallback } from "react";
import { useDropzone } from "react-dropzone";
import * as Tone from "tone";
import { useLibrary } from "../context/LibraryContext";

const S = {
  card:  { background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "14px", padding: "20px" },
  inner: { background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: "10px" },
  lbl:   { fontSize: "10px", color: "#4b5563", textTransform: "uppercase", letterSpacing: "0.1em" },
  mono:  { fontFamily: "'JetBrains Mono', ui-monospace, monospace" },
};

function fmt(s) {
  if (!s || !isFinite(s)) return "--:--";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}
function fmtSize(b) {
  return b < 1e6 ? `${(b / 1e3).toFixed(0)} KB` : `${(b / 1e6).toFixed(1)} MB`;
}

function SpectrumBars({ fftRef, playing }) {
  const canvasRef = useRef(null);
  const rafRef    = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const tick = () => {
      const w = canvas.offsetWidth, h = canvas.offsetHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const N = 52, bw = (w - N + 1) / N;
      const fft = fftRef.current;
      let vals = new Array(N).fill(-80);
      if (fft && playing) {
        try {
          const raw = fft.getValue(), step = Math.floor(raw.length / N);
          for (let i = 0; i < N; i++) vals[i] = raw[i * step] ?? -80;
        } catch (_) {}
      }
      for (let i = 0; i < N; i++) {
        const norm = (Math.max(vals[i], -80) + 80) / 80;
        const bh   = Math.max(2, norm * h * 0.88);
        ctx.fillStyle = `rgba(59,130,246,${playing ? 0.25 + norm * 0.75 : 0.1})`;
        ctx.beginPath(); ctx.roundRect(i * (bw + 1), h - bh, bw, bh, 1.5); ctx.fill();
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [fftRef, playing]);

  return <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}/>;
}

let activePlayer = null, activeVol = null, activeFft = null;

function teardown() {
  if (activePlayer) { try { activePlayer.stop(); } catch (_) {} activePlayer.disconnect(); activePlayer.dispose(); activePlayer = null; }
  if (activeFft)    { activeFft.dispose(); activeFft = null; }
  if (activeVol)    { activeVol.dispose(); activeVol = null; }
  Tone.getTransport().stop();
  Tone.getTransport().cancel();
}

function DropZone({ onFiles }) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: f => { if (f.length) onFiles(f); },
    accept: { "audio/*": [".mp3", ".wav", ".flac", ".ogg", ".aac", ".aiff", ".m4a"] },
    multiple: true,
  });
  return (
    <div {...getRootProps()} style={{
      border: `1.5px dashed ${isDragActive ? "#3b82f6" : "rgba(255,255,255,0.09)"}`,
      borderRadius: "12px", padding: "22px 16px",
      display: "flex", flexDirection: "column", alignItems: "center", gap: "7px",
      cursor: "pointer", textAlign: "center",
      background: isDragActive ? "rgba(59,130,246,0.06)" : "transparent",
      boxShadow: isDragActive ? "0 0 0 3px rgba(59,130,246,0.12)" : "none",
      transition: "all 0.15s",
    }}
    onMouseEnter={e => { if (!isDragActive) e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
    onMouseLeave={e => { if (!isDragActive) e.currentTarget.style.background = "transparent"; }}
    >
      <input {...getInputProps()} />
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={isDragActive ? "#3b82f6" : "#374151"} strokeWidth="1.8" strokeLinecap="round">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      <span style={{ fontSize: "12px", color: isDragActive ? "#93c5fd" : "#6b7280" }}>
        {isDragActive ? "Release to add" : "Drop audio files here · they'll be available across all tools"}
      </span>
      <span style={{ fontSize: "10px", color: "#374151" }}>MP3 · WAV · FLAC · OGG · AAC</span>
    </div>
  );
}

export default function Library() {
  const { tracks, addTracks, removeTrack, updateTrack } = useLibrary();

  const [activeId,    setActiveId]    = useState(null);
  const [playing,     setPlaying]     = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration,    setDuration]    = useState(0);
  const [volume,      setVolumeState] = useState(0.8);

  const playerRef = useRef(null);
  const volRef    = useRef(null);
  const fftRef    = useRef(null);
  const syncedRef = useRef(false);
  const pollRef   = useRef(null);

  useEffect(() => {
    return () => { teardown(); clearInterval(pollRef.current); };
  }, []);

  // Auto-analyze: fetch BPM/key for any track that hasn't been analyzed yet
  useEffect(() => {
    const API = "http://localhost:8000";
    tracks.forEach(track => {
      if (track.bpm != null || track.error || track._metaPending) return;
      // Mark as pending to avoid duplicate calls on re-render
      updateTrack(track.id, { _metaPending: true });
      const body = new FormData();
      body.append("file", track.file);
      fetch(`${API}/analyze-meta`, { method: "POST", body })
        .then(res => res.ok ? res.json() : Promise.reject(new Error("meta-analysis failed")))
        .then(data => {
          updateTrack(track.id, {
            bpm:      data.tempo,
            duration: data.duration || track.duration,
            _metaPending: false,
          });
        })
        .catch(() => {
          updateTrack(track.id, { _metaPending: false });
        });
    });
  }, [tracks, updateTrack]);

  const handleFiles = useCallback((files) => {
    addTracks(files);
  }, [addTracks]);

  const handleRemove = useCallback((id) => {
    if (activeId === id) {
      teardown(); playerRef.current = null;
      setActiveId(null); setPlaying(false); setCurrentTime(0); setDuration(0);
    }
    removeTrack(id);
  }, [activeId, removeTrack]);

  const loadAndPlay = useCallback(async (track) => {
    if (activeId === track.id && playerRef.current) {
      await Tone.start();
      if (playing) {
        Tone.getTransport().pause(); setPlaying(false); clearInterval(pollRef.current);
      } else {
        if (!syncedRef.current) { playerRef.current.sync().start(0); syncedRef.current = true; }
        Tone.getTransport().start(); setPlaying(true);
        pollRef.current = setInterval(() => setCurrentTime(Tone.getTransport().seconds), 100);
      }
      return;
    }

    clearInterval(pollRef.current);
    teardown(); playerRef.current = null; syncedRef.current = false;
    setPlaying(false); setCurrentTime(0); setDuration(0);
    setActiveId(track.id);
    await Tone.start();

    const vol = new Tone.Volume(20 * Math.log10(Math.max(volume, 0.0001))).toDestination();
    const fft = new Tone.FFT(256);
    activeVol = vol; activeFft = fft;
    volRef.current = vol; fftRef.current = fft;

    const player = new Tone.Player({
      url: track.url, loop: false,
      onload: () => {
        const dur = player.buffer.duration;
        setDuration(dur);
        updateTrack(track.id, { duration: dur });
      },
      onerror: () => updateTrack(track.id, { error: "Failed to load" }),
    });
    player.connect(vol);
    player.connect(fft);
    activePlayer = player; playerRef.current = player;

    const go = () => {
      if (!playerRef.current) return;
      playerRef.current.sync().start(0); syncedRef.current = true;
      Tone.getTransport().start(); setPlaying(true);
      pollRef.current = setInterval(() => {
        const t = Tone.getTransport().seconds; setCurrentTime(t);
        const dur = playerRef.current?.buffer?.duration;
        if (dur && t >= dur - 0.15) {
          Tone.getTransport().stop(); clearInterval(pollRef.current);
          setPlaying(false); setCurrentTime(0);
        }
      }, 100);
    };

    if (player.loaded) { go(); }
    else { const w = setInterval(() => { if (player.loaded) { clearInterval(w); go(); } }, 80); }
  }, [activeId, playing, volume, updateTrack]);

  const seek = useCallback((e) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = Math.max(0, Math.min((e.clientX - rect.left) / rect.width * duration, duration - 0.1));
    Tone.getTransport().seconds = t; setCurrentTime(t);
  }, [duration]);

  const handleVolume = (v) => {
    setVolumeState(v);
    if (volRef.current) volRef.current.volume.value = v === 0 ? -Infinity : 20 * Math.log10(v);
  };

  const activeTrack = tracks.find(t => t.id === activeId);
  const progress    = activeTrack && duration ? (currentTime / duration) * 100 : 0;

  return (
    <div style={{ maxWidth: "700px", display: "flex", flexDirection: "column", gap: "20px" }}>
      <div>
        <h2 style={{ fontSize: "22px", fontWeight: 700, color: "#f9fafb", margin: "0 0 6px", letterSpacing: "-0.3px" }}>
          Library
        </h2>
        <p style={{ fontSize: "13px", color: "#6b7280", margin: 0, lineHeight: 1.6 }}>
          Tracks added here are available everywhere — pick them directly in Infinite Jukebox and Transitions without re-uploading.
        </p>
      </div>

      {activeTrack && (
        <div style={{ ...S.card, display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ ...S.inner, position: "relative", height: "58px", overflow: "hidden" }}>
            <SpectrumBars fftRef={fftRef} playing={playing} />
          </div>
          <div onClick={seek} style={{ height: "4px", borderRadius: "2px", background: "rgba(255,255,255,0.07)", cursor: "pointer", position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${progress}%`, background: "linear-gradient(90deg, #3b82f6, #6366f1)", borderRadius: "2px", transition: "width 0.1s linear" }}/>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <button onClick={() => loadAndPlay(activeTrack)} style={{
              width: "36px", height: "36px", borderRadius: "50%",
              background: "linear-gradient(135deg, #3b82f6, #6366f1)",
              border: "none", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "white", flexShrink: 0, boxShadow: "0 0 16px rgba(59,130,246,0.3)",
            }}>
              {playing
                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                : <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
              }
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "12px", fontWeight: 500, color: "#e5e7eb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeTrack.name}</div>
              <div style={{ fontSize: "10px", color: "#4b5563", marginTop: "2px", ...S.mono }}>{fmt(currentTime)} / {fmt(duration)}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="2" strokeLinecap="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                {volume > 0.25 && <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>}
                {volume > 0.65 && <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>}
              </svg>
              <input type="range" min="0" max="1" step="0.01" value={volume}
                onChange={e => handleVolume(+e.target.value)}
                style={{ width: "72px", accentColor: "#3b82f6", cursor: "pointer" }}
              />
            </div>
          </div>
        </div>
      )}

      <DropZone onFiles={handleFiles} />

      {tracks.length === 0 ? (
        <div style={{ ...S.inner, padding: "40px 20px", display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", textAlign: "center" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth="1.6" strokeLinecap="round">
            <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
          </svg>
          <p style={{ fontSize: "13px", color: "#4b5563", margin: 0 }}>No tracks yet</p>
          <p style={{ fontSize: "11px", color: "#1f2937", margin: 0 }}>Add files above — they'll appear in Jukebox and Transitions too</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <div style={{ ...S.lbl, marginBottom: "8px" }}>{tracks.length} track{tracks.length !== 1 ? "s" : ""} in pool</div>
          {tracks.map((track, i) => {
            const isActive = track.id === activeId;
            const rowProg  = isActive && duration ? (currentTime / duration) * 100 : 0;
            return (
              <div key={track.id} onClick={() => !track.error && loadAndPlay(track)} style={{
                display: "flex", alignItems: "center", gap: "12px",
                padding: "10px 14px", borderRadius: "10px",
                cursor: track.error ? "default" : "pointer",
                background: isActive ? "rgba(59,130,246,0.08)" : "rgba(255,255,255,0.02)",
                border: `1px solid ${isActive ? "rgba(59,130,246,0.2)" : "rgba(255,255,255,0.05)"}`,
                position: "relative", overflow: "hidden", transition: "background 0.12s",
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = isActive ? "rgba(59,130,246,0.08)" : "rgba(255,255,255,0.02)"; }}
              >
                {isActive && <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${rowProg}%`, background: "rgba(59,130,246,0.05)", transition: "width 0.1s linear", pointerEvents: "none" }}/>}
                <div style={{
                  width: "28px", height: "28px", borderRadius: "8px", flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: isActive ? "rgba(59,130,246,0.15)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${isActive ? "rgba(59,130,246,0.3)" : "rgba(255,255,255,0.06)"}`,
                  position: "relative", zIndex: 1,
                }}>
                  {isActive && playing
                    ? <svg width="11" height="11" viewBox="0 0 24 24" fill="#3b82f6"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                    : isActive
                    ? <svg width="11" height="11" viewBox="0 0 24 24" fill="#3b82f6"><polygon points="5,3 19,12 5,21"/></svg>
                    : <span style={{ fontSize: "10px", color: "#4b5563", ...S.mono }}>{i + 1}</span>
                  }
                </div>
                <div style={{ flex: 1, minWidth: 0, position: "relative", zIndex: 1 }}>
                  <div style={{ fontSize: "13px", fontWeight: 500, color: isActive ? "#e5e7eb" : "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {track.name}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "7px", marginTop: "2px" }}>
                    <span style={{ fontSize: "10px", color: "#374151", ...S.mono }}>{fmtSize(track.size)}</span>
                    <span style={{ width: "2px", height: "2px", borderRadius: "50%", background: "#1f2937" }}/>
                    <span style={{ fontSize: "10px", color: "#374151" }}>{track.ext}</span>
                    {track.duration && <>
                      <span style={{ width: "2px", height: "2px", borderRadius: "50%", background: "#1f2937" }}/>
                      <span style={{ fontSize: "10px", color: "#374151", ...S.mono }}>{fmt(track.duration)}</span>
                    </>}
                    {track.error && <span style={{ fontSize: "10px", color: "#ef4444" }}>{track.error}</span>}
                  </div>
                </div>
                {isActive && duration > 0 && (
                  <div style={{ fontSize: "10px", color: "#3b82f6", ...S.mono, flexShrink: 0, position: "relative", zIndex: 1 }}>{fmt(currentTime)}</div>
                )}
                <button onClick={e => { e.stopPropagation(); handleRemove(track.id); }} style={{
                  width: "26px", height: "26px", borderRadius: "6px", border: "none",
                  background: "transparent", cursor: "pointer", color: "#374151",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0, position: "relative", zIndex: 1, transition: "all 0.1s",
                }}
                onMouseEnter={e => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.background = "rgba(239,68,68,0.1)"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "#374151"; e.currentTarget.style.background = "transparent"; }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
