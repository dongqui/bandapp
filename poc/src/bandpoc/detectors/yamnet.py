"""YAMNet AudioSet tagger (spec § 3.2).

Already frame-wise - 0.96 s windows at 0.48 s hop - so no sliding window is
needed, just chunking to keep memory flat. CPU-only TensorFlow is fine here;
the model is small and the RTF table will show exactly how fine.
"""

from __future__ import annotations

import csv

import numpy as np

from ..audio import resample
from .audioset_classes import VARIANTS, indices_for, score_from_logits
from .base import Detector, chunked_scores

_SR = 16000
_HOP_S = 0.48
_CHUNK_S = 120.0
_HANDLE = "https://tfhub.dev/google/yamnet/1"
_HANDLE_FALLBACK = "https://www.kaggle.com/models/google/yamnet/TensorFlow2/yamnet/1"


class Yamnet(Detector):
    name = "yamnet"
    version = "1"
    requires = ("tensorflow", "tensorflow_hub")

    def __init__(self, variant: str = "music_group") -> None:
        self.variant = variant
        self._model = None
        self._idx: list[int] = []

    def load(self) -> None:
        import tensorflow_hub as hub

        try:
            self._model = hub.load(_HANDLE)
        except Exception:
            # tfhub.dev redirects to Kaggle; older/newer clients disagree on which
            # handle resolves, so try both before giving up.
            self._model = hub.load(_HANDLE_FALLBACK)
        path = self._model.class_map_path().numpy().decode("utf-8")
        with open(path, newline="", encoding="utf-8") as fh:
            labels = [row["display_name"] for row in csv.DictReader(fh)]
        self._idx = indices_for(labels, VARIANTS[self.variant])

    def _score_chunk(self, chunk: np.ndarray) -> np.ndarray:
        scores, _, _ = self._model(chunk)
        return score_from_logits(np.asarray(scores), self._idx)

    def music_score(self, wav: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
        wav = resample(np.asarray(wav, dtype=np.float32), sr, _SR)
        scores = chunked_scores(
            wav, _SR, chunk_s=_CHUNK_S, overlap_s=0.96, fn=self._score_chunk, hop_s=_HOP_S
        )
        return scores, _HOP_S
