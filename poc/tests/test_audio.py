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
    # hop = 3 s = 300 samples. The chunk at 600 already spans 600..1000, so no
    # fourth chunk is emitted — a chunk at 900 would be fully redundant.
    assert [start for start, _ in chunks] == [0, 300, 600]
    assert len(chunks[0][1]) == 400
    # last chunk reaches the end
    assert chunks[-1][0] + len(chunks[-1][1]) == len(wav)


def test_iter_chunks_final_chunk_is_longer_than_the_overlap():
    # Detectors pass overlap_s = their analysis window, so a final chunk shorter
    # than the overlap would get zero-padded and score a spurious tail.
    wav = np.zeros(1000, dtype=np.float32)
    for chunk_s, overlap_s in [(4.0, 1.0), (3.0, 0.5), (2.5, 1.2)]:
        chunks = list(iter_chunks(wav, sr=100, chunk_s=chunk_s, overlap_s=overlap_s))
        assert len(chunks[-1][1]) > overlap_s * 100


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


def test_load_audio_resamples_to_the_requested_rate(tmp_path):
    import soundfile as sf

    from bandpoc.audio import load_audio

    path = tmp_path / "tone.wav"
    t = np.arange(44100 * 2) / 44100
    sf.write(str(path), (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32), 44100)

    wav, sr = load_audio(path, target_sr=16000)

    assert sr == 16000
    assert abs(len(wav) - 32000) <= 2
    assert wav.dtype == np.float32
    assert float(np.max(np.abs(wav))) > 0.1, "resampling must not silence the signal"


def test_load_audio_downmixes_stereo_to_mono(tmp_path):
    import soundfile as sf

    from bandpoc.audio import load_audio

    path = tmp_path / "stereo.wav"
    left = np.full(16000, 0.5, dtype=np.float32)
    right = np.full(16000, -0.1, dtype=np.float32)
    sf.write(str(path), np.stack([left, right], axis=1), 16000)

    wav, sr = load_audio(path)

    assert wav.ndim == 1
    assert sr == 16000
    assert float(np.mean(wav)) == pytest.approx(0.2, abs=1e-3)
