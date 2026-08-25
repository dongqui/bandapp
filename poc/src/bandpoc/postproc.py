"""Turn a per-frame music-score curve into Take segments.

This is the tunable half of the pipeline (spec § 5). It never touches a model,
so a full parameter sweep runs on cached curves in seconds.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Segment:
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass(frozen=True)
class PostParams:
    threshold: float
    min_duration: float
    merge_gap: float


def scores_to_segments(scores: np.ndarray, hop: float, params: PostParams) -> list[Segment]:
    """Binarise, merge short gaps, then drop short segments — in that order.

    Merging must precede the duration filter: two 12 s runs 4 s apart are one
    28 s Take, but filtering first would delete both.
    """
    segments = _runs_to_segments(np.asarray(scores) >= params.threshold, hop)
    segments = _merge_gaps(segments, params.merge_gap)
    return [s for s in segments if s.duration >= params.min_duration - 1e-9]


def _runs_to_segments(mask: np.ndarray, hop: float) -> list[Segment]:
    if mask.size == 0:
        return []
    padded = np.concatenate(([False], mask.astype(bool), [False]))
    edges = np.diff(padded.astype(np.int8))
    starts = np.flatnonzero(edges == 1)
    ends = np.flatnonzero(edges == -1)
    # Round to 10 decimal places to avoid floating-point errors from frame index * hop
    return [Segment(round(float(s) * hop, 10), round(float(e) * hop, 10)) for s, e in zip(starts, ends)]


def _merge_gaps(segments: list[Segment], merge_gap: float) -> list[Segment]:
    if not segments:
        return []
    merged = [segments[0]]
    for seg in segments[1:]:
        if seg.start - merged[-1].end <= merge_gap + 1e-9:
            merged[-1] = Segment(merged[-1].start, seg.end)
        else:
            merged.append(seg)
    return merged


def segments_to_mask(segments, n_frames: int, hop: float) -> np.ndarray:
    """Frame mask of the union of ``segments``, on the evaluation grid."""
    mask = np.zeros(n_frames, dtype=bool)
    for seg in segments:
        lo = max(0, int(round(seg.start / hop)))
        hi = min(n_frames, int(round(seg.end / hop)))
        if hi > lo:
            mask[lo:hi] = True
    return mask


def resample_scores(
    scores: np.ndarray, src_hop: float, n_frames: int, dst_hop: float
) -> np.ndarray:
    """Interpolate a detector's native-rate curve onto the evaluation grid.

    Edges are held flat rather than extrapolated, so a coarse detector never
    invents values beyond what it actually reported.
    """
    scores = np.asarray(scores, dtype=np.float32)
    if n_frames <= 0:
        return np.zeros(0, dtype=np.float32)
    if scores.size == 0:
        return np.zeros(n_frames, dtype=np.float32)
    if scores.size == 1:
        return np.full(n_frames, float(scores[0]), dtype=np.float32)
    src_t = np.arange(scores.size) * src_hop
    dst_t = np.arange(n_frames) * dst_hop
    return np.interp(dst_t, src_t, scores, left=scores[0], right=scores[-1]).astype(
        np.float32
    )
