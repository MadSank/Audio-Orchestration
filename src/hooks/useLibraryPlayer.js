/**
 * useLibraryPlayer.js
 * ====================
 * Tone.js playback engine with DSP effect routing and WaveSurfer sync.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import * as Tone from "tone";
import WaveSurfer from "wavesurfer.js";
import { useApp } from "../context/AppContext";

const API = "http://localhost:8000";

const PLAYBACK_MODES = [
  { id: "normal",        label: "Normal",         icon: "▶" },
  { id: "sped_up",       label: "Sped Up",        icon: "⏩" },
  { id: "8d_audio",      label: "8D Audio",       icon: "🎧" },
  { id: "lofi_vhs",      label: "Lofi VHS",       icon: "📼" },
  { id: "slowed_reverb", label: "Slowed + Reverb", icon: "🌙" },
  { id: "nightcore",     label: "Nightcore",      icon: "⚡" },
  { id: "bass_boost",    label: "Bass Boost",     icon: "🔊" },
  { id: "vinyl_crackle", label: "Vinyl Crackle",  icon: "💿" },
  { id: "underwater",    label: "Underwater",     icon: "🫧" },
];

export { PLAYBACK_MODES };

export default function useLibraryPlayer() {
  const { setProgress, currentMode, setCurrentMode, registerSeek, globalMeter } = useApp();

  const [activeId,    setActiveId]    = useState(null);
  const [playing,     setPlaying]     = useState(false);
  const [isLoading,   setIsLoading]   = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration,    setDuration]    = useState(0);
  const [volume,      setVolumeState] = useState(0.8);

  const containerRef = useRef(null);
  const wavesurferRef = useRef(null);
  const noiseSynthRef = useRef(null);

  const engineRef = useRef({
    player: null,
    gain: null,
    effects: [],
    buffer: null,
    startTime: 0,
    offset: 0,
    playing: false,
  });

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wavesurferRef.current) wavesurferRef.current.destroy();
      const eng = engineRef.current;
      if (eng.player) eng.player.dispose();
      if (eng.gain) eng.gain.dispose();
      if (eng.buffer) eng.buffer.dispose();
      eng.effects.forEach(fx => fx.dispose());
    };
  }, []);

  const clearEffects = useCallback(() => {
    const eng = engineRef.current;
    if (eng.player) eng.player.disconnect();
    eng.effects.forEach(fx => {
      try { fx.dispose(); } catch (e) { }
    });
    eng.effects = [];
    if (eng.player) eng.player.playbackRate = 1.0;
    if (noiseSynthRef.current) {
      try { noiseSynthRef.current.stop(); noiseSynthRef.current.dispose(); } catch (e) { }
      noiseSynthRef.current = null;
    }
  }, []);

  const routeEffects = useCallback((player, gainNode, m) => {
    clearEffects();
    let chain = [];

    switch (m) {
      case "normal":
        player.connect(gainNode);
        break;
      case "sped_up":
        player.playbackRate = 1.25;
        player.connect(gainNode);
        break;
      case "8d_audio": {
        const panner = new Tone.AutoPanner("0.1Hz").start();
        const pReverb = new Tone.Freeverb({ roomSize: 0.6, dampening: 3000 });
        chain.push(panner, pReverb);
        player.chain(panner, pReverb, gainNode);
        break;
      }
      case "lofi_vhs": {
        player.playbackRate = 0.9;
        const lofiFilter = new Tone.Filter(2000, "lowpass");
        const crusher = new Tone.BitCrusher(4);
        const vibrato = new Tone.Vibrato(5, 0.1);
        chain.push(lofiFilter, crusher, vibrato);
        player.chain(crusher, lofiFilter, vibrato, gainNode);
        break;
      }
      case "slowed_reverb": {
        player.playbackRate = 0.8;
        const jcReverb = new Tone.JCReverb(0.7);
        jcReverb.wet.value = 0.4;
        const chorus = new Tone.Chorus(0.8, 4, 0.25).start();
        chain.push(jcReverb, chorus);
        player.chain(chorus, jcReverb, gainNode);
        break;
      }
      case "nightcore": {
        player.playbackRate = 1.3;
        const hiShelf = new Tone.EQ3({ high: 4 });
        chain.push(hiShelf);
        player.chain(hiShelf, gainNode);
        break;
      }
      case "bass_boost": {
        const eq = new Tone.EQ3({ low: 12, mid: 0, high: -2 });
        const limiter = new Tone.Limiter(-2);
        chain.push(eq, limiter);
        player.chain(eq, limiter, gainNode);
        break;
      }
      case "vinyl_crackle": {
        const bpFilter = new Tone.Filter({ frequency: 3000, type: "bandpass", Q: 0.7 });
        const vinylReverb = new Tone.Freeverb({ roomSize: 0.3, dampening: 5000 });
        vinylReverb.wet.value = 0.15;
        chain.push(bpFilter, vinylReverb);
        player.chain(bpFilter, vinylReverb, gainNode);
        const noise = new Tone.Noise("brown");
        const noiseFilter = new Tone.Filter({ frequency: 4000, type: "bandpass", Q: 2 });
        const noiseGain = new Tone.Gain(0.025).connect(gainNode);
        noise.chain(noiseFilter, noiseGain);
        noise.start();
        chain.push(noiseFilter, noiseGain);
        noiseSynthRef.current = noise;
        break;
      }
      case "underwater": {
        const lpFilter = new Tone.AutoFilter({
          frequency: 0.15, baseFrequency: 200, octaves: 1.5, type: "sine"
        }).start();
        const uwReverb = new Tone.Freeverb({ roomSize: 0.8, dampening: 1500 });
        uwReverb.wet.value = 0.5;
        chain.push(lpFilter, uwReverb);
        player.chain(lpFilter, uwReverb, gainNode);
        break;
      }
      default:
        player.connect(gainNode);
    }
    engineRef.current.effects = chain;
  }, [clearEffects]);

  // Update effects when mode changes
  useEffect(() => {
    const eng = engineRef.current;
    if (eng.player && eng.gain) {
      const wasPlaying = eng.playing;
      const offset = eng.offset + (wasPlaying ? (Tone.now() - eng.startTime) * eng.player.playbackRate : 0);
      if (wasPlaying) eng.player.stop();
      routeEffects(eng.player, eng.gain, currentMode);
      eng.offset = offset;
      if (wasPlaying) {
        eng.player.start(0, offset);
        eng.startTime = Tone.now();
      }
    }
  }, [currentMode, routeEffects]);

  // Sync WaveSurfer to Tone.js + push progress to AppContext
  useEffect(() => {
    let rafId;
    const loop = () => {
      const eng = engineRef.current;
      if (eng.playing && eng.player && eng.buffer) {
        const rate = eng.player.playbackRate;
        const pos = eng.offset + (Tone.now() - eng.startTime) * rate;

        if (pos >= eng.buffer.duration) {
          eng.playing = false;
          setPlaying(false);
          eng.offset = 0;
          setCurrentTime(0);
          setProgress(0);
          if (wavesurferRef.current) wavesurferRef.current.seekTo(0);
        } else {
          setCurrentTime(pos);
          const fraction = pos / eng.buffer.duration;
          setProgress(fraction);
          if (wavesurferRef.current) wavesurferRef.current.seekTo(fraction);
        }
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [setProgress]);

  const seekTo = useCallback((p, isScrubbing = false) => {
    const eng = engineRef.current;
    if (eng.buffer) {
      const pos = Math.max(0, Math.min(1, p)) * eng.buffer.duration;
      eng.offset = pos;
      setCurrentTime(pos);
      setProgress(p);
      if (wavesurferRef.current) wavesurferRef.current.seekTo(p);

      if (eng.playing && eng.player) {
        if (isScrubbing) {
          eng.player.stop();
        } else {
          eng.player.stop();
          eng.player.start(0, pos);
          eng.startTime = Tone.now();
        }
      }
    }
  }, [setProgress]);

  useEffect(() => {
    if (registerSeek) registerSeek(seekTo);
  }, [registerSeek, seekTo]);

  const loadAndPlay = useCallback(async (track, waveformContainer) => {
    if (isLoading) return;
    const eng = engineRef.current;

    // Toggle pause/play if same track
    if (activeId === track.id && eng.player) {
      if (eng.playing) {
        eng.player.stop();
        eng.offset += (Tone.now() - eng.startTime) * eng.player.playbackRate;
        eng.playing = false;
        setPlaying(false);
      } else {
        await Tone.start();
        eng.player.start(0, eng.offset);
        eng.startTime = Tone.now();
        eng.playing = true;
        setPlaying(true);
      }
      return;
    }

    // New track
    if (eng.player) eng.player.stop();
    eng.playing = false;
    setPlaying(false);
    setActiveId(track.id);
    setCurrentTime(0);
    eng.offset = 0;

    if (wavesurferRef.current) {
      wavesurferRef.current.destroy();
      wavesurferRef.current = null;
    }

    clearEffects();
    if (eng.player) eng.player.dispose();
    if (eng.gain) eng.gain.dispose();
    if (eng.buffer) eng.buffer.dispose();

    // Build WaveSurfer
    if (waveformContainer) {
      setTimeout(() => {
        const ws = WaveSurfer.create({
          container: waveformContainer,
          waveColor: "rgba(139, 92, 246, 0.4)",
          progressColor: "rgba(139, 92, 246, 0.9)",
          cursorColor: "#f9fafb",
          barWidth: 2, barGap: 1, barRadius: 2, height: 48,
          normalize: true, url: track.url, interact: true,
        });
        ws.on("interaction", (newTime) => {
          if (engineRef.current.player && engineRef.current.buffer) {
            const wasPlaying = engineRef.current.playing;
            if (wasPlaying) engineRef.current.player.stop();
            engineRef.current.offset = (newTime / ws.getDuration()) * engineRef.current.buffer.duration;
            setCurrentTime(engineRef.current.offset);
            if (wasPlaying) {
              engineRef.current.player.start(0, engineRef.current.offset);
              engineRef.current.startTime = Tone.now();
            }
          }
        });
        ws.setVolume(0);
        wavesurferRef.current = ws;
      }, 50);
    }

    // Build Tone
    setIsLoading(true);
    await Tone.start();
    eng.gain = new Tone.Gain(volume).toDestination();
    if (globalMeter) eng.gain.connect(globalMeter);

    try {
      const buffer = new Tone.ToneAudioBuffer(track.url, () => {
        eng.buffer = buffer;
        setDuration(buffer.duration);
        const player = new Tone.Player(buffer);
        eng.player = player;
        routeEffects(player, eng.gain, currentMode);
        player.start(0, 0);
        eng.startTime = Tone.now();
        eng.playing = true;
        setPlaying(true);
        setIsLoading(false);
      }, () => {
        setIsLoading(false);
      });
    } catch (err) {
      setIsLoading(false);
    }
  }, [activeId, volume, currentMode, clearEffects, routeEffects, isLoading, setProgress]);

  const handleVolume = (v) => {
    setVolumeState(v);
    if (engineRef.current.gain) engineRef.current.gain.gain.value = v;
  };

  const stop = () => {
    const eng = engineRef.current;
    if (eng.player) {
      eng.player.stop();
      eng.player.dispose();
      eng.player = null;
    }
    eng.playing = false;
    eng.offset = 0;
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setActiveId(null);
    setProgress(0);
    if (wavesurferRef.current) {
      wavesurferRef.current.destroy();
      wavesurferRef.current = null;
    }
    clearEffects();
  };

  const handleDownload = useCallback(async (modeId, activeTrack) => {
    if (!activeTrack) return null;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const body = new FormData();
    body.append("file", activeTrack.file);
    body.append("mode", modeId);

    const res = await fetch(`${API}/render-version`, {
      method: "POST", body, signal: controller.signal,
    });

    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(await res.text().catch(() => "Unknown error"));

    const blob = await res.blob();
    const modeLabel = PLAYBACK_MODES.find(m => m.id === modeId)?.label || modeId;
    const filename = `${activeTrack.name} (${modeLabel}).mp3`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }, []);

  return {
    activeId, playing, isLoading, currentTime, duration,
    volume, loadAndPlay, handleVolume, stop, handleDownload,
    wavesurferRef, containerRef,
  };
}
