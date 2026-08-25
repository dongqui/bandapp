import numpy as np
import pytest

from bandpoc.audio import iter_chunks, normalize_loudness, resample


def test_resample_changes_length_proportionally():
    wav = np.sin(2 * np.pi * 440 * np.arange(16000) / 16000).astype(np.float32)
    out = resample(wav, 16000, 8000)
    assert abs(len(out) - 8000) <= 1
    assert out.dtype == np.float32


def test_resample_is_identity_when_rates_match():
    wav = np.random.RandomState(0).randn(1000).astype(np.float32)
    out = resample(wav, 16000, 16000)
    np.testing.assert_array_equal(out, wav)


def test_iter_chunks_covers_whole_signal_with_overlap():
    wav = np.arange(10 * 100, dtype=np.float32)  # 10 s at sr=100
    chunks = list(iter_chunks(wav, sr=100, chunk_s=4.0, overlap_s=1.0))
    # hop = 3 s = 300 samples
    assert [start for start, _ in chunks] == [0, 300, 600, 900]
    assert len(chunks[0][1]) == 400
    # last chunk is short and reaches the end
    assert chunks[-1][0] + len(chunks[-1][1]) == len(wav)


def test_iter_chunks_single_chunk_when_signal_shorter_than_chunk():
    wav = np.zeros(50, dtype=np.float32)
    chunks = list(iter_chunks(wav, sr=100, chunk_s=4.0, overlap_s=1.0))
    assert len(chunks) == 1
    assert chunks[0] [0] == 0
    assert len(chunks[0][1]) == 50


def test_iter_chunks_rejects_overlap_not_smaller_than_chunk():
    wav = np.zeros(100, dtype=np.float32)
    with pytest.raises(ValueError):
        list(iter_chunks(wav, sr=100, chunk_s=1.0, overlap_s=1.0))


def test_normalize_loudness_scales_quiet_signal_up():
    rs = np.random.RandomState(1)
    wav = (rs.randn(48000 * 3) * 0.001).astype(np.float32)
    out = normalize_loudness(wav, 48000, target_lufs=-23.0)
    assert np.max(np.abs(out)) > np.max(np.abs(wav))
    assert np.max(np.abs(out)) <= 0.99 + 1e-6


def test_normalize_loudness_leaves_silence_untouched():
    wav = np.zeros(48000 * 2, dtype=np.float32)
    out = normalize_loudness(wav, 48000)
    np.testing.assert_array_equal(out, wav)
