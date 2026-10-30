"""Analysis bundle contract, schema `saics.analysis/6` (see PLAN.md).

Any change to these models bumps SCHEMA and the app-side type in the same change
(CLAUDE.md hard rule 8).
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

SCHEMA = "saics.analysis/6"
LIBRARY_SCHEMA = "saics.library/6"


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


class Jump(_M):
    from_beat: int
    to_beat: int
    score: float
    kind: str
    xfade_ms: float


class Cue(_M):
    beat: int
    score: float
    reason: str


class Cues(_M):
    out: list[Cue] = []
    in_: list[Cue] = Field([], alias="in")


class TrackBundle(_M):
    schema_: Literal["saics.analysis/6"] = Field(SCHEMA, alias="schema")
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
    jumps: list[Jump] = []  # P3
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
    schema_: Literal["saics.library/6"] = Field(LIBRARY_SCHEMA, alias="schema")
    track_schema: str = SCHEMA
    generated: str
    tracks: list[LibraryTrack]
    groups: dict[str, LibraryGroup]
    neighbours: dict[str, list[dict]] = {}  # P4: group id -> top-K compatible groups
