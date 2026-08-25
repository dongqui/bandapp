"""Audio Spectrogram Transformer, AudioSet-finetuned (spec § 3.2).

AST takes a fixed 10.24 s window, which is coarse next to the ±5-10 s boundary
target - hence a 2.5 s hop, accepting ~4x redundant compute to buy resolution.
Multi-label head, so logits go through a sigmoid, not a softmax.
"""

from __future__ import annotations

import numpy as np

from ..audio import resample
from .audioset_classes import VARIANTS, indices_for, score_from_logits
from .base import Detector, chunked_scores

_SR = 16000
_WIN_S = 10.24
_HOP_S = 2.5
_CHUNK_S = 120.0
_BATCH = 8
_MODEL_ID = "MIT/ast-finetuned-audioset-10-10-0.4593"


class AstAudioSet(Detector):
    name = "ast"
    version = "1"
    requires = ("torch", "transformers")

    def __init__(self, variant: str = "music_group", device: str = "cuda") -> None:
        self.variant = variant
        self._device = device
        self._model = None
        self._extractor = None
        self._idx: list[int] = []

    def load(self) -> None:
        import torch
        from transformers import ASTForAudioClassification, AutoFeatureExtractor

        self._device = self._device if torch.cuda.is_available() else "cpu"
        self._extractor = AutoFeatureExtractor.from_pretrained(_MODEL_ID)
        self._model = ASTForAudioClassification.from_pretrained(_MODEL_ID)
        self._model.to(self._device).eval()
        labels = [self._model.config.id2label[i] for i in range(self._model.config.num_labels)]
        self._idx = indices_for(labels, VARIANTS[self.variant])

    def _score_chunk(self, chunk: np.ndarray) -> np.ndarray:
        import torch

        win = int(_WIN_S * _SR)
        hop = int(_HOP_S * _SR)
        if chunk.size < win:
            chunk = np.pad(chunk, (0, win - chunk.size))
        windows = [chunk[s : s + win] for s in range(0, chunk.size - win + 1, hop)]
        out: list[np.ndarray] = []
        for i in range(0, len(windows), _BATCH):
            feats = self._extractor(
                windows[i : i + _BATCH], sampling_rate=_SR, return_tensors="pt"
            )
            feats = {k: v.to(self._device) for k, v in feats.items()}
            with torch.no_grad():
                logits = self._model(**feats).logits
            out.append(torch.sigmoid(logits).cpu().numpy())
        probs = np.concatenate(out) if out else np.zeros((0, self._model.config.num_labels))
        return score_from_logits(probs, self._idx)

    def music_score(self, wav: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
        wav = resample(np.asarray(wav, dtype=np.float32), sr, _SR)
        scores = chunked_scores(
            wav, _SR, chunk_s=_CHUNK_S, overlap_s=_WIN_S, fn=self._score_chunk, hop_s=_HOP_S
        )
        return scores, _HOP_S
