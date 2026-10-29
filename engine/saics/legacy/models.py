"""
models.py — SAICS v5 shared data structures.
"""

from dataclasses import dataclass, field
from typing import List, Optional
import numpy as np


@dataclass
class Beat:
    """A single beat with its sample position and feature vector."""
    index:           int
    sample:          int
    time:            float
    beat_phase:      int   = 0
    is_phrase_start: bool  = False
    harmonic_energy: float = 0.0
    feature: np.ndarray = field(default_factory=lambda: np.array([]))


@dataclass
class TransitionEdge:
    """A directed jump edge in the transition graph."""
    source:       int
    target:       int
    cost:         float
    score:        float = 0.0
    reachability: float = 0.0
    probability:  float = 0.0


@dataclass
class JumpCandidate:
    """A single jump option at a trigger point."""
    target_beat_idx:  int
    target_sample:    int
    target_time:      float
    probability:      float
    score:            float


@dataclass
class JumpPoint:
    """A pre-computed trigger point with weighted candidates."""
    beat_idx:        int
    trigger_sample:  int
    trigger_time:    float
    candidates:      List[JumpCandidate] = field(default_factory=list)


@dataclass
class CandidateTransition:
    src_beat_idx: int
    tgt_beat_idx: int
    src_time:     float
    tgt_time:     float
    score:        float


@dataclass
class TransitionResult:
    src_beat_idx:  int
    tgt_beat_idx:  int
    src_time:      float
    tgt_time:      float
    score:         float
    tempo_a:       float
    tempo_b:       float
    tempo_delta:   float
    key_distance:  int
    duration_a:    float = 0.0
    duration_b:    float = 0.0
    candidates:    list  = field(default_factory=list)


@dataclass
class TrackFingerprint:
    """Lightweight fingerprint for library-wide compatibility scoring."""
    track_id:      str
    tempo:         float
    key_idx:       int
    mean_chroma:   np.ndarray = field(default_factory=lambda: np.zeros(12))
    mean_mfcc:     np.ndarray = field(default_factory=lambda: np.zeros(13))
    energy_profile: np.ndarray = field(default_factory=lambda: np.array([]))
    duration:      float = 0.0

    # Camelot key notation
    CAMELOT = [
        "8B", "3B", "10B", "5B", "12B", "7B",
        "2B", "9B", "4B", "11B", "6B", "1B",
    ]

    @property
    def camelot_key(self) -> str:
        return self.CAMELOT[self.key_idx % 12]
