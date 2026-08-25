import numpy as np
import pytest

from bandpoc.labels import HOP, LabelBlock, SceneLabels
from bandpoc.postproc import Segment
from bandpoc.sweep import (
    MERGE_GAPS,
    MIN_DURATIONS,
    THRESHOLDS,
    SceneInput,
    best_point,
    run_sweep,
)


def make_scene(scene_id="s"):
    """60 s music (take 1), 60 s speech, 60 s music (take 2)."""
    blocks = (
        LabelBlock(0.0, 60.0, "music", 1),
        LabelBlock(60.0, 120.0, "speech", None),
        LabelBlock(120.0, 180.0, "music", 2),
    )
    return SceneLabels(scene_id=scene_id, duration=180.0, blocks=blocks)


def oracle_scores(scene):
    m = scene.frame_masks()
    return np.where(m.is_music, 0.95, 0.05).astype(np.float32)


def test_grid_dimensions_match_the_spec():
    assert len(THRESHOLDS) == 19
    assert THRESHOLDS[0] == pytest.approx(0.05)
    assert THRESHOLDS[-1] == pytest.approx(0.95)
    assert MIN_DURATIONS == (10.0, 20.0, 30.0)
    assert MERGE_GAPS == (5.0, 10.0, 20.0)


def test_sweep_covers_the_whole_grid():
    scene = make_scene()
    points = run_sweep([SceneInput("s", oracle_scores(scene), scene)])
    assert len(points) == 19 * 3 * 3


def test_oracle_scores_reach_perfect_recall_with_no_false_music():
    scene = make_scene()
    points = run_sweep([SceneInput("s", oracle_scores(scene), scene)])
    best, _ = best_point(points, min_recall=0.90)
    assert best is not None
    assert best.recall == pytest.approx(1.0)
    assert best.false_seconds == pytest.approx(0.0)
    assert best.take_count_error == 0


def test_best_point_returns_none_when_the_recall_floor_is_unreachable():
    scene = make_scene()
    flat = np.zeros(scene.n_frames(), dtype=np.float32)
    points = run_sweep([SceneInput("s", flat, scene)])
    best, top_recall = best_point(points, min_recall=0.90)
    assert best is None
    assert top_recall.recall == pytest.approx(0.0)


def test_best_point_prefers_lower_false_music_among_qualifying_points():
    scene = make_scene()
    # Music is clear; speech sits at 0.5 so low thresholds pull it in.
    m = scene.frame_masks()
    scores = np.where(m.is_music, 0.95, 0.5).astype(np.float32)
    points = run_sweep([SceneInput("s", scores, scene)])
    best, _ = best_point(points, min_recall=0.90)
    assert best is not None
    assert best.params.threshold > 0.5
    assert best.false_seconds == pytest.approx(0.0)


def test_scenes_are_combined_by_micro_average():
    a, b = make_scene("a"), make_scene("b")
    scores_a = oracle_scores(a)
    scores_b = np.zeros(b.n_frames(), dtype=np.float32)  # detects nothing
    points = run_sweep([SceneInput("a", scores_a, a), SceneInput("b", scores_b, b)])
    _, top_recall = best_point(points, min_recall=0.90)
    assert top_recall.recall == pytest.approx(0.5)


def test_a_detection_in_one_scene_never_matches_a_take_in_another():
    # Scene A is all speech with no takes, but its curve spuriously peaks over
    # its first 60 s. Scene B has a real take over ITS first 60 s and a curve
    # that detects nothing. Both land at the same timestamps within their own
    # scene, so without run_sweep's timeline offset, A's false detection gets
    # IoU-matched against B's genuine take and scored as a hit.
    a = SceneLabels(
        scene_id="a",
        duration=180.0,
        blocks=(LabelBlock(0.0, 180.0, "speech", None),),
    )
    b = SceneLabels(
        scene_id="b",
        duration=180.0,
        blocks=(
            LabelBlock(0.0, 60.0, "music", 1),
            LabelBlock(60.0, 180.0, "speech", None),
        ),
    )
    a_scores = np.concatenate(
        [np.full(600, 0.95, dtype=np.float32), np.full(1200, 0.05, dtype=np.float32)]
    )
    b_scores = np.full(b.n_frames(), 0.05, dtype=np.float32)

    points = run_sweep([SceneInput("a", a_scores, a), SceneInput("b", b_scores, b)])
    point = next(
        p
        for p in points
        if abs(p.params.threshold - 0.7) < 1e-9
        and p.params.min_duration == 20.0
        and p.params.merge_gap == 10.0
    )
    assert point.segments_by_scene["a"] == [Segment(0.0, 60.0)]
    assert point.segments_by_scene["b"] == []
    assert point.boundary.truth_count == 1
    assert point.boundary.detected_count == 1
    assert point.boundary.matched == 0
