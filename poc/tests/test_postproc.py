import numpy as np
import pytest

from bandpoc.postproc import (
    PostParams,
    Segment,
    resample_scores,
    scores_to_segments,
    segments_to_mask,
)

HOP = 0.1


def curve(spec):
    """Build a score curve from (value, seconds) pairs at hop=0.1."""
    parts = [np.full(int(round(sec / HOP)), val, dtype=np.float32) for val, sec in spec]
    return np.concatenate(parts)


def test_threshold_is_inclusive():
    scores = curve([(0.7, 30.0)])
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=10.0)
    assert scores_to_segments(scores, HOP, params) == [Segment(0.0, 30.0)]


def test_score_just_below_threshold_is_excluded():
    scores = curve([(0.69, 30.0)])
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=10.0)
    assert scores_to_segments(scores, HOP, params) == []


def test_gap_exactly_equal_to_merge_gap_is_merged():
    scores = curve([(0.9, 30.0), (0.1, 10.0), (0.9, 30.0)])
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=10.0)
    assert scores_to_segments(scores, HOP, params) == [Segment(0.0, 70.0)]


def test_gap_just_over_merge_gap_is_not_merged():
    scores = curve([(0.9, 30.0), (0.1, 10.1), (0.9, 30.0)])
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=10.0)
    assert scores_to_segments(scores, HOP, params) == [
        Segment(0.0, 30.0),
        Segment(40.1, 70.1),
    ]


def test_duration_exactly_equal_to_min_duration_is_kept():
    scores = curve([(0.1, 5.0), (0.9, 20.0), (0.1, 5.0)])
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=5.0)
    assert scores_to_segments(scores, HOP, params) == [Segment(5.0, 25.0)]


def test_duration_just_under_min_duration_is_dropped():
    scores = curve([(0.1, 5.0), (0.9, 19.9), (0.1, 5.0)])
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=5.0)
    assert scores_to_segments(scores, HOP, params) == []


def test_merge_happens_before_min_duration_filter():
    # Two 12 s runs, 4 s apart: neither survives alone, together they do.
    scores = curve([(0.9, 12.0), (0.1, 4.0), (0.9, 12.0)])
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=5.0)
    assert scores_to_segments(scores, HOP, params) == [Segment(0.0, 28.0)]


def test_segment_reaching_end_of_curve_is_closed():
    scores = curve([(0.1, 5.0), (0.9, 25.0)])
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=5.0)
    assert scores_to_segments(scores, HOP, params) == [Segment(5.0, 30.0)]


def test_empty_curve_yields_no_segments():
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=5.0)
    assert scores_to_segments(np.array([], dtype=np.float32), HOP, params) == []


def test_segments_to_mask_marks_exactly_the_covered_frames():
    mask = segments_to_mask([Segment(1.0, 2.0)], n_frames=30, hop=HOP)
    assert mask[:10].sum() == 0
    assert mask[10:20].all()
    assert mask[20:].sum() == 0


def test_resample_scores_stretches_a_coarse_curve_onto_the_fine_grid():
    coarse = np.array([0.0, 1.0], dtype=np.float32)  # hop 1.0 s
    fine = resample_scores(coarse, src_hop=1.0, n_frames=20, dst_hop=HOP)
    assert len(fine) == 20
    assert fine[0] == pytest.approx(0.0, abs=0.06)
    assert fine[-1] == pytest.approx(1.0, abs=0.06)
    assert np.all(np.diff(fine) >= -1e-6)


def test_resample_scores_pads_when_curve_is_shorter_than_the_grid():
    coarse = np.array([0.4, 0.4], dtype=np.float32)
    fine = resample_scores(coarse, src_hop=1.0, n_frames=100, dst_hop=HOP)
    assert len(fine) == 100
    assert fine[-1] == pytest.approx(0.4, abs=1e-6)


def test_resample_scores_handles_single_point_curve():
    fine = resample_scores(np.array([0.8], dtype=np.float32), 1.0, 10, HOP)
    assert len(fine) == 10
    assert np.allclose(fine, 0.8)
