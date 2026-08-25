"""Smoke tests. Skipped unless the TensorFlow backend is installed."""

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


@pytest.mark.parametrize(
    "key", ["yamnet:music_only", "yamnet:music_group", "ina_segmenter:default"]
)
def test_returns_a_bounded_curve_with_a_positive_hop(key):
    det = get_or_skip(key)
    scores, hop = det.music_score(tone(220, 20.0), SR)
    assert hop > 0
    assert scores.dtype == np.float32
    assert scores.min() >= 0.0 and scores.max() <= 1.0
    assert len(scores) >= 2


@pytest.mark.parametrize("key", ["yamnet:music_group", "ina_segmenter:default"])
def test_curve_length_grows_with_audio_length(key):
    det = get_or_skip(key)
    short, hop = det.music_score(tone(220, 20.0), SR)
    long, _ = det.music_score(tone(220, 90.0), SR)
    assert len(long) > len(short) * 3
    assert len(long) == pytest.approx(90.0 / hop, rel=0.25)


def test_yamnet_hop_is_the_documented_0_48_seconds():
    det = get_or_skip("yamnet:music_group")
    _, hop = det.music_score(tone(220, 20.0), SR)
    assert hop == pytest.approx(0.48, abs=0.01)


def test_yamnet_scores_a_musical_tone_above_silence():
    det = get_or_skip("yamnet:music_group")
    music, _ = det.music_score(tone(220, 20.0), SR)
    quiet, _ = det.music_score(np.zeros(SR * 20, dtype=np.float32), SR)
    assert float(np.median(music)) > float(np.median(quiet))


def test_ina_produces_a_hard_binary_curve():
    det = get_or_skip("ina_segmenter:default")
    scores, _ = det.music_score(tone(220, 20.0), SR)
    assert set(np.unique(scores)) <= {0.0, 1.0}
