/**
 * useTransitionEngine.js
 * =======================
 * Handles cross-track transition API calls and preview playback.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import WaveSurfer from "wavesurfer.js";
import { useApp } from "../context/AppContext";

const API = "http://localhost:8000";

export default function useTransitionEngine() {
  const { setTransitionResult, setTransitionPhase, setProgress } = useApp();

  const [mode, setMode]           = useState("auto");
  const [loading, setLoading]     = useState(false);
  const [result, setResult]       = useState(null);
  const [error, setError]         = useState(null);

  const previewWsRef       = useRef(null);
  const previewContainerRef = useRef(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);

  const analyzeTransition = useCallback((trackA, trackB) => {
    if (!trackA || !trackB) return;
    setLoading(true); setError(null); setResult(null);

    const body = new FormData();
    body.append("mode", mode);
    body.append("track_a", trackA.file);
    body.append("track_b", trackB.file);

    fetch(`${API}/transition`, { method: "POST", body })
      .then(r => r.ok ? r.json() : Promise.reject(new Error("Transition analysis failed")))
      .then(d => {
        setResult(d);
        setTransitionResult(d);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [mode, setTransitionResult]);



  // Setup preview WaveSurfer when result arrives
  const setupPreview = useCallback((container) => {
    if (!result?.preview_url || !container) return;
    if (previewWsRef.current) previewWsRef.current.destroy();

    const ws = WaveSurfer.create({
      container,
      waveColor: "rgba(167, 139, 250, 0.4)",
      progressColor: "rgba(167, 139, 250, 0.9)",
      cursorColor: "#f9fafb",
      barWidth: 2, barGap: 1, barRadius: 2, height: 48,
      normalize: true,
      url: `${API}${result.preview_url}`,
    });

    ws.on("ready", () => ws.play());
    ws.on("play", () => {
      setPreviewPlaying(true);
      setTransitionPhase("a");
    });
    ws.on("pause", () => setPreviewPlaying(false));
    ws.on("finish", () => {
      setPreviewPlaying(false);
      setTransitionPhase("a");
    });

    // Track progress to detect transition point for Mars camera sweep
    ws.on("timeupdate", (time) => {
      if (result && ws.getDuration() > 0) {
        const frac = time / ws.getDuration();
        setProgress(frac);

        // Estimate transition midpoint
        const transitionFrac = result.src_time / (result.duration_a + result.duration_b - result.tgt_time);
        if (frac < transitionFrac * 0.9) {
          setTransitionPhase("a");
        } else if (frac < transitionFrac * 1.1) {
          setTransitionPhase("transition");
        } else {
          setTransitionPhase("b");
        }
      }
    });

    previewWsRef.current = ws;
  }, [result, setTransitionPhase, setProgress]);

  const togglePreview = () => previewWsRef.current?.playPause();

  const cleanup = useCallback(() => {
    if (previewWsRef.current) {
      previewWsRef.current.destroy();
      previewWsRef.current = null;
    }
    setResult(null);
    setError(null);
    setPreviewPlaying(false);
  }, []);

  return {
    mode, setMode, loading, result, error,
    previewPlaying, previewContainerRef,
    analyzeTransition,
    setupPreview, togglePreview, cleanup,
  };
}
