"""Name parsing and version labels on real filenames from the owner's library."""

import pytest

from saics.groups import decide_link, name_similarity, parse_name

CASES = [
    ("Y2meta.app - 夜に駆ける racing into the night - YOASOBI (𝙨𝙡𝙤𝙬𝙚𝙙 + 𝙧𝙚𝙫𝙚𝙧𝙗) (320 kbps)",
     "slowed+reverb"),
    ("YOASOBI _ racing into the night_Sped up", "sped up"),
    ("Aaron Smith - Dancin (KRONO Remix) (8D AUDIO)", "8d+remix"),
    ("Aaron Smith - Dancin (KRONO Remix) - Lyrics", "remix+lyrics"),
    ("Nightcore - Dancin", "nightcore"),
    ("y2mate.is - YOASOBI Biri Biri English Version Official Music Video-01x2NNfgTL8-192k-1702522",
     "english"),
    ("y2mate.is - YOASOBI Biri Biri Official Music Video-shZyg5VFI1Y-192k-1702521", "original"),
    ("y2mate.com - 夜に駆ける 𝖼𝗈𝗏𝖾𝗋", "cover"),
    ("夜に駆けるを0.8倍速してみたらイケボと化した件 [96qg_uNCAZw]", "slowed"),
    ("heatwaves - glass animals (sped upnightcore)", "sped up+nightcore"),
    ("Night Dancer - imase (Marimba iPhone Ringtone)", "ringtone"),
    ("Y2Mate.is - YOASOBI「夜に駆ける Racing into the Night [1 HOUR LOOP]⏰-coZVZp-vqzc-160k-1660030022662",
     "extended"),
    ("TheFatRat - Electrified", "original"),
]  # fmt: skip


@pytest.mark.parametrize("stem,version", CASES)
def test_version_labels(stem, version):
    assert parse_name(stem).version == version


def test_junk_is_stripped():
    n = parse_name("y2mate.is - YOASOBI Biri Biri Official Music Video-shZyg5VFI1Y-192k-1702521")
    assert n.tokens == {"yoasobi", "biri"}


def test_language_versions_share_a_title():
    a = parse_name(
        "y2mate.is - YOASOBI Biri Biri English Version Official Music Video-01x2NNfgTL8-192k-1"
    )
    b = parse_name("y2mate.is - YOASOBI Biri Biri Official Music Video-shZyg5VFI1Y-192k-1702521")
    assert name_similarity(a, b) == 1.0
    assert a.version != b.version


def test_mashups_do_not_bridge_by_audio():
    m = parse_name("yt1s.com - night dancer x racing into the night_320kbps")
    s = parse_name("Racing into the Night - YOASOBI (Hatsune Miku ver.)")
    assert m.mashup and not s.mashup
    # Strong audio but weak name: a mashup must not join through audio.
    assert decide_link(m, parse_name("Totally Different"), 0.9, False, True) is None


def test_versions_of_one_mashup_group_together():
    from saics.groups import build_groups

    stems = [
        "Lovedrug x Headlock - Lady Gaga, Imogen Heap (Mashup) (Lofi VHS)",
        "Lovedrug x Headlock - Lady Gaga, Imogen Heap (Mashup) (Sped Up)",
        "Lovedrug x Headlock - Lady Gaga, Imogen Heap (Mashup) (Vinyl Crackle)",
        "Lovedrug x Headlock - Lady Gaga, Imogen Heap (Mashup)",
        "headlock x headlock",
    ]
    g = build_groups(stems, [parse_name(s) for s in stems], [None] * 5, [220.0] * 5,
                     audio_fn=lambda a, b: 0.0)  # fmt: skip
    assert len(set(g.group[:4])) == 1
    assert g.version[:4] == ["lofi", "sped up", "vinyl", "original"]


def test_unrelated_names_need_audio():
    a, b = parse_name("Night Dancer - imase"), parse_name("Racing into the Night - YOASOBI")
    assert decide_link(a, b, 0.0, True, True) is None
    assert decide_link(a, b, 0.5, True, True) == "audio"
