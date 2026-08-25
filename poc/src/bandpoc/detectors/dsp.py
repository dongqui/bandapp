"""Classic-DSP baseline (spec § 3.2).

Deliberately dumb: an energy gate times a blend of tonality and low-band
weight. If a 100 MB neural network cannot beat this, it has no business in the
product.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import stft

from ..audio import resample
from .base import Detector

_SR = 16000
_HOP_S = 0.1
_WIN_S = 0.4


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


class DspBaseline(Detector):
    name = "dsp_baseline"
    version = "1"
    requires = ()

    def music_score(self, wav: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
        wav = resample(np.asarray(wav, dtype=np.float32), sr, _SR)
        nperseg = int(_WIN_S * _SR)
        noverlap = nperseg - int(_HOP_S * _SR)
        if wav.size < nperseg:
            wav = np.pad(wav, (0, nperseg - wav.size))
        _, _, Z = stft(wav, fs=_SR, nperseg=nperseg, noverlap=noverlap,
                       boundary=None, padded=False)
        power = (np.abs(Z) ** 2).astype(np.float64) + 1e-12
        freqs = np.linspace(0, _SR / 2, power.shape[0])

        rms_db = 10.0 * np.log10(power.sum(axis=0))
        flatness = np.exp(np.mean(np.log(power), axis=0)) / np.mean(power, axis=0)
        low_ratio = power[freqs < 250].sum(axis=0) / power.sum(axis=0)

        gate = _sigmoid((rms_db + 55.0) / 6.0)
        tonal = _sigmoid((0.35 - flatness) / 0.08)
        lowness = _sigmoid((low_ratio - 0.25) / 0.10)
        scores = gate * (0.6 * tonal + 0.4 * lowness)
        return np.clip(scores, 0.0, 1.0).astype(np.float32), _HOP_S
