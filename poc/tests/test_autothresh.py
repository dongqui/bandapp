import numpy as np
import pytest

from bandpoc.autothresh import FALLBACK, auto_threshold


def bimodal(low=0.1, high=0.9, n=500):
    return np.concatenate([np.full(n, low), np.full(n, high)]).astype(np.float32)


def test_bimodal_scores_get_a_threshold_between_the_two_modes():
    result = auto_threshold(bimodal())
    assert 0.1 < result.value < 0.9
    assert result.separated is True


def test_a_noisy_bimodal_curve_still_separates():
    rng = np.random.default_rng(0)
    quiet = rng.normal(0.15, 0.05, 800)
    loud = rng.normal(0.85, 0.05, 800)
    result = auto_threshold(np.clip(np.concatenate([quiet, loud]), 0, 1).astype(np.float32))
    assert 0.3 < result.value < 0.7
    assert result.separated is True


def test_a_constant_curve_falls_back_and_says_why():
    result = auto_threshold(np.full(500, 0.8, dtype=np.float32))
    assert result.value == FALLBACK
    assert result.separated is False
    assert "spread" in result.reason
    assert "below" in result.reason


def test_a_unimodal_curve_falls_back():
    rng = np.random.default_rng(1)
    scores = np.clip(rng.normal(0.5, 0.02, 1000), 0, 1).astype(np.float32)
    result = auto_threshold(scores)
    assert result.value == FALLBACK
    assert result.separated is False


def test_a_binary_curve_lands_between_zero_and_one():
    scores = np.array([0.0] * 300 + [1.0] * 300, dtype=np.float32)
    result = auto_threshold(scores)
    assert 0.0 < result.value < 1.0
    assert result.separated is True


def test_uniform_noise_is_reported_as_separated_even_though_it_has_no_humps():
    # Documents a known limitation (see the module docstring), not a desired
    # outcome: Otsu's between-class variance is monotone in overall spread,
    # not in bimodality. The most structureless curve possible -- uniform
    # noise over the whole range -- has high spread and clears the floor, so
    # `separated` comes back True even though there are no humps at all.
    rng = np.random.default_rng(0)
    scores = rng.uniform(0, 1, 1000).astype(np.float32)
    result = auto_threshold(scores)
    assert result.separated is True


def test_a_tight_bimodal_curve_is_reported_as_not_separated():
    # Documents the mirror-image limitation: two clusters squeezed into a
    # narrow band (the compressed-scale model the module docstring warns
    # about) are genuinely bimodal but have low overall spread, so they can
    # measure below the floor and come back separated=False. This is the
    # false negative side of the same monotone-in-spread behaviour above --
    # pinned here so the constant is not "fixed" later by retuning it, which
    # cannot repair the flag (the two regimes overlap; no constant separates
    # them).
    scores = np.concatenate([np.full(500, 0.43), np.full(500, 0.57)]).astype(np.float32)
    result = auto_threshold(scores)
    assert result.separated is False


def test_an_empty_curve_falls_back_without_raising():
    result = auto_threshold(np.zeros(0, dtype=np.float32))
    assert result.value == FALLBACK
    assert result.separated is False


def test_the_reason_string_is_ascii_for_a_cp949_console():
    for scores in (bimodal(), np.full(100, 0.3, dtype=np.float32)):
        auto_threshold(scores).reason.encode("cp949")


def test_the_threshold_is_reported_to_two_decimals():
    value = auto_threshold(bimodal()).value
    assert value == pytest.approx(round(value, 2))
