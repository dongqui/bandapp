import numpy as np
import pytest

from bandpoc.labels import HOP, LabelBlock, SceneLabels
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
