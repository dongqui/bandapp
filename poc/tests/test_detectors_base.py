import numpy as np
import pytest

from bandpoc import registry
from bandpoc.detectors.base import Detector, chunked_scores
from bandpoc.detectors.dsp import DspBaseline

SR = 16000


def tone(freq, seconds, sr=SR, amp=0.3):
    t = np.arange(int(seconds * sr)) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def noise(seconds, sr=SR, amp=0.3, seed=0):
    return (amp * np.random.RandomState(seed).randn(int(seconds * sr))).astype(np.float32)


def test_chunked_scores_concatenates_in_order_and_trims_overlap():
    wav = np.zeros(SR * 10, dtype=np.float32)

    def fn(chunk):
        return np.full(int(len(chunk) / SR / 0.5), 0.5, dtype=np.float32)

    out = chunked_scores(wav, SR, chunk_s=4.0, overlap_s=1.0, fn=fn, hop_s=0.5)
    assert len(out) == pytest.approx(20, abs=2)
    assert np.allclose(out, 0.5)


def test_dsp_baseline_returns_a_bounded_curve_of_the_right_length():
    det = DspBaseline()
    det.load()
    scores, hop = det.music_score(tone(220, 6.0), SR)
    assert hop == pytest.approx(0.1)
    assert len(scores) == pytest.approx(60, abs=3)
    assert scores.min() >= 0.0 and scores.max() <= 1.0
    assert scores.dtype == np.float32


def test_dsp_baseline_scores_a_tone_above_white_noise():
    # 880 Hz, not 220: a tone below the 250 Hz cutoff would be separated from
    # noise by the low-band term alone, leaving the tonality term untested.
    det = DspBaseline()
    det.load()
    tonal, _ = det.music_score(tone(880, 6.0), SR)
    noisy, _ = det.music_score(noise(6.0), SR)
    assert float(np.median(tonal)) > float(np.median(noisy))


def test_dsp_baseline_scores_silence_near_zero():
    det = DspBaseline()
    det.load()
    scores, _ = det.music_score(np.zeros(SR * 6, dtype=np.float32), SR)
    assert float(np.max(scores)) < 0.05


def test_dsp_baseline_stitches_chunks_into_a_uniform_grid():
    # 130 s spans three 60 s chunks, so this fails if chunked_scores drops or
    # duplicates frames at a seam. The single-chunk cases below cannot catch that.
    det = DspBaseline()
    det.load()
    short, hop = det.music_score(tone(220, 5.0), SR)
    long, _ = det.music_score(tone(220, 130.0), SR)
    assert hop == pytest.approx(0.1)
    assert len(long) == pytest.approx(130.0 / hop, abs=10)
    assert len(long) > len(short) * 10
    assert float(np.median(long)) == pytest.approx(float(np.median(short)), abs=0.15)


def test_registry_round_trips_a_detector():
    registry.register("fake:default", lambda: DspBaseline())
    try:
        assert "fake:default" in registry.all_keys()
        assert isinstance(registry.get("fake:default"), Detector)
    finally:
        # module-level registry: without this the key outlives the test
        registry._FACTORIES.pop("fake:default", None)


def test_registry_raises_on_an_unknown_key():
    with pytest.raises(KeyError, match="nope"):
        registry.get("nope")


def test_dsp_baseline_reports_itself_available():
    ok, reason = DspBaseline().is_available()
    assert ok and reason == ""


def test_detector_reports_unavailable_when_a_required_package_is_missing():
    class Missing(Detector):
        name = "missing"
        version = "1"
        requires = ("definitely_not_installed_xyz",)

        def music_score(self, wav, sr):
            raise AssertionError("should never run")

    ok, reason = Missing().is_available()
    assert not ok
    assert "definitely_not_installed_xyz" in reason


def test_dsp_baseline_is_registered_by_default():
    import bandpoc.detectors  # noqa: F401 — registration happens on import

    assert "dsp_baseline:default" in registry.all_keys()
