"""Analysis bundle contract, schema `saics.analysis/6` (see PLAN.md).

Any change to these models bumps SCHEMA and the app-side type in the same change
(CLAUDE.md hard rule 8).
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

SCHEMA = "saics.analysis/8"  # /7: + breaks; /8: structural jumps (P3)
LIBRARY_SCHEMA = "saics.library/7"


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Track(_M):
    id: str
    file: str  # relative to the music folder, forward slashes
    title: str = ""
    artist: str = ""
    duration_s: float
    codec: str
    native_sample_rate: int
    decoder_offset_ms: float = 0.0  # ffmpeg's stream start time (encoder delay/priming); R1


class Triage(_M):
    cls: Literal["music", "sfx", "speech", "short", "unreadable", "duplicate", "not_audio"] = Field(
        "music", alias="class"
    )
    reasons: list[str] = []


class Group(_M):
    id: str
    version: str = "original"
    evidence: str = ""


class Loudness(_M):
    integrated_lufs: float
    gain_db: float  # gain to reach -14 LUFS


class Tempo(_M):
    bpm: float
    stable: bool
    confidence: float


class Meter(_M):
    beats_per_bar: int
    confidence: float


class Key(_M):
    tonic: str
    mode: Literal["major", "minor"]
    camelot: str
    confidence: float


class Section(_M):
    start_bar: int
    end_bar: int  # exclusive
    label: str | None = None
    group: int  # repeat class: sections with the same group are repeats of each other


class Break(_M):
    """A silence or near-silent breakdown: a first-class jump/transition point."""

    start_beat: int  # beat nearest the start of the drop
    end_beat: int  # beat nearest the point where the music returns
    start_s: float
    end_s: float
    depth_db: float  # lowest short-term level relative to the track's typical level (negative)
    kind: Literal["silence", "breakdown"]  # silence: <= -30 dB; breakdown: <= -15 dB
    ramp_up: bool  # the music comes back: the 4 s after the break average >= -8 dB
    return_db: float  # level of those 4 s relative to the track's typical level


class Jump(_M):
    """Instead of playing bar `from_bar`, continue at bar `to_bar` (both start on downbeats)."""

    from_beat: int
    to_beat: int
    from_bar: int  # == number of bars for a song-end jump
    to_bar: int
    score: float
    kind: Literal["repeat", "break", "end"]
    xfade_ms: float
    label: str  # e.g. "B2:5 → B1:5" (repeat group letter, instance, bar in section)
    context: float  # mean bar similarity over the 4 bars before and after the seam
    lyric: float  # vocal-stem chroma continuity across the seam (1 = instrumental both sides)
    distance_s: float


class Cue(_M):
    beat: int
    score: float
    reason: str


class Cues(_M):
    out: list[Cue] = []
    in_: list[Cue] = Field([], alias="in")


class TrackBundle(_M):
    schema_: Literal["saics.analysis/8"] = Field(SCHEMA, alias="schema")
    track: Track
    triage: Triage = Triage()
    group: Group
    loudness: Loudness
    tempo: Tempo
    meter: Meter
    key: Key
    beats: list[float]  # seconds
    downbeats: list[int]  # indices into beats
    sections: list[Section]
    bar_energy: list[float]  # per bar, 0..1
    vocal_activity: list[float]  # per beat, 0..1
    breaks: list[Break] = []  # silences / near-silent breakdowns (since /7)
    jumps: list[Jump] = []  # P3 structural jumps (since /8)
    cues: Cues = Cues()  # P4

    def dump(self) -> str:
        return self.model_dump_json(by_alias=True, indent=None)


class LibraryTrack(_M):
    id: str
    file: str
    size: int
    mtime_ns: int
    group: str
    version: str
    cls: str = Field(alias="class")


class LibraryGroup(_M):
    name: str
    tracks: list[dict]  # [{"id": ..., "version": ...}]


class Library(_M):
    schema_: Literal["saics.library/7"] = Field(LIBRARY_SCHEMA, alias="schema")
    track_schema: str = SCHEMA
    generated: str
    tracks: list[LibraryTrack]
    groups: dict[str, LibraryGroup]
    neighbours: dict[str, list[dict]] = {}  # P4: group id -> top-K compatible groups
