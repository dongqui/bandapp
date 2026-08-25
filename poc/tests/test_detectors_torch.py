"""Smoke tests. Skipped unless the torch backend is installed."""

import numpy as np
import pytest

from bandpoc import registry
import bandpoc.detectors  # noqa: F401 - triggers registration

SR = 16000


def tone(freq, seconds, sr=SR):
    t = np.arange(int(seconds * sr)) / sr
    return (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def get_or_skip(key):
    det = registry.get(key)
    ok, reason = det.is_available()
    if not ok:
        pytest.skip(f"{key} unavailable: {reason}")
    det.load()
    return det


@pytest.mark.parametrize(
    "key", ["panns_cnn14:music_only", "panns_cnn14:music_group", "silero_vad:default"]
)
def test_returns_a_bounded_curve_with_a_positive_hop(key):
    det = get_or_skip(key)
    scores, hop = det.music_score(tone(220, 12.0), SR)
    assert hop > 0
    assert scores.dtype == np.float32
    assert scores.min() >= 0.0 and scores.max() <= 1.0
    assert len(scores) >= 1


@pytest.mark.parametrize("key", ["panns_cnn14:music_group", "silero_vad:default"])
def test_curve_length_grows_with_audio_length(key):
    det = get_or_skip(key)
    short, hop = det.music_score(tone(220, 12.0), SR)
    long, _ = det.music_score(tone(220, 60.0), SR)
    assert len(long) > len(short)
    assert len(long) == pytest.approx(60.0 / hop, rel=0.25)


def test_panns_scores_a_musical_tone_above_silence():
    det = get_or_skip("panns_cnn14:music_group")
    music, _ = det.music_score(tone(220, 12.0), SR)
    quiet, _ = det.music_score(np.zeros(SR * 12, dtype=np.float32), SR)
    assert float(np.median(music)) > float(np.median(quiet))


@pytest.mark.parametrize("key", ["panns_cnn14:music_only", "panns_cnn14:music_group"])
def test_registered_keys_report_their_variant(key):
    assert registry.get(key).key == key
