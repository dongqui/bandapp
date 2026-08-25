"""Evaluation metrics (spec § 6).

Everything is counted, not averaged, so scenes combine by micro-average:
``frame_counts(a) + frame_counts(b)`` is the same as evaluating the two scenes
concatenated. Averaging per-scene rates would over-weight short scenes.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .labels import LABELS, MUSIC_LABEL, FrameMasks
from .postproc import Segment

_LABEL_INDEX = {name: i for i, name in enumerate(LABELS)}
_NON_MUSIC_LABELS = tuple(name for name in LABELS if name != MUSIC_LABEL)


@dataclass(frozen=True)
class FrameCounts:
    music_hit: int
    music_total: int
    false_hit: int
    false_total: int
    per_label_hit: dict[str, int] = field(default_factory=dict)
    per_label_total: dict[str, int] = field(default_factory=dict)

    def __add__(self, other: "FrameCounts") -> "FrameCounts":
        return FrameCounts(
            music_hit=self.music_hit + other.music_hit,
            music_total=self.music_total + other.music_total,
            false_hit=self.false_hit + other.false_hit,
            false_total=self.false_total + other.false_total,
            per_label_hit={
                k: self.per_label_hit.get(k, 0) + other.per_label_hit.get(k, 0)
                for k in _NON_MUSIC_LABELS
            },
            per_label_total={
                k: self.per_label_total.get(k, 0) + other.per_label_total.get(k, 0)
                for k in _NON_MUSIC_LABELS
            },
        )

    @property
    def music_recall(self) -> float:
        if self.music_total == 0:
            return float("nan")
        return self.music_hit / self.music_total

    @property
    def false_music_ratio(self) -> float:
        if self.false_total == 0:
            return float("nan")
        return self.false_hit / self.false_total

    def false_music_seconds(self, hop: float) -> float:
        return self.false_hit * hop

    @property
    def per_label_false_rate(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for name in _NON_MUSIC_LABELS:
            total = self.per_label_total.get(name, 0)
            out[name] = float("nan") if total == 0 else self.per_label_hit.get(name, 0) / total
        return out


def frame_counts(detected_mask: np.ndarray, masks: FrameMasks) -> FrameCounts:
    """Count hits against the ground-truth frame masks.

    Don't-care frames are removed from every numerator and denominator here —
    this is the single place that rule is enforced, so a bug in it is invisible
    in the report. See the dedicated tests.
    """
    detected = np.asarray(detected_mask, dtype=bool)
    keep = ~masks.is_dontcare
    music = masks.is_music & keep
    eligible = ~masks.is_music & keep

    per_hit: dict[str, int] = {}
    per_total: dict[str, int] = {}
    for name in _NON_MUSIC_LABELS:
        sel = (masks.label_idx == _LABEL_INDEX[name]) & keep
        per_total[name] = int(sel.sum())
        per_hit[name] = int((detected & sel).sum())

    return FrameCounts(
        music_hit=int((detected & music).sum()),
        music_total=int(music.sum()),
        false_hit=int((detected & eligible).sum()),
        false_total=int(eligible.sum()),
        per_label_hit=per_hit,
        per_label_total=per_total,
    )


def _iou(a: Segment, b: Segment) -> float:
    inter = max(0.0, min(a.end, b.end) - max(a.start, b.start))
    union = (a.end - a.start) + (b.end - b.start) - inter
    return 0.0 if union <= 0 else inter / union


def match_takes(
    truth: list[Segment], detected: list[Segment], iou_threshold: float = 0.5
) -> list[tuple[int, int, float]]:
    """Greedy one-to-one matching by descending IoU."""
    candidates = [
        (_iou(t, d), ti, di)
        for ti, t in enumerate(truth)
        for di, d in enumerate(detected)
        if _iou(t, d) > iou_threshold
    ]
    candidates.sort(key=lambda c: (-c[0], c[1], c[2]))
    used_t: set[int] = set()
    used_d: set[int] = set()
    pairs: list[tuple[int, int, float]] = []
    for iou, ti, di in candidates:
        if ti in used_t or di in used_d:
            continue
        used_t.add(ti)
        used_d.add(di)
        pairs.append((ti, di, iou))
    return sorted(pairs, key=lambda p: p[0])


@dataclass(frozen=True)
class BoundaryStats:
    start_p50: float
    start_p90: float
    end_p50: float
    end_p90: float
    matched: int
    truth_count: int
    detected_count: int

    @property
    def take_count_error(self) -> int:
        return self.detected_count - self.truth_count


def boundary_stats(
    truth: list[Segment], detected: list[Segment], iou_threshold: float = 0.5
) -> BoundaryStats:
    pairs = match_takes(truth, detected, iou_threshold)
    if not pairs:
        nan = float("nan")
        return BoundaryStats(nan, nan, nan, nan, 0, len(truth), len(detected))
    start_err = np.array([abs(detected[d].start - truth[t].start) for t, d, _ in pairs])
    end_err = np.array([abs(detected[d].end - truth[t].end) for t, d, _ in pairs])
    return BoundaryStats(
        start_p50=float(np.median(start_err)),
        start_p90=float(np.percentile(start_err, 90)),
        end_p50=float(np.median(end_err)),
        end_p90=float(np.percentile(end_err, 90)),
        matched=len(pairs),
        truth_count=len(truth),
        detected_count=len(detected),
    )
