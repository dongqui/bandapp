"""inaSpeechSegmenter - the one model built for exactly this task (spec § 3.2).

Returns hard labels, not probabilities, so the curve is binary and threshold
sweeping is degenerate: only min_duration and merge_gap actually vary. The
report flags this so its sweep column is not read as a real optimum.

The library only accepts a file path, so each call round-trips through a temp
wav. That cost shows up honestly in the RTF column.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np

from ..audio import resample, save_audio
from .base import Detector

_SR = 16000
_HOP_S = 0.1


class InaSegmenter(Detector):
    name = "ina_segmenter"
    version = "1"
    requires = ("inaSpeechSegmenter",)

    def __init__(self) -> None:
        self._segmenter = None

    def load(self) -> None:
        from inaSpeechSegmenter import Segmenter

        self._segmenter = Segmenter(vad_engine="smn", detect_gender=False)

    def music_score(self, wav: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
        wav = resample(np.asarray(wav, dtype=np.float32), sr, _SR)
        n_frames = max(1, int(np.floor(wav.size / _SR / _HOP_S)))
        scores = np.zeros(n_frames, dtype=np.float32)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "chunk.wav"
            save_audio(path, wav, _SR)
            for label, start, end in self._segmenter(str(path)):
                if label != "music":
                    continue
                lo = max(0, int(start / _HOP_S))
                hi = min(n_frames, int(np.ceil(end / _HOP_S)))
                if hi > lo:
                    scores[lo:hi] = 1.0
        return scores, _HOP_S
