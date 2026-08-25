import numpy as np
import pytest

from bandpoc.labels import FrameMasks, LABELS
from bandpoc.metrics import BoundaryStats, boundary_stats, frame_counts, match_takes
from bandpoc.postproc import Segment

IDX = {name: i for i, name in enumerate(LABELS)}


def masks_from(labels, dontcare=()):
    """Build FrameMasks from a list of label names, one entry per frame."""
    label_idx = np.array([IDX[name] for name in labels], dtype=np.int8)
    is_music = label_idx == IDX["music"]
    is_dontcare = np.zeros(len(labels), dtype=bool)
    for i in dontcare:
        is_dontcare[i] = True
    return FrameMasks(label_idx=label_idx, is_music=is_music, is_dontcare=is_dontcare)


def test_perfect_detection_scores_full_recall_and_no_false_music():
    m = masks_from(["music"] * 10 + ["speech"] * 10)
    detected = np.array([True] * 10 + [False] * 10)
    c = frame_counts(detected, m)
    assert c.music_recall == 1.0
    assert c.false_music_ratio == 0.0
    assert c.false_music_seconds(0.1) == 0.0


def test_half_the_music_missed_gives_half_recall():
    m = masks_from(["music"] * 10 + ["speech"] * 10)
    detected = np.array([True] * 5 + [False] * 15)
    c = frame_counts(detected, m)
    assert c.music_recall == pytest.approx(0.5)


def test_speech_flagged_as_music_counts_as_false_music():
    m = masks_from(["music"] * 10 + ["speech"] * 10)
    detected = np.ones(20, dtype=bool)
    c = frame_counts(detected, m)
    assert c.false_music_ratio == pytest.approx(1.0)
    assert c.false_music_seconds(0.1) == pytest.approx(1.0)


def test_dontcare_frames_are_excluded_from_false_music():
    # 10 music, 5 speech inside the take (don't-care), 10 speech outside.
    m = masks_from(["music"] * 10 + ["speech"] * 5 + ["speech"] * 10,
                   dontcare=range(10, 15))
    detected = np.array([True] * 15 + [False] * 10)
    c = frame_counts(detected, m)
    assert c.music_recall == 1.0
    assert c.false_music_ratio == 0.0, "bridging a mid-take pause must not be penalised"
    assert c.false_total == 10


def test_dontcare_wins_over_music_in_the_recall_denominator():
    # labels.py makes music and don't-care disjoint, so this state is
    # unreachable in production. Constructing it directly is the only way to
    # prove the `& keep` guard on the music path does something — without it,
    # a future change to that invariant would silently inflate music_total.
    m = masks_from(["music"] * 10 + ["speech"] * 5, dontcare=range(5, 15))
    detected = np.array([True] * 10 + [False] * 5)
    c = frame_counts(detected, m)
    assert c.music_total == 5, "music frames marked don't-care must not count"
    assert c.music_hit == 5


def test_per_label_false_rate_isolates_the_hard_cases():
    m = masks_from(["speech_with_noodling"] * 10 + ["tuning"] * 10)
    detected = np.array([True] * 10 + [False] * 10)
    c = frame_counts(detected, m)
    assert c.per_label_false_rate["speech_with_noodling"] == pytest.approx(1.0)
    assert c.per_label_false_rate["tuning"] == pytest.approx(0.0)


def test_counts_add_across_scenes():
    m1 = masks_from(["music"] * 10)
    m2 = masks_from(["music"] * 10)
    total = frame_counts(np.ones(10, dtype=bool), m1) + frame_counts(
        np.zeros(10, dtype=bool), m2
    )
    assert total.music_total == 20
    assert total.music_recall == pytest.approx(0.5)


def test_recall_of_a_scene_with_no_music_is_nan():
    m = masks_from(["speech"] * 10)
    c = frame_counts(np.zeros(10, dtype=bool), m)
    assert np.isnan(c.music_recall)


def test_match_takes_pairs_overlapping_segments_by_best_iou():
    truth = [Segment(0.0, 100.0), Segment(200.0, 300.0)]
    detected = [Segment(5.0, 95.0), Segment(190.0, 310.0)]
    pairs = match_takes(truth, detected)
    assert [(t, d) for t, d, _ in pairs] == [(0, 0), (1, 1)]


def test_match_takes_ignores_pairs_below_the_iou_threshold():
    truth = [Segment(0.0, 100.0)]
    detected = [Segment(90.0, 400.0)]  # IoU ≈ 0.025
    assert match_takes(truth, detected) == []


def test_match_takes_is_one_to_one():
    truth = [Segment(0.0, 100.0)]
    detected = [Segment(0.0, 100.0), Segment(1.0, 99.0)]
    assert len(match_takes(truth, detected)) == 1


def test_boundary_stats_reports_absolute_edge_errors():
    truth = [Segment(0.0, 100.0), Segment(200.0, 300.0)]
    detected = [Segment(2.0, 106.0), Segment(196.0, 302.0)]
    s = boundary_stats(truth, detected)
    assert s.matched == 2
    assert s.start_p50 == pytest.approx(3.0)   # median of |2|, |4|
    assert s.end_p50 == pytest.approx(4.0)     # median of |6|, |2|
    assert s.truth_count == 2
    assert s.detected_count == 2


def test_boundary_stats_with_no_matches_reports_nan_but_keeps_counts():
    s = boundary_stats([Segment(0.0, 10.0)], [])
    assert s.matched == 0
    assert np.isnan(s.start_p50)
    assert s.truth_count == 1
    assert s.detected_count == 0
