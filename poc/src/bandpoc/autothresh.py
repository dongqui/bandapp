"""Pick a cutoff without ground truth (spec Section 3.2).

Models disagree on scale: one reports 0.95 over a rehearsal take, another 0.55
over the same audio. A single fixed cutoff would punish the second one for
nothing. Otsu's method finds the valley between the two humps of whatever
distribution a model actually produced, which needs no labels.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

FALLBACK = 0.5
_BINS = 256
# Between-class variance below this means the histogram is one hump, not two.
# Calibrated so a normal(0.5, 0.02) blob stays under it while two separated
# clusters clear it by an order of magnitude.
_MIN_SEPARATION = 0.005


@dataclass(frozen=True)
class AutoThreshold:
    value: float
    reason: str
    separated: bool


def auto_threshold(scores: np.ndarray) -> AutoThreshold:
    scores = np.asarray(scores, dtype=np.float64).ravel()
    if scores.size == 0:
        return AutoThreshold(FALLBACK, "empty curve; cannot separate", False)

    counts, edges = np.histogram(scores, bins=_BINS, range=(0.0, 1.0))
    weight = counts / counts.sum()
    centres = (edges[:-1] + edges[1:]) / 2.0

    # Otsu: maximise between-class variance over every split point.
    w0 = np.cumsum(weight)
    w1 = 1.0 - w0
    mean_total = float((weight * centres).sum())
    mean0 = np.cumsum(weight * centres)
    with np.errstate(divide="ignore", invalid="ignore"):
        between = (mean_total * w0 - mean0) ** 2 / (w0 * w1)
    between = np.nan_to_num(between, nan=0.0, posinf=0.0, neginf=0.0)

    # Ties are common: two clean point masses make between-class variance flat
    # across the whole gap between them. np.argmax alone would grab the first
    # tied index, i.e. the edge of the lower cluster, not the gap's middle.
    # Average all indices at the max to land the split in the middle instead.
    max_between = float(between.max())
    tied = np.flatnonzero(between >= max_between - 1e-12)
    best = int(round(float(tied.mean())))
    separation = float(between[best])
    if separation < _MIN_SEPARATION:
        return AutoThreshold(
            FALLBACK,
            f"scores do not separate into two groups (spread {separation:.4f}); "
            f"using {FALLBACK}",
            False,
        )
    value = round(float(edges[best + 1]), 2)
    return AutoThreshold(value, f"Otsu split (spread {separation:.4f})", True)
