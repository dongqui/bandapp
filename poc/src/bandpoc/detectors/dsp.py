"""Classic-DSP baseline (spec § 3.2).

Deliberately dumb: an energy gate times a blend of tonality and low-band
weight. If a 100 MB neural network cannot beat this, it has no business in the
product.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import stft

from ..audio import resample
from .base import Detector, chunked_scores

_SR = 16000
_HOP_S = 0.1
_WIN_S = 0.4
_CHUNK_S = 60.0


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


class DspBaseline(Detector):
    name = "dsp_baseline"
    # v2: routed through chunked_scores so memory stays independent of audio
    # length (see fix report — v1 ran a single stft() over the whole signal,
    # which was ~2.7 GB peak on a 60-minute scene). Bumped because the cache
    # (Task 9) keys on version and scores now change shape at chunk seams.
    version = "2"
    requires = ()

    def _score_chunk(self, chunk: np.ndarray) -> np.ndarray:
        nperseg = int(_WIN_S * _SR)
        noverlap = nperseg - int(_HOP_S * _SR)
        if chunk.size < nperseg:
            chunk = np.pad(chunk, (0, nperseg - chunk.size))
        _, _, Z = stft(chunk, fs=_SR, nperseg=nperseg, noverlap=noverlap,
                       boundary=None, padded=False)
        power = (np.abs(Z) ** 2).astype(np.float64) + 1e-12
        freqs = np.linspace(0, _SR / 2, power.shape[0])

        rms_db = 10.0 * np.log10(power.sum(axis=0))
        flatness = np.exp(np.mean(np.log(power), axis=0)) / np.mean(power, axis=0)
        low_ratio = power[freqs < 250].sum(axis=0) / power.sum(axis=0)

        gate = _sigmoid((rms_db + 55.0) / 6.0)
        tonal = _sigmoid((0.35 - flatness) / 0.08)
        lowness = _sigmoid((low_ratio - 0.25) / 0.10)
        return (gate * (0.6 * tonal + 0.4 * lowness)).astype(np.float32)

    def music_score(self, wav: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
        wav = resample(np.asarray(wav, dtype=np.float32), sr, _SR)
        scores = chunked_scores(
            wav, _SR, chunk_s=_CHUNK_S, overlap_s=_WIN_S, fn=self._score_chunk,
            hop_s=_HOP_S,
        )
        return scores, _HOP_S
