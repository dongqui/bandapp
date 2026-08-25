"""Post-processing parameter sweep (spec § 5, § 6.4).

Runs entirely on cached score curves, so the full 171-point grid over every
scene finishes in seconds. This is what makes it fair to compare detectors at
their own optima rather than at one shared threshold.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .labels import HOP, SceneLabels
from .metrics import BoundaryStats, FrameCounts, boundary_stats, frame_counts
from .postproc import PostParams, Segment, scores_to_segments, segments_to_mask

THRESHOLDS = np.round(np.arange(0.05, 0.955, 0.05), 2)
MIN_DURATIONS: tuple[float, ...] = (10.0, 20.0, 30.0)
MERGE_GAPS: tuple[float, ...] = (5.0, 10.0, 20.0)


@dataclass(frozen=True)
class SceneInput:
    scene_id: str
    scores: np.ndarray  # already on the evaluation grid
    labels: SceneLabels


@dataclass(frozen=True)
class SweepPoint:
    params: PostParams
    counts: FrameCounts
    boundary: BoundaryStats
    segments_by_scene: dict[str, list[Segment]]

    @property
    def recall(self) -> float:
        return self.counts.music_recall

    @property
    def false_seconds(self) -> float:
        return self.counts.false_music_seconds(HOP)

    @property
    def false_ratio(self) -> float:
        return self.counts.false_music_ratio

    @property
    def take_count_error(self) -> int:
        return self.boundary.take_count_error


def run_sweep(inputs: list[SceneInput], hop: float = HOP) -> list[SweepPoint]:
    prepared = [
        (inp, inp.labels.frame_masks(hop), inp.labels.ground_truth_takes())
        for inp in inputs
    ]
    points: list[SweepPoint] = []
    for threshold in THRESHOLDS:
        for merge_gap in MERGE_GAPS:
            for min_duration in MIN_DURATIONS:
                params = PostParams(
                    threshold=float(threshold),
                    min_duration=min_duration,
                    merge_gap=merge_gap,
                )
                total: FrameCounts | None = None
                all_truth: list[Segment] = []
                all_detected: list[Segment] = []
                by_scene: dict[str, list[Segment]] = {}
                offset = 0.0
                for inp, masks, truth in prepared:
                    segs = scores_to_segments(inp.scores, hop, params)
                    by_scene[inp.scene_id] = segs
                    counts = frame_counts(
                        segments_to_mask(segs, len(masks.is_music), hop), masks
                    )
                    total = counts if total is None else total + counts
                    # Shift each scene onto a shared timeline so segment matching
                    # never pairs takes across scene boundaries.
                    all_truth += [Segment(s + offset, e + offset) for s, e in truth]
                    all_detected += [
                        Segment(s.start + offset, s.end + offset) for s in segs
                    ]
                    offset += inp.labels.duration + 3600.0
                if total is None:
                    continue
                points.append(
                    SweepPoint(
                        params=params,
                        counts=total,
                        boundary=boundary_stats(all_truth, all_detected),
                        segments_by_scene=by_scene,
                    )
                )
    return points


def best_point(
    points: list[SweepPoint], min_recall: float = 0.90
) -> tuple[SweepPoint | None, SweepPoint]:
    """Lowest False Music among points meeting the recall floor.

    Returns ``(best_or_none, highest_recall_point)``. When no configuration can
    reach the floor, the caller reports that fact rather than silently showing
    the least-bad point as if it qualified.
    """
    if not points:
        raise ValueError("no sweep points")

    def recall_or_zero(p: SweepPoint) -> float:
        return 0.0 if np.isnan(p.recall) else p.recall

    def false_seconds_of(p: SweepPoint) -> float:
        # false_total == 0 means the scenes contain no non-music frames at all,
        # so there was no opportunity for a false positive and false_seconds is
        # genuinely 0.0, not infinite. This is params-independent, so it is the
        # same for every point in a sweep and cannot change any ranking — but
        # inf would still be the wrong thing to write down.
        return 0.0 if np.isnan(p.false_ratio) else p.false_seconds

    top_recall = max(points, key=lambda p: (recall_or_zero(p), -false_seconds_of(p)))
    qualifying = [p for p in points if recall_or_zero(p) >= min_recall]
    if not qualifying:
        return None, top_recall
    best = min(qualifying, key=lambda p: (false_seconds_of(p), abs(p.take_count_error)))
    return best, top_recall
