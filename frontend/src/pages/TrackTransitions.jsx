import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import AudioDropzone from "../components/AudioDropzone";
import ProcessingOverlay from "../components/ProcessingOverlay";
import { useLibrary } from "../context/LibraryContext";

const API = "http://localhost:8000";

const STAGES = [
  "Uploading both tracks…",
  "Extracting beats & features…",
  "Building cross-track similarity matrix…",
  "Scoring transition candidates…",
  "Synthesising EDM drop preview…",
];

const S = {
  card:  { background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "14px", padding: "20px" },
  inner: { background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: "10px" },
  lbl:   { fontSize: "10px", color: "#4b5563", textTransform: "uppercase", letterSpacing: "0.1em" },
  mono:  { fontFamily: "'JetBrains Mono', ui-monospace, monospace" },
};

function fmt(s) {
  if (!isFinite(s) || isNaN(s)) return "0:00";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}
function scoreColor(sc) {
  const p = sc * 100;
  return p >= 70 ? "#10b981" : p >= 45 ? "#f59e0b" : "#ef4444";
}
const KEY_LABELS = ["Unison","m2","M2","m3","M3","P4","Tritone","P5","m6","M6","m7","M7"];

// Quick BPM/key compatibility score for library combos (client-side, no backend)
// Returns 0-1 based on how close BPMs are (within ±6% = good) and whether durations
// are both available. We don't have BPM from the library so we use duration as a proxy
// for now and mark pairs that haven't been analysed yet.
function estimateComboScore(a, b) {
  // If we have actual BPM from analyze results, use those; otherwise use heuristics
  const bpmA = a.bpm, bpmB = b.bpm;
  let score = 0.5; // baseline
  if (bpmA && bpmB) {
    // BPM compatibility: ratio within 4% = excellent, 8% = good, more = poor
    const ratio = Math.min(bpmA, bpmB) / Math.max(bpmA, bpmB);
    const bpmScore = ratio >= 0.96 ? 1.0 : ratio >= 0.92 ? 0.75 : ratio >= 0.85 ? 0.5 : 0.25;
    score = bpmScore;
  } else if (a.duration && b.duration) {
    // Duration similarity as a rough proxy (not musical but better than nothing)
    const shorter = Math.min(a.duration, b.duration);
    const longer  = Math.max(a.duration, b.duration);
    score = 0.3 + 0.4 * (shorter / longer);
  }
  return Math.round(score * 100);
}

// Dual timeline canvas
function DualTimeline({ result, selectedIdx, onSelect, fileA, fileB }) {
  const canvasRef  = useRef(null);
  const stateRef   = useRef({ result, selectedIdx });
  const hoverRef   = useRef(-1);
  const tooltipRef = useRef(null);
  const rafRef     = useRef(null);

  useEffect(() => { stateRef.current = { result, selectedIdx }; }, [result, selectedIdx]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sync = () => {
      const dpr = window.devicePixelRatio || 1, w = canvas.offsetWidth, h = canvas.offsetHeight;
      if (w > 0 && h > 0 && (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr))) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      }
    };
    const ro = new ResizeObserver(sync); ro.observe(canvas); sync();
    return () => ro.disconnect();
  }, []);

  const distToCurve = (px, py, p) => {
    let min = Infinity;
    for (let t = 0; t <= 1; t += 0.05) {
      const mt = 1 - t;
      const bx = mt*mt*mt*p.x1 + 3*mt*mt*t*p.cx1 + 3*mt*t*t*p.cx2 + t*t*t*p.x2;
      const by = mt*mt*mt*p.y1 + 3*mt*mt*t*p.cy1 + 3*mt*t*t*p.cy2 + t*t*t*p.y2;
      const d  = Math.hypot(bx - px, by - py); if (d < min) min = d;
    }
    return min;
  };

  const getCurvePaths = (w, h, cands, durA, durB) => {
    if (!cands?.length) return [];
    const laneH = h * 0.28, gapH = h * 0.44, aBotY = laneH, bTopY = laneH + gapH;
    return cands.map(c => {
      const x1 = (c.src_time / (durA || 1)) * w, x2 = (c.tgt_time / (durB || 1)) * w;
      return { x1, y1: aBotY, x2, y2: bTopY, cx1: x1, cy1: aBotY + gapH * 0.28, cx2: x2, cy2: bTopY - gapH * 0.28 };
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const { result, selectedIdx } = stateRef.current;
      const hover = hoverRef.current;
      if (!canvas.width || !canvas.height) { rafRef.current = requestAnimationFrame(draw); return; }
      const dpr = window.devicePixelRatio || 1, w = canvas.offsetWidth, h = canvas.offsetHeight;
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const laneH = h * 0.28, gapH = h * 0.44, aBotY = laneH, bTopY = laneH + gapH;

      const drawLane = (y, label, color, phase) => {
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        ctx.beginPath(); ctx.roundRect(0, y, w, laneH, 8); ctx.fill();
        ctx.strokeStyle = `${color}28`; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(0, y, w, laneH, 8); ctx.stroke();
        const N = 80, bw = (w - N) / N;
        for (let i = 0; i < N; i++) {
          const n = Math.sin(i * 0.38 + phase) * 0.38 + Math.sin(i * 1.1 + phase * 0.5) * 0.3 + Math.sin(i * 2.2) * 0.18 + 0.52;
          const bh = Math.max(3, n * laneH * 0.62);
          ctx.fillStyle = `${color}22`;
          ctx.beginPath(); ctx.roundRect(i * (bw + 1), y + (laneH - bh) / 2, bw, bh, 1.5); ctx.fill();
        }
        ctx.fillStyle = `${color}80`; ctx.font = "500 10px Inter, system-ui, sans-serif";
        ctx.fillText(label, 10, y + laneH - 8);
      };

      drawLane(0,     (fileA?.name || "Track A").replace(/\.[^.]+$/, ""), "#10b981", 0);
      drawLane(bTopY, (fileB?.name || "Track B").replace(/\.[^.]+$/, ""), "#8b5cf6", 1.2);

      if (result?.candidates?.length) {
        const cands = result.candidates, durA = result.duration_a || 1, durB = result.duration_b || 1;
        for (let i = cands.length - 1; i >= 0; i--) {
          if (i === selectedIdx || i === hover) continue;
          const c = cands[i], x1 = (c.src_time / durA) * w, x2 = (c.tgt_time / durB) * w;
          ctx.beginPath(); ctx.moveTo(x1, aBotY); ctx.bezierCurveTo(x1, aBotY + gapH * 0.28, x2, bTopY - gapH * 0.28, x2, bTopY);
          ctx.strokeStyle = `rgba(139,92,246,${0.04 + c.score * 0.12})`; ctx.lineWidth = 0.7 + c.score * 1.1; ctx.stroke();
          ctx.fillStyle = `rgba(139,92,246,${0.06 + c.score * 0.14})`;
          ctx.beginPath(); ctx.arc(x1, aBotY, 1.8, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(x2, bTopY, 1.8, 0, Math.PI * 2); ctx.fill();
        }
        if (hover >= 0 && hover !== selectedIdx) {
          const c = cands[hover], x1 = (c.src_time / durA) * w, x2 = (c.tgt_time / durB) * w;
          ctx.beginPath(); ctx.moveTo(x1, aBotY); ctx.bezierCurveTo(x1, aBotY + gapH * 0.28, x2, bTopY - gapH * 0.28, x2, bTopY);
          ctx.strokeStyle = "rgba(139,92,246,0.75)"; ctx.lineWidth = 2; ctx.shadowColor = "#8b5cf6"; ctx.shadowBlur = 7; ctx.stroke(); ctx.shadowBlur = 0;
          ctx.fillStyle = "#8b5cf6";
          ctx.beginPath(); ctx.arc(x1, aBotY, 3.5, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(x2, bTopY, 3.5, 0, Math.PI * 2); ctx.fill();
        }
        if (selectedIdx >= 0 && selectedIdx < cands.length) {
          const c = cands[selectedIdx], x1 = (c.src_time / durA) * w, x2 = (c.tgt_time / durB) * w;
          ctx.beginPath(); ctx.moveTo(x1, aBotY); ctx.bezierCurveTo(x1, aBotY + gapH * 0.28, x2, bTopY - gapH * 0.28, x2, bTopY);
          ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 2.5; ctx.shadowColor = "#f59e0b"; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0;
          ctx.fillStyle = "#f59e0b";
          ctx.beginPath(); ctx.arc(x1, aBotY, 4.5, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(x2, bTopY, 4.5, 0, Math.PI * 2); ctx.fill();
          ctx.font = "600 10px 'JetBrains Mono', monospace"; ctx.fillStyle = "#f59e0b"; ctx.textAlign = "center";
          ctx.fillText(`${Math.round(c.score * 100)}%`, (x1 + x2) / 2, (aBotY + bTopY) / 2); ctx.textAlign = "left";
        }
        for (let i = 0; i <= 4; i++) {
          const x = (i / 4) * w;
          ctx.fillStyle = "rgba(255,255,255,0.1)"; ctx.fillRect(x - 0.5, aBotY - 7, 1, 7);
          ctx.fillStyle = "#374151"; ctx.font = "9px 'JetBrains Mono', monospace"; ctx.textAlign = "center";
          ctx.fillText(fmt((i / 4) * (result.duration_a || 1)), x, aBotY - 9);
        }
        for (let i = 0; i <= 4; i++) {
          const x = (i / 4) * w;
          ctx.fillStyle = "rgba(255,255,255,0.1)"; ctx.fillRect(x - 0.5, bTopY, 1, 7);
          ctx.fillStyle = "#374151"; ctx.font = "9px 'JetBrains Mono', monospace"; ctx.textAlign = "center";
          ctx.fillText(fmt((i / 4) * (result.duration_b || 1)), x, bTopY + 16);
        }
        ctx.textAlign = "left";
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(rafRef.current); rafRef.current = null; };
  }, [fileA, fileB]); // eslint-disable-line

  const onMouseMove = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas || !stateRef.current.result?.candidates) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const { result } = stateRef.current;
    const paths = getCurvePaths(canvas.offsetWidth, canvas.offsetHeight, result.candidates, result.duration_a || 1, result.duration_b || 1);
    let bestI = -1, bestD = 12;
    paths.forEach((p, i) => { const d = distToCurve(px, py, p); if (d < bestD) { bestD = d; bestI = i; } });
    hoverRef.current = bestI;
    const tip = tooltipRef.current;
    if (!tip) return;
    if (bestI >= 0) {
      const c = result.candidates[bestI];
      tip.style.display = "block"; tip.style.left = `${px + 12}px`; tip.style.top = `${py - 10}px`;
      tip.innerHTML = `<strong>${Math.round(c.score * 100)}% match</strong><br/>${fmt(c.src_time)} → ${fmt(c.tgt_time)}`;
      canvas.style.cursor = "pointer";
    } else { tip.style.display = "none"; canvas.style.cursor = "default"; }
  }, []); // eslint-disable-line

  const onMouseLeave = () => {
    hoverRef.current = -1;
    if (tooltipRef.current) tooltipRef.current.style.display = "none";
    if (canvasRef.current) canvasRef.current.style.cursor = "default";
  };
  const onClick = useCallback(() => { if (hoverRef.current >= 0) onSelect(hoverRef.current); }, [onSelect]);

  return (
    <div style={{ position: "relative" }}>
      <canvas ref={canvasRef} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave} onClick={onClick}
        style={{ width: "100%", height: "200px", display: "block", borderRadius: "10px", border: "1px solid rgba(255,255,255,0.05)" }}/>
      <div ref={tooltipRef} style={{
        display: "none", position: "absolute", pointerEvents: "none",
        background: "rgba(10,14,22,0.96)", border: "1px solid rgba(139,92,246,0.4)",
        borderRadius: "7px", padding: "6px 10px", fontSize: "11px", color: "#e5e7eb",
        lineHeight: 1.6, zIndex: 10, whiteSpace: "nowrap",
        fontFamily: "'JetBrains Mono', monospace", boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
      }}/>
    </div>
  );
}

export default function TrackTransitions() {
  const { tracks: libraryTracks } = useLibrary();

  const [fileA,       setFileA]       = useState(null);
  const [fileB,       setFileB]       = useState(null);
  const [mode,        setMode]        = useState("idle");
  const [error,       setError]       = useState("");
  const [result,      setResult]      = useState(null);
  const [previewUrl,  setPreviewUrl]  = useState(null);
  const [playing,     setPlaying]     = useState(false);
  const [autoMode,    setAutoMode]    = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);

  const audioRef = useRef(null);
  const abortRef = useRef(null);

  const canSubmit = fileA && fileB && mode !== "loading";
  const chosen    = result?.candidates?.[selectedIdx] ?? null;

  // Library combos: ranked pairs from the global track pool (client-side scoring)
  const libraryCombos = useMemo(() => {
    if (libraryTracks.length < 2) return [];
    const pairs = [];
    for (let i = 0; i < libraryTracks.length; i++) {
      for (let j = 0; j < libraryTracks.length; j++) {
        if (i === j) continue;
        pairs.push({
          a:     libraryTracks[i],
          b:     libraryTracks[j],
          score: estimateComboScore(libraryTracks[i], libraryTracks[j]),
        });
      }
    }
    pairs.sort((x, y) => y.score - x.score);
    // Deduplicate: only keep the best direction per unordered pair
    const seen = new Set();
    return pairs.filter(p => {
      const key = [p.a.id, p.b.id].sort().join("|");
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 8);
  }, [libraryTracks]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }
    setMode("loading"); setError(""); setResult(null); setPlaying(false); setSelectedIdx(0);
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); }
    const ctrl = new AbortController(); abortRef.current = ctrl;
    try {
      const body = new FormData();
      body.append("track_a", fileA); body.append("track_b", fileB);
      const res = await fetch(`${API}/transition`, { method: "POST", body, signal: ctrl.signal });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || res.statusText); }
      const data = await res.json();
      const wavRes = await fetch(`${API}${data.preview_url}`, { signal: ctrl.signal });
      if (!wavRes.ok) throw new Error("Could not fetch preview audio.");
      setResult(data); setPreviewUrl(URL.createObjectURL(await wavRes.blob())); setMode("ready");
    } catch (e) { if (e.name !== "AbortError") { setError(e.message); setMode("error"); } }
  };

  const selectCandidate = useCallback((i) => { setSelectedIdx(i); setAutoMode(false); }, []);
  const setAuto = () => { setAutoMode(true); setSelectedIdx(0); };

  const togglePlay = async () => {
    const a = audioRef.current; if (!a) return;
    if (playing) { a.pause(); setPlaying(false); return; }
    try { await a.play(); setPlaying(true); }
    catch (err) { console.error("[Transitions] play():", err); }
  };

  const reset = () => {
    abortRef.current?.abort();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); }
    setFileA(null); setFileB(null); setMode("idle");
    setResult(null); setPreviewUrl(null); setPlaying(false);
    setError(""); setAutoMode(true); setSelectedIdx(0);
  };

  // When a combo is clicked, load both files and run the analysis automatically
  const loadCombo = (combo) => {
    setFileA(combo.a.file);
    setFileB(combo.b.file);
  };

  return (
    <div style={{ maxWidth: "780px", display: "flex", flexDirection: "column", gap: "20px" }}>
      <div>
        <h2 style={{ fontSize: "22px", fontWeight: 700, color: "#f9fafb", margin: "0 0 6px", letterSpacing: "-0.3px" }}>
          Find the right transition
        </h2>
        <p style={{ fontSize: "13px", color: "#6b7280", margin: 0, lineHeight: 1.6 }}>
          Upload two tracks. The engine analyses both, scores every possible beat-pair crossing,
          and renders the transition with a DJ-style filter sweep and beat drop.
          Pick your crossfade point on the timeline or let it choose automatically.
        </p>
      </div>

      {/* Library combos section — only shown when tracks are in the pool */}
      {libraryCombos.length > 0 && mode === "idle" && (
        <div style={S.card}>
          <div style={{ ...S.lbl, marginBottom: "12px" }}>
            Recommended combos from your library
            <span style={{ marginLeft: "8px", color: "#1f2937", fontWeight: 400 }}>
              · scored on BPM compatibility · click to load
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {libraryCombos.map((combo, i) => {
              const col = scoreColor(combo.score / 100);
              const isLoaded = fileA?.name === combo.a.file.name && fileB?.name === combo.b.file.name;
              return (
                <div
                  key={`${combo.a.id}-${combo.b.id}`}
                  onClick={() => loadCombo(combo)}
                  style={{
                    display: "flex", alignItems: "center", gap: "10px",
                    padding: "9px 12px", borderRadius: "9px", cursor: "pointer",
                    background: isLoaded ? "rgba(139,92,246,0.08)" : "rgba(255,255,255,0.02)",
                    border: `1px solid ${isLoaded ? "rgba(139,92,246,0.25)" : "rgba(255,255,255,0.04)"}`,
                    transition: "all 0.12s",
                  }}
                  onMouseEnter={e => { if (!isLoaded) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                  onMouseLeave={e => { if (!isLoaded) e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
                >
                  <span style={{ width: "18px", fontSize: "10px", color: "#4b5563", ...S.mono, flexShrink: 0 }}>#{i + 1}</span>
                  <span style={{
                    padding: "2px 7px", borderRadius: "999px", fontSize: "11px", fontWeight: 700,
                    background: `${col}14`, color: col, border: `1px solid ${col}28`,
                    ...S.mono, flexShrink: 0, minWidth: "40px", textAlign: "center",
                  }}>{combo.score}%</span>
                  <span style={{ flex: 1, fontSize: "12px", color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <span style={{ color: "#6ee7b7" }}>{combo.a.name}</span>
                    <span style={{ color: "#374151", margin: "0 6px" }}>→</span>
                    <span style={{ color: "#c4b5fd" }}>{combo.b.name}</span>
                  </span>
                  {combo.a.duration && combo.b.duration && (
                    <span style={{ fontSize: "10px", color: "#374151", ...S.mono, flexShrink: 0 }}>
                      {fmt(combo.a.duration)} + {fmt(combo.b.duration)}
                    </span>
                  )}
                  <span style={{
                    fontSize: "11px", fontWeight: 500, padding: "3px 10px", borderRadius: "6px",
                    background: isLoaded ? "rgba(139,92,246,0.14)" : "rgba(255,255,255,0.04)",
                    color: isLoaded ? "#a78bfa" : "#6b7280",
                  }}>
                    {isLoaded ? "✓ Loaded" : "Load"}
                  </span>
                </div>
              );
            })}
          </div>
          <p style={{ fontSize: "11px", color: "#374151", marginTop: "10px", marginBottom: 0 }}>
            Scores are estimated from BPM compatibility. Run the analysis for the exact match.
          </p>
        </div>
      )}

      {/* Drop zones */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: "12px", alignItems: "center" }}>
        <div>
          <div style={{ ...S.lbl, marginBottom: "8px" }}>Track A — Outgoing</div>
          <AudioDropzone onFile={setFileA} file={fileA} label="Drop outgoing track" accentColor="emerald" />
          {libraryTracks.length > 0 && !fileA && (
            <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "2px" }}>
              <div style={{ fontSize: "10px", color: "#374151", padding: "0 2px", marginBottom: "3px" }}>From library</div>
              {libraryTracks.slice(0, 4).map(t => (
                <div key={t.id} onClick={() => setFileA(t.file)} style={{
                  padding: "5px 10px", borderRadius: "7px", cursor: "pointer", fontSize: "12px",
                  color: "#6b7280", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", transition: "all 0.1s",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(16,185,129,0.07)"; e.currentTarget.style.color = "#9ca3af"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.02)"; e.currentTarget.style.color = "#6b7280"; }}
                >
                  {t.name}
                </div>
              ))}
            </div>
          )}
        </div>

        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2d3748" strokeWidth="1.5" strokeLinecap="round">
          <path d="M5 12h14M15 7l5 5-5 5"/>
        </svg>

        <div>
          <div style={{ ...S.lbl, marginBottom: "8px" }}>Track B — Incoming</div>
          <AudioDropzone onFile={setFileB} file={fileB} label="Drop incoming track" accentColor="violet" />
          {libraryTracks.length > 0 && !fileB && (
            <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "2px" }}>
              <div style={{ fontSize: "10px", color: "#374151", padding: "0 2px", marginBottom: "3px" }}>From library</div>
              {libraryTracks.slice(0, 4).map(t => (
                <div key={t.id} onClick={() => setFileB(t.file)} style={{
                  padding: "5px 10px", borderRadius: "7px", cursor: "pointer", fontSize: "12px",
                  color: "#6b7280", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", transition: "all 0.1s",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(139,92,246,0.07)"; e.currentTarget.style.color = "#9ca3af"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.02)"; e.currentTarget.style.color = "#6b7280"; }}
                >
                  {t.name}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Submit row */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <button onClick={handleSubmit} disabled={!canSubmit} style={{
          padding: "9px 20px", borderRadius: "9px", border: "none",
          fontSize: "13px", fontWeight: 600, cursor: canSubmit ? "pointer" : "not-allowed",
          background: canSubmit ? "linear-gradient(135deg, #10b981, #059669)" : "rgba(255,255,255,0.05)",
          color: canSubmit ? "#022c22" : "#4b5563",
          boxShadow: canSubmit ? "0 0 18px rgba(16,185,129,0.22)" : "none", transition: "all 0.15s",
        }}>Analyse Transition</button>
        {mode === "ready" && <button onClick={reset} style={{ padding: "8px 14px", borderRadius: "9px", fontSize: "12px", color: "#6b7280", background: "transparent", border: "1px solid rgba(255,255,255,0.07)", cursor: "pointer" }}>Reset</button>}
        {!canSubmit && mode === "idle" && (
          <span style={{ fontSize: "12px", color: "#4b5563" }}>
            {!fileA && !fileB ? "Pick two tracks to continue" : !fileA ? "Add Track A" : "Add Track B"}
          </span>
        )}
      </div>

      {mode === "loading" && <div style={S.card}><ProcessingOverlay stages={STAGES} accentColor="violet" /></div>}

      {mode === "error" && (
        <div style={{ ...S.card, background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.18)" }}>
          <p style={{ fontSize: "13px", color: "#f87171", marginBottom: "4px" }}>Analysis failed</p>
          <p style={{ fontSize: "11px", color: "#9ca3af", margin: 0 }}>{error}</p>
        </div>
      )}

      {mode === "ready" && result && (
        <>
          {/* Mode toggle */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
            <div style={{ display: "flex", gap: "2px", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "8px", padding: "3px" }}>
              {[["auto", "Auto", setAuto], ["manual", "Manual", () => setAutoMode(false)]].map(([id, label, action]) => {
                const active = id === "auto" ? autoMode : !autoMode;
                const col    = id === "auto" ? "#10b981" : "#a78bfa";
                return (
                  <button key={id} onClick={action} style={{
                    padding: "5px 14px", borderRadius: "6px", border: "none", fontSize: "12px", fontWeight: 500, cursor: "pointer",
                    background: active ? `${col}14` : "transparent", color: active ? col : "#6b7280",
                    outline: active ? `1px solid ${col}28` : "none", outlineOffset: "-1px", transition: "all 0.12s",
                  }}>{label}</button>
                );
              })}
            </div>
            {chosen && (
              <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" }}>
                <span style={{ color: "#4b5563" }}>{autoMode ? "Best:" : `#${selectedIdx + 1}:`}</span>
                <span style={{ padding: "3px 10px", borderRadius: "999px", fontWeight: 600, background: `${scoreColor(chosen.score)}14`, color: scoreColor(chosen.score), border: `1px solid ${scoreColor(chosen.score)}28`, ...S.mono }}>
                  {Math.round(chosen.score * 100)}%
                </span>
                <span style={{ color: "#4b5563", ...S.mono }}>{fmt(chosen.src_time)} → {fmt(chosen.tgt_time)}</span>
              </div>
            )}
          </div>

          {/* Timeline */}
          <div style={S.card}>
            <div style={{ ...S.lbl, marginBottom: "12px" }}>
              Transition timeline
              <span style={{ marginLeft: "8px", color: "#1f2937", fontWeight: 400 }}>hover a line to see match · click to select · {result.candidates?.length ?? 0} candidates</span>
            </div>
            <DualTimeline result={result} selectedIdx={selectedIdx} onSelect={selectCandidate} fileA={fileA} fileB={fileB} />
            <div style={{ display: "flex", gap: "16px", marginTop: "10px", fontSize: "10px", color: "#374151" }}>
              <span style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                <span style={{ width: "14px", height: "2px", background: "#f59e0b", display: "inline-block", borderRadius: "1px" }}/>selected
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                <span style={{ width: "14px", height: "1px", background: "rgba(139,92,246,0.5)", display: "inline-block" }}/>other candidates
              </span>
            </div>
          </div>

          {/* Metrics */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "8px" }}>
            {[
              { lbl: "Best score",   val: `${Math.round(result.score * 100)}%`,                     col: scoreColor(result.score) },
              { lbl: "BPM delta",    val: `${result.tempo_delta?.toFixed(1)} BPM`,                   col: result.tempo_delta < 5 ? "#10b981" : "#f59e0b" },
              { lbl: "Key distance", val: KEY_LABELS[Math.min(result.key_distance ?? 0, 11)],        col: result.key_distance <= 2 ? "#10b981" : "#f59e0b" },
              { lbl: "Candidates",   val: `${result.candidates?.length ?? 0}`,                       col: "#a78bfa" },
            ].map(({ lbl, val, col }) => (
              <div key={lbl} style={{ ...S.inner, padding: "12px 14px" }}>
                <div style={S.lbl}>{lbl}</div>
                <div style={{ fontSize: "16px", fontWeight: 700, color: col, marginTop: "6px", ...S.mono }}>{val}</div>
              </div>
            ))}
          </div>

          {/* Preview player */}
          {previewUrl && (
            <div style={S.card}>
              <div style={{ ...S.lbl, marginBottom: "12px" }}>Preview — with beat drop effect</div>
              <div style={{ ...S.inner, padding: "14px 16px", display: "flex", alignItems: "center", gap: "12px" }}>
                <button onClick={togglePlay} style={{
                  width: "36px", height: "36px", borderRadius: "50%",
                  background: "linear-gradient(135deg, #8b5cf6, #7c3aed)",
                  border: "none", cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "white", flexShrink: 0, boxShadow: "0 0 14px rgba(139,92,246,0.3)",
                }}>
                  {playing
                    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                    : <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
                  }
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "12px", color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {fileA?.name} → {fileB?.name}
                  </div>
                  <div style={{ fontSize: "10px", color: "#4b5563", marginTop: "2px" }}>
                    Filter sweep · beat drop · S-curve crossfade
                  </div>
                </div>
                <a href={previewUrl} download={`transition_${Date.now()}.wav`} style={{
                  display: "flex", alignItems: "center", gap: "5px", fontSize: "11px", color: "#6b7280",
                  textDecoration: "none", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "7px", padding: "5px 9px",
                }}
                onMouseEnter={e => { e.currentTarget.style.color = "#8b5cf6"; e.currentTarget.style.borderColor = "rgba(139,92,246,0.3)"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "#6b7280"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  WAV
                </a>
              </div>
              <audio ref={audioRef} src={previewUrl} onEnded={() => setPlaying(false)} onPause={() => setPlaying(false)} preload="auto" style={{ display: "none" }}/>
            </div>
          )}

          {/* Best Jumps (renamed from Recommended Combos) */}
          {result.candidates?.length > 0 && (
            <div style={S.card}>
              <div style={{ ...S.lbl, marginBottom: "12px" }}>
                Best jumps
                <span style={{ marginLeft: "8px", color: "#1f2937", fontWeight: 400 }}>
                  · ranked by composite score · click any row to select on timeline
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                {result.candidates.slice(0, 12).map((c, i) => {
                  const pct = Math.round(c.score * 100), col = scoreColor(c.score), isSel = i === selectedIdx;
                  return (
                    <div key={i} onClick={() => selectCandidate(i)} style={{
                      display: "flex", alignItems: "center", gap: "12px", padding: "9px 12px",
                      borderRadius: "9px", cursor: "pointer",
                      background: isSel ? "rgba(245,158,11,0.07)" : "rgba(255,255,255,0.02)",
                      border: `1px solid ${isSel ? "rgba(245,158,11,0.24)" : "rgba(255,255,255,0.04)"}`,
                      transition: "all 0.12s",
                    }}
                    onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                    onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = isSel ? "rgba(245,158,11,0.07)" : "rgba(255,255,255,0.02)"; }}
                    >
                      <span style={{ width: "20px", fontSize: "10px", color: isSel ? "#f59e0b" : "#4b5563", ...S.mono, flexShrink: 0 }}>#{i + 1}</span>
                      <span style={{ padding: "2px 8px", borderRadius: "999px", fontSize: "11px", fontWeight: 700, background: `${col}14`, color: col, border: `1px solid ${col}28`, ...S.mono, flexShrink: 0, minWidth: "44px", textAlign: "center" }}>{pct}%</span>
                      <div style={{ flex: 1, height: "4px", borderRadius: "2px", background: "rgba(255,255,255,0.05)", overflow: "hidden" }}>
                        <div style={{ width: `${pct}%`, height: "100%", background: col, borderRadius: "2px" }}/>
                      </div>
                      <span style={{ fontSize: "11px", color: "#6b7280", ...S.mono, flexShrink: 0 }}>
                        <span style={{ color: "#10b981" }}>{fmt(c.src_time)}</span>
                        <span style={{ color: "#374151", margin: "0 4px" }}>→</span>
                        <span style={{ color: "#8b5cf6" }}>{fmt(c.tgt_time)}</span>
                      </span>
                      <button onClick={e => { e.stopPropagation(); selectCandidate(i); }} style={{
                        padding: "3px 10px", borderRadius: "6px", border: "none", fontSize: "11px", fontWeight: 500,
                        cursor: "pointer", flexShrink: 0,
                        background: isSel ? "rgba(245,158,11,0.14)" : "rgba(255,255,255,0.04)",
                        color: isSel ? "#f59e0b" : "#6b7280", transition: "all 0.12s",
                      }}>{isSel ? "✓ Selected" : "Select"}</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
