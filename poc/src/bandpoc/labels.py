"""Ground-truth label schema and its expansion onto the evaluation frame grid.

Two invariants carry the whole evaluation:

1. A Take is whatever the recipe *declares* via the ``take`` field, never
   something derived from the post-processing parameters under test.
2. Frames inside a take that are not ``music`` are don't-care: the product wants
   them kept inside the take, so scoring them as False Music would penalise a
   detector for behaving correctly.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

HOP = 0.1
"""Evaluation frame grid, in seconds. Every score curve is interpolated to this."""

LABELS: tuple[str, ...] = (
    "music",
    "speech",
    "silence",
    "tuning",
    "ambient",
    "speech_with_noodling",
)

MUSIC_LABEL = "music"
_LABEL_INDEX = {name: i for i, name in enumerate(LABELS)}


@dataclass(frozen=True)
class LabelBlock:
    start: float
    end: float
    label: str
    take: int | None = None


@dataclass(frozen=True)
class FrameMasks:
    label_idx: np.ndarray  # int8, index into LABELS
    is_music: np.ndarray  # bool
    is_dontcare: np.ndarray  # bool


@dataclass(frozen=True)
class SceneLabels:
    scene_id: str
    duration: float
    blocks: tuple[LabelBlock, ...]

    def n_frames(self, hop: float = HOP) -> int:
        return int(np.floor(round(self.duration / hop, 6)))

    def ground_truth_takes(self) -> list[tuple[float, float]]:
        """Span of each declared take group, in start order.

        A group's span covers any intervening block, which is how a mid-song
        pause stays a single Take.
        """
        spans: dict[int, tuple[float, float]] = {}
        for b in self.blocks:
            if b.take is None:
                continue
            lo, hi = spans.get(b.take, (b.start, b.end))
            spans[b.take] = (min(lo, b.start), max(hi, b.end))
        return sorted(spans.values())

    def frame_masks(self, hop: float = HOP) -> FrameMasks:
        n = self.n_frames(hop)
        centres = (np.arange(n) + 0.5) * hop
        label_idx = np.full(n, _LABEL_INDEX["silence"], dtype=np.int8)
        for b in self.blocks:
            sel = (centres >= b.start) & (centres < b.end)
            label_idx[sel] = _LABEL_INDEX[b.label]
        is_music = label_idx == _LABEL_INDEX[MUSIC_LABEL]
        in_take = np.zeros(n, dtype=bool)
        for start, end in self.ground_truth_takes():
            in_take |= (centres >= start) & (centres < end)
        return FrameMasks(
            label_idx=label_idx,
            is_music=is_music,
            is_dontcare=in_take & ~is_music,
        )

    def to_json(self, path: str | Path) -> None:
        payload = {
            "scene_id": self.scene_id,
            "duration": self.duration,
            "blocks": [
                {"start": b.start, "end": b.end, "label": b.label, "take": b.take}
                for b in self.blocks
            ],
        }
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    @classmethod
    def from_json(cls, path: str | Path) -> "SceneLabels":
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(
            scene_id=payload["scene_id"],
            duration=float(payload["duration"]),
            blocks=tuple(
                LabelBlock(
                    start=float(b["start"]),
                    end=float(b["end"]),
                    label=b["label"],
                    take=b["take"],
                )
                for b in payload["blocks"]
            ),
        )


def validate(scene: SceneLabels) -> None:
    """Raise ValueError on anything that would silently corrupt evaluation."""
    for b in scene.blocks:
        if b.label not in _LABEL_INDEX:
            raise ValueError(f"unknown label {b.label!r}; allowed: {LABELS}")
        if b.end <= b.start:
            raise ValueError(f"block {b} has non-positive duration")
        if b.label == MUSIC_LABEL and b.take is None:
            raise ValueError(
                f"music block {b.start}-{b.end} has no take id; every music block "
                "must declare which Take it belongs to"
            )
    ordered = sorted(scene.blocks, key=lambda b: b.start)
    for prev, cur in zip(ordered, ordered[1:]):
        if cur.start < prev.end - 1e-9:
            raise ValueError(f"blocks overlap: {prev} and {cur}")
    if ordered and ordered[-1].end > scene.duration + 1e-6:
        raise ValueError("last block extends past the declared scene duration")
