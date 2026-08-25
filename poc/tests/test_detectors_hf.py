"""Smoke tests. Skipped unless the transformers backend is installed."""

import numpy as np
import pytest

from bandpoc import registry
import bandpoc.detectors  # noqa: F401

SR = 16000


def tone(freq, seconds, sr=SR):
    t = np.arange(int(seconds * sr)) / sr
    return (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def get_or_skip(key):
    try:
        det = registry.get(key)
    except ImportError as exc:
        pytest.skip(f"{key} unavailable: {exc}")
    ok, reason = det.is_available()
    if not ok:
        pytest.skip(f"{key} unavailable: {reason}")
    det.load()
    return det


@pytest.mark.parametrize("key", ["ast:music_only", "ast:music_group", "clap_zeroshot:default"])
def test_returns_a_bounded_curve_with_a_positive_hop(key):
    det = get_or_skip(key)
    scores, hop = det.music_score(tone(220, 30.0), SR)
    assert hop > 0
    assert scores.dtype == np.float32
    assert scores.min() >= 0.0 and scores.max() <= 1.0
    assert len(scores) >= 2


@pytest.mark.parametrize("key", ["ast:music_group", "clap_zeroshot:default"])
def test_curve_length_grows_with_audio_length(key):
    det = get_or_skip(key)
    short, _ = det.music_score(tone(220, 30.0), SR)
    long, _ = det.music_score(tone(220, 120.0), SR)
    assert len(long) > len(short) * 2


def test_ast_scores_a_musical_tone_above_silence():
    det = get_or_skip("ast:music_group")
    music, _ = det.music_score(tone(220, 30.0), SR)
    quiet, _ = det.music_score(np.zeros(SR * 30, dtype=np.float32), SR)
    assert float(np.median(music)) > float(np.median(quiet))


def test_clap_prompt_sets_are_non_empty_and_disjoint():
    from bandpoc.detectors.clap import NEGATIVE_PROMPTS, POSITIVE_PROMPTS

    assert POSITIVE_PROMPTS and NEGATIVE_PROMPTS
    assert not set(POSITIVE_PROMPTS) & set(NEGATIVE_PROMPTS)
