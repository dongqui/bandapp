"""Pick a cutoff without ground truth (spec Section 3.2).

Models disagree on scale: one reports 0.95 over a rehearsal take, another 0.55
over the same audio. A single fixed cutoff would punish the second one for
nothing. Otsu's method finds the valley between the two humps of whatever
distribution a model actually produced, which needs no labels.

Known limitation: `separated` is a spread check, not a bimodality test.
Otsu's between-class variance grows with how spread out the scores are, not
with how cleanly they split into two humps. A wide unimodal curve (e.g.
uniform noise) can clear the floor and report separated=True; a narrow
bimodal curve compressed into a tight band (the 0.55-scale model above) can
measure below the floor and report separated=False even though it genuinely
has two humps. Treat `separated` as a hint for a human skimming the report
alongside the audio, not a verdict: that costs a glance, so it's not worth
reaching for real bimodality machinery (dip test, kernel smoothing) to make
the flag exact.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

FALLBACK = 0.5
_BINS = 256
# Between-class variance floor. This is a proxy for "this curve has some
# structure", NOT a test for two modes -- see the module docstring's Known
# limitation. Calibrated so a normal(0.5, 0.02) blob stays under it while two
# separated clusters clear it by an order of magnitude.
_MIN_SPREAD = 0.005


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
    centres = (edges[:-1] + edges[1:]) / 2.0

    # Otsu: maximise between-class variance over every split point. Wrapped in
    # one errstate guard because counts.sum() can be 0 (e.g. all-NaN or
    # all-out-of-range scores), which would otherwise leak a RuntimeWarning
    # to stderr even though the eventual fallback result is already correct.
    with np.errstate(divide="ignore", invalid="ignore"):
        weight = counts / counts.sum()
        w0 = np.cumsum(weight)
        w1 = 1.0 - w0
        mean_total = float((weight * centres).sum())
        mean0 = np.cumsum(weight * centres)
        between = (mean_total * w0 - mean0) ** 2 / (w0 * w1)
    between = np.nan_to_num(between, nan=0.0, posinf=0.0, neginf=0.0)

    # Ties are common: two clean point masses make between-class variance flat
    # across the whole gap between them. np.argmax alone would grab the first
    # tied index, i.e. the edge of the lower cluster, not the gap's middle.
    # Average all indices at the max to land the split in the middle instead.
    max_between = float(between.max())
    tied = np.flatnonzero(between >= max_between - 1e-12)
    best = int(round(float(tied.mean())))
    # Guard against max_between, not between[best]: when the tied plateau is
    # non-contiguous, the averaged index can itself sit at a lower value than
    # the true max, which would otherwise report both a wrong flag and a
    # wrong printed spread.
    separation = max_between
    if separation < _MIN_SPREAD:
        return AutoThreshold(
            FALLBACK,
            f"score spread {separation:.4f} below {_MIN_SPREAD}; using {FALLBACK}",
            False,
        )
    value = round(float(edges[best + 1]), 2)
    return AutoThreshold(value, f"Otsu split (spread {separation:.4f})", True)
