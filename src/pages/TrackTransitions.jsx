/**
 * TrackTransitions.jsx — A/B Deck Transition Console
 * ====================================================
 * Deck A (left), Transition Console (center), Deck B (right).
 * Compatibility analysis, preview playback, and mix computation.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { useLibrary } from "../context/LibraryContext";
import { useApp } from "../context/AppContext";
import useTransitionEngine from "../hooks/useTransitionEngine";
import AudioDropzone from "../components/AudioDropzone";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play, Pause, Loader2, ArrowLeftRight, Disc3,
  Volume2, Music2, ChevronDown, Zap,
} from "lucide-react";

function fmt(s) {
  if (!s || !isFinite(s)) return "--:--";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

// ── Circular Score Ring ──
function ScoreRing({ value, max = 100, label, size = 72, color = "#8b5cf6" }) {
  const pct = max > 0 ? Math.min(value / max, 1) : 0;
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct);

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width={size} height={size} className="transform -rotate-90">
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="3"
        />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke={color} strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          className="transition-all duration-700 ease-out"
          style={{ filter: `drop-shadow(0 0 4px ${color}50)` }}
        />
      </svg>
      <div className="absolute flex flex-col items-center justify-center" style={{ width: size, height: size }}>
        <span className="font-mono text-[16px] font-bold text-white">
          {typeof value === "number" ? (max === 1 ? `${(value * 100).toFixed(0)}%` : value.toFixed(1)) : "--"}
        </span>
      </div>
      <span className="text-[9px] uppercase tracking-[0.12em] text-zinc-600 font-medium">{label}</span>
    </div>
  );
}

// ── Deck Card ──
function DeckCard({ side, trackId, setTrackId, tracks, addTracks }) {
  const track = tracks.find(t => t.id === trackId);

  const handleFile = useCallback((file) => {
    const [t] = addTracks([file]);
    if (t) setTrackId(t.id);
  }, [addTracks, setTrackId]);

  return (
    <div className="flex-1 flex flex-col gap-4">
      {/* Deck label */}
      <div className="flex items-center gap-2">
        <div className={`
          w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-bold
          ${side === "A"
            ? "bg-purple-500/15 text-purple-400 border border-purple-500/25"
            : "bg-zinc-800 text-zinc-400 border border-white/[0.06]"
          }
        `}>
          {side}
        </div>
        <span className="text-[12px] font-semibold text-zinc-400 uppercase tracking-wide">
          Deck {side}
        </span>
      </div>

      {/* Track selector */}
      <select
        value={trackId || ""}
        onChange={e => setTrackId(e.target.value || null)}
        className="
          w-full px-3 py-2 rounded-lg
          bg-zinc-950 border border-white/[0.06]
          text-[12px] text-zinc-300
          focus:outline-none focus:border-purple-500/40
          transition-colors
        "
      >
        <option value="">Select track…</option>
        {tracks.map(t => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>

      {/* Or drop */}
      <AudioDropzone
        onFile={handleFile}
        label={`Drop for Deck ${side}`}
        file={track?.file}
      />

      {/* Track metadata */}
      {track && (
        <div className="rounded-lg bg-zinc-950 border border-white/[0.04] p-4 space-y-3">
          <div className="text-[12px] font-medium text-white truncate flex items-center gap-2">
            <Disc3 className="w-3.5 h-3.5 text-purple-500 shrink-0" />
            {track.name}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-zinc-600 mb-1">BPM</div>
              <div className="font-mono text-[16px] font-bold text-white">
                {track.bpm || "--"}
              </div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-[0.12em] text-zinc-600 mb-1">Key</div>
              <div className="font-mono text-[16px] font-bold text-white">
                {track.camelot_key || track.key || "--"}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


export default function TrackTransitions() {
  const { tracks, addTracks } = useLibrary();
  const { transitionPhase } = useApp();
  const transition = useTransitionEngine();

  const [trackAId, setTrackAId] = useState(null);
  const [trackBId, setTrackBId] = useState(null);

  const trackA = tracks.find(t => t.id === trackAId) || null;
  const trackB = tracks.find(t => t.id === trackBId) || null;

  const previewRef = useRef(null);

  // Clean up on unmount to prevent audio leaks
  useEffect(() => {
    return transition.cleanup;
  }, [transition.cleanup]);

  // Setup preview waveform when result arrives
  useEffect(() => {
    if (transition.result && previewRef.current) {
      transition.setupPreview(previewRef.current);
    }
  }, [transition.result]);

  const handleCompute = useCallback(() => {
    if (trackA && trackB) {
      transition.analyzeTransition(trackA, trackB);
    }
  }, [trackA, trackB, transition]);

  const MODES = [
    { id: "auto",   label: "Auto" },
    { id: "smooth", label: "Smooth" },
    { id: "edm",    label: "EDM" },
    { id: "cut",    label: "Cut" },
  ];

  return (
    <div className="flex flex-col h-full p-6 gap-6 overflow-y-auto">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
          <ArrowLeftRight className="w-5 h-5 text-purple-500" />
          Track Transitions
        </h1>
        <p className="text-xs text-zinc-600 mt-1">
          Compute intelligent crossfade transitions between two tracks
        </p>
      </div>

      {/* No tracks */}
      {tracks.length === 0 && (
        <div className="flex flex-col items-center justify-center flex-1 text-zinc-700">
          <Music2 className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm font-medium">No tracks in library</p>
          <p className="text-xs text-zinc-800 mt-1">Upload tracks in the Library first</p>
        </div>
      )}

      {/* A/B Deck Layout */}
      {tracks.length > 0 && (
        <div className="grid grid-cols-[1fr_auto_1fr] gap-6 items-start">
          {/* Deck A */}
          <DeckCard
            side="A"
            trackId={trackAId}
            setTrackId={setTrackAId}
            tracks={tracks}
            addTracks={addTracks}
          />

          {/* ── Transition Console (Center) ── */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1, type: "spring", stiffness: 300, damping: 25 }}
            className="w-[240px] flex flex-col gap-4 items-center pt-8"
          >
            {/* Mode Selector */}
            <div className="w-full">
              <div className="text-[9px] uppercase tracking-[0.12em] text-zinc-600 mb-2 font-medium text-center">
                Transition Mode
              </div>
              <div className="flex gap-1 w-full">
                {MODES.map(m => (
                  <button
                    key={m.id}
                    onClick={() => transition.setMode(m.id)}
                    className={`
                      flex-1 py-1.5 rounded-md text-[10px] font-semibold
                      transition-all cursor-pointer border
                      ${transition.mode === m.id
                        ? "bg-purple-500/15 text-purple-400 border-purple-500/30"
                        : "bg-zinc-950 text-zinc-600 border-white/[0.04] hover:text-zinc-400 hover:border-white/[0.08]"
                      }
                    `}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Compute Button */}
            <button
              onClick={handleCompute}
              disabled={!trackA || !trackB || transition.loading}
              className="
                w-full py-3 rounded-xl
                bg-gradient-to-r from-purple-600 to-purple-700
                text-white text-[13px] font-bold
                hover:from-purple-500 hover:to-purple-600
                disabled:opacity-30 disabled:cursor-not-allowed
                transition-all cursor-pointer border-0
                shadow-[0_0_20px_rgba(139,92,246,0.25)]
                hover:shadow-[0_0_35px_rgba(139,92,246,0.5)]
                flex items-center justify-center gap-2
              "
            >
              {transition.loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Computing…
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4" />
                  Compute Mix
                </>
              )}
            </button>

            {/* Error */}
            {transition.error && (
              <div className="w-full px-3 py-2 rounded-lg bg-red-500/8 border border-red-500/20 text-[11px] text-red-400 text-center">
                {transition.error}
              </div>
            )}

            {/* Results — Compatibility Scores */}
            {transition.result && (
              <div className="w-full flex flex-col gap-4 items-center">
                {/* Score Rings */}
                <div className="flex gap-5 justify-center">
                  <div className="relative flex flex-col items-center">
                    <ScoreRing value={transition.result.score} max={1} label="Overall" size={76} />
                  </div>
                </div>

                {/* Data readouts */}
                <div className="w-full grid grid-cols-2 gap-2">
                  <div className="rounded-md bg-zinc-950 border border-white/[0.04] p-3 text-center">
                    <div className="text-[9px] uppercase tracking-[0.12em] text-zinc-600 mb-1">BPM Delta</div>
                    <div className={`font-mono text-[14px] font-bold ${transition.result.tempo_delta < 2 ? "text-purple-400" : "text-amber-400"}`}>
                      {transition.result.tempo_delta?.toFixed(1) || "--"}
                    </div>
                    <div className="font-mono text-[10px] text-zinc-600 mt-0.5">
                      {transition.result.tempo_a} → {transition.result.tempo_b}
                    </div>
                  </div>
                  <div className="rounded-md bg-zinc-950 border border-white/[0.04] p-3 text-center">
                    <div className="text-[9px] uppercase tracking-[0.12em] text-zinc-600 mb-1">Key Dist</div>
                    <div className={`font-mono text-[14px] font-bold ${transition.result.key_distance <= 2 ? "text-purple-400" : "text-amber-400"}`}>
                      {transition.result.key_distance}
                    </div>
                    <div className="font-mono text-[10px] text-zinc-600 mt-0.5">
                      {transition.result.camelot_a || "--"} → {transition.result.camelot_b || "--"}
                    </div>
                  </div>
                </div>

                {/* Mode badge */}
                <div className="
                  inline-flex items-center gap-1.5 px-3 py-1 rounded-md
                  bg-purple-500/10 border border-purple-500/25
                  text-[10px] font-bold text-purple-300
                  uppercase tracking-[0.06em]
                ">
                  {transition.result.applied_mode === "edm" ? "EDM Buildup" :
                   transition.result.applied_mode === "smooth" ? "Smooth Blend" :
                   transition.result.applied_mode === "cut" ? "Hard Cut" :
                   transition.result.applied_mode}
                </div>
              </div>
            )}
          </motion.div>

          {/* Deck B */}
          <DeckCard
            side="B"
            trackId={trackBId}
            setTrackId={setTrackBId}
            tracks={tracks}
            addTracks={addTracks}
          />
        </div>
      )}

      {/* ── Preview Section (full-width below) ── */}
      <AnimatePresence>
      {transition.result && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          transition={{ type: "spring", stiffness: 300, damping: 25 }}
          className="border-t border-white/[0.04] pt-6 space-y-4"
        >
          <div className="text-[10px] uppercase tracking-[0.12em] text-zinc-600 font-medium">
            Transition Preview
          </div>

          {/* Phase indicator */}
          <div className="flex items-center gap-2">
            <div className={`
              flex-1 h-[3px] rounded-full transition-all duration-500
              ${transitionPhase === "a"
                ? "bg-gradient-to-r from-purple-500 to-purple-500/30"
                : "bg-white/[0.04]"
              }
            `} />
            <div className={`
              w-2 h-2 rounded-full transition-all duration-300
              ${transitionPhase === "transition"
                ? "bg-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.6)]"
                : "bg-white/[0.08]"
              }
            `} />
            <div className={`
              flex-1 h-[3px] rounded-full transition-all duration-500
              ${transitionPhase === "b"
                ? "bg-gradient-to-r from-purple-500/30 to-purple-500"
                : "bg-white/[0.04]"
              }
            `} />
          </div>

          {/* Waveform */}
          <div
            ref={previewRef}
            className="h-[56px] rounded-md bg-zinc-950/50 border border-white/[0.04] overflow-hidden"
          />

          {/* Controls */}
          <div className="flex items-center gap-4">
            <button
              onClick={transition.togglePreview}
              className="
                w-10 h-10 rounded-full shrink-0
                bg-gradient-to-br from-purple-500 to-purple-700
                flex items-center justify-center
                shadow-[0_0_20px_rgba(139,92,246,0.3)]
                hover:shadow-[0_0_30px_rgba(139,92,246,0.5)]
                transition-shadow cursor-pointer border-0 text-white
              "
            >
              {transition.previewPlaying ? (
                <Pause className="w-4 h-4" />
              ) : (
                <Play className="w-4 h-4 ml-0.5" />
              )}
            </button>

            <div className="flex-1 flex justify-between font-mono text-[11px] text-zinc-500">
              <span>Exit: {fmt(transition.result.src_time)}</span>
              <span>Entry: {fmt(transition.result.tgt_time)}</span>
            </div>
          </div>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}
