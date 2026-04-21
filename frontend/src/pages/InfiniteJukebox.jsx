import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import AudioDropzone from "../components/AudioDropzone";
import ProcessingOverlay from "../components/ProcessingOverlay";
import { useLibrary } from "../context/LibraryContext";

const API = "http://localhost:8000";

const JUMP_SCORE_GATE  = 0.85;
const JUMP_LOOKAHEAD_S = 0.35;  // 350ms window — generous for ~16ms rAF tick
const JUMP_COOLDOWN_MS = 30000; // 30s between jumps — lets the song breathe

const UPLOAD_STAGES = [
  "Uploading audio…",
  "Extracting beats & tempo…",
  "Computing self-similarity matrix…",
  "Building transition graph…",
  "Pathfinding through the structure…",
  "Synthesising crossfades…",
  "Finishing up…",
];

const ANALYZE_STAGES = [
  "Uploading audio…",
  "Extracting beats & tempo…",
  "Building chroma & MFCC features…",
  "Computing self-similarity matrix…",
  "Scoring transition edges…",
];

function fmt(s) {
  if (!isFinite(s) || isNaN(s)) return "0:00";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function isPurple(e) {
  return (e.is_section === true || e.score >= JUMP_SCORE_GATE) && e.score >= JUMP_SCORE_GATE;
}

const S = {
  card:  { background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "14px", padding: "20px" },
  inner: { background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: "10px" },
  lbl:   { fontSize: "10px", color: "#4b5563", textTransform: "uppercase", letterSpacing: "0.1em" },
  mono:  { fontFamily: "'JetBrains Mono', ui-monospace, monospace" },
};

function JumpGraph({ beats, edges, currentTime, duration }) {
  const canvasRef = useRef(null);
  const rafRef    = useRef(null);
  const stateRef  = useRef({ beats, edges, currentTime, duration });

  useEffect(() => { stateRef.current = { beats, edges, currentTime, duration }; }, [beats, edges, currentTime, duration]);

  // ResizeObserver keeps the buffer sized correctly even when the tab starts hidden
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sync = () => {
      const w = canvas.offsetWidth, h = canvas.offsetHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      const W = Math.round(w * dpr), H = Math.round(h * dpr);
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    };
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    sync();
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let sorted = [], lastEdges = null;

    const draw = (ts) => {
      const { beats, edges, currentTime, duration } = stateRef.current;
      const dpr = window.devicePixelRatio || 1;
      const cw = canvas.offsetWidth, ch = canvas.offsetHeight;
      if (cw > 0 && ch > 0) {
        const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
        if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      }
      if (!beats.length || !edges.length || !canvas.width || !canvas.height) {
        rafRef.current = requestAnimationFrame(draw); return;
      }
      if (edges !== lastEdges) { sorted = [...edges].sort((a, b) => b.score - a.score).slice(0, 250); lastEdges = edges; }

      const ctx = canvas.getContext("2d");
      const w = cw, h = ch;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const toX = t => (t / (duration || 1)) * w;

      let active = -1;
      for (let i = beats.length - 1; i >= 0; i--) { if (beats[i].time <= currentTime) { active = i; break; } }

      const phase = (ts / 600) % 1;
      const flash = 0.55 + Math.sin(phase * Math.PI * 2) * 0.45;

      sorted.forEach(e => {
        const s = beats[e.source], t = beats[e.target];
        if (!s || !t) return;
        const x1 = toX(s.time), x2 = toX(t.time);
        const mx = (x1 + x2) / 2, arc = Math.abs(x2 - x1) * 0.52;
        const isAct = e.source === active;
        const purp  = isPurple(e);

        ctx.beginPath();
        ctx.moveTo(x1, h);
        ctx.quadraticCurveTo(mx, h - arc, x2, h);

        if (isAct) {
          ctx.strokeStyle = purp ? `rgba(167,139,250,${flash})` : `rgba(52,211,153,${flash * 0.7})`;
          ctx.lineWidth   = 1.2 + e.score * 1.8;
          ctx.shadowColor = purp ? "#7c3aed" : "#059669";
          ctx.shadowBlur  = 8;
        } else if (purp) {
          ctx.strokeStyle = `rgba(139,92,246,${0.06 + e.score * 0.22})`;
          ctx.lineWidth   = 0.8 + e.score * 1.2;
          ctx.shadowBlur  = 0;
        } else {
          ctx.strokeStyle = `rgba(52,211,153,${0.03 + e.score * 0.1})`;
          ctx.lineWidth   = 0.4 + e.score * 0.6;
          ctx.shadowBlur  = 0;
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      });

      beats.forEach(b => {
        const x = toX(b.time);
        const isAct = b.index === active;
        const th = b.beat_phase === 0 ? 14 : 8;
        ctx.fillStyle = isAct ? "rgba(52,211,153,0.65)" : b.beat_phase === 0 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.07)";
        ctx.fillRect(x - 0.5, h - th, 1, th);
      });

      if (active >= 0) {
        const ax = toX(beats[active].time);
        const r  = 3 + Math.sin(phase * Math.PI * 2) * 1.2;
        ctx.beginPath(); ctx.arc(ax, h - 2, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(52,211,153,${flash})`;
        ctx.shadowColor = "#10b981"; ctx.shadowBlur = 10;
        ctx.fill(); ctx.shadowBlur = 0;
      }

      if (duration > 0 && currentTime > 0) {
        const px = toX(currentTime);
        ctx.strokeStyle = "rgba(16,185,129,0.7)"; ctx.lineWidth = 1.5;
        ctx.shadowColor = "#10b981"; ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
        ctx.shadowBlur = 0;
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(rafRef.current); rafRef.current = null; };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", display: "block" }}
    />
  );
}

function CooldownPill({ cooldownUntil }) {
  const [rem, setRem] = useState(0);
  useEffect(() => {
    if (!cooldownUntil) return;
    let id;
    const tick = () => { const r = Math.max(0, cooldownUntil - performance.now()); setRem(r); if (r > 0) id = requestAnimationFrame(tick); };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [cooldownUntil]);
  if (rem <= 0) return null;
  const pct = ((JUMP_COOLDOWN_MS - rem) / JUMP_COOLDOWN_MS) * 100;
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: "8px",
      padding: "4px 10px", borderRadius: "999px",
      background: "rgba(139,92,246,0.1)", border: "1px solid rgba(139,92,246,0.22)",
      fontSize: "11px", color: "#c4b5fd",
    }}>
      <span>Next jump in {(rem / 1000).toFixed(1)}s</span>
      <div style={{ width: "44px", height: "3px", borderRadius: "2px", background: "rgba(139,92,246,0.2)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "#8b5cf6", borderRadius: "2px" }}/>
      </div>
    </div>
  );
}

function AudioInitOverlay({ onInit }) {
  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 10,
      background: "rgba(6,8,16,0.88)", backdropFilter: "blur(8px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      borderRadius: "14px",
    }}>
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center", gap: "16px",
        padding: "32px 40px", textAlign: "center",
      }}>
        <div style={{
          width: "48px", height: "48px", borderRadius: "50%",
          background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.25)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="1.8" strokeLinecap="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
        </div>
        <div>
          <div style={{ fontSize: "14px", fontWeight: 600, color: "#f3f4f6", marginBottom: "6px" }}>
            Initialize Audio Engine
          </div>
          <div style={{ fontSize: "11px", color: "#6b7280", lineHeight: 1.5, maxWidth: "240px" }}>
            Browsers require a user interaction before audio can play. Click below to unlock the audio engine.
          </div>
        </div>
        <button onClick={onInit} style={{
          padding: "10px 28px", borderRadius: "10px", border: "none",
          background: "linear-gradient(135deg, #10b981, #059669)",
          color: "#022c22", fontSize: "13px", fontWeight: 600,
          cursor: "pointer", letterSpacing: "0.02em",
          boxShadow: "0 0 24px rgba(16,185,129,0.25), inset 0 1px 0 rgba(255,255,255,0.15)",
          transition: "transform 0.1s, box-shadow 0.15s",
        }}
        onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.04)"; e.currentTarget.style.boxShadow = "0 0 32px rgba(16,185,129,0.4), inset 0 1px 0 rgba(255,255,255,0.15)"; }}
        onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.boxShadow = "0 0 24px rgba(16,185,129,0.25), inset 0 1px 0 rgba(255,255,255,0.15)"; }}
        >
          Unlock Audio
        </button>
      </div>
    </div>
  );
}

function useWebAudioPlayer(audioUrl, graphData) {
  // ═══════════════════════════════════════════════════════════════════════
  //  Raw Web Audio API Architecture
  //  ────────────────────────────────
  //  NO Tone.js.  We use AudioContext + BufferSourceNode + GainNode
  //  directly.  The AudioContext is created explicitly on a user gesture
  //  (the "Unlock Audio" button) to satisfy the autoplay policy.
  //
  //  Playback: A single BufferSourceNode (loop=false).  When it reaches
  //  the buffer end, onended re-creates a new source from offset 0
  //  (manual looping).
  //
  //  Jump: Hard-switch at beat boundary.  We call oldSource.stop(t) and
  //  newSource.start(t, targetOffset) at the same AudioContext time
  //  for sample-accurate gapless transitions.  No crossfade.
  //
  //  Position: songOffset + max(0, audioCtx.currentTime − startedAt)
  // ═══════════════════════════════════════════════════════════════════════

  // ─── Audio context refs (created on user gesture) ───
  const audioCtxRef    = useRef(null);
  const gainRef        = useRef(null);
  const audioBufferRef = useRef(null);
  const sourceRef      = useRef(null);

  // ─── Timing refs ───
  const startedAtRef   = useRef(0);      // audioCtx.currentTime when source started
  const songOffsetRef  = useRef(0);      // offset in song when source started
  const pausedPosRef   = useRef(0);
  const userGainRef    = useRef(0.8);    // linear gain [0..1]

  // ─── Jump evaluation refs ───
  const jumpMapRef     = useRef(new Map());
  const jumpedRef      = useRef(new Set());
  const lastJumpMsRef  = useRef(0);
  const jumpLockRef    = useRef(false);
  const graphDataRef   = useRef(graphData);
  const playingRef     = useRef(false);
  const rafRef         = useRef(null);

  // ─── React state ───
  const [playing,          setPlaying]          = useState(false);
  const [currentTime,      setCurrentTime]      = useState(0);
  const [duration,         setDuration]         = useState(0);
  const [ready,            setReady]            = useState(false);
  const [cooldownUntil,    setCooldownUntil]    = useState(0);
  const [audioInitialized, setAudioInitialized] = useState(false);

  useEffect(() => { graphDataRef.current = graphData; }, [graphData]);
  const updatePlaying = (v) => { playingRef.current = v; setPlaying(v); };

  // ─── Helpers ───

  /** Current song position from the AudioContext high-res clock. */
  const getPosition = () => {
    const ctx = audioCtxRef.current;
    const buf = audioBufferRef.current;
    if (!ctx || !buf || buf.duration <= 0) return pausedPosRef.current;
    if (!playingRef.current) return pausedPosRef.current;
    const elapsed = Math.max(0, ctx.currentTime - startedAtRef.current);
    const pos = songOffsetRef.current + elapsed;
    return pos >= buf.duration ? pos % buf.duration : pos;
  };

  /** Stop and disconnect the active BufferSourceNode safely. */
  const stopSource = () => {
    const src = sourceRef.current;
    if (!src) return;
    try { src.onended = null; } catch (_) {}
    try { src.stop(); } catch (_) {}
    try { src.disconnect(); } catch (_) {}
    sourceRef.current = null;
  };

  /** Create a new BufferSourceNode at the given song offset and start it. */
  const createSource = (offset) => {
    const ctx  = audioCtxRef.current;
    const buf  = audioBufferRef.current;
    const gain = gainRef.current;
    if (!ctx || !buf || !gain) return;

    stopSource();

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop   = false;
    src.connect(gain);

    src.onended = () => {
      // Only re-loop if this source is still the active one and we're playing
      if (sourceRef.current === src && playingRef.current) {
        createSource(0);
      }
    };

    src.start(0, offset);
    sourceRef.current    = src;
    startedAtRef.current = ctx.currentTime;
    songOffsetRef.current = offset;
  };

  // ─── Initialize AudioContext (must be called from user gesture) ───
  const initAudio = useCallback(async () => {
    if (audioCtxRef.current) return;
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    gain.gain.value = userGainRef.current;
    gain.connect(ctx.destination);
    audioCtxRef.current = ctx;
    gainRef.current     = gain;
    await ctx.resume();
    setAudioInitialized(true);
  }, []);

  // ─── Build jump map from graph edges ───
  const prevGraphIdRef = useRef(null);
  useEffect(() => {
    const id = graphData ? (graphData.filename || "") + (graphData.beat_count || 0) : null;
    const isNew = id !== prevGraphIdRef.current;
    prevGraphIdRef.current = id;

    const map = new Map();
    if (graphData?.beats && graphData?.edges) {
      graphData.edges.filter(isPurple).forEach(e => {
        const ex = map.get(e.source);
        if (!ex || e.score > ex.score) {
          const tgt = graphData.beats[e.target];
          if (tgt) map.set(e.source, { time: tgt.time, score: e.score });
        }
      });
    }
    jumpMapRef.current = map;
    if (isNew) {
      jumpedRef.current.clear();
      lastJumpMsRef.current = 0;
      jumpLockRef.current   = false;
      setCooldownUntil(0);
    }
  }, [graphData]);

  // ─── Load buffer when audioUrl changes (requires AudioContext) ───
  useEffect(() => {
    if (!audioUrl || !audioCtxRef.current) return;
    let cancelled = false;

    // Full teardown of any previous track
    stopSource();
    audioBufferRef.current = null;
    pausedPosRef.current   = 0;
    lastJumpMsRef.current  = 0;
    jumpLockRef.current    = false;
    updatePlaying(false);
    setCurrentTime(0); setDuration(0); setReady(false); setCooldownUntil(0);

    fetch(audioUrl)
      .then(r => r.arrayBuffer())
      .then(ab => audioCtxRef.current.decodeAudioData(ab))
      .then(decoded => {
        if (cancelled) return;
        audioBufferRef.current = decoded;
        setDuration(decoded.duration);
        setReady(true);
      })
      .catch(err => console.error("[Jukebox] buffer decode:", err));

    return () => {
      cancelled = true;
      stopSource();
      audioBufferRef.current = null;
      jumpLockRef.current    = false;
    };
  }, [audioUrl, audioInitialized]);

  // ─── rAF loop: position tracking + jump evaluation ───
  useEffect(() => {
    if (!playing) return;

    const tick = () => {
      if (!playingRef.current) return;

      const pos = getPosition();
      setCurrentTime(pos);

      // ── Jump evaluation ──
      if (!jumpLockRef.current) {
        const gd = graphDataRef.current;
        if (gd?.beats && jumpMapRef.current.size > 0 && audioBufferRef.current) {
          const nowMs = performance.now();
          if (nowMs - lastJumpMsRef.current >= JUMP_COOLDOWN_MS) {
            const beats = gd.beats;

            let active = -1;
            for (let i = beats.length - 1; i >= 0; i--) {
              if (beats[i].time <= pos) { active = i; break; }
            }

            if (active >= 0 && !jumpedRef.current.has(active)) {
              const jump = jumpMapRef.current.get(active);
              if (jump) {
                const beat    = beats[active];
                const beatEnd = active + 1 < beats.length
                  ? beats[active + 1].time
                  : beat.time + 60 / (gd.tempo || 120);
                const tte = beatEnd - pos;

                if (tte <= JUMP_LOOKAHEAD_S && tte >= 0) {
                  // ═══════════════════════════════════════════════════
                  //  JUMP — Hard-switch at the beat boundary
                  // ═══════════════════════════════════════════════════
                  jumpLockRef.current = true;

                  jumpedRef.current.add(active);
                  const tgtBeat = beats.findIndex(b => Math.abs(b.time - jump.time) < 0.05);
                  if (tgtBeat >= 0) jumpedRef.current.add(tgtBeat);

                  lastJumpMsRef.current = nowMs;
                  setCooldownUntil(nowMs + JUMP_COOLDOWN_MS);

                  try {
                    const ctx  = audioCtxRef.current;
                    const buf  = audioBufferRef.current;
                    const gain = gainRef.current;
                    const oldSrc = sourceRef.current;

                    // Calculate the exact AudioContext time of the beat boundary
                    const switchTime = ctx.currentTime + Math.max(0, tte);

                    // Detach the old source's loop handler and schedule its stop
                    if (oldSrc) {
                      try { oldSrc.onended = null; } catch (_) {}
                      try { oldSrc.stop(switchTime); } catch (_) {}
                    }

                    // Create new source scheduled to start at the exact same instant
                    const newSrc = ctx.createBufferSource();
                    newSrc.buffer = buf;
                    newSrc.loop   = false;
                    newSrc.connect(gain);

                    newSrc.onended = () => {
                      if (sourceRef.current === newSrc && playingRef.current) {
                        createSource(0);
                      }
                    };

                    newSrc.start(switchTime, jump.time);

                    // Update refs — position calc uses max(0, ctx.currentTime - startedAt)
                    // so before switchTime it returns songOffset (the target), which is
                    // correct for UI display (graph marker snaps to jump target immediately)
                    sourceRef.current     = newSrc;
                    startedAtRef.current  = switchTime;
                    songOffsetRef.current = jump.time;
                  } catch (err) {
                    console.warn("[Jukebox] jump failed:", err);
                  }

                  jumpLockRef.current = false;
                }
              }
            }
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    };
  }, [playing]);

  // ─── Play / Pause toggle ───
  const togglePlay = useCallback(async () => {
    if (!audioBufferRef.current || !audioCtxRef.current) return;
    await audioCtxRef.current.resume();
    if (playing) {
      pausedPosRef.current = getPosition();
      stopSource();
      updatePlaying(false);
    } else {
      createSource(pausedPosRef.current || 0);
      updatePlaying(true);
    }
  }, [playing]);

  // ─── Volume ───
  const setVolume = useCallback(v => {
    userGainRef.current = v;
    if (gainRef.current) gainRef.current.gain.value = v;
  }, []);

  return { playing, currentTime, duration, ready, cooldownUntil, audioInitialized, initAudio, togglePlay, setVolume };
}

export default function InfiniteJukebox() {
  const { tracks: libraryTracks } = useLibrary();
  const [file,         setFile]         = useState(null);
  const [mode,         setMode]         = useState("idle");
  const [audioUrl,     setAudioUrl]     = useState(null);
  const [dlUrl,        setDlUrl]        = useState(null);
  const [dlName,       setDlName]       = useState("loop.wav");
  const [volume,       setVolumeState]  = useState(0.8);
  const [graphData,    setGraphData]    = useState(null);
  const [activeTab,    setActiveTab]    = useState("loop");
  const [loopLoading,  setLoopLoading]  = useState(false);
  const [graphLoading, setGraphLoading] = useState(false);
  const [loopError,    setLoopError]    = useState("");
  const [graphError,   setGraphError]   = useState("");

  const abortLoopRef  = useRef(null);
  const abortGraphRef = useRef(null);

  const { playing, currentTime, duration, ready, cooldownUntil, audioInitialized, initAudio, togglePlay, setVolume } =
    useWebAudioPlayer(audioUrl, graphData);

  const purpleCount = useMemo(() =>
    graphData?.edges ? graphData.edges.filter(isPurple).length : 0,
  [graphData]);

  const runUpload = useCallback(async f => {
    abortLoopRef.current?.abort();
    setLoopLoading(true); setLoopError(""); setAudioUrl(null);
    const ctrl = new AbortController();
    abortLoopRef.current = ctrl;
    try {
      const body = new FormData(); body.append("file", f);
      const res  = await fetch(`${API}/upload`, { method: "POST", body, signal: ctrl.signal });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || res.statusText); }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const m    = (res.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/);
      setAudioUrl(url); setDlUrl(url);
      setDlName(m ? m[1] : `${f.name.replace(/\.[^.]+$/, "")}_loop.wav`);
    } catch (e) { if (e.name !== "AbortError") setLoopError(e.message); }
    finally { setLoopLoading(false); }
  }, []);

  const runAnalyze = useCallback(async f => {
    abortGraphRef.current?.abort();
    setGraphLoading(true); setGraphError(""); setGraphData(null);
    const ctrl = new AbortController();
    abortGraphRef.current = ctrl;
    try {
      const body = new FormData(); body.append("file", f);
      const res  = await fetch(`${API}/analyze`, { method: "POST", body, signal: ctrl.signal });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || res.statusText); }
      setGraphData(await res.json());
    } catch (e) { if (e.name !== "AbortError") setGraphError(e.message); }
    finally { setGraphLoading(false); }
  }, []);

  const onFile = useCallback(f => {
    setFile(f); setMode("ready"); setLoopError(""); setGraphError("");
    runUpload(f); runAnalyze(f);
  }, [runUpload, runAnalyze]);

  const reset = useCallback(() => {
    abortLoopRef.current?.abort(); abortGraphRef.current?.abort();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setFile(null); setMode("idle"); setAudioUrl(null); setDlUrl(null);
    setGraphData(null); setLoopLoading(false); setGraphLoading(false);
    setLoopError(""); setGraphError(""); setActiveTab("loop");
  }, [audioUrl]);

  const handleVol = v => { setVolumeState(v); setVolume(v); };

  if (mode === "idle") {
    return (
      <div style={{ maxWidth: "540px" }}>
        <h2 style={{ fontSize: "22px", fontWeight: 700, color: "#f9fafb", margin: "0 0 8px", letterSpacing: "-0.3px" }}>
          Make any song loop forever
        </h2>
        <p style={{ fontSize: "13px", color: "#6b7280", lineHeight: 1.6, margin: "0 0 24px" }}>
          Drop in a track. The engine analyses its beat structure, builds a self-similarity
          graph, and finds natural loop points — so the song plays endlessly without feeling
          repetitive.
        </p>
        <AudioDropzone onFile={onFile} label="Drop a track to analyse" accentColor="emerald" />

        {libraryTracks.length > 0 && (
          <div style={{ marginTop: "20px" }}>
            <div style={{ ...S.lbl, marginBottom: "10px" }}>Or pick from your library</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              {libraryTracks.map(t => (
                <div key={t.id} onClick={() => onFile(t.file)} style={{
                  display: "flex", alignItems: "center", gap: "10px",
                  padding: "9px 12px", borderRadius: "9px", cursor: "pointer",
                  background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)",
                  transition: "background 0.12s",
                }}
                onMouseEnter={e => e.currentTarget.style.background = "rgba(16,185,129,0.07)"}
                onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.02)"}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                  </svg>
                  <span style={{ flex: 1, fontSize: "13px", color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.name}
                  </span>
                  {t.duration && (
                    <span style={{ fontSize: "10px", color: "#374151", fontFamily: "'JetBrains Mono', monospace" }}>
                      {Math.floor(t.duration / 60)}:{String(Math.floor(t.duration % 60)).padStart(2, "0")}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {libraryTracks.length === 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "7px", marginTop: "14px" }}>
            {["Beat detection", "Self-similarity matrix", "Structural jump graph", "Micro-crossfades"].map(t => (
              <span key={t} style={{
                fontSize: "11px", color: "#374151",
                border: "1px solid rgba(255,255,255,0.07)",
                borderRadius: "999px", padding: "3px 10px",
              }}>{t}</span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: "660px", display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
        <div style={{ minWidth: 0 }}>
          <div style={S.lbl}>Track loaded</div>
          <div style={{ fontSize: "14px", fontWeight: 500, color: "#e5e7eb", marginTop: "3px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {file?.name}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          {graphData && (
            <span style={{
              fontSize: "11px", color: "#10b981",
              background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.18)",
              borderRadius: "999px", padding: "3px 10px", ...S.mono,
            }}>
              {graphData.beats.length}b · {purpleCount} jumps
            </span>
          )}
          <button onClick={reset} style={{
            display: "flex", alignItems: "center", gap: "5px",
            fontSize: "12px", color: "#6b7280", background: "transparent",
            border: "1px solid rgba(255,255,255,0.07)", borderRadius: "8px",
            padding: "5px 10px", cursor: "pointer",
          }}
          onMouseEnter={e => e.currentTarget.style.color = "#d1d5db"}
          onMouseLeave={e => e.currentTarget.style.color = "#6b7280"}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.51"/>
            </svg>
            New file
          </button>
        </div>
      </div>

      <div style={{
        display: "flex", gap: "2px",
        background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: "10px", padding: "3px", width: "fit-content",
      }}>
        {[["loop", "Seamless Loop"], ["graph", "Jump Graph"]].map(([id, label]) => (
          <button key={id} onClick={() => setActiveTab(id)} style={{
            padding: "6px 16px", borderRadius: "7px", border: "none",
            fontSize: "12px", fontWeight: 500, cursor: "pointer", transition: "all 0.12s",
            background: activeTab === id ? "rgba(16,185,129,0.12)" : "transparent",
            color: activeTab === id ? "#6ee7b7" : "#6b7280",
            outline: activeTab === id ? "1px solid rgba(16,185,129,0.2)" : "none",
            outlineOffset: "-1px",
          }}>{label}</button>
        ))}
      </div>

      {/* Loop tab */}
      <div style={{ display: activeTab === "loop" ? "block" : "none" }}>
        <div style={{ ...S.card, position: "relative" }}>
          {!audioInitialized && !loopLoading && !loopError && audioUrl && (
            <AudioInitOverlay onInit={initAudio} />
          )}
          {loopLoading && <ProcessingOverlay stages={UPLOAD_STAGES} accentColor="emerald" />}
          {loopError && (
            <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: "10px", padding: "16px", textAlign: "center" }}>
              <p style={{ color: "#f87171", fontSize: "13px", marginBottom: "4px" }}>Loop generation failed</p>
              <p style={{ color: "#9ca3af", fontSize: "11px", marginBottom: "12px" }}>{loopError}</p>
              <button onClick={() => file && runUpload(file)} style={{ fontSize: "12px", color: "#f87171", background: "transparent", border: "1px solid rgba(239,68,68,0.3)", borderRadius: "7px", padding: "5px 12px", cursor: "pointer" }}>Retry</button>
            </div>
          )}
          {!loopLoading && !loopError && audioUrl && (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div style={{ ...S.inner, padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                {ready ? (
                  <>
                    <div>
                      <div style={{ fontSize: "12px", color: "#9ca3af" }}>Ready · loop mode</div>
                      {purpleCount > 0 && <div style={{ fontSize: "11px", color: "#8b5cf6", marginTop: "3px" }}>{purpleCount} jump arc{purpleCount !== 1 ? "s" : ""} · {JUMP_COOLDOWN_MS / 1000}s cooldown</div>}
                    </div>
                    <div style={{ fontSize: "13px", color: "#10b981", ...S.mono }}>{fmt(currentTime)} / {fmt(duration)}</div>
                  </>
                ) : (
                  <div style={{ fontSize: "12px", color: "#6b7280" }}>Loading audio buffer…</div>
                )}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <button onClick={togglePlay} disabled={!ready} style={{
                  width: "40px", height: "40px", borderRadius: "50%",
                  background: ready ? "#10b981" : "#1f2937", border: "none",
                  cursor: ready ? "pointer" : "not-allowed",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: ready ? "#022c22" : "#4b5563",
                  boxShadow: ready ? "0 0 20px rgba(16,185,129,0.3)" : "none",
                  transition: "all 0.15s", flexShrink: 0,
                }}>
                  {playing
                    ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                    : <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
                  }
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: "7px", flex: 1 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="2" strokeLinecap="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    {volume > 0.3 && <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>}
                    {volume > 0.7 && <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>}
                  </svg>
                  <input type="range" min="0" max="1" step="0.01" value={volume}
                    onChange={e => handleVol(+e.target.value)}
                    style={{ flex: 1, accentColor: "#10b981", cursor: "pointer" }}
                  />
                </div>
                {dlUrl && (
                  <a href={dlUrl} download={dlName} style={{
                    display: "flex", alignItems: "center", gap: "5px", fontSize: "11px",
                    color: "#6b7280", textDecoration: "none",
                    border: "1px solid rgba(255,255,255,0.08)", borderRadius: "8px", padding: "6px 10px",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = "#10b981"; e.currentTarget.style.borderColor = "rgba(16,185,129,0.3)"; }}
                  onMouseLeave={e => { e.currentTarget.style.color = "#6b7280"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    WAV
                  </a>
                )}
              </div>

              {playing && cooldownUntil > 0 && <CooldownPill cooldownUntil={cooldownUntil} />}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
                {[
                  { lbl: "Duration",  val: fmt(duration), col: "#10b981" },
                  { lbl: "Engine",    val: "Tone.js" },
                  { lbl: "Cooldown",  val: `${JUMP_COOLDOWN_MS / 1000}s`, col: "#8b5cf6" },
                ].map(({ lbl, val, col }) => (
                  <div key={lbl} style={{ ...S.inner, padding: "10px 14px", textAlign: "center" }}>
                    <div style={S.lbl}>{lbl}</div>
                    <div style={{ fontSize: "13px", fontWeight: 600, color: col || "#e5e7eb", marginTop: "4px", ...S.mono }}>{val}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {!loopLoading && !loopError && !audioUrl && (
            <div style={{ padding: "24px", textAlign: "center" }}>
              <p style={{ fontSize: "13px", color: "#6b7280" }}>Generating loop…</p>
              <p style={{ fontSize: "11px", color: "#4b5563", marginTop: "5px" }}>Switch to the Graph tab to see the beat structure while you wait.</p>
            </div>
          )}
        </div>
      </div>

      {/* Graph tab */}
      <div style={{ display: activeTab === "graph" ? "block" : "none" }}>
        <div style={S.card}>
          {graphLoading && <ProcessingOverlay stages={ANALYZE_STAGES} accentColor="emerald" />}
          {graphError && (
            <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: "10px", padding: "16px", textAlign: "center" }}>
              <p style={{ color: "#f87171", fontSize: "13px", marginBottom: "4px" }}>Analysis failed</p>
              <p style={{ color: "#9ca3af", fontSize: "11px", marginBottom: "12px" }}>{graphError}</p>
              <button onClick={() => file && runAnalyze(file)} style={{ fontSize: "12px", color: "#f87171", background: "transparent", border: "1px solid rgba(239,68,68,0.3)", borderRadius: "7px", padding: "5px 12px", cursor: "pointer" }}>Retry</button>
            </div>
          )}
          {!graphLoading && !graphError && graphData && (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "#e5e7eb" }}>Jump Graph</div>
                  <div style={{ fontSize: "11px", color: "#6b7280", marginTop: "4px" }}>
                    <span style={{ color: "#a78bfa" }}>Purple arcs</span> fire audio jumps ·{" "}
                    <span style={{ color: "#34d399", opacity: 0.7 }}>green lines</span> are beat markers only
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: "14px", color: "#10b981", fontWeight: 600, ...S.mono }}>{graphData.tempo?.toFixed(1)}</div>
                  <div style={{ fontSize: "10px", color: "#4b5563" }}>BPM</div>
                </div>
              </div>

              <div style={{ ...S.inner, position: "relative", width: "100%", height: "180px", overflow: "hidden" }}>
                <JumpGraph
                  beats={graphData.beats}
                  edges={graphData.edges}
                  currentTime={currentTime}
                  duration={graphData.song_duration_s ?? duration}
                />
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "14px", fontSize: "10px", color: "#4b5563" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                  <span style={{ width: "12px", height: "1px", background: "rgba(139,92,246,0.6)", display: "inline-block" }}/>
                  purple — fires jump
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                  <span style={{ width: "12px", height: "1px", background: "rgba(52,211,153,0.3)", display: "inline-block" }}/>
                  green — visual only
                </span>
              </div>

              {audioUrl && !playing && (
                <p style={{ fontSize: "11px", color: "#374151", textAlign: "center" }}>
                  Hit play on the Loop tab to hear the jumps in action.
                </p>
              )}

              <div>
                <div style={{ ...S.lbl, marginBottom: "8px" }}>Top jump edges</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                  {[...graphData.edges].sort((a, b) => b.score - a.score).slice(0, 8).map((e, i) => {
                    const s = graphData.beats[e.source], t = graphData.beats[e.target];
                    const p = isPurple(e);
                    return (
                      <div key={i} style={{
                        display: "flex", alignItems: "center", gap: "10px",
                        padding: "7px 10px", borderRadius: "8px", fontSize: "11px",
                        background: p ? "rgba(139,92,246,0.07)" : "rgba(255,255,255,0.025)",
                        border: `1px solid ${p ? "rgba(139,92,246,0.18)" : "rgba(255,255,255,0.04)"}`,
                        ...S.mono,
                      }}>
                        <span style={{ color: p ? "#a78bfa" : "#10b981", width: "20px", flexShrink: 0 }}>#{i + 1}</span>
                        <span style={{ color: s?.beat_phase === 0 ? "#6ee7b7" : "#6b7280" }}>{s ? fmt(s.time) : "—"}</span>
                        <span style={{ color: "#374151" }}>→</span>
                        <span style={{ color: t?.beat_phase === 0 ? "#6ee7b7" : "#6b7280" }}>{t ? fmt(t.time) : "—"}</span>
                        {p && <span style={{ fontSize: "9px", color: "#a78bfa", border: "1px solid rgba(139,92,246,0.4)", borderRadius: "4px", padding: "1px 5px" }}>jump</span>}
                        <span style={{ marginLeft: "auto", color: p ? "#c4b5fd" : "#10b981" }}>{e.score.toFixed(3)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          {!graphLoading && !graphError && !graphData && (
            <div style={{ padding: "24px", textAlign: "center" }}>
              <p style={{ fontSize: "13px", color: "#6b7280" }}>Analysing structure…</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
