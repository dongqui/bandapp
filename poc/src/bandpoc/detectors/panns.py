"""PANNs CNN14 AudioSet tagger (spec § 3.2).

CNN14 emits one clip-level vector per forward pass, so a time series comes from
sliding a window. 2 s windows at 1 s hop trade a little smoothing for a frame
rate fine enough to place Take boundaries within the ±5-10 s target.
"""

from __future__ import annotations

import shutil
import urllib.request
from pathlib import Path

import numpy as np

from ..audio import resample
from .audioset_classes import VARIANTS, indices_for, score_from_logits
from .base import Detector, chunked_scores

_SR = 32000
_WIN_S = 2.0
_HOP_S = 1.0
_CHUNK_S = 60.0

_DATA_DIR = Path.home() / "panns_data"
_LABELS_URL = (
    "http://storage.googleapis.com/us_audioset/youtube_corpus/v1/csv/class_labels_indices.csv"
)
_CKPT_URL = "https://zenodo.org/record/3987831/files/Cnn14_mAP%3D0.431.pth?download=1"
# panns_inference re-downloads any checkpoint smaller than this, so matching its
# threshold keeps a truncated download from being mistaken for a finished one.
_CKPT_MIN_BYTES = int(3e8)


def _download(url: str, dest: Path, min_bytes: int) -> Path:
    if dest.exists() and dest.stat().st_size >= min_bytes:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url) as response, part.open("wb") as out:
        shutil.copyfileobj(response, out)
    part.replace(dest)
    return dest


def _ensure_assets() -> Path:
    """Fetch what panns_inference cannot fetch for itself.

    The package shells out to ``wget`` for both its label CSV and its
    checkpoint, which is a silent no-op on Windows - the label download fails at
    *import* time, before any of our code runs. Downloading them here first
    makes the import safe and the checkpoint path explicit.
    """
    _download(_LABELS_URL, _DATA_DIR / "class_labels_indices.csv", min_bytes=1)
    return _download(_CKPT_URL, _DATA_DIR / "Cnn14_mAP=0.431.pth", _CKPT_MIN_BYTES)


class PannsCnn14(Detector):
    name = "panns_cnn14"
    version = "1"
    requires = ("torch", "panns_inference")

    def __init__(self, variant: str = "music_group", device: str = "cuda") -> None:
        self.variant = variant
        self._device = device
        self._model = None
        self._idx: list[int] = []

    def load(self) -> None:
        import torch

        checkpoint = _ensure_assets()
        from panns_inference import AudioTagging, labels

        device = self._device if torch.cuda.is_available() else "cpu"
        self._device = device
        self._model = AudioTagging(checkpoint_path=str(checkpoint), device=device)
        self._idx = indices_for(labels, VARIANTS[self.variant])

    def _score_chunk(self, chunk: np.ndarray) -> np.ndarray:
        win = int(_WIN_S * _SR)
        hop = int(_HOP_S * _SR)
        if chunk.size < win:
            chunk = np.pad(chunk, (0, win - chunk.size))
        starts = range(0, max(1, chunk.size - win + 1), hop)
        batch = np.stack([chunk[s : s + win] for s in starts]).astype(np.float32)
        clipwise, _ = self._model.inference(batch)
        return score_from_logits(np.asarray(clipwise), self._idx)

    def music_score(self, wav: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
        wav = resample(np.asarray(wav, dtype=np.float32), sr, _SR)
        scores = chunked_scores(
            wav, _SR, chunk_s=_CHUNK_S, overlap_s=_WIN_S, fn=self._score_chunk, hop_s=_HOP_S
        )
        return scores, _HOP_S
