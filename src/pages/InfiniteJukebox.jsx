/**
 * InfiniteJukebox.jsx — Infinite Playback Engine
 * ================================================
 * Massive waveform, jump-graph arc visualization, technical readouts.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useLibrary } from "../context/LibraryContext";
import { useApp } from "../context/AppContext";
import useJukeboxEngine from "../hooks/useJukeboxEngine";
import ProcessingOverlay from "../components/ProcessingOverlay";
import WaveSurfer from "wavesurfer.js";
import { motion } from "framer-motion";
import {
  Play, Pause, Square, Volume2, Loader2,
  Infinity as InfinityIcon, Zap, Timer, Music2,
} from "lucide-react";

const API = "http://localhost:8000";

function fmt(s) {
  if (!s || !isFinite(s)) return "--:--";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

// ── Jump Arc Graph ──
function JumpGraph({ analysisData, currentTime, activeJumpIndex }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analysisData) return;

    const ctx = canvas.getContext("2d");
    const { beats, jump_schedule, song_duration_s } = analysisData;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const w = rect.width;
    const h = rect.height;

    if (!jump_schedule || jump_schedule.length === 0 || !song_duration_s) return;

    // Draw arcs for each jump
    jump_schedule.forEach((jump, jumpIdx) => {
      const srcBeat = beats[jump.beat_idx];
      if (!srcBeat) return;
      const srcX = (srcBeat.time / song_duration_s) * w;

      jump.candidates.forEach((cand) => {
        const tgtBeat = beats[cand.target_beat_idx];
        if (!tgtBeat) return;
        const tgtX = (tgtBeat.time / song_duration_s) * w;

        const midX = (srcX + tgtX) / 2;
        const span = Math.abs(tgtX - srcX);
        const arcH = Math.min(span * 0.3, h * 0.85);

        const isActive = jumpIdx === activeJumpIndex;

        ctx.beginPath();
        ctx.moveTo(srcX, h);
        ctx.quadraticCurveTo(midX, h - arcH, tgtX, h);

        if (isActive) {
          const vol = parseFloat(document.documentElement.style.getPropertyValue("--vol") || 0);
          ctx.strokeStyle = `rgba(167, 139, 250, ${0.8 + vol * 0.2})`;
          ctx.lineWidth = 2.5 + vol * 2;
          ctx.shadowColor = `rgba(167, 139, 250, ${0.6 + vol * 0.4})`;
          ctx.shadowBlur = 12 + vol * 20;
        } else {
          const alpha = 0.06 + cand.probability * 0.2;
          ctx.strokeStyle = `rgba(139, 92, 246, ${alpha})`;
          ctx.lineWidth = 1;
          ctx.shadowColor = "transparent";
          ctx.shadowBlur = 0;
        }

        ctx.stroke();
        ctx.shadowBlur = 0;
      });
    });

    // Draw playhead position
    if (currentTime > 0 && song_duration_s > 0) {
      const px = (currentTime / song_duration_s) * w;
      ctx.beginPath();
      ctx.moveTo(px, h);
      ctx.lineTo(px, 0);
      ctx.strokeStyle = "rgba(250, 250, 250, 0.2)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }, [analysisData, currentTime, activeJumpIndex]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full rounded-md bg-zinc-950/50 border border-white/[0.04]"
      style={{ height: "120px" }}
    />
  );
}


export default function InfiniteJukebox() {
  const { tracks } = useLibrary();
  const { analysisData, setAnalysisData, isProcessing, setIsProcessing, activeJumpIndex } = useApp();

  const [selectedTrackId, setSelectedTrackId] = useState(null);
  const selectedTrack = tracks.find(t => t.id === selectedTrackId);

  const jukebox = useJukeboxEngine(selectedTrack?.url || null, analysisData);

  const waveformRef = useRef(null);
  const wsRef = useRef(null);

  // Build WaveSurfer when analysis completes
  useEffect(() => {
    if (!analysisData || !selectedTrack || !waveformRef.current) return;

    if (wsRef.current) {
      wsRef.current.destroy();
      wsRef.current = null;
    }

    const ws = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: "rgba(139, 92, 246, 0.3)",
      progressColor: "rgba(139, 92, 246, 0.7)",
      cursorColor: "#fafafa",
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      height: 80,
      normalize: true,
      url: selectedTrack.url,
      interact: false,
    });
    ws.setVolume(0); // visual only — audio from Tone.js
    wsRef.current = ws;

    return () => {
      if (wsRef.current) {
        wsRef.current.destroy();
        wsRef.current = null;
      }
    };
  }, [analysisData, selectedTrack?.id]);

  // Sync waveform position to jukebox current time
  useEffect(() => {
    if (wsRef.current && analysisData?.song_duration_s && jukebox.currentTime > 0) {
      const frac = Math.min(1, jukebox.currentTime / analysisData.song_duration_s);
      wsRef.current.seekTo(frac);
    }
  }, [jukebox.currentTime, analysisData]);

  // Analyze track
  const handleAnalyze = useCallback(async () => {
    if (!selectedTrack) return;
    setIsProcessing(true);
    setAnalysisData(null);

    const body = new FormData();
    body.append("file", selectedTrack.file);

    try {
      const res = await fetch(`${API}/analyze`, { method: "POST", body });
      if (res.ok) {
        const data = await res.json();
        setAnalysisData(data);
      }
    } catch (err) {
      console.error("Analysis failed:", err);
    } finally {
      setIsProcessing(false);
    }
  }, [selectedTrack, setAnalysisData, setIsProcessing]);

  // Find current beat
  const currentBeat = useMemo(() => {
    if (!analysisData?.beats || !jukebox.currentTime) return null;
    const { beats } = analysisData;
    for (let i = beats.length - 1; i >= 0; i--) {
      if (jukebox.currentTime >= beats[i].time) return beats[i];
    }
    return null;
  }, [analysisData, jukebox.currentTime]);

  // Find active jump info
  const activeJump = useMemo(() => {
    if (activeJumpIndex < 0 || !analysisData?.jump_schedule) return null;
    return analysisData.jump_schedule[activeJumpIndex] || null;
  }, [activeJumpIndex, analysisData]);

  return (
    <div className="flex flex-col h-full p-6 gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            <InfinityIcon className="w-5 h-5 text-purple-500" />
            Infinite Jukebox
          </h1>
          <p className="text-xs text-zinc-600 mt-1">
            Structural audio analysis with probabilistic jump scheduling
          </p>
        </div>
      </div>

      {/* Track Selector */}
      <div className="flex items-center gap-3">
        <select
          value={selectedTrackId || ""}
          onChange={e => {
            setSelectedTrackId(e.target.value || null);
            setAnalysisData(null);
            jukebox.stop();
          }}
          className="
            flex-1 max-w-sm px-3 py-2 rounded-lg
            bg-zinc-950 border border-white/[0.06]
            text-[13px] text-zinc-300
            focus:outline-none focus:border-purple-500/40
            transition-colors
          "
        >
          <option value="">Select a track…</option>
          {tracks.map(t => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>

        <button
          onClick={handleAnalyze}
          disabled={!selectedTrack || isProcessing}
          className="
            px-5 py-2 rounded-lg
            bg-gradient-to-r from-purple-600 to-purple-700
            text-white text-[12px] font-semibold
            hover:from-purple-500 hover:to-purple-600
            disabled:opacity-40 disabled:cursor-not-allowed
            transition-all cursor-pointer border-0
            shadow-[0_0_15px_rgba(139,92,246,0.2)]
            hover:shadow-[0_0_25px_rgba(139,92,246,0.4)]
          "
        >
          {isProcessing ? (
            <span className="flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Analyzing…
            </span>
          ) : (
            "Analyze"
          )}
        </button>
      </div>

      {/* No tracks state */}
      {tracks.length === 0 && (
        <div className="flex flex-col items-center justify-center flex-1 text-zinc-700">
          <Music2 className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm font-medium">No tracks in library</p>
          <p className="text-xs text-zinc-800 mt-1">Upload tracks in the Library first</p>
        </div>
      )}

      {/* Processing */}
      {isProcessing && (
        <div className="flex-1 flex items-center justify-center">
          <ProcessingOverlay
            stages={[
              "Loading audio buffer",
              "Extracting beat grid",
              "Computing timbral features",
              "Building similarity matrix",
              "Generating jump schedule",
            ]}
            accentColor="violet"
          />
        </div>
      )}

      {/* Analysis UI */}
      {analysisData && !isProcessing && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 25, staggerChildren: 0.1 }}
          className="flex flex-col gap-6"
        >
          {/* Massive waveform */}
          <div className="rounded-lg overflow-hidden border border-white/[0.04] bg-zinc-950/50">
            <div ref={waveformRef} className="w-full" style={{ height: "80px" }} />
          </div>

          {/* Jump Graph */}
          <JumpGraph
            analysisData={analysisData}
            currentTime={jukebox.currentTime}
            activeJumpIndex={activeJumpIndex}
          />

          {/* Technical Readout Panels */}
          <div className="grid grid-cols-3 gap-3">
            {/* Current Beat */}
            <div className="rounded-lg bg-zinc-950 border border-white/[0.04] p-4">
              <div className="text-[9px] uppercase tracking-[0.14em] text-zinc-600 mb-2 font-medium">
                Current Beat
              </div>
              <div className="font-mono text-2xl font-bold text-white">
                {currentBeat ? currentBeat.index : "--"}
              </div>
              <div className="font-mono text-[11px] text-zinc-500 mt-1">
                {currentBeat ? `${currentBeat.time.toFixed(3)}s` : "--"}
              </div>
            </div>

            {/* Active Jump */}
            <div className={`
              rounded-lg border p-4 transition-all duration-300
              ${activeJump
                ? "bg-purple-500/5 border-purple-500/20 shadow-[0_0_15px_rgba(139,92,246,0.1)]"
                : "bg-zinc-950 border-white/[0.04]"
              }
            `}>
              <div className="text-[9px] uppercase tracking-[0.14em] text-zinc-600 mb-2 font-medium flex items-center gap-1.5">
                <Zap className={`w-3 h-3 ${activeJump ? "text-purple-400" : "text-zinc-700"}`} />
                Active Jump
              </div>
              <div className="font-mono text-lg font-bold text-purple-400">
                {activeJump
                  ? `${activeJump.beat_idx} → ${activeJump.candidates[0]?.target_beat_idx || "?"}`
                  : "IDLE"
                }
              </div>
              <div className="font-mono text-[11px] text-zinc-500 mt-1">
                {jukebox.jumpCount} total jumps
              </div>
            </div>

            {/* Cooldown Status */}
            <div className="rounded-lg bg-zinc-950 border border-white/[0.04] p-4">
              <div className="text-[9px] uppercase tracking-[0.14em] text-zinc-600 mb-2 font-medium flex items-center gap-1.5">
                <Timer className="w-3 h-3 text-zinc-700" />
                Cooldown
              </div>
              <div className="font-mono text-2xl font-bold text-white">
                {analysisData?.min_beats_between_jumps || "--"}
              </div>
              <div className="font-mono text-[11px] text-zinc-500 mt-1">
                beat minimum
              </div>
            </div>
          </div>

          {/* Stats bar */}
          <div className="flex items-center gap-6 px-1 text-[11px] text-zinc-500">
            <span className="font-mono">BPM: <span className="text-zinc-300 font-semibold">{analysisData.tempo?.toFixed(1) || "--"}</span></span>
            <span className="font-mono">Edges: <span className="text-zinc-300 font-semibold">{analysisData.edge_count || "--"}</span></span>
            <span className="font-mono">Beats: <span className="text-zinc-300 font-semibold">{analysisData.beats?.length || "--"}</span></span>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-4">
            <button
              onClick={jukebox.togglePlay}
              className="
                w-12 h-12 rounded-full shrink-0
                bg-gradient-to-br from-purple-500 to-purple-700
                flex items-center justify-center
                shadow-[0_0_25px_rgba(139,92,246,0.3)]
                hover:shadow-[0_0_35px_rgba(139,92,246,0.5)]
                transition-shadow cursor-pointer border-0 text-white
              "
            >
              {jukebox.playing ? (
                <Pause className="w-5 h-5" />
              ) : (
                <Play className="w-5 h-5 ml-0.5" />
              )}
            </button>

            <button
              onClick={jukebox.stop}
              className="p-2.5 rounded-md text-zinc-600 hover:text-zinc-300 bg-transparent border-0 cursor-pointer transition-colors"
            >
              <Square className="w-4 h-4" />
            </button>

            {/* Time */}
            <div className="flex-1">
              <div className="font-mono text-[28px] font-bold text-white tracking-tight">
                {fmt(jukebox.currentTime)}
              </div>
              <div className="text-[11px] text-purple-500 font-medium">/ ∞</div>
            </div>

            {/* Volume */}
            <div className="flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-zinc-600" />
              <input
                type="range" min="0" max="1" step="0.01"
                value={jukebox.volume}
                onChange={e => jukebox.setVolume(+e.target.value)}
                className="w-24 cursor-pointer"
              />
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}
