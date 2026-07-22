"""
audio_processor.py v5 — SAICS DSP Core
=======================================
Vectorized SSM, reachability-scored graph, probabilistic jumps,
pre-computed jump schedule, musical-time cooldown (32-beat minimum).
"""

import os, math, tempfile, logging
from collections import defaultdict
from dataclasses import dataclass, field
from typing import List, Tuple, Optional, Dict

import numpy as np
import librosa
import soundfile as sf
from scipy.spatial.distance import cdist
from scipy import signal as scipy_signal
from scipy.signal import sosfilt, sosfilt_zi

from models import (
    Beat, TransitionEdge, JumpCandidate, JumpPoint,
    CandidateTransition, TransitionResult, TrackFingerprint,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
log = logging.getLogger(__name__)


class AudioContinuityProcessor:
    """End-to-end processor: audio file → analysis data + jump schedule."""

    TARGET_DURATION_S  = 300.0
    TOP_K_JUMPS        = 6
    MIN_JUMP_DELTA     = 8
    JUMP_SCORE_GATE    = 0.82
    SSM_CHROMA_W       = 0.5
    SSM_MFCC_W         = 0.5
    ANTI_LOOP_WINDOW   = 16
    BARS_PER_PHRASE    = 4
    MIN_BEATS_BETWEEN_JUMPS = 32  # 8 bars = musical cooldown
    CTX_RADIUS         = 3

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

    # ── Feature Extraction ──────────────────────────────────────────────

    def load_and_extract(self) -> None:
        log.info("Loading audio: %s", self.filepath)
        self.y, self.sr = librosa.load(self.filepath, mono=True, sr=None)
        duration = librosa.get_duration(y=self.y, sr=self.sr)
        log.info("  Duration: %.2f s  |  SR: %d Hz", duration, self.sr)

        self.tempo, self.beat_frames = librosa.beat.beat_track(
            y=self.y, sr=self.sr, units="frames"
        )
        if isinstance(self.tempo, np.ndarray):
            self.tempo = float(self.tempo[0])

        self.beat_times = librosa.frames_to_time(self.beat_frames, sr=self.sr)
        log.info("  Tempo: %.1f BPM  |  Beats: %d", self.tempo, len(self.beat_frames))

        beat_phases = self._estimate_beat_phases(self.beat_frames)
        chroma_cqt = librosa.feature.chroma_cqt(y=self.y, sr=self.sr)
        chroma_sync = librosa.util.sync(chroma_cqt, self.beat_frames, aggregate=np.median)
        mfcc = librosa.feature.mfcc(y=self.y, sr=self.sr, n_mfcc=13)
        mfcc_sync = librosa.util.sync(mfcc, self.beat_frames, aggregate=np.mean)

        def l2(mat):
            n = np.linalg.norm(mat, axis=0, keepdims=True)
            n[n == 0] = 1.0
            return mat / n

        combined = np.vstack([l2(chroma_sync), l2(mfcc_sync)]).T
        beat_samples = librosa.frames_to_samples(self.beat_frames)
        
        # HPSS Optimization (Vocal Saver)
        log.info("  Running HPSS Optimization...")
        S = np.abs(librosa.stft(self.y))
        S_h, _ = librosa.decompose.hpss(S, margin=1.2)
        rms_h = librosa.feature.rms(S=S_h)[0]
        harmonic_energy_sync = librosa.util.sync(rms_h[np.newaxis, :], self.beat_frames, aggregate=np.mean)[0]
        if np.max(harmonic_energy_sync) > 0:
            harmonic_energy_sync /= np.max(harmonic_energy_sync)

        self.beats = [
            Beat(index=i, sample=int(beat_samples[i]), time=float(self.beat_times[i]),
                 beat_phase=int(beat_phases[i]), harmonic_energy=float(harmonic_energy_sync[i]), feature=combined[i])
            for i in range(len(self.beat_frames))
        ]

        phrase_starts = self._detect_phrase_boundaries()
        for i, b in enumerate(self.beats):
            b.is_phrase_start = bool(phrase_starts[i])

        log.info("  Features dim=%d | downbeats: %d | phrase starts: %d",
                 combined.shape[1],
                 sum(1 for b in self.beats if b.beat_phase == 0),
                 sum(1 for b in self.beats if b.is_phrase_start))

    def _estimate_beat_phases(self, beat_frames: np.ndarray) -> np.ndarray:
        n = len(beat_frames)
        if n < 8:
            return np.arange(n) % 4
        rms = librosa.feature.rms(y=self.y)[0]
        rms_sync = librosa.util.sync(rms[np.newaxis, :], beat_frames, aggregate=np.mean)[0]
        best_phase, best_energy = 0, -np.inf
        for offset in range(4):
            energy = rms_sync[offset::4].sum()
            if energy > best_energy:
                best_energy = energy
                best_phase = offset
        return np.array([(i - best_phase) % 4 for i in range(n)], dtype=int)

    def _detect_phrase_boundaries(self) -> np.ndarray:
        n = len(self.beats)
        if n == 0:
            return np.array([], dtype=bool)
        is_phrase = np.zeros(n, dtype=bool)
        bt = np.array([b.time for b in self.beats])
        beat_dur = 60.0 / max(self.tempo, 1.0)

        try:
            chroma = librosa.feature.chroma_cqt(y=self.y, sr=self.sr)
            k = max(2, n // 16)
            bounds = librosa.segment.agglomerative(chroma, k=k)
            b_times = librosa.frames_to_time(bounds, sr=self.sr)
            for t in b_times:
                dists = np.abs(bt - t)
                nearest = int(np.argmin(dists))
                if dists[nearest] < beat_dur * 2.0:
                    lo, hi = max(0, nearest - 3), min(n, nearest + 4)
                    db_cands = [i for i in range(lo, hi) if self.beats[i].beat_phase == 0]
                    if db_cands:
                        is_phrase[min(db_cands, key=lambda i: abs(bt[i] - t))] = True
                    else:
                        is_phrase[nearest] = True
        except Exception as exc:
            log.warning("  Segmentation failed: %s", exc)

        db_count = 0
        for i, b in enumerate(self.beats):
            if b.beat_phase == 0:
                if db_count % self.BARS_PER_PHRASE == 0:
                    is_phrase[i] = True
                db_count += 1
        if n > 0:
            is_phrase[0] = True
        return is_phrase

    # ── Vectorized SSM + Graph ──────────────────────────────────────────

    def build_similarity_graph(self) -> None:
        n = len(self.beats)
        if n < self.MIN_JUMP_DELTA + 2:
            raise ValueError("Audio too short for graph.")

        feat = np.stack([b.feature for b in self.beats])
        dist_chroma = cdist(feat[:, :12], feat[:, :12], metric="cosine").clip(0, 1)
        dist_mfcc = cdist(feat[:, 12:], feat[:, 12:], metric="cosine").clip(0, 1)
        dist_combined = self.SSM_CHROMA_W * dist_chroma + self.SSM_MFCC_W * dist_mfcc
        self.ssm = 1.0 - dist_combined

        # Vectorized contextual distance (replaces O(n^3) loop)
        ctx_dist = self._vectorized_ctx_distance(dist_combined, n)

        phases = np.array([b.beat_phase for b in self.beats], dtype=int)
        phrase_arr = np.array([b.is_phrase_start for b in self.beats], dtype=bool)

        self.edges = []
        for src in range(n):
            if not phrase_arr[src] or phases[src] != 0:
                continue
            for tgt in range(n):
                if abs(src - tgt) < self.MIN_JUMP_DELTA:
                    continue
                if phases[tgt] != 0 or not phrase_arr[tgt]:
                    continue
                raw = 1.0 - float(dist_combined[src, tgt])
                ctx = 1.0 - float(ctx_dist[src, tgt])
                score = 0.6 * raw + 0.4 * ctx
                
                # Vocal Saver HPSS Penalty
                src_harm = self.beats[src].harmonic_energy
                tgt_harm = self.beats[tgt].harmonic_energy
                if src_harm > 0.6 or tgt_harm > 0.6:
                    score -= 0.15 * max(src_harm, tgt_harm)
                    
                # Dynamic "Desperation" Thresholding (Quadratic Curve)
                total_duration = self.beats[-1].time if n > 0 else 1.0
                f = self.beats[src].time / total_duration
                if f <= 0.75:
                    dynamic_gate = 0.92
                else:
                    t = (f - 0.75) / 0.25
                    dynamic_gate = 0.92 - (0.92 - 0.75) * (t ** 2)
                    
                if score < dynamic_gate:
                    continue
                self.edges.append(TransitionEdge(source=src, target=tgt,
                                                 cost=1.0 - score, score=score))

        # Top-K per source
        by_src = defaultdict(list)
        for e in self.edges:
            by_src[e.source].append(e)
        pruned = []
        for src_edges in by_src.values():
            src_edges.sort(key=lambda e: e.score, reverse=True)
            pruned.extend(src_edges[:self.TOP_K_JUMPS])
        self.edges = pruned

        # Reachability scoring
        self._score_reachability()
        # Probability assignment
        self._assign_probabilities()

        log.info("Graph: %d edges (phrase-gated, reachability-scored)", len(self.edges))

    def _vectorized_ctx_distance(self, dist_combined: np.ndarray, n: int) -> np.ndarray:
        """Sliding-window contextual distance — O(n^2) instead of O(n^3)."""
        r = self.CTX_RADIUS
        padded = np.pad(dist_combined, ((r, r), (r, r)), mode="edge")
        ctx = np.zeros((n, n), dtype=np.float64)
        count = np.zeros((n, n), dtype=np.float64)
        for k in range(-r, r + 1):
            row_slice = slice(r + k, r + k + n)
            col_slice = slice(r + k, r + k + n)
            ctx += padded[row_slice, col_slice]
            count += 1.0
        return ctx / count

    def _score_reachability(self) -> None:
        """Score edges by how many outgoing edges the target has (3-hop)."""
        adj = defaultdict(list)
        for e in self.edges:
            adj[e.source].append(e.target)

        reach = {}
        for e in self.edges:
            tgt = e.target
            if tgt not in reach:
                hop1 = set(adj.get(tgt, []))
                hop2 = set()
                for h in hop1:
                    hop2.update(adj.get(h, []))
                hop3 = set()
                for h in hop2:
                    hop3.update(adj.get(h, []))
                reach[tgt] = len(hop1 | hop2 | hop3)

            max_r = max(1, max(reach.values())) if reach else 1
            e.reachability = reach[tgt] / max_r

    def _assign_probabilities(self) -> None:
        """Assign probability-weighted selection per source beat."""
        by_src = defaultdict(list)
        for e in self.edges:
            by_src[e.source].append(e)

        for src, edges in by_src.items():
            # Composite weight: 60% timbral + 20% reachability + 20% score
            weights = []
            for e in edges:
                w = 0.6 * e.score + 0.2 * e.reachability + 0.2 * e.score
                weights.append(max(w, 0.01))
            total = sum(weights)
            for e, w in zip(edges, weights):
                e.probability = w / total

    # ── Jump Schedule Builder ───────────────────────────────────────────

    def build_jump_schedule(self) -> List[dict]:
        """
        Pre-computed jump schedule for the frontend.
        Returns list of {beat_idx, trigger_sample, trigger_time, candidates}.
        """
        by_src = defaultdict(list)
        for e in self.edges:
            by_src[e.source].append(e)

        schedule = []
        for src_idx, edges in sorted(by_src.items()):
            src_beat = self.beats[src_idx]
            candidates = []
            for e in sorted(edges, key=lambda x: x.probability, reverse=True):
                tgt = self.beats[e.target]
                candidates.append({
                    "target_beat_idx": e.target,
                    "target_sample": tgt.sample,
                    "target_time": round(tgt.time, 4),
                    "probability": round(e.probability, 4),
                    "score": round(e.score, 4),
                })
            schedule.append({
                "beat_idx": src_idx,
                "trigger_sample": src_beat.sample,
                "trigger_time": round(src_beat.time, 4),
                "candidates": candidates,
            })
        return schedule

    # ── Fingerprint (for library scoring) ───────────────────────────────

    def extract_fingerprint(self, track_id: str = "") -> TrackFingerprint:
        """Extract a lightweight fingerprint for cross-track scoring."""
        if self.y is None:
            self.load_and_extract()

        chroma_feats = np.stack([b.feature[:12] for b in self.beats])
        mfcc_feats = np.stack([b.feature[12:] for b in self.beats])
        mean_chroma = chroma_feats.mean(axis=0)
        mean_mfcc = mfcc_feats.mean(axis=0)
        key_idx = int(np.argmax(mean_chroma))

        # Energy profile: RMS in 16 segments
        seg_len = max(1, len(self.y) // 16)
        energy = np.array([
            float(np.sqrt(np.mean(self.y[i * seg_len:(i + 1) * seg_len] ** 2)))
            for i in range(16)
        ])

        return TrackFingerprint(
            track_id=track_id, tempo=self.tempo, key_idx=key_idx,
            mean_chroma=mean_chroma, mean_mfcc=mean_mfcc,
            energy_profile=energy,
            duration=float(len(self.y) / self.sr),
        )

    # ── Pathfinding ─────────────────────────────────────────────────────

    def find_playback_path(self) -> List[Beat]:
        """Build playback path with probabilistic jumps and musical-time cooldown."""
        n = len(self.beats)
        if n == 0:
            raise ValueError("No beats found.")

        adj: dict = {i: [] for i in range(n)}
        for e in self.edges:
            adj[e.source].append(e)

        path, current, accumulated = [], 0, 0.0
        beats_since_jump = self.MIN_BEATS_BETWEEN_JUMPS
        visited_recently, jump_count = [], 0

        for _ in range(int(self.TARGET_DURATION_S * 20)):
            beat = self.beats[current]
            path.append(beat)
            beat_dur = (self.beats[current + 1].time - beat.time
                        if current + 1 < n else 60.0 / self.tempo)
            accumulated += beat_dur
            if accumulated >= self.TARGET_DURATION_S:
                break

            visited_recently.append(current)
            if len(visited_recently) > self.ANTI_LOOP_WINDOW * 3:
                visited_recently = visited_recently[-self.ANTI_LOOP_WINDOW * 2:]
            recent_set = set(visited_recently[-self.ANTI_LOOP_WINDOW:])

            beats_since_jump += 1
            next_beat = (current + 1) % n

            if beats_since_jump >= self.MIN_BEATS_BETWEEN_JUMPS and adj[current]:
                valid = [e for e in adj[current] if e.target not in recent_set]
                if valid:
                    # Probabilistic selection
                    probs = np.array([e.probability for e in valid])
                    probs = probs / probs.sum()
                    chosen = np.random.choice(len(valid), p=probs)
                    next_beat = valid[chosen].target
                    beats_since_jump = 0
                    jump_count += 1

            current = next_beat

        log.info("Path: %d beats | %.1f s | %d jumps", len(path), accumulated, jump_count)
        return path

    # ── Synthesis ───────────────────────────────────────────────────────

    def _crossfade_samples(self, n_samples: int) -> Tuple[np.ndarray, np.ndarray]:
        t = np.linspace(0, 1, n_samples, endpoint=True)
        s = t * t * (3.0 - 2.0 * t)
        return np.sqrt(1.0 - s), np.sqrt(s)

    def _beat_duration_samples(self, beat_idx: int) -> int:
        b = self.beats[beat_idx] if beat_idx < len(self.beats) else None
        if b is None:
            return int(self.sr * 60.0 / self.tempo)
        if b.index + 1 < len(self.beats):
            return max(1, int((self.beats[b.index + 1].time - b.time) * self.sr))
        return max(1, int(60.0 / self.tempo * self.sr))

    def synthesise(self, path: List[Beat]) -> np.ndarray:
        if not path:
            raise ValueError("Empty path.")
        xfade_s = min(0.1, max(0.05, (60.0 / self.tempo) * 0.15))
        xfade_n = int(xfade_s * self.sr)
        audio_len = self.y.shape[0]

        durations = []
        for beat in path:
            end = min(beat.sample + self._beat_duration_samples(beat.index), audio_len)
            durations.append(max(0, end - beat.sample))

        total = 0
        for i, d in enumerate(durations):
            if d <= 0: continue
            total += d if i == 0 else d - min(xfade_n, d // 4, durations[i - 1] // 4)

        out = np.zeros(total + xfade_n, dtype=np.float32)
        wp = 0

        for pos, beat in enumerate(path):
            d = durations[pos]
            if d <= 0: continue
            chunk = self.y[beat.sample:beat.sample + d].astype(np.float32)
            xp = 0 if pos == 0 else min(xfade_n, d // 4, durations[pos - 1] // 4)
            xn = 0 if pos == len(path) - 1 else min(xfade_n, d // 4, durations[pos + 1] // 4)

            needed = wp + (d - xp)
            if needed > len(out):
                out = np.pad(out, (0, needed - len(out) + xfade_n))

            if xp > 0:
                _, fi = self._crossfade_samples(xp)
                out[wp:wp + xp] += chunk[:xp] * fi
            bs, be = xp, d - xn if pos < len(path) - 1 else d
            bl = be - bs
            if bl > 0:
                ds = wp + xp
                de = ds + bl
                if de > len(out):
                    out = np.pad(out, (0, de - len(out) + xfade_n))
                out[ds:de] = chunk[bs:be]
            if xn > 0 and pos < len(path) - 1:
                fo, _ = self._crossfade_samples(xn)
                tail = chunk[d - xn:d] * fo
                ds = wp + (d - xp) - xn
                de = ds + xn
                if de > len(out):
                    out = np.pad(out, (0, de - len(out) + xfade_n))
                out[ds:de] = tail
            wp += (d - xp)

        out = out[:wp]
        peak = np.max(np.abs(out))
        if peak > 0:
            out *= 10 ** (-1.0 / 20.0) / peak
        log.info("Synthesis: %.2f s", len(out) / self.sr)
        return out

    def process(self) -> str:
        self.load_and_extract()
        self.build_similarity_graph()
        path = self.find_playback_path()
        audio_out = self.synthesise(path)
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False, prefix="saics_")
        sf.write(tmp.name, audio_out, self.sr, subtype="PCM_16")
        log.info("Output: %s", tmp.name)
        return tmp.name


# ── Cross-track transition engine ───────────────────────────────────

class TrackTransitionProcessor:
    CHROMA_W = 0.50
    MFCC_W   = 0.30
    TEMPO_W  = 0.12
    PHASE_W  = 0.08
    SEARCH_TAIL_FRAC = 0.40
    SEARCH_HEAD_FRAC = 0.40
    BUILDUP_S = 2.0

    def __init__(self, path_a: str, path_b: str):
        self.proc_a = AudioContinuityProcessor(path_a)
        self.proc_b = AudioContinuityProcessor(path_b)

    def find_best_crossfade_point(self) -> TransitionResult:
        for label, proc in [("A", self.proc_a), ("B", self.proc_b)]:
            log.info("Loading Track %s…", label)
            proc.load_and_extract()
            proc.build_similarity_graph()

        ba, bb = self.proc_a.beats, self.proc_b.beats
        na, nb = len(ba), len(bb)
        tail_start = max(0, int(na * (1 - self.SEARCH_TAIL_FRAC)))
        head_end = min(nb, int(nb * self.SEARCH_HEAD_FRAC))

        def _pf(bl):
            ps = [b for b in bl if b.is_phrase_start]
            if len(ps) >= 2: return ps
            db = [b for b in bl if b.beat_phase == 0]
            return db if len(db) >= 2 else list(bl)

        tail = _pf(ba[tail_start:])
        head = _pf(bb[:head_end])
        if not tail or not head:
            raise ValueError("Tracks too short.")

        tf = np.stack([b.feature for b in tail])
        hf = np.stack([b.feature for b in head])
        sim_c = 1.0 - cdist(tf[:, :12], hf[:, :12], metric="cosine").clip(0, 1)
        sim_m = 1.0 - cdist(tf[:, 12:], hf[:, 12:], metric="cosine").clip(0, 1)

        bpm_a, bpm_b = self.proc_a.tempo, self.proc_b.tempo
        tp = float(np.clip(abs(bpm_a - bpm_b) / 20.0, 0, 1))
        pa = (np.array([b.beat_phase for b in tail]) == 0).astype(float)[:, None]
        pb = (np.array([b.beat_phase for b in head]) == 0).astype(float)[None, :]
        pp = 1.0 - (pa * pb)

        sm = self.CHROMA_W * sim_c + self.MFCC_W * sim_m - self.TEMPO_W * tp - self.PHASE_W * pp
        ti, hi = np.unravel_index(int(np.argmax(sm)), sm.shape)

        ka = int(np.argmax(tf[:, :12].mean(axis=0)))
        kb = int(np.argmax(hf[:, :12].mean(axis=0)))
        kd = min(abs(ka - kb), 12 - abs(ka - kb))

        flat = sm.flatten()
        top_idx = np.argsort(flat)[::-1]
        seen, cands = set(), []
        for fi in top_idx:
            if len(cands) >= 20: break
            ci, cj = np.unravel_index(int(fi), sm.shape)
            if (ci, cj) in seen: continue
            seen.add((ci, cj))
            cands.append(CandidateTransition(
                src_beat_idx=tail[ci].index, tgt_beat_idx=head[cj].index,
                src_time=tail[ci].time, tgt_time=head[cj].time,
                score=float(flat[fi])))

        return TransitionResult(
            src_beat_idx=tail[ti].index, tgt_beat_idx=head[hi].index,
            src_time=tail[ti].time, tgt_time=head[hi].time,
            score=float(sm[ti, hi]), tempo_a=bpm_a, tempo_b=bpm_b,
            tempo_delta=abs(bpm_a - bpm_b), key_distance=kd,
            duration_a=float(len(self.proc_a.y) / self.proc_a.sr),
            duration_b=float(len(self.proc_b.y) / self.proc_b.sr),
            candidates=cands)

    def _apply_lp_buildup(self, audio, sr):
        out, n, nyq = audio.copy(), len(audio), sr / 2.0
        seg = max(1, n // 8)
        zi = None
        for step in range(8):
            t = step / 7
            fc = min(18000 * (1 - t) + 400 * t, nyq * 0.98)
            sos = scipy_signal.butter(2, fc / nyq, btype="low", output="sos")
            s, e = step * seg, min(step * seg + seg, n)
            if s >= e: break
            if zi is None: zi = sosfilt_zi(sos) * out[s]
            out[s:e], zi = sosfilt(sos, out[s:e], zi=zi)
        return np.clip(out, -1, 1)

    def synthesise_full_mix(self, result: TransitionResult, mode: str) -> str:
        pa, pb = self.proc_a, self.proc_b
        sr = pa.sr
        src_s = pa.beats[result.src_beat_idx].sample
        tgt_s = pb.beats[result.tgt_beat_idx].sample
        
        if mode == "smooth":
            # 16-beat overlap (or whatever is shorter)
            overlap_beats = 16
            fade_samples_a = int(sr * 60 / max(pa.tempo, 1) * overlap_beats)
            fade_samples_b = int(sr * 60 / max(pb.tempo, 1) * overlap_beats)
            overlap = min(fade_samples_a, fade_samples_b, src_s, len(pb.y) - tgt_s)
            overlap = max(min(sr * 2, src_s, len(pb.y) - tgt_s), overlap)
            
            # Recompute based on overlap limit
            src_start = src_s - overlap
            tgt_end = tgt_s + overlap
            
            seg_a = pa.y[:src_s].astype(np.float32).copy()
            seg_b = pb.y[tgt_s:].astype(np.float32).copy()
            
            # Equal power curves
            t = np.linspace(0, 1, overlap, endpoint=True, dtype=np.float32)
            s = t * t * (3.0 - 2.0 * t)
            fade_out = np.sqrt(1.0 - s)
            fade_in = np.sqrt(s)
            
            seg_a[-overlap:] *= fade_out
            if len(seg_b) >= overlap:
                seg_b[:overlap] *= fade_in
            else:
                seg_b *= fade_in[:len(seg_b)]
                
            # Mix overlapping region
            out_len = len(seg_a) + len(seg_b) - overlap
            out = np.zeros(out_len, dtype=np.float32)
            out[:len(seg_a)] = seg_a
            out[len(seg_a) - overlap : len(seg_a) - overlap + len(seg_b)] += seg_b
            
        elif mode == "cut":
            seg_a = pa.y[:src_s].astype(np.float32).copy()
            seg_b = pb.y[tgt_s:].astype(np.float32).copy()
            
            # 5ms micro-fades to prevent clicks
            xfade = min(int(0.005 * sr), len(seg_a), len(seg_b))
            if xfade > 0:
                t = np.linspace(0, 1, xfade, dtype=np.float32)
                seg_a[-xfade:] *= (1.0 - t)
                seg_b[:xfade] *= t
                
            out = np.concatenate([seg_a, seg_b])
            
        else: # edm
            buildup_n = min(int(self.BUILDUP_S * sr), max(0, src_s - sr // 2))
            seg_a = pa.y[:src_s].astype(np.float32).copy()
            if buildup_n > 64:
                seg_a[-buildup_n:] = self._apply_lp_buildup(seg_a[-buildup_n:], sr)
            seg_b = pb.y[tgt_s:].astype(np.float32).copy()
            atk = min(int(0.005 * sr), len(seg_b))
            if atk > 0:
                seg_b[:atk] *= np.linspace(0, 1, atk, dtype=np.float32)
            out = np.concatenate([seg_a, seg_b])
        peak = np.max(np.abs(out))
        if peak > 0:
            out *= 10 ** (-1.0 / 20.0) / peak
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False, prefix="saics_mix_")
        sf.write(tmp.name, out, sr, subtype="PCM_16")
        return tmp.name

    def process(self, mode: str = "auto") -> Tuple[TransitionResult, str, str]:
        result = self.find_best_crossfade_point()
        
        applied_mode = mode
        if mode == "auto":
            # Dynamic Heuristic Logic
            if result.tempo_delta > 8:
                # Big tempo jump -> EDM Buildup to reset groove
                applied_mode = "edm"
            elif result.key_distance <= 2 and result.tempo_delta <= 3:
                # Key and tempo matched -> Smooth 16-beat blend (80% chance) or Hard Cut (20% chance)
                applied_mode = "smooth" if np.random.random() < 0.8 else "cut"
            else:
                # Default hard cut on the phrase boundary
                applied_mode = "cut"
                
        audio_path = self.synthesise_full_mix(result, applied_mode)
        return result, audio_path, applied_mode


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python audio_processor.py <input_audio>")
        sys.exit(1)
    print(f"Done → {AudioContinuityProcessor(sys.argv[1]).process()}")
