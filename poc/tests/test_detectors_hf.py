"""Smoke tests. Skipped unless the transformers backend is installed."""

import numpy as np
import pytest

from bandpoc import registry
import bandpoc.detectors  # noqa: F401

SR = 16000


def tone(freq, seconds, sr=SR):
    t = np.arange(int(seconds * sr)) / sr
    return (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def music_like(seconds, sr=SR):
    """A stimulus an AudioSet head actually calls music.

    A bare sine will not do: AST labels one "Sine wave" at 0.94 and "Music" at
    0.008, which is the model being right, not broken. Harmonic chords, note
    attacks and a percussive hit are what push the Music class up.
    """
    rng = np.random.default_rng(0)
    n = int(seconds * sr)
    out = np.zeros(n, dtype=np.float32)
    beat = int(0.5 * sr)
    t = np.arange(beat) / sr
    envelope = np.exp(-3.5 * t)
    for k, start in enumerate(range(0, n - beat, beat)):
        chord = (220.0, 277.18, 329.63) if k % 2 == 0 else (246.94, 311.13, 369.99)
        for root in chord:
            for harmonic, amp in enumerate((1.0, 0.5, 0.3, 0.18, 0.1), start=1):
                phase = rng.uniform(0, 2 * np.pi)
                out[start : start + beat] += (
                    amp * 0.12 * np.sin(2 * np.pi * root * harmonic * t + phase) * envelope
                )
        out[start : start + beat] += (
            rng.standard_normal(beat).astype(np.float32) * np.exp(-30 * t) * 0.25
        )
    return np.clip(out, -1.0, 1.0).astype(np.float32)


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


def test_ast_scores_music_above_silence():
    det = get_or_skip("ast:music_group")
    music, _ = det.music_score(music_like(30.0), SR)
    quiet, _ = det.music_score(np.zeros(SR * 30, dtype=np.float32), SR)
    assert float(np.median(music)) > float(np.median(quiet))


def test_clap_prompt_sets_are_non_empty_and_disjoint():
    from bandpoc.detectors.clap import NEGATIVE_PROMPTS, POSITIVE_PROMPTS

    assert POSITIVE_PROMPTS and NEGATIVE_PROMPTS
    assert not set(POSITIVE_PROMPTS) & set(NEGATIVE_PROMPTS)
