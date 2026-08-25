import numpy as np
import pytest

from bandpoc.labels import HOP, LabelBlock, SceneLabels, validate


def build(blocks):
    """Lay blocks end to end and wrap them in a SceneLabels."""
    out, t = [], 0.0
    for label, dur, take in blocks:
        out.append(LabelBlock(start=t, end=t + dur, label=label, take=take))
        t += dur
    return SceneLabels(scene_id="t", duration=t, blocks=tuple(out))


def test_ground_truth_take_spans_an_intervening_non_music_block():
    scene = build([
        ("music", 40.0, 3),
        ("speech", 8.0, 3),     # "야 다시 가자"
        ("music", 60.0, 3),
        ("speech", 30.0, None),
        ("music", 50.0, 4),
    ])
    assert scene.ground_truth_takes() == [(0.0, 108.0), (138.0, 188.0)]


def test_frames_inside_a_take_but_not_music_are_dontcare():
    scene = build([("music", 10.0, 1), ("speech", 5.0, 1), ("music", 10.0, 1)])
    m = scene.frame_masks()
    assert m.is_music[:100].all()
    assert not m.is_music[100:150].any()
    assert not m.is_dontcare[:100].any()
    assert m.is_dontcare[100:150].all()
    assert not m.is_dontcare[150:].any()


def test_speech_outside_a_take_is_not_dontcare():
    scene = build([("music", 10.0, 1), ("speech", 10.0, None)])
    m = scene.frame_masks()
    assert not m.is_dontcare.any()


def test_noodling_is_never_music():
    scene = build([("speech_with_noodling", 10.0, None)])
    m = scene.frame_masks()
    assert not m.is_music.any()
    assert not m.is_dontcare.any()


def test_frame_count_matches_duration():
    scene = build([("music", 12.3, 1)])
    m = scene.frame_masks()
    assert scene.n_frames() == 123
    assert len(m.is_music) == 123
    assert len(m.label_idx) == 123


def test_json_roundtrip(tmp_path):
    scene = build([("music", 10.0, 1), ("speech", 5.0, 1), ("tuning", 7.0, None)])
    path = tmp_path / "s.labels.json"
    scene.to_json(path)
    assert SceneLabels.from_json(path) == scene


def test_validate_rejects_music_block_without_take():
    scene = build([("music", 10.0, None)])
    with pytest.raises(ValueError, match="take"):
        validate(scene)


def test_validate_rejects_unknown_label():
    scene = build([("chatter", 10.0, None)])
    with pytest.raises(ValueError, match="chatter"):
        validate(scene)


def test_validate_rejects_overlapping_blocks():
    scene = SceneLabels(
        scene_id="t",
        duration=20.0,
        blocks=(
            LabelBlock(0.0, 12.0, "music", 1),
            LabelBlock(10.0, 20.0, "speech", None),
        ),
    )
    with pytest.raises(ValueError, match="overlap"):
        validate(scene)
