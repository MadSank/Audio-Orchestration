/**
 * useJukeboxEngine.js
 * ====================
 * Tone.js-based infinite playback engine with probabilistic jump scheduling.
 */

import { useState, useRef, useEffect } from "react";
import * as Tone from "tone";
import { useApp } from "../context/AppContext";

export default function useJukeboxEngine(audioUrl, analysisData) {
  const { setProgress, setJumpCount: setAppJumpCount, setActiveJumpIndex, globalMeter } = useApp();

  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [currentTime, setCurrentTime] = useState(0);
  const [jumpCount, setJumpCount] = useState(0);

  const bufferRef = useRef(null);
  const gainRef = useRef(null);
  const filterRef = useRef(null);

  const stateRef = useRef({
    activePlayer: null,
    nodeStartTime: 0,
    playbackOffset: 0,
    playing: false,
    lastJumpBeatIdx: -999,
  });

  // Initialize Tone & load buffer
  useEffect(() => {
    if (!audioUrl) return;

    const filter = new Tone.Filter(20000, "lowpass").toDestination();
    if (globalMeter) filter.connect(globalMeter);
    const gain = new Tone.Gain(volume).connect(filter);

    filterRef.current = filter;
    gainRef.current = gain;

    const buffer = new Tone.ToneAudioBuffer(audioUrl, () => {
      bufferRef.current = buffer;
    });

    return () => {
      if (stateRef.current.activePlayer) {
        stateRef.current.activePlayer.stop();
        stateRef.current.activePlayer.dispose();
        stateRef.current.activePlayer = null;
      }
      if (gainRef.current) gainRef.current.dispose();
      if (filterRef.current) filterRef.current.dispose();
      if (bufferRef.current) bufferRef.current.dispose();
    };
  }, [audioUrl]);

  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = volume;
  }, [volume]);

  // Main loop & scheduler
  useEffect(() => {
    if (!analysisData || !playing || !bufferRef.current) return;

    let rafId;
    const { beats, jump_schedule, min_beats_between_jumps, song_duration_s } = analysisData;

    const scheduleJump = (targetTime) => {
      const state = stateRef.current;
      const now = Tone.now();
      const rampTime = 0.025;
      const jumpTime = now + rampTime;

      if (gainRef.current) {
        gainRef.current.gain.cancelScheduledValues(now);
        gainRef.current.gain.setValueAtTime(gainRef.current.gain.value, now);
        gainRef.current.gain.linearRampToValueAtTime(0, jumpTime);
      }

      if (state.activePlayer) {
        state.activePlayer.stop(jumpTime);
        const oldPlayer = state.activePlayer;
        setTimeout(() => {
          try { oldPlayer.dispose(); } catch (e) { }
        }, 100);
      }

      const player = new Tone.Player(bufferRef.current);
      player.connect(gainRef.current);
      player.fadeIn = 0.005;

      if (filterRef.current) {
        filterRef.current.frequency.cancelScheduledValues(now);
        filterRef.current.frequency.setValueAtTime(800, jumpTime);
        filterRef.current.frequency.exponentialRampToValueAtTime(20000, jumpTime + 0.5);
      }

      player.start(jumpTime, targetTime);

      if (gainRef.current) {
        gainRef.current.gain.setValueAtTime(0, jumpTime);
        gainRef.current.gain.linearRampToValueAtTime(volume, jumpTime + rampTime);
      }

      state.activePlayer = player;
      state.nodeStartTime = jumpTime;
      state.playbackOffset = targetTime;
    };

    const loop = () => {
      const state = stateRef.current;
      if (!state.playing) return;

      const now = Tone.now();
      const pos = (now - state.nodeStartTime) + state.playbackOffset;
      setCurrentTime(pos);

      // Update progress
      if (song_duration_s > 0) {
        setProgress(pos / song_duration_s);
      }

      if (pos >= bufferRef.current.duration - 0.05) {
        scheduleJump(0);
        state.lastJumpBeatIdx = -999;
      }

      let currentBeat = null;
      for (let i = 0; i < beats.length; i++) {
        if (pos >= beats[i].time && (i === beats.length - 1 || pos < beats[i + 1].time)) {
          currentBeat = beats[i];
          break;
        }
      }

      if (currentBeat) {
        if (currentBeat.index - state.lastJumpBeatIdx >= min_beats_between_jumps) {
          const trigger = jump_schedule.find(j => j.beat_idx === currentBeat.index);
          if (trigger && (pos >= trigger.trigger_time) && (pos < trigger.trigger_time + 0.05)) {
            const r = Math.random();
            let cumProb = 0;
            let chosenCandidate = null;
            for (const cand of trigger.candidates) {
              cumProb += cand.probability;
              if (r <= cumProb) {
                chosenCandidate = cand;
                break;
              }
            }
            if (!chosenCandidate && trigger.candidates.length > 0) {
              chosenCandidate = trigger.candidates[trigger.candidates.length - 1];
            }

            if (chosenCandidate) {
              scheduleJump(chosenCandidate.target_time);
              state.lastJumpBeatIdx = chosenCandidate.target_beat_idx;
              setJumpCount(c => c + 1);
              setAppJumpCount(c => c + 1);

              // Find jump index for UI highlight
              const jumpIdx = jump_schedule.findIndex(j => j.beat_idx === currentBeat.index);
              setActiveJumpIndex(jumpIdx);
              setTimeout(() => setActiveJumpIndex(-1), 300);
            }
          }
        }
      }

      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [playing, analysisData, volume, setProgress, setAppJumpCount, setActiveJumpIndex]);

  const togglePlay = async () => {
    const state = stateRef.current;
    if (!playing) {
      if (!bufferRef.current) return;
      await Tone.start();
      const player = new Tone.Player(bufferRef.current);
      player.connect(gainRef.current);
      player.start(0, state.playbackOffset);
      state.activePlayer = player;
      state.nodeStartTime = Tone.now();
      state.playing = true;
      setPlaying(true);
    } else {
      if (state.activePlayer) {
        state.activePlayer.stop();
        state.activePlayer.dispose();
        state.activePlayer = null;
      }
      state.playbackOffset += (Tone.now() - state.nodeStartTime);
      state.playing = false;
      setPlaying(false);
    }
  };

  const stop = () => {
    const state = stateRef.current;
    if (state.activePlayer) {
      state.activePlayer.stop();
      state.activePlayer.dispose();
      state.activePlayer = null;
    }
    state.playing = false;
    state.playbackOffset = 0;
    setPlaying(false);
    setCurrentTime(0);
    setJumpCount(0);
  };

  return { playing, togglePlay, stop, currentTime, volume, setVolume, jumpCount };
}
