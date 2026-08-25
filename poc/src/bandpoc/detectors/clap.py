"""CLAP zero-shot music detection (spec § 3.2).

The only adapter whose notion of "music" can be aimed at this product's edge
cases directly, because it is written in the prompts rather than baked into a
label set. Note the negatives deliberately name tuning and idle noodling -
the two cases an AudioSet "Music" head is most likely to get wrong.

Uses transformers' ClapModel rather than the laion_clap package: same weights,
far tamer dependencies.
"""

from __future__ import annotations

import numpy as np

from ..audio import resample
from .base import Detector, chunked_scores

_SR = 48000
_WIN_S = 10.0
_HOP_S = 2.5
_CHUNK_S = 120.0
_MODEL_ID = "laion/clap-htsat-unfused"

POSITIVE_PROMPTS: tuple[str, ...] = (
    "a band playing music together in a rehearsal room",
    "people playing musical instruments together",
    "a rock band performing a song with drums and guitar",
    "a drummer playing a full drum beat",
)

NEGATIVE_PROMPTS: tuple[str, ...] = (
    "people talking to each other in a room",
    "a conversation between several people",
    "an empty quiet room with background noise",
    "someone tuning a guitar string by string",
    "someone idly plucking a guitar while people talk",
)


class ClapZeroShot(Detector):
    name = "clap_zeroshot"
    version = "1"
    requires = ("torch", "transformers")

    def __init__(self, device: str = "cuda") -> None:
        self._device = device
        self._model = None
        self._processor = None
        self._text_emb = None
        self._n_pos = len(POSITIVE_PROMPTS)

    def load(self) -> None:
        import torch
        from transformers import ClapModel, ClapProcessor

        self._device = self._device if torch.cuda.is_available() else "cpu"
        self._processor = ClapProcessor.from_pretrained(_MODEL_ID)
        self._model = ClapModel.from_pretrained(_MODEL_ID).to(self._device).eval()
        prompts = list(POSITIVE_PROMPTS) + list(NEGATIVE_PROMPTS)
        inputs = self._processor(text=prompts, return_tensors="pt", padding=True)
        inputs = {k: v.to(self._device) for k, v in inputs.items()}
        with torch.no_grad():
            out = self._model.get_text_features(**inputs)
        # transformers 5 returns an output object whose pooler_output is the
        # already-L2-normalised projection, not a bare tensor.
        self._text_emb = out.pooler_output

    def _score_chunk(self, chunk: np.ndarray) -> np.ndarray:
        import torch

        win = int(_WIN_S * _SR)
        hop = int(_HOP_S * _SR)
        if chunk.size < win:
            chunk = np.pad(chunk, (0, win - chunk.size))
        windows = [chunk[s : s + win] for s in range(0, chunk.size - win + 1, hop)]
        if not windows:
            return np.zeros(0, dtype=np.float32)
        inputs = self._processor(
            audio=windows, sampling_rate=_SR, return_tensors="pt", padding=True
        )
        inputs = {k: v.to(self._device) for k, v in inputs.items()}
        with torch.no_grad():
            audio_emb = self._model.get_audio_features(**inputs).pooler_output
            sims = audio_emb @ self._text_emb.T
            pos = sims[:, : self._n_pos].mean(dim=1)
            neg = sims[:, self._n_pos :].mean(dim=1)
            scale = self._model.logit_scale_a.exp()
            probs = torch.softmax(torch.stack([pos, neg], dim=1) * scale, dim=1)[:, 0]
        return probs.cpu().numpy().astype(np.float32)

    def music_score(self, wav: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
        wav = resample(np.asarray(wav, dtype=np.float32), sr, _SR)
        scores = chunked_scores(
            wav, _SR, chunk_s=_CHUNK_S, overlap_s=_WIN_S, fn=self._score_chunk, hop_s=_HOP_S
        )
        return scores, _HOP_S
