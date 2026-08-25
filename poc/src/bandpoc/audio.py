"""Audio loading, resampling, loudness normalisation and chunking."""

from __future__ import annotations

from math import gcd
from pathlib import Path
from typing import Iterator

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

WORK_SR = 48000
"""Sample rate used for synthesised scenes. Detectors resample from here."""

_PEAK_CEILING = 0.99


def resample(wav: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    """Polyphase resample. Returns float32."""
    if sr_in == sr_out:
        return wav.astype(np.float32, copy=False)
    g = gcd(int(sr_in), int(sr_out))
    return resample_poly(wav, int(sr_out // g), int(sr_in // g)).astype(np.float32)


def load_audio(path: str | Path, target_sr: int | None = None) -> tuple[np.ndarray, int]:
    """Load any soundfile-readable file as mono float32."""
    wav, sr = sf.read(str(path), dtype="float32", always_2d=True)
    wav = wav.mean(axis=1)
    if target_sr is not None and sr != target_sr:
        wav = resample(wav, sr, target_sr)
        sr = target_sr
    return np.ascontiguousarray(wav, dtype=np.float32), int(sr)


def save_audio(path: str | Path, wav: np.ndarray, sr: int) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), wav.astype(np.float32), sr, subtype="PCM_16")


def normalize_loudness(wav: np.ndarray, sr: int, target_lufs: float = -23.0) -> np.ndarray:
    """EBU R128 integrated-loudness normalisation with a peak ceiling.

    Digital silence and clips too short to measure are returned unchanged.
    """
    import pyloudnorm as pyln

    if wav.size < int(0.5 * sr) or not np.any(wav):
        return wav
    meter = pyln.Meter(sr)
    loudness = meter.integrated_loudness(wav)
    if not np.isfinite(loudness):
        return wav
    out = pyln.normalize.loudness(wav, loudness, target_lufs).astype(np.float32)
    peak = float(np.max(np.abs(out)))
    if peak > _PEAK_CEILING:
        out = out * (_PEAK_CEILING / peak)
    return out.astype(np.float32)


def iter_chunks(
    wav: np.ndarray, sr: int, chunk_s: float, overlap_s: float
) -> Iterator[tuple[int, np.ndarray]]:
    """Yield ``(start_sample, chunk)`` pairs covering ``wav``.

    Keeps detector memory independent of audio length. The final chunk may be
    shorter than ``chunk_s``.
    """
    if overlap_s >= chunk_s:
        raise ValueError(f"overlap_s ({overlap_s}) must be smaller than chunk_s ({chunk_s})")
    size = int(round(chunk_s * sr))
    hop = int(round((chunk_s - overlap_s) * sr))
    if size <= 0 or hop <= 0:
        raise ValueError("chunk_s and the resulting hop must be positive")
    n = len(wav)
    if n == 0:
        return
    pos = 0
    while True:
        yield pos, wav[pos : pos + size]
        # Stop as soon as this chunk reaches the end. Because the previous
        # position satisfied pos + size < n, the final chunk is longer than
        # (size - hop) == overlap_s — i.e. always at least one full analysis
        # window, never a zero-padded stub.
        if pos + size >= n:
            return
        pos += hop
