"""The pydantic bundle models and the app-side TypeScript type must agree (hard rule 8)."""

import re
from pathlib import Path

from saics import schema

TS = (Path(__file__).resolve().parents[2] / "app" / "src" / "types" / "analysis.ts").read_text(
    encoding="utf-8"
)


def _ts_block(name: str) -> str:
    m = re.search(rf"export interface {name} \{{(.*?)\n\}}", TS, re.S)
    assert m, name
    return m.group(1)


def test_schema_versions_match():
    assert f'ANALYSIS_SCHEMA = "{schema.SCHEMA}"' in TS
    assert f'LIBRARY_SCHEMA = "{schema.LIBRARY_SCHEMA}"' in TS


def test_bundle_fields_match():
    ts_fields = set(re.findall(r"^\s+(\w+)\??:", _ts_block("TrackBundle"), re.M))
    py_fields = {f.alias or n for n, f in schema.TrackBundle.model_fields.items()}
    assert ts_fields == py_fields


def test_break_fields_match():
    ts_fields = set(re.findall(r"^\s+(\w+)\??:", _ts_block("Break"), re.M))
    assert ts_fields == set(schema.Break.model_fields)


def test_jump_fields_match():
    ts_fields = set(re.findall(r"^\s+(\w+)\??:", _ts_block("Jump"), re.M))
    assert ts_fields == set(schema.Jump.model_fields)
