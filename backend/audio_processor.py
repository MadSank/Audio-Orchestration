"""
audio_processor.py
==================
Structure-Aware Intelligent Audio Continuity System — DSP Core

Pipeline:
  1. Feature Extraction  → beats, tempo, chroma, MFCCs, beat phase
  2. Self-Similarity     → SSM + transition graph with jump costs
                           (meter-aware: downbeat-phase penalty)
  3. Pathfinding         → graph walk producing ~5 min playback path
  4. Synthesis           → splice + adaptive crossfade (50-100 ms)
  5. Export              → 16-bit PCM WAV to a temp file

Cross-track transition (POST /transition):
  - Extracts features for two tracks independently
  - Builds a cross-track similarity matrix (tail-of-A × head-of-B)
  - Finds the best crossfade beat pair by composite score
  - Synthesises the FULL mixed song: [A] + [S-curve overlap] + [B]
"""

import os
import math
import tempfile
import logging
from dataclasses import dataclass, field
from typing import List, Tuple, Optional

import numpy as np
import librosa
import soundfile as sf
from scipy.spatial.distance import cdist
from scipy import signal as scipy_signal
from scipy.signal import sosfilt, sosfilt_zi

logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data Structures
# ---------------------------------------------------------------------------

@dataclass
class Beat:
    """A single beat with its sample position and feature vector."""
    index: int
    sample: int
    time: float
    beat_phase: int = 0           # 0 = downbeat (beat 1), 1, 2, 3
    feature: np.ndarray = field(default_factory=lambda: np.array([]))


@dataclass
class TransitionEdge:
    """A directed jump edge in the transition graph."""
    source: int
    target: int
    cost: float
    score: float = 0.0   # 1.0 - cost; pre-computed for threshold checks


@dataclass
class CandidateTransition:
    """A single scored beat-pair transition candidate."""
    src_beat_idx: int
    tgt_beat_idx: int
    src_time: float
    tgt_time: float
    score: float


@dataclass
class TransitionResult:
    """Result from TrackTransitionProcessor.find_best_crossfade_point."""
    src_beat_idx: int
    tgt_beat_idx: int
    src_time: float
    tgt_time: float
    score: float
    tempo_a: float
    tempo_b: float
    tempo_delta: float
    key_distance: int
    duration_a: float = 0.0
    duration_b: float = 0.0
    candidates: list = field(default_factory=list)  # List[CandidateTransition]


# ---------------------------------------------------------------------------
# Main Processor Class
# ---------------------------------------------------------------------------

class AudioContinuityProcessor:
    """
    End-to-end processor that turns a single audio file into an
    infinite-feeling, non-repetitive loop exported as a WAV file.
    """

    TARGET_DURATION_S: float = 300.0
    TOP_K_JUMPS: int = 4
    MIN_JUMP_DELTA: int = 8
    JUMP_SCORE_GATE: float = 0.85  # only edges with score >= this are usable jumps
    CROSSFADE_MIN_MS: float = 50.0
    CROSSFADE_MAX_MS: float = 100.0
    SSM_CHROMA_W: float = 0.5
    SSM_MFCC_W: float = 0.5
    ANTI_LOOP_WINDOW: int = 16

    # Meter-aware jump penalty ---------------------------------------------------
    # Penalty added to acoustic jump cost when source and target beat phases differ.
    # PHASE_PENALTY_MAX = 0   → pure acoustic matching (original behaviour)
    # PHASE_PENALTY_MAX = 0.35 → strong pull toward beat-1 → beat-1 jumps
    PHASE_PENALTY_MAX: float = 0.35
    PREFERRED_PHASE: int = 0   # 0 = downbeat

    def __init__(self, filepath: str):
        self.filepath = filepath
        self.y: Optional[np.ndarray] = None
        self.sr: int = 22050
        self.beat_times: np.ndarray = np.array([])
        self.beat_frames: np.ndarray = np.array([])
        self.tempo: float = 120.0
        self.beats: List[Beat] = []
        self.ssm: np.ndarray = np.array([])
        self.edges: List[TransitionEdge] = []

    # =========================================================================
    # Part 1 — Feature Extraction
    # =========================================================================

    def load_and_extract(self) -> None:
        log.info("Loading audio: %s", self.filepath)
        self.y, self.sr = librosa.load(self.filepath, mono=True, sr=None)
        duration = librosa.get_duration(y=self.y, sr=self.sr)
        log.info("  Duration: %.2f s  |  Sample rate: %d Hz", duration, self.sr)

        self.tempo, self.beat_frames = librosa.beat.beat_track(
            y=self.y, sr=self.sr, units="frames"
        )
        if isinstance(self.tempo, np.ndarray):
            self.tempo = float(self.tempo[0])

        self.beat_times = librosa.frames_to_time(self.beat_frames, sr=self.sr)
        log.info("  Tempo: %.1f BPM  |  Beats: %d", self.tempo, len(self.beat_frames))

        beat_phases = self._estimate_beat_phases(self.beat_frames)

        chroma_cqt  = librosa.feature.chroma_cqt(y=self.y, sr=self.sr)
        chroma_sync = librosa.util.sync(chroma_cqt, self.beat_frames, aggregate=np.median)

        mfcc      = librosa.feature.mfcc(y=self.y, sr=self.sr, n_mfcc=13)
        mfcc_sync = librosa.util.sync(mfcc, self.beat_frames, aggregate=np.mean)

        def l2_norm(mat):
            norms = np.linalg.norm(mat, axis=0, keepdims=True)
            norms[norms == 0] = 1.0
            return mat / norms

        combined = np.vstack([l2_norm(chroma_sync), l2_norm(mfcc_sync)]).T  # (n, 25)

        beat_samples = librosa.frames_to_samples(self.beat_frames)
        self.beats = [
            Beat(
                index=i,
                sample=int(beat_samples[i]),
                time=float(self.beat_times[i]),
                beat_phase=int(beat_phases[i]),
                feature=combined[i],
            )
            for i in range(len(self.beat_frames))
        ]
        log.info(
            "  Feature vectors built (dim=%d)  |  downbeats: %d",
            combined.shape[1],
            sum(1 for b in self.beats if b.beat_phase == self.PREFERRED_PHASE),
        )

    def _estimate_beat_phases(self, beat_frames: np.ndarray) -> np.ndarray:
        """
        Assign a phase ∈ {0,1,2,3} to each beat.

        We look for the phase offset that maximises beat-synchronous RMS energy
        at every-4th-beat positions — the downbeat tends to be the loudest beat
        in each bar.  Falls back to plain modulo-4 for very short tracks.
        """
        n = len(beat_frames)
        if n < 8:
            return np.arange(n) % 4

        rms = librosa.feature.rms(y=self.y)[0]
        rms_sync = librosa.util.sync(
            rms[np.newaxis, :], beat_frames, aggregate=np.mean
        )[0]

        best_phase, best_energy = 0, -np.inf
        for offset in range(4):
            energy = rms_sync[offset::4].sum()
            if energy > best_energy:
                best_energy = energy
                best_phase = offset

        phases = np.array([(i - best_phase) % 4 for i in range(n)], dtype=int)
        log.info("  Downbeat phase offset: %d", best_phase)
        return phases

    # =========================================================================
    # Part 2 — Self-Similarity Matrix + Meter-Aware Transition Graph
    # =========================================================================

    def build_similarity_graph(self) -> None:
        """
        Compute SSM and build the transition graph.

        Meter-aware cost
        ----------------
        Raw acoustic cost (1 - similarity) is augmented by a phase-mismatch
        penalty that uses circular distance on the 4/4 bar:

            phase_pen(src, tgt) = PHASE_PENALTY_MAX * circ_dist(src, tgt) / 2

        where circ_dist ∈ {0, 1, 2} (max mismatch across a bar).

        Results: beat-1→beat-1 jumps have the lowest total cost; the graph
        naturally steers the path to land on downbeats.
        """
        n = len(self.beats)
        if n < self.MIN_JUMP_DELTA + 2:
            raise ValueError("Audio too short to build a meaningful graph.")

        feat_matrix  = np.stack([b.feature for b in self.beats])
        chroma_feats = feat_matrix[:, :12]
        mfcc_feats   = feat_matrix[:, 12:]

        dist_chroma   = cdist(chroma_feats, chroma_feats, metric="cosine").clip(0, 1)
        dist_mfcc     = cdist(mfcc_feats,   mfcc_feats,   metric="cosine").clip(0, 1)
        dist_combined = self.SSM_CHROMA_W * dist_chroma + self.SSM_MFCC_W * dist_mfcc

        self.ssm = 1.0 - dist_combined
        log.info("SSM computed  (%d × %d)", n, n)

        # ---- Strict meter mask -----------------------------------------------
        # Only allow jumps between beats that sit at the same position within
        # the bar (e.g. beat-1 → beat-1, beat-3 → beat-3).  This is a hard
        # gate: candidates with mismatched phases are set to infinite cost and
        # never become edges, regardless of how good their acoustic similarity is.
        phases         = np.array([b.beat_phase for b in self.beats], dtype=int)
        same_phase_mat = phases[:, None] == phases[None, :]   # (n, n) bool

        self.edges = []
        for src in range(n):
            mask = np.ones(n, dtype=bool)
            mask[max(0, src - self.MIN_JUMP_DELTA): src + self.MIN_JUMP_DELTA + 1] = False
            # Hard-gate: target must share the same beat position in the bar
            mask &= same_phase_mat[src]
            if not mask.any():
                continue

            cost_row = dist_combined[src].copy()
            cost_row[~mask] = np.inf

            k = min(self.TOP_K_JUMPS, int(mask.sum()))
            top_k = np.argpartition(cost_row, k)[:k]
            for tgt in top_k:
                if not mask[tgt]:
                    continue
                edge_cost  = float(dist_combined[src, tgt])
                edge_score = 1.0 - edge_cost
                if edge_score < self.JUMP_SCORE_GATE:
                    continue   # discard sub-threshold edges entirely
                self.edges.append(TransitionEdge(
                    source=src, target=tgt,
                    cost=edge_cost, score=edge_score,
                ))

        log.info("Transition graph: %d edges", len(self.edges))

    # =========================================================================
    # Part 3 — Pathfinding
    # =========================================================================

    def find_playback_path(self) -> List[Beat]:
        n = len(self.beats)
        if n == 0:
            raise ValueError("No beats found.")

        adj: dict[int, List[TransitionEdge]] = {i: [] for i in range(n)}
        for e in self.edges:
            adj[e.source].append(e)

        song_dur = self.beats[-1].time if self.beats else 0.0
        p_jump   = min(0.35, max(0.10, 1.0 - (song_dur / self.TARGET_DURATION_S)))
        log.info("Jump probability: %.2f", p_jump)

        path: List[Beat] = []
        current, accumulated = 0, 0.0
        recent: List[int] = []
        rng = np.random.default_rng(seed=42)

        for _ in range(int(self.TARGET_DURATION_S * 20)):
            beat = self.beats[current]
            path.append(beat)

            beat_dur = (
                self.beats[current + 1].time - beat.time
                if current + 1 < n else 60.0 / self.tempo
            )
            accumulated += beat_dur
            if accumulated >= self.TARGET_DURATION_S:
                break

            recency: dict[int, float] = {
                idx: (self.ANTI_LOOP_WINDOW - r) / self.ANTI_LOOP_WINDOW
                for r, idx in enumerate(reversed(recent[-self.ANTI_LOOP_WINDOW:]))
            }

            if rng.random() < p_jump and adj[current]:
                # Only consider edges that meet the quality gate
                cands = [e for e in adj[current] if e.score >= self.JUMP_SCORE_GATE]
                if cands:
                    scores = np.array([e.score - recency.get(e.target, 0.0) * 0.4 for e in cands])
                    scores -= scores.max()
                    probs   = np.exp(scores * 3.0)
                    probs  /= probs.sum()
                    next_beat = cands[int(rng.choice(len(cands), p=probs))].target
                else:
                    # No high-quality jump available — fall back to sequential
                    next_beat = (current + 1) % n
            else:
                next_beat = (current + 1) % n

            recent.append(current)
            if len(recent) > self.ANTI_LOOP_WINDOW * 2:
                recent.pop(0)
            current = next_beat

        log.info("Playback path: %d beats  |  %.1f s", len(path), accumulated)
        return path

    # =========================================================================
    # Part 4 — Synthesis
    # =========================================================================

    def _crossfade_samples(self, n_samples: int) -> Tuple[np.ndarray, np.ndarray]:
        """
        Equal-power S-curve crossfade window.

        Uses a smoothstep (3t²−2t³) shape instead of a plain quarter-cosine.
        This keeps the instantaneous power constant through the transition
        (fade_out² + fade_in² ≈ 1 everywhere) while also having zero first-
        derivative at both endpoints — so there is no kink in the amplitude
        envelope at the splice boundaries, which eliminates the subtle click
        that a hard cosine edge can introduce when waveforms are out of phase.
        """
        t = np.linspace(0.0, 1.0, n_samples, endpoint=True)
        # Smoothstep: zero slope at t=0 and t=1
        s       = t * t * (3.0 - 2.0 * t)      # 0 → 1, S-shaped
        fade_in  = np.sqrt(s)                    # power-preserving
        fade_out = np.sqrt(1.0 - s)
        return fade_out, fade_in

    def _beat_duration_samples(self, beat_idx: int) -> int:
        b = self.beats[beat_idx] if beat_idx < len(self.beats) else None
        if b is None:
            return int(self.sr * 60.0 / self.tempo)
        if b.index + 1 < len(self.beats):
            dur_s = self.beats[b.index + 1].time - b.time
        else:
            dur_s = 60.0 / self.tempo
        return max(1, int(dur_s * self.sr))

    def synthesise(self, path: List[Beat]) -> np.ndarray:
        if not path:
            raise ValueError("Empty path.")

        beat_dur_s    = 60.0 / self.tempo
        xfade_s       = min(self.CROSSFADE_MAX_MS / 1000.0,
                            max(self.CROSSFADE_MIN_MS / 1000.0, beat_dur_s * 0.15))
        xfade_samples = int(xfade_s * self.sr)
        audio_len     = self.y.shape[0]

        total_src = sum(self._beat_duration_samples(b.index) for b in path)
        out = np.zeros(total_src + xfade_samples * 2, dtype=np.float32)
        write_pos = 0

        for pos, beat in enumerate(path):
            src_end    = min(beat.sample + self._beat_duration_samples(beat.index), audio_len)
            actual_dur = src_end - beat.sample
            if actual_dur <= 0:
                continue

            chunk   = self.y[beat.sample:src_end].astype(np.float32)
            is_last = pos == len(path) - 1
            xf      = min(xfade_samples, actual_dur // 4)
            body    = max(0, actual_dur - (0 if is_last else xf))

            end = write_pos + body
            if end > len(out):
                out = np.pad(out, (0, end - len(out) + xf))
            out[write_pos:end] += chunk[:body]

            if not is_last and xf > 0:
                fo, _ = self._crossfade_samples(xf)
                tail   = chunk[body:body + xf]
                tl     = len(tail)
                if tl:
                    p = write_pos + body
                    if p + tl > len(out):
                        out = np.pad(out, (0, p + tl - len(out) + xf))
                    out[p:p + tl] += tail * fo[:tl]

                nb     = path[pos + 1]
                nb_c   = self.y[nb.sample:nb.sample + xf].astype(np.float32)
                nl     = len(nb_c)
                if nl:
                    _, fi = self._crossfade_samples(nl)
                    p = write_pos + body
                    if p + nl > len(out):
                        out = np.pad(out, (0, p + nl - len(out) + xf))
                    out[p:p + nl] += nb_c * fi

            write_pos += body

        out  = out[:write_pos + xfade_samples]
        peak = np.max(np.abs(out))
        if peak > 0.0:
            out = out * (10 ** (-1.0 / 20.0) / peak)
        log.info("Synthesis complete: %.2f s", len(out) / self.sr)
        return out

    def process(self) -> str:
        self.load_and_extract()
        self.build_similarity_graph()
        path      = self.find_playback_path()
        audio_out = self.synthesise(path)
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False, prefix="saics_")
        sf.write(tmp.name, audio_out, self.sr, subtype="PCM_16")
        log.info("Output WAV: %s", tmp.name)
        return tmp.name


# ---------------------------------------------------------------------------
# Cross-track transition engine
# ---------------------------------------------------------------------------

class TrackTransitionProcessor:
    """
    Finds the optimal beat pair for crossfading Track A into Track B,
    then renders the complete mixed song as a single WAV file.

    Algorithm
    ---------
    1.  Full feature extraction on both tracks (beats, chroma, MFCCs, phase).
    2.  Cross-track similarity matrix over tail-of-A × head-of-B.
    3.  Composite score:
            score = CHROMA_W * chroma_sim
                  + MFCC_W   * mfcc_sim
                  - TEMPO_W  * tempo_penalty   (|ΔBPM| / 20, clipped to 1)
                  - PHASE_W  * phase_penalty   (1 unless both beats are downbeats)
    4.  Best (src_beat, tgt_beat) returned as TransitionResult.
    5.  Full mix WAV:
            [all of A up to crossfade start]
          + [S-curve equal-power overlap region, CROSSFADE_DURATION_S seconds]
          + [all of B from crossfade end to its end]
    """

    CHROMA_W: float = 0.50
    MFCC_W:   float = 0.30
    TEMPO_W:  float = 0.12
    PHASE_W:  float = 0.08

    SEARCH_TAIL_FRAC: float = 0.40
    SEARCH_HEAD_FRAC: float = 0.40

    CROSSFADE_DURATION_S: float = 4.0   # length of the overlap region in seconds

    def __init__(self, path_a: str, path_b: str):
        self.proc_a = AudioContinuityProcessor(path_a)
        self.proc_b = AudioContinuityProcessor(path_b)

    def find_best_crossfade_point(self) -> TransitionResult:
        for label, proc in [("A", self.proc_a), ("B", self.proc_b)]:
            log.info("Loading Track %s…", label)
            proc.load_and_extract()
            proc.build_similarity_graph()

        beats_a, beats_b = self.proc_a.beats, self.proc_b.beats
        n_a, n_b = len(beats_a), len(beats_b)

        tail_start = max(0, int(n_a * (1 - self.SEARCH_TAIL_FRAC)))
        head_end   = min(n_b, int(n_b * self.SEARCH_HEAD_FRAC))
        tail, head = beats_a[tail_start:], beats_b[:head_end]

        if not tail or not head:
            raise ValueError("Tracks too short for transition analysis.")

        tf = np.stack([b.feature for b in tail])   # (nt, 25)
        hf = np.stack([b.feature for b in head])   # (nh, 25)

        sim_chroma = 1.0 - cdist(tf[:, :12], hf[:, :12], metric="cosine").clip(0, 1)
        sim_mfcc   = 1.0 - cdist(tf[:, 12:], hf[:, 12:], metric="cosine").clip(0, 1)

        bpm_a, bpm_b = self.proc_a.tempo, self.proc_b.tempo
        tempo_pen = float(np.clip(abs(bpm_a - bpm_b) / 20.0, 0.0, 1.0))

        pa = (np.array([b.beat_phase for b in tail]) == 0).astype(float)[:, None]
        pb = (np.array([b.beat_phase for b in head]) == 0).astype(float)[None, :]
        phase_pen_mat = 1.0 - (pa * pb)   # 0 only when both are beat-1

        score_mat = (
            self.CHROMA_W * sim_chroma
            + self.MFCC_W * sim_mfcc
            - self.TEMPO_W * tempo_pen
            - self.PHASE_W * phase_pen_mat
        )

        ti, hi    = np.unravel_index(int(np.argmax(score_mat)), score_mat.shape)
        beat_a    = tail[ti]
        beat_b    = head[hi]

        key_a     = int(np.argmax(tf[:, :12].mean(axis=0)))
        key_b     = int(np.argmax(hf[:, :12].mean(axis=0)))
        key_dist  = min(abs(key_a - key_b), 12 - abs(key_a - key_b))

        # Top-20 distinct candidates for the UI "Recommended Combos" list
        flat_scores = score_mat.flatten()
        top_indices = np.argsort(flat_scores)[::-1]
        seen_pairs: set = set()
        candidates: list = []
        for flat_idx in top_indices:
            if len(candidates) >= 20:
                break
            ci, cj = np.unravel_index(int(flat_idx), score_mat.shape)
            pair = (int(ci), int(cj))
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            candidates.append(CandidateTransition(
                src_beat_idx=tail[ci].index,
                tgt_beat_idx=head[cj].index,
                src_time=tail[ci].time,
                tgt_time=head[cj].time,
                score=float(flat_scores[flat_idx]),
            ))

        dur_a = float(len(self.proc_a.y) / self.proc_a.sr)
        dur_b = float(len(self.proc_b.y) / self.proc_b.sr)

        result = TransitionResult(
            src_beat_idx=beat_a.index,
            tgt_beat_idx=beat_b.index,
            src_time=beat_a.time,
            tgt_time=beat_b.time,
            score=float(score_mat[ti, hi]),
            tempo_a=bpm_a,
            tempo_b=bpm_b,
            tempo_delta=abs(bpm_a - bpm_b),
            key_distance=key_dist,
            duration_a=dur_a,
            duration_b=dur_b,
            candidates=candidates,
        )
        log.info(
            "Best transition: A@%.2fs → B@%.2fs  score=%.3f  ΔBPM=%.1f  key_dist=%d",
            result.src_time, result.tgt_time,
            result.score, result.tempo_delta, result.key_distance,
        )
        return result

    def _apply_edm_drop(self, audio: np.ndarray, sr: int, xf_len: int) -> np.ndarray:
        """
        Apply a DJ-style beat-drop effect over the crossfade region.

        The effect has three passes:
          1. Low-pass sweep on the outgoing half: a Butterworth low-pass filter
             whose cutoff slides from full-range (~18 kHz) down to ~400 Hz,
             giving the classic "muffled buildup" feel as the drop approaches.
          2. High-pass sweep on the incoming half: cutoff slides from ~600 Hz
             down to ~80 Hz, opening up the full frequency range of Track B
             as it kicks in — the classic DJ "filter release" drop moment.
          3. A brief (+2 dB) transient boost at the exact midpoint of the
             crossfade so the beat drop hits with physical impact.

        Filter state is carried across segments via sosfilt / sosfilt_zi so
        there are no transient clicks at segment boundaries.
        """
        out   = audio.copy()
        n     = len(out)
        mid   = n // 2
        nyq   = sr / 2.0

        # -- Pass 1: Low-pass sweep over the first half (outgoing track fades out) --
        STEPS_LP = 48
        half_a   = min(mid, xf_len // 2)
        seg_size = max(1, half_a // STEPS_LP)
        zi_lp    = None
        for step in range(STEPS_LP):
            t       = step / max(STEPS_LP - 1, 1)           # 0 → 1
            fc      = 18000.0 * (1.0 - t) + 380.0 * t       # 18 kHz → 380 Hz
            fc_norm = min(fc / nyq, 0.98)
            sos     = scipy_signal.butter(2, fc_norm, btype="low", output="sos")
            start   = step * seg_size
            end     = min(start + seg_size, half_a)
            if start >= end:
                break
            if zi_lp is None:
                zi_lp = sosfilt_zi(sos) * out[start]
            out[start:end], zi_lp = sosfilt(sos, out[start:end], zi=zi_lp)

        # -- Pass 2: High-pass sweep over the second half (incoming track opens up) --
        STEPS_HP = 48
        half_b   = min(n - mid, xf_len - half_a)
        seg_size = max(1, half_b // STEPS_HP)
        zi_hp    = None
        for step in range(STEPS_HP):
            t       = step / max(STEPS_HP - 1, 1)           # 0 → 1
            fc      = 580.0 * (1.0 - t) + 55.0 * t          # 580 Hz → 55 Hz
            fc_norm = max(fc / nyq, 0.002)
            sos     = scipy_signal.butter(2, fc_norm, btype="high", output="sos")
            start   = mid + step * seg_size
            end     = min(start + seg_size, mid + half_b)
            if start >= end or start >= n:
                break
            if zi_hp is None:
                zi_hp = sosfilt_zi(sos) * out[start]
            out[start:end], zi_hp = sosfilt(sos, out[start:end], zi=zi_hp)

        # -- Pass 3: transient impact boost at the drop point --
        # Hann-window envelope for a smooth, click-free boost
        boost_db   = 2.0
        boost_lin  = 10 ** (boost_db / 20.0)
        boost_half = int(0.025 * sr)   # 25 ms each side
        boost_len  = boost_half * 2
        if boost_len > 0 and mid - boost_half >= 0 and mid + boost_half <= n:
            hann = np.hanning(boost_len)
            gain = 1.0 + (boost_lin - 1.0) * hann
            b_start = mid - boost_half
            b_end   = mid + boost_half
            out[b_start:b_end] *= gain[:b_end - b_start]

        # Clamp to prevent any buffer clipping
        np.clip(out, -1.0, 1.0, out=out)
        return out

    def synthesise_full_mix(self, result: TransitionResult) -> str:
        """
        Render the full mix as a WAV file with an EDM-style beat-drop transition.

        Layout
        ------
        [Track A body] → [EDM filter-sweep overlap] → [Track B tail]

        The crossfade region is centred on the best beat pair.
        A DJ-style filter sweep (low-pass out, high-pass in, impact boost at midpoint)
        is applied over the overlap to create a proper beat-drop effect.
        """
        proc_a, proc_b = self.proc_a, self.proc_b
        sr = proc_a.sr
        half_xf = int((self.CROSSFADE_DURATION_S / 2.0) * sr)

        src_sample = proc_a.beats[result.src_beat_idx].sample
        tgt_sample = proc_b.beats[result.tgt_beat_idx].sample

        a_xf_start = max(0, src_sample - half_xf)
        b_xf_start = max(0, tgt_sample - half_xf)

        seg_a_body = proc_a.y[:a_xf_start].astype(np.float32)
        seg_a_tail = proc_a.y[a_xf_start:].astype(np.float32)
        seg_b_head = proc_b.y[b_xf_start:].astype(np.float32)

        xf = min(int(self.CROSSFADE_DURATION_S * sr), len(seg_a_tail), len(seg_b_head))
        xf = max(xf, 1)

        # S-curve equal-power crossfade
        t        = np.linspace(0.0, 1.0, xf, endpoint=True)
        s        = t * t * (3.0 - 2.0 * t)
        fade_in  = np.sqrt(s)
        fade_out = np.sqrt(1.0 - s)

        overlap = seg_a_tail[:xf] * fade_out + seg_b_head[:xf] * fade_in

        # Apply the EDM beat-drop filter sweep over the overlap region
        try:
            overlap = self._apply_edm_drop(overlap, sr, xf)
        except Exception as exc:
            log.warning("EDM drop effect failed, using plain crossfade: %s", exc)

        b_remainder = seg_b_head[xf:]
        out = np.concatenate([seg_a_body, overlap, b_remainder])

        peak = np.max(np.abs(out))
        if peak > 0.0:
            out = out * (10 ** (-1.0 / 20.0) / peak)

        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False, prefix="saics_mix_")
        sf.write(tmp.name, out, sr, subtype="PCM_16")
        log.info(
            "Full mix WAV: %s  (%.2f s = %.2f s A-body + %.2f s xfade + %.2f s B-tail)",
            tmp.name, len(out) / sr,
            len(seg_a_body) / sr, xf / sr, len(b_remainder) / sr,
        )
        return tmp.name

    def process(self) -> Tuple[TransitionResult, str]:
        result   = self.find_best_crossfade_point()
        wav_path = self.synthesise_full_mix(result)
        return result, wav_path


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python audio_processor.py <input_audio>")
        sys.exit(1)
    out_path = AudioContinuityProcessor(sys.argv[1]).process()
    print(f"Done → {out_path}")
