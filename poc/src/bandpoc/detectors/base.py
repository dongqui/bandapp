"""The one interface every model hides behind (spec § 3.1)."""

from __future__ import annotations

import importlib.util
from abc import ABC, abstractmethod
from typing import Callable

import numpy as np

from ..audio import iter_chunks


class Detector(ABC):
    name: str = "detector"
    version: str = "1"
    variant: str = "default"
    requires: tuple[str, ...] = ()

    @property
    def key(self) -> str:
        return f"{self.name}:{self.variant}"

    def is_available(self) -> tuple[bool, str]:
        """Check imports without importing, so one broken backend cannot take
        down the whole run."""
        for module in self.requires:
            if importlib.util.find_spec(module) is None:
                return False, f"missing package: {module}"
        return True, ""

    def load(self) -> None:
        """Load weights. Called once before the first ``music_score``."""

    @abstractmethod
    def music_score(self, wav: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
        """Return ``(per-frame music score in [0, 1], hop in seconds)``."""


def chunked_scores(
    wav: np.ndarray,
    sr: int,
    chunk_s: float,
    overlap_s: float,
    fn: Callable[[np.ndarray], np.ndarray],
    hop_s: float,
) -> np.ndarray:
    """Score a long signal chunk by chunk and stitch the pieces together.

    Overlap exists so a chunk boundary never lands inside a model's analysis
    window; the overlapping tail of each chunk is discarded rather than blended,
    which keeps the output frame grid uniform.
    """
    pieces: list[np.ndarray] = []
    keep = int(round((chunk_s - overlap_s) / hop_s))
    chunks = list(iter_chunks(wav, sr, chunk_s, overlap_s))
    for i, (_, chunk) in enumerate(chunks):
        scores = np.asarray(fn(chunk), dtype=np.float32).ravel()
        pieces.append(scores if i == len(chunks) - 1 else scores[:keep])
    if not pieces:
        return np.zeros(0, dtype=np.float32)
    return np.clip(np.concatenate(pieces), 0.0, 1.0).astype(np.float32)
