/**
 * AppContext.jsx — SAICS v5 Shared Audio State
 * ==============================================
 * Lightweight context for shared audio/playback state.
 * Consumed by useLibraryPlayer, useJukeboxEngine, useTransitionEngine.
 */

import { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";
import * as Tone from "tone";

const AppCtx = createContext(null);

export function AppProvider({ children }) {
  // Global Audio Analyzers
  const globalMeterRef = useRef(null);
  const globalFFTRef = useRef(null);

  // Initialize once
  useEffect(() => {
    globalMeterRef.current = new Tone.Meter({ smoothing: 0.8 });
    globalFFTRef.current = new Tone.Analyser("fft", 32); // 32 bins is enough for bass detection
    globalMeterRef.current.connect(globalFFTRef.current);
    
    return () => {
      globalMeterRef.current?.dispose();
      globalFFTRef.current?.dispose();
    };
  }, []);

  // Playback progress 0→1
  const [playbackProgress, setPlaybackProgress] = useState(0);

  // Analysis / processing
  const [analysisData, setAnalysisData]   = useState(null);
  const [isProcessing, setIsProcessing]   = useState(false);

  // Jukebox state
  const [jumpCount, setJumpCount]             = useState(0);
  const [activeJumpIndex, setActiveJumpIndex] = useState(-1);

  // Transition state
  const [transitionResult, setTransitionResult] = useState(null);
  const [transitionPhase, setTransitionPhase]   = useState("a"); // "a" | "transition" | "b"

  // Library playback DSP mode
  const [currentMode, setCurrentMode] = useState("normal");

  // High-frequency progress ref (avoids re-renders)
  const progressRef = useRef(0);
  const seekRef     = useRef(null);

  const registerSeek = useCallback((fn) => { seekRef.current = fn; }, []);
  const seekTo = useCallback((p, isScrubbing = false) => {
    if (seekRef.current) seekRef.current(p, isScrubbing);
  }, []);

  const setProgress = useCallback((p) => {
    progressRef.current = p;
    setPlaybackProgress(p);
  }, []);

  const resetPlaybackState = useCallback(() => {
    setPlaybackProgress(0);
    setAnalysisData(null);
    setTransitionResult(null);
    setJumpCount(0);
    setActiveJumpIndex(-1);
    setTransitionPhase("a");
    progressRef.current = 0;
  }, []);

  return (
    <AppCtx.Provider
      value={{
        playbackProgress,
        analysisData,
        isProcessing,
        jumpCount,
        activeJumpIndex,
        transitionResult,
        transitionPhase,
        currentMode,
        progressRef,
        globalMeter: globalMeterRef.current,
        globalFFT: globalFFTRef.current,

        setProgress,
        setAnalysisData,
        setIsProcessing,
        setJumpCount,
        setActiveJumpIndex,
        setTransitionResult,
        setTransitionPhase,
        setCurrentMode,
        registerSeek,
        seekTo,
        resetPlaybackState,
      }}
    >
      {children}
    </AppCtx.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
