"""Silero VAD as an inverted axis (spec § 3.2).

This is a speech detector, not a music detector: the score is ``1 - speech``.
Silence and room noise will therefore read as music, so poor standalone numbers
are the expected result - the point is to see whether the speech axis adds
anything the music detectors miss.

Like inaSpeechSegmenter it produces hard labels, so its curve is binary and
threshold sweeping is degenerate.
"""

from __future__ import annotations

import numpy as np

from ..audio import resample
from .base import Detector

_SR = 16000
_HOP_S = 0.1


class SileroVad(Detector):
    name = "silero_vad"
    version = "1"
    requires = ("torch",)

    def __init__(self, device: str = "cpu") -> None:
        self._model = None
        self._get_speech_timestamps = None
        self._device = device

    def load(self) -> None:
        import torch

        model, utils = torch.hub.load(
            "snakers4/silero-vad", "silero_vad", trust_repo=True, onnx=False
        )
        self._model = model.to(self._device)
        self._get_speech_timestamps = utils[0]

    def music_score(self, wav: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
        import torch

        wav = resample(np.asarray(wav, dtype=np.float32), sr, _SR)
        n_frames = int(np.floor(wav.size / _SR / _HOP_S))
        speech = np.zeros(max(n_frames, 1), dtype=bool)
        # Timestamps rather than per-chunk probabilities: one call over the whole
        # signal is far faster than 100k Python-level forward passes, and Silero
        # only exposes a hard decision anyway.
        stamps = self._get_speech_timestamps(
            torch.from_numpy(wav).to(self._device), self._model, sampling_rate=_SR
        )
        for s in stamps:
            lo = int(s["start"] / _SR / _HOP_S)
            hi = min(len(speech), int(np.ceil(s["end"] / _SR / _HOP_S)))
            if hi > lo:
                speech[lo:hi] = True
        return (1.0 - speech.astype(np.float32)), _HOP_S
