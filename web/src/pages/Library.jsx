/**
 * Library.jsx — Track Library & Player
 * ======================================
 * Upload zone, track grid, and sticky bottom audio player.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { useLibrary } from "../context/LibraryContext";
import { useApp } from "../context/AppContext";
import useLibraryPlayer, { PLAYBACK_MODES } from "../hooks/useLibraryPlayer";
import AudioDropzone from "../components/AudioDropzone";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play, Pause, Square, Volume2, Music2, Clock, Loader2,
  ChevronDown, Download, Trash2,
} from "lucide-react";

const API = "http://localhost:8000";

function fmt(s) {
  if (!s || !isFinite(s)) return "--:--";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function fmtSize(bytes) {
  if (!bytes) return "--";
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

export default function Library() {
  const { tracks, addTracks, removeTrack, updateTrack } = useLibrary();
  const { currentMode, setCurrentMode, isProcessing, setIsProcessing } = useApp();
  const player = useLibraryPlayer();

  const waveformRef = useRef(null);
  const [processingIds, setProcessingIds] = useState(new Set());
  const [showModes, setShowModes] = useState(false);

  const activeTrack = tracks.find(t => t.id === player.activeId);

  // Analyze track with backend
  const analyzeTrack = useCallback(async (track) => {
    setProcessingIds(prev => new Set(prev).add(track.id));
    const body = new FormData();
    body.append("file", track.file);

    try {
      const res = await fetch(`${API}/analyze`, { method: "POST", body });
      if (res.ok) {
        const data = await res.json();
        updateTrack(track.id, {
          bpm: data.tempo?.toFixed(1) || null,
          key: data.key || null,
          camelot_key: data.camelot_key || null,
          duration: data.song_duration_s || null,
        });
      }
    } catch (err) {
      updateTrack(track.id, { error: err.message });
    } finally {
      setProcessingIds(prev => {
        const next = new Set(prev);
        next.delete(track.id);
        return next;
      });
    }
  }, [updateTrack]);

  // Handle file drop
  const handleDrop = useCallback((files) => {
    const newTracks = addTracks(files);
    newTracks.forEach(t => analyzeTrack(t));
  }, [addTracks, analyzeTrack]);

  // Handle track click → play
  const handleTrackClick = useCallback((track) => {
    player.loadAndPlay(track, waveformRef.current);
  }, [player]);

  return (
    <div className="flex flex-col h-full">
      {/* Scrollable content */}
      <div className={`flex-1 overflow-y-auto p-6 pb-32 ${player.activeId ? "pb-44" : ""}`}>
        {/* Page header */}
        <div className="mb-6">
          <h1 className="text-xl font-bold text-white tracking-tight">Library</h1>
          <p className="text-xs text-zinc-600 mt-1">Upload, analyze, and play your audio tracks</p>
        </div>

        {/* Upload zone */}
        <div className="mb-8">
          <AudioDropzone
            onFile={(files) => handleDrop(Array.isArray(files) ? files : [files])}
            label="Drop audio files to upload"
          />
        </div>

        {/* Track list */}
        {tracks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-700">
            <Music2 className="w-10 h-10 mb-3 opacity-30" />
            <p className="text-sm font-medium">No tracks yet</p>
            <p className="text-xs text-zinc-800 mt-1">Drop audio files above to get started</p>
          </div>
        ) : (
          <div className="space-y-1">
            {/* Table header */}
            <div className="grid grid-cols-[1fr_80px_80px_80px_40px] gap-3 px-4 py-2 text-[10px] uppercase tracking-[0.12em] text-zinc-600 font-medium border-b border-white/[0.04]">
              <span>Track</span>
              <span className="text-right">BPM</span>
              <span className="text-right">Key</span>
              <span className="text-right">Duration</span>
              <span></span>
            </div>

            {/* Track rows */}
            <AnimatePresence mode="popLayout">
            {tracks.map(track => {
              const isActive = player.activeId === track.id;
              const isAnalyzing = processingIds.has(track.id);

              return (
                <motion.div
                  layout
                  initial={{ opacity: 0, y: 10, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.99 }}
                  key={track.id}
                  onClick={() => handleTrackClick(track)}
                  className={`
                    grid grid-cols-[1fr_80px_80px_80px_40px] gap-3 items-center
                    px-4 py-3 rounded-lg cursor-pointer
                    transition-colors duration-150 group
                    ${isActive
                      ? "bg-purple-500/8 border border-purple-500/20"
                      : "border border-transparent hover:bg-white/[0.02] hover:border-white/[0.04]"
                    }
                  `}
                >
                  {/* Name */}
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`
                      w-8 h-8 rounded-md flex items-center justify-center shrink-0
                      ${isActive
                        ? "bg-purple-500/20 border border-purple-500/30"
                        : "bg-zinc-900 border border-white/[0.06]"
                      }
                    `}>
                      {isActive && player.playing ? (
                        <Pause className="w-3.5 h-3.5 text-purple-400" />
                      ) : isAnalyzing ? (
                        <Loader2 className="w-3.5 h-3.5 text-zinc-500 animate-spin" />
                      ) : (
                        <Play className="w-3.5 h-3.5 text-zinc-500 group-hover:text-zinc-300 transition-colors" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className={`text-[13px] font-medium truncate ${isActive ? "text-white" : "text-zinc-300"}`}>
                        {track.name}
                      </div>
                      <div className="text-[10px] text-zinc-700 mt-0.5">{fmtSize(track.size)}</div>
                    </div>
                  </div>

                  {/* BPM */}
                  <div className={`text-right font-mono text-[13px] font-medium ${isActive ? "text-purple-400" : "text-zinc-400"}`}>
                    {isAnalyzing ? "..." : track.bpm || "--"}
                  </div>

                  {/* Key */}
                  <div className="text-right font-mono text-[13px] text-zinc-400">
                    {isAnalyzing ? "..." : track.camelot_key || track.key || "--"}
                  </div>

                  {/* Duration */}
                  <div className="text-right font-mono text-[12px] text-zinc-500">
                    {track.duration ? fmt(track.duration) : "--:--"}
                  </div>

                  {/* Actions */}
                  <div className="flex justify-end">
                    <button
                      onClick={(e) => { e.stopPropagation(); removeTrack(track.id); }}
                      className="p-1 rounded text-zinc-700 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 cursor-pointer bg-transparent border-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </motion.div>
              );
            })}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* ── Sticky Bottom Player ── */}
      <AnimatePresence>
      {player.activeId && (
        <motion.div
          initial={{ y: "100%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "100%", opacity: 0 }}
          transition={{ type: "spring", stiffness: 350, damping: 30 }}
          className="fixed bottom-0 left-0 right-0 z-50 border-t border-white/[0.06]"
          style={{
            background: "linear-gradient(to top, rgba(0,0,0,0.98), rgba(9,9,11,0.95))",
            backdropFilter: "blur(20px) saturate(1.5)",
          }}
        >
          <div className="px-6 py-3">
            {/* Waveform */}
            <div
              ref={waveformRef}
              className="h-[48px] rounded-md bg-black/60 border border-white/[0.04] overflow-hidden mb-3"
            />

            <div className="flex items-center gap-4">
              {/* Play/Pause */}
              <button
                onClick={() => activeTrack && player.loadAndPlay(activeTrack, waveformRef.current)}
                disabled={player.isLoading}
                className="
                  w-10 h-10 rounded-full shrink-0
                  bg-gradient-to-br from-purple-500 to-purple-700
                  flex items-center justify-center
                  shadow-[0_0_20px_rgba(139,92,246,0.3)]
                  hover:shadow-[0_0_30px_rgba(139,92,246,0.5)]
                  transition-shadow cursor-pointer border-0 text-white
                  disabled:opacity-50
                "
              >
                {player.isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : player.playing ? (
                  <Pause className="w-4 h-4" />
                ) : (
                  <Play className="w-4 h-4 ml-0.5" />
                )}
              </button>

              {/* Stop */}
              <button
                onClick={player.stop}
                className="p-2 rounded-md text-zinc-600 hover:text-zinc-300 bg-transparent border-0 cursor-pointer transition-colors"
              >
                <Square className="w-4 h-4" />
              </button>

              {/* Track Info */}
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-white truncate">
                  {activeTrack?.name || "No track"}
                </div>
                <div className="font-mono text-[11px] text-zinc-600 mt-0.5">
                  {fmt(player.currentTime)} / {fmt(player.duration)}
                </div>
              </div>

              {/* DSP Mode selector */}
              <div className="relative">
                <button
                  onClick={() => setShowModes(s => !s)}
                  className="
                    flex items-center gap-1.5 px-3 py-1.5 rounded-md
                    bg-zinc-900 border border-white/[0.06]
                    text-[11px] font-medium text-zinc-400
                    hover:text-zinc-200 hover:border-white/[0.1]
                    transition-all cursor-pointer
                  "
                >
                  <span>{PLAYBACK_MODES.find(m => m.id === currentMode)?.icon}</span>
                  <span>{PLAYBACK_MODES.find(m => m.id === currentMode)?.label || "Normal"}</span>
                  <ChevronDown className="w-3 h-3" />
                </button>

                {showModes && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowModes(false)} />
                    <div className="absolute bottom-full right-0 mb-2 z-50 w-48 py-1 rounded-lg bg-zinc-900 border border-white/[0.08] shadow-2xl">
                      {PLAYBACK_MODES.map(m => (
                        <button
                          key={m.id}
                          onClick={() => { setCurrentMode(m.id); setShowModes(false); }}
                          className={`
                            w-full flex items-center gap-2 px-3 py-2
                            text-[11px] text-left cursor-pointer
                            border-0 bg-transparent transition-colors
                            ${currentMode === m.id
                              ? "text-purple-400 bg-purple-500/10"
                              : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.03]"
                            }
                          `}
                        >
                          <span>{m.icon}</span>
                          <span className="font-medium">{m.label}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* Volume */}
              <div className="flex items-center gap-2">
                <Volume2 className="w-4 h-4 text-zinc-600" />
                <input
                  type="range" min="0" max="1" step="0.01"
                  value={player.volume}
                  onChange={e => player.handleVolume(+e.target.value)}
                  className="w-20 cursor-pointer"
                />
              </div>
            </div>
          </div>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}
