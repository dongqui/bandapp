# 합주 연주 구간 검출 모델 비교 환경 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사전학습 오디오 분류 모델 7종을 동일 조건에서 비교해, 합주 녹음에서 연주 구간을 검출하는 최적 모델과 후처리 파라미터를 찾아내는 오프라인 실험 하네스를 만든다.

**Architecture:** 모델 추론(느림)과 후처리(빠름) 사이에 `.npz` 캐시 경계를 둔다. 추론은 씬당 1회만 하고, threshold/merge/min-duration 스윕은 캐시된 점수 곡선 위에서 수 초 만에 반복한다. 테스트 데이터는 태그된 유튜브 클립을 레시피대로 조립해 만들며, 정답은 조립 시점에 확정되므로 수동 라벨링이 없다. 모든 모델은 `Detector` ABC 하나 뒤에 들어가고, 임포트 실패 시 해당 모델만 건너뛴다.

**Tech Stack:** Python 3.11, numpy/scipy/soundfile/pyloudnorm, PyTorch (PANNs·AST·CLAP·Silero), TensorFlow-CPU (YAMNet·inaSpeechSegmenter), matplotlib, yt-dlp, pytest

**Spec:** `docs/superpowers/specs/2026-08-25-audio-segmentation-poc-design.md`

## Global Constraints

- Python 3.11. 모든 작업은 `poc/` 하위에서 이루어진다. 앱 코드와 격리한다.
- **`numpy<2` 고정.** TensorFlow는 CPU 전용(`tensorflow-cpu`)만 쓴다.
- **프레임 격자 hop은 0.1초로 고정** (`bandpoc.labels.HOP`). 모든 점수 곡선은 평가 전에 이 격자로 보간된다.
- **정답 라벨은 6종 고정:** `music`, `speech`, `silence`, `tuning`, `ambient`, `speech_with_noodling`. 이 중 `music`만 양성이다.
- **`speech_with_noodling`은 음악이 아니다.** 어떤 코드도 이걸 음악으로 취급하면 안 된다.
- **don't-care 프레임**(take 그룹 안에 있으나 `label != "music"`)은 Recall과 False Music 계산 양쪽의 분자·분모에서 제외한다.
- 후처리 비교 연산자는 스펙대로 `score >= threshold`, `gap <= merge_gap`, `duration >= min_duration` (전부 등호 포함).
- 모델 어댑터는 **긴 오디오를 청크 단위로 처리**해 메모리가 오디오 길이와 무관해야 한다.
- 다운로드 원본·클립·씬·캐시·리포트는 커밋하지 않는다.
- 커밋 메시지는 영어, Conventional Commits 형식.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `poc/pyproject.toml` | 패키지 정의, 의존성 extras, `bandpoc` 콘솔 스크립트 |
| `poc/sources.yaml` | 클립 풀별 유튜브 검색 쿼리 / URL |
| `poc/scenes.yaml` | 씬 6종 레시피 |
| `poc/src/bandpoc/audio.py` | 로드·리샘플·모노·라우드니스 정규화·청크 분할 |
| `poc/src/bandpoc/labels.py` | 라벨 스키마, 프레임 격자 전개, take 그룹, don't-care |
| `poc/src/bandpoc/postproc.py` | 점수 곡선 → 구간 (threshold/merge/min-duration) |
| `poc/src/bandpoc/metrics.py` | Recall, False Music, 라벨별 분해, Boundary Error, Take Count |
| `poc/src/bandpoc/sweep.py` | 파라미터 격자 탐색, 제약 하 최적점 선택 |
| `poc/src/bandpoc/fetch.py` | yt-dlp 다운로드 → 클립 추출 → 정규화 |
| `poc/src/bandpoc/synth.py` | 레시피 → 씬 wav + labels.json |
| `poc/src/bandpoc/detectors/base.py` | `Detector` ABC, 가용성 체크, 청크 헬퍼 |
| `poc/src/bandpoc/detectors/audioset_classes.py` | AudioSet 음악군 클래스 이름 집합 |
| `poc/src/bandpoc/detectors/{dsp,panns,silero,ast,clap,yamnet,ina}.py` | 어댑터 7종 |
| `poc/src/bandpoc/registry.py` | 어댑터 지연 등록/조회 |
| `poc/src/bandpoc/cache.py` | `(scene, detector)` → `.npz` |
| `poc/src/bandpoc/report.py` | matplotlib 그림 + 자기완결형 HTML |
| `poc/src/bandpoc/cli.py` | `fetch` / `build-scenes` / `run` / `report` |

---

### Task 1: 프로젝트 스캐폴드 + 오디오 프리미티브

**Files:**
- Create: `poc/pyproject.toml`, `poc/.gitignore`, `poc/README.md`
- Create: `poc/src/bandpoc/__init__.py`, `poc/src/bandpoc/audio.py`
- Test: `poc/tests/test_audio.py`

**Interfaces:**
- Consumes: 없음 (첫 작업)
- Produces:
  - `bandpoc.audio.resample(wav: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray`
  - `bandpoc.audio.load_audio(path, target_sr: int | None = None) -> tuple[np.ndarray, int]` — 항상 모노 float32
  - `bandpoc.audio.normalize_loudness(wav, sr, target_lufs: float = -23.0) -> np.ndarray`
  - `bandpoc.audio.iter_chunks(wav, sr, chunk_s: float, overlap_s: float) -> Iterator[tuple[int, np.ndarray]]` — `(시작 샘플 인덱스, 청크)`
  - `bandpoc.audio.WORK_SR: int = 48000`

- [ ] **Step 1: 프로젝트 뼈대 만들기**

`poc/pyproject.toml`:

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "bandpoc"
version = "0.1.0"
description = "Model comparison harness for band-rehearsal music segment detection"
requires-python = ">=3.11,<3.12"
dependencies = [
    "numpy>=1.24,<2",
    "scipy>=1.11",
    "soundfile>=0.12",
    "pyloudnorm>=0.1.1",
    "PyYAML>=6.0",
    "matplotlib>=3.8",
    "yt-dlp>=2024.1.1",
    "tqdm>=4.66",
]

[project.optional-dependencies]
dev = ["pytest>=8.0"]
torch = ["torch>=2.1", "panns-inference>=0.1.1"]
hf = ["torch>=2.1", "transformers>=4.40"]
tf = ["tensorflow-cpu>=2.13,<2.17", "tensorflow-hub>=0.15", "inaSpeechSegmenter>=0.7.7"]

[project.scripts]
bandpoc = "bandpoc.cli:main"

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

`poc/.gitignore`:

```
data/
reports/
.venv/
__pycache__/
*.egg-info/
.pytest_cache/
```

`poc/README.md`:

```markdown
# bandpoc — 합주 연주 구간 검출 모델 비교 하네스

설계 문서: `../docs/superpowers/specs/2026-08-25-audio-segmentation-poc-design.md`

## 설치

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install --upgrade pip
.venv/Scripts/python.exe -m pip install -e ".[dev]"
```

모델 백엔드는 필요한 것만 추가로 설치한다:

```bash
.venv/Scripts/python.exe -m pip install -e ".[torch]"   # PANNs, Silero
.venv/Scripts/python.exe -m pip install -e ".[hf]"      # AST, CLAP
.venv/Scripts/python.exe -m pip install -e ".[tf]"      # YAMNet, inaSpeechSegmenter
```

설치하지 않은 백엔드의 어댑터는 리포트에 `unavailable`로 표시되고 나머지는 정상 동작한다.

`ffmpeg`이 PATH에 있어야 한다. 없으면: `winget install Gyan.FFmpeg`

## 사용

```bash
bandpoc fetch          # 유튜브 → data/clips/
bandpoc build-scenes   # data/clips/ → data/scenes/
bandpoc run            # 추론 → data/cache/
bandpoc report         # 스윕 + 메트릭 → reports/<timestamp>/index.html
```
```

`poc/src/bandpoc/__init__.py`:

```python
"""Offline harness for comparing music-segment detectors on band rehearsal audio."""

__version__ = "0.1.0"
```

- [ ] **Step 2: 실패하는 테스트 작성**

`poc/tests/test_audio.py`:

```python
import numpy as np
import pytest

from bandpoc.audio import iter_chunks, normalize_loudness, resample


def test_resample_changes_length_proportionally():
    wav = np.sin(2 * np.pi * 440 * np.arange(16000) / 16000).astype(np.float32)
    out = resample(wav, 16000, 8000)
    assert abs(len(out) - 8000) <= 1
    assert out.dtype == np.float32


def test_resample_is_identity_when_rates_match():
    wav = np.random.RandomState(0).randn(1000).astype(np.float32)
    out = resample(wav, 16000, 16000)
    np.testing.assert_array_equal(out, wav)


def test_iter_chunks_covers_whole_signal_with_overlap():
    wav = np.arange(10 * 100, dtype=np.float32)  # 10 s at sr=100
    chunks = list(iter_chunks(wav, sr=100, chunk_s=4.0, overlap_s=1.0))
    # hop = 3 s = 300 samples
    assert [start for start, _ in chunks] == [0, 300, 600, 900]
    assert len(chunks[0][1]) == 400
    # last chunk is short and reaches the end
    assert chunks[-1][0] + len(chunks[-1][1]) == len(wav)


def test_iter_chunks_single_chunk_when_signal_shorter_than_chunk():
    wav = np.zeros(50, dtype=np.float32)
    chunks = list(iter_chunks(wav, sr=100, chunk_s=4.0, overlap_s=1.0))
    assert len(chunks) == 1
    assert chunks[0] [0] == 0
    assert len(chunks[0][1]) == 50


def test_iter_chunks_rejects_overlap_not_smaller_than_chunk():
    wav = np.zeros(100, dtype=np.float32)
    with pytest.raises(ValueError):
        list(iter_chunks(wav, sr=100, chunk_s=1.0, overlap_s=1.0))


def test_normalize_loudness_scales_quiet_signal_up():
    rs = np.random.RandomState(1)
    wav = (rs.randn(48000 * 3) * 0.001).astype(np.float32)
    out = normalize_loudness(wav, 48000, target_lufs=-23.0)
    assert np.max(np.abs(out)) > np.max(np.abs(wav))
    assert np.max(np.abs(out)) <= 0.99 + 1e-6


def test_normalize_loudness_leaves_silence_untouched():
    wav = np.zeros(48000 * 2, dtype=np.float32)
    out = normalize_loudness(wav, 48000)
    np.testing.assert_array_equal(out, wav)
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_audio.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'bandpoc.audio'`

- [ ] **Step 4: `audio.py` 구현**

`poc/src/bandpoc/audio.py`:

```python
"""Audio loading, resampling, loudness normalisation and chunking."""

from __future__ import annotations

from math import gcd
from pathlib import Path
from typing import Iterator

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

WORK_SR = 48000
"""Sample rate used for synthesised scenes. Detectors resample from here."""

_PEAK_CEILING = 0.99


def resample(wav: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    """Polyphase resample. Returns float32."""
    if sr_in == sr_out:
        return wav.astype(np.float32, copy=False)
    g = gcd(int(sr_in), int(sr_out))
    return resample_poly(wav, int(sr_out // g), int(sr_in // g)).astype(np.float32)


def load_audio(path: str | Path, target_sr: int | None = None) -> tuple[np.ndarray, int]:
    """Load any soundfile-readable file as mono float32."""
    wav, sr = sf.read(str(path), dtype="float32", always_2d=True)
    wav = wav.mean(axis=1)
    if target_sr is not None and sr != target_sr:
        wav = resample(wav, sr, target_sr)
        sr = target_sr
    return np.ascontiguousarray(wav, dtype=np.float32), int(sr)


def save_audio(path: str | Path, wav: np.ndarray, sr: int) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), wav.astype(np.float32), sr, subtype="PCM_16")


def normalize_loudness(wav: np.ndarray, sr: int, target_lufs: float = -23.0) -> np.ndarray:
    """EBU R128 integrated-loudness normalisation with a peak ceiling.

    Digital silence and clips too short to measure are returned unchanged.
    """
    import pyloudnorm as pyln

    if wav.size < int(0.5 * sr) or not np.any(wav):
        return wav
    meter = pyln.Meter(sr)
    loudness = meter.integrated_loudness(wav)
    if not np.isfinite(loudness):
        return wav
    out = pyln.normalize.loudness(wav, loudness, target_lufs).astype(np.float32)
    peak = float(np.max(np.abs(out)))
    if peak > _PEAK_CEILING:
        out = out * (_PEAK_CEILING / peak)
    return out.astype(np.float32)


def iter_chunks(
    wav: np.ndarray, sr: int, chunk_s: float, overlap_s: float
) -> Iterator[tuple[int, np.ndarray]]:
    """Yield ``(start_sample, chunk)`` pairs covering ``wav``.

    Keeps detector memory independent of audio length. The final chunk may be
    shorter than ``chunk_s``.
    """
    if overlap_s >= chunk_s:
        raise ValueError(f"overlap_s ({overlap_s}) must be smaller than chunk_s ({chunk_s})")
    size = int(round(chunk_s * sr))
    hop = int(round((chunk_s - overlap_s) * sr))
    if size <= 0 or hop <= 0:
        raise ValueError("chunk_s and the resulting hop must be positive")
    n = len(wav)
    if n == 0:
        return
    pos = 0
    while True:
        yield pos, wav[pos : pos + size]
        if pos + size >= n:
            return
        pos += hop
```

- [ ] **Step 5: 테스트 통과 확인 후 커밋**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_audio.py -v
```

Expected: 7 passed

```bash
git add poc/
git commit -m "feat(poc): scaffold bandpoc package with audio primitives"
```

---

### Task 2: 라벨 모델과 프레임 격자

**Files:**
- Create: `poc/src/bandpoc/labels.py`
- Test: `poc/tests/test_labels.py`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `bandpoc.labels.HOP: float = 0.1`
  - `bandpoc.labels.LABELS: tuple[str, ...]` — 6종, 순서 고정
  - `bandpoc.labels.LabelBlock(start: float, end: float, label: str, take: int | None)` — frozen dataclass
  - `bandpoc.labels.SceneLabels(scene_id: str, duration: float, blocks: tuple[LabelBlock, ...])`
    - `.to_json(path)` / `SceneLabels.from_json(path)` (classmethod)
    - `.n_frames(hop: float = HOP) -> int`
    - `.ground_truth_takes() -> list[tuple[float, float]]`
    - `.frame_masks(hop: float = HOP) -> FrameMasks`
  - `bandpoc.labels.FrameMasks(label_idx: np.ndarray, is_music: np.ndarray, is_dontcare: np.ndarray)`
  - `bandpoc.labels.validate(scene: SceneLabels) -> None` — 위반 시 `ValueError`

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_labels.py`:

```python
import numpy as np
import pytest

from bandpoc.labels import HOP, LabelBlock, SceneLabels, validate


def build(blocks):
    """Lay blocks end to end and wrap them in a SceneLabels."""
    out, t = [], 0.0
    for label, dur, take in blocks:
        out.append(LabelBlock(start=t, end=t + dur, label=label, take=take))
        t += dur
    return SceneLabels(scene_id="t", duration=t, blocks=tuple(out))


def test_ground_truth_take_spans_an_intervening_non_music_block():
    scene = build([
        ("music", 40.0, 3),
        ("speech", 8.0, 3),     # "야 다시 가자"
        ("music", 60.0, 3),
        ("speech", 30.0, None),
        ("music", 50.0, 4),
    ])
    assert scene.ground_truth_takes() == [(0.0, 108.0), (138.0, 188.0)]


def test_frames_inside_a_take_but_not_music_are_dontcare():
    scene = build([("music", 10.0, 1), ("speech", 5.0, 1), ("music", 10.0, 1)])
    m = scene.frame_masks()
    assert m.is_music[:100].all()
    assert not m.is_music[100:150].any()
    assert not m.is_dontcare[:100].any()
    assert m.is_dontcare[100:150].all()
    assert not m.is_dontcare[150:].any()


def test_speech_outside_a_take_is_not_dontcare():
    scene = build([("music", 10.0, 1), ("speech", 10.0, None)])
    m = scene.frame_masks()
    assert not m.is_dontcare.any()


def test_noodling_is_never_music():
    scene = build([("speech_with_noodling", 10.0, None)])
    m = scene.frame_masks()
    assert not m.is_music.any()
    assert not m.is_dontcare.any()


def test_frame_count_matches_duration():
    scene = build([("music", 12.3, 1)])
    m = scene.frame_masks()
    assert scene.n_frames() == 123
    assert len(m.is_music) == 123
    assert len(m.label_idx) == 123


def test_json_roundtrip(tmp_path):
    scene = build([("music", 10.0, 1), ("speech", 5.0, 1), ("tuning", 7.0, None)])
    path = tmp_path / "s.labels.json"
    scene.to_json(path)
    assert SceneLabels.from_json(path) == scene


def test_validate_rejects_music_block_without_take():
    scene = build([("music", 10.0, None)])
    with pytest.raises(ValueError, match="take"):
        validate(scene)


def test_validate_rejects_unknown_label():
    scene = build([("chatter", 10.0, None)])
    with pytest.raises(ValueError, match="chatter"):
        validate(scene)


def test_validate_rejects_overlapping_blocks():
    scene = SceneLabels(
        scene_id="t",
        duration=20.0,
        blocks=(
            LabelBlock(0.0, 12.0, "music", 1),
            LabelBlock(10.0, 20.0, "speech", None),
        ),
    )
    with pytest.raises(ValueError, match="overlap"):
        validate(scene)
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_labels.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'bandpoc.labels'`

- [ ] **Step 3: `labels.py` 구현**

`poc/src/bandpoc/labels.py`:

```python
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
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_labels.py -v
```

Expected: 9 passed

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/labels.py poc/tests/test_labels.py
git commit -m "feat(poc): add label schema with take groups and dont-care frames"
```

---

### Task 3: 후처리 — 점수 곡선에서 구간 만들기

**Files:**
- Create: `poc/src/bandpoc/postproc.py`
- Test: `poc/tests/test_postproc.py`

**Interfaces:**
- Consumes: `bandpoc.labels.HOP`
- Produces:
  - `bandpoc.postproc.Segment(start: float, end: float)` — frozen dataclass, `.duration` property
  - `bandpoc.postproc.PostParams(threshold: float, min_duration: float, merge_gap: float)` — frozen dataclass
  - `bandpoc.postproc.scores_to_segments(scores: np.ndarray, hop: float, params: PostParams) -> list[Segment]`
  - `bandpoc.postproc.segments_to_mask(segments, n_frames: int, hop: float) -> np.ndarray` (bool)
  - `bandpoc.postproc.resample_scores(scores: np.ndarray, src_hop: float, n_frames: int, dst_hop: float) -> np.ndarray`

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_postproc.py`:

```python
import numpy as np
import pytest

from bandpoc.postproc import (
    PostParams,
    Segment,
    resample_scores,
    scores_to_segments,
    segments_to_mask,
)

HOP = 0.1


def curve(spec):
    """Build a score curve from (value, seconds) pairs at hop=0.1."""
    parts = [np.full(int(round(sec / HOP)), val, dtype=np.float32) for val, sec in spec]
    return np.concatenate(parts)


def test_threshold_is_inclusive():
    scores = curve([(0.7, 30.0)])
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=10.0)
    assert scores_to_segments(scores, HOP, params) == [Segment(0.0, 30.0)]


def test_score_just_below_threshold_is_excluded():
    scores = curve([(0.69, 30.0)])
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=10.0)
    assert scores_to_segments(scores, HOP, params) == []


def test_gap_exactly_equal_to_merge_gap_is_merged():
    scores = curve([(0.9, 30.0), (0.1, 10.0), (0.9, 30.0)])
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=10.0)
    assert scores_to_segments(scores, HOP, params) == [Segment(0.0, 70.0)]


def test_gap_just_over_merge_gap_is_not_merged():
    scores = curve([(0.9, 30.0), (0.1, 10.1), (0.9, 30.0)])
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=10.0)
    assert scores_to_segments(scores, HOP, params) == [
        Segment(0.0, 30.0),
        Segment(40.1, 70.1),
    ]


def test_duration_exactly_equal_to_min_duration_is_kept():
    scores = curve([(0.1, 5.0), (0.9, 20.0), (0.1, 5.0)])
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=5.0)
    assert scores_to_segments(scores, HOP, params) == [Segment(5.0, 25.0)]


def test_duration_just_under_min_duration_is_dropped():
    scores = curve([(0.1, 5.0), (0.9, 19.9), (0.1, 5.0)])
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=5.0)
    assert scores_to_segments(scores, HOP, params) == []


def test_merge_happens_before_min_duration_filter():
    # Two 12 s runs, 4 s apart: neither survives alone, together they do.
    scores = curve([(0.9, 12.0), (0.1, 4.0), (0.9, 12.0)])
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=5.0)
    assert scores_to_segments(scores, HOP, params) == [Segment(0.0, 28.0)]


def test_segment_reaching_end_of_curve_is_closed():
    scores = curve([(0.1, 5.0), (0.9, 25.0)])
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=5.0)
    assert scores_to_segments(scores, HOP, params) == [Segment(5.0, 30.0)]


def test_empty_curve_yields_no_segments():
    params = PostParams(threshold=0.7, min_duration=20.0, merge_gap=5.0)
    assert scores_to_segments(np.array([], dtype=np.float32), HOP, params) == []


def test_segments_to_mask_marks_exactly_the_covered_frames():
    mask = segments_to_mask([Segment(1.0, 2.0)], n_frames=30, hop=HOP)
    assert mask[:10].sum() == 0
    assert mask[10:20].all()
    assert mask[20:].sum() == 0


def test_resample_scores_stretches_a_coarse_curve_onto_the_fine_grid():
    coarse = np.array([0.0, 1.0], dtype=np.float32)  # hop 1.0 s
    fine = resample_scores(coarse, src_hop=1.0, n_frames=20, dst_hop=HOP)
    assert len(fine) == 20
    assert fine[0] == pytest.approx(0.0, abs=0.06)
    assert fine[-1] == pytest.approx(1.0, abs=0.06)
    assert np.all(np.diff(fine) >= -1e-6)


def test_resample_scores_pads_when_curve_is_shorter_than_the_grid():
    coarse = np.array([0.4, 0.4], dtype=np.float32)
    fine = resample_scores(coarse, src_hop=1.0, n_frames=100, dst_hop=HOP)
    assert len(fine) == 100
    assert fine[-1] == pytest.approx(0.4, abs=1e-6)


def test_resample_scores_handles_single_point_curve():
    fine = resample_scores(np.array([0.8], dtype=np.float32), 1.0, 10, HOP)
    assert len(fine) == 10
    assert np.allclose(fine, 0.8)
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_postproc.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'bandpoc.postproc'`

- [ ] **Step 3: `postproc.py` 구현**

`poc/src/bandpoc/postproc.py`:

```python
"""Turn a per-frame music-score curve into Take segments.

This is the tunable half of the pipeline (spec § 5). It never touches a model,
so a full parameter sweep runs on cached curves in seconds.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Segment:
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass(frozen=True)
class PostParams:
    threshold: float
    min_duration: float
    merge_gap: float


def scores_to_segments(scores: np.ndarray, hop: float, params: PostParams) -> list[Segment]:
    """Binarise, merge short gaps, then drop short segments — in that order.

    Merging must precede the duration filter: two 12 s runs 4 s apart are one
    28 s Take, but filtering first would delete both.
    """
    segments = _runs_to_segments(np.asarray(scores) >= params.threshold, hop)
    segments = _merge_gaps(segments, params.merge_gap)
    return [s for s in segments if s.duration >= params.min_duration - 1e-9]


def _runs_to_segments(mask: np.ndarray, hop: float) -> list[Segment]:
    if mask.size == 0:
        return []
    padded = np.concatenate(([False], mask.astype(bool), [False]))
    edges = np.diff(padded.astype(np.int8))
    starts = np.flatnonzero(edges == 1)
    ends = np.flatnonzero(edges == -1)
    return [Segment(float(s) * hop, float(e) * hop) for s, e in zip(starts, ends)]


def _merge_gaps(segments: list[Segment], merge_gap: float) -> list[Segment]:
    if not segments:
        return []
    merged = [segments[0]]
    for seg in segments[1:]:
        if seg.start - merged[-1].end <= merge_gap + 1e-9:
            merged[-1] = Segment(merged[-1].start, seg.end)
        else:
            merged.append(seg)
    return merged


def segments_to_mask(segments, n_frames: int, hop: float) -> np.ndarray:
    """Frame mask of the union of ``segments``, on the evaluation grid."""
    mask = np.zeros(n_frames, dtype=bool)
    for seg in segments:
        lo = max(0, int(round(seg.start / hop)))
        hi = min(n_frames, int(round(seg.end / hop)))
        if hi > lo:
            mask[lo:hi] = True
    return mask


def resample_scores(
    scores: np.ndarray, src_hop: float, n_frames: int, dst_hop: float
) -> np.ndarray:
    """Interpolate a detector's native-rate curve onto the evaluation grid.

    Edges are held flat rather than extrapolated, so a coarse detector never
    invents values beyond what it actually reported.
    """
    scores = np.asarray(scores, dtype=np.float32)
    if n_frames <= 0:
        return np.zeros(0, dtype=np.float32)
    if scores.size == 0:
        return np.zeros(n_frames, dtype=np.float32)
    if scores.size == 1:
        return np.full(n_frames, float(scores[0]), dtype=np.float32)
    src_t = np.arange(scores.size) * src_hop
    dst_t = np.arange(n_frames) * dst_hop
    return np.interp(dst_t, src_t, scores, left=scores[0], right=scores[-1]).astype(
        np.float32
    )
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_postproc.py -v
```

Expected: 13 passed

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/postproc.py poc/tests/test_postproc.py
git commit -m "feat(poc): add score-curve post-processing with inclusive boundaries"
```

---

### Task 4: 평가 지표

**Files:**
- Create: `poc/src/bandpoc/metrics.py`
- Test: `poc/tests/test_metrics.py`

**Interfaces:**
- Consumes: `bandpoc.labels.{LABELS, FrameMasks, SceneLabels, HOP}`, `bandpoc.postproc.{Segment, segments_to_mask}`
- Produces:
  - `bandpoc.metrics.FrameCounts(music_hit: int, music_total: int, false_hit: int, false_total: int, per_label_hit: dict[str,int], per_label_total: dict[str,int])`
    - `.__add__` — 씬 간 합산(마이크로 평균)용
    - `.music_recall -> float`, `.false_music_seconds(hop) -> float`, `.false_music_ratio -> float`, `.per_label_false_rate -> dict[str,float]`
  - `bandpoc.metrics.frame_counts(detected_mask, masks: FrameMasks) -> FrameCounts`
  - `bandpoc.metrics.match_takes(truth, detected, iou_threshold=0.5) -> list[tuple[int,int,float]]`
  - `bandpoc.metrics.BoundaryStats(start_p50, start_p90, end_p50, end_p90, matched, truth_count, detected_count)`
  - `bandpoc.metrics.boundary_stats(truth, detected, iou_threshold=0.5) -> BoundaryStats`

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_metrics.py`:

```python
import numpy as np
import pytest

from bandpoc.labels import FrameMasks, LABELS
from bandpoc.metrics import BoundaryStats, boundary_stats, frame_counts, match_takes
from bandpoc.postproc import Segment

IDX = {name: i for i, name in enumerate(LABELS)}


def masks_from(labels, dontcare=()):
    """Build FrameMasks from a list of label names, one entry per frame."""
    label_idx = np.array([IDX[name] for name in labels], dtype=np.int8)
    is_music = label_idx == IDX["music"]
    is_dontcare = np.zeros(len(labels), dtype=bool)
    for i in dontcare:
        is_dontcare[i] = True
    return FrameMasks(label_idx=label_idx, is_music=is_music, is_dontcare=is_dontcare)


def test_perfect_detection_scores_full_recall_and_no_false_music():
    m = masks_from(["music"] * 10 + ["speech"] * 10)
    detected = np.array([True] * 10 + [False] * 10)
    c = frame_counts(detected, m)
    assert c.music_recall == 1.0
    assert c.false_music_ratio == 0.0
    assert c.false_music_seconds(0.1) == 0.0


def test_half_the_music_missed_gives_half_recall():
    m = masks_from(["music"] * 10 + ["speech"] * 10)
    detected = np.array([True] * 5 + [False] * 15)
    c = frame_counts(detected, m)
    assert c.music_recall == pytest.approx(0.5)


def test_speech_flagged_as_music_counts_as_false_music():
    m = masks_from(["music"] * 10 + ["speech"] * 10)
    detected = np.ones(20, dtype=bool)
    c = frame_counts(detected, m)
    assert c.false_music_ratio == pytest.approx(1.0)
    assert c.false_music_seconds(0.1) == pytest.approx(1.0)


def test_dontcare_frames_are_excluded_from_false_music():
    # 10 music, 5 speech inside the take (don't-care), 10 speech outside.
    m = masks_from(["music"] * 10 + ["speech"] * 5 + ["speech"] * 10,
                   dontcare=range(10, 15))
    detected = np.array([True] * 15 + [False] * 10)
    c = frame_counts(detected, m)
    assert c.music_recall == 1.0
    assert c.false_music_ratio == 0.0, "bridging a mid-take pause must not be penalised"
    assert c.false_total == 10


def test_dontcare_frames_are_excluded_from_recall_denominator():
    m = masks_from(["music"] * 10 + ["speech"] * 5, dontcare=range(10, 15))
    detected = np.array([True] * 10 + [False] * 5)
    c = frame_counts(detected, m)
    assert c.music_total == 10


def test_per_label_false_rate_isolates_the_hard_cases():
    m = masks_from(["speech_with_noodling"] * 10 + ["tuning"] * 10)
    detected = np.array([True] * 10 + [False] * 10)
    c = frame_counts(detected, m)
    assert c.per_label_false_rate["speech_with_noodling"] == pytest.approx(1.0)
    assert c.per_label_false_rate["tuning"] == pytest.approx(0.0)


def test_counts_add_across_scenes():
    m1 = masks_from(["music"] * 10)
    m2 = masks_from(["music"] * 10)
    total = frame_counts(np.ones(10, dtype=bool), m1) + frame_counts(
        np.zeros(10, dtype=bool), m2
    )
    assert total.music_total == 20
    assert total.music_recall == pytest.approx(0.5)


def test_recall_of_a_scene_with_no_music_is_nan():
    m = masks_from(["speech"] * 10)
    c = frame_counts(np.zeros(10, dtype=bool), m)
    assert np.isnan(c.music_recall)


def test_match_takes_pairs_overlapping_segments_by_best_iou():
    truth = [Segment(0.0, 100.0), Segment(200.0, 300.0)]
    detected = [Segment(5.0, 95.0), Segment(190.0, 310.0)]
    pairs = match_takes(truth, detected)
    assert [(t, d) for t, d, _ in pairs] == [(0, 0), (1, 1)]


def test_match_takes_ignores_pairs_below_the_iou_threshold():
    truth = [Segment(0.0, 100.0)]
    detected = [Segment(90.0, 400.0)]  # IoU ≈ 0.025
    assert match_takes(truth, detected) == []


def test_match_takes_is_one_to_one():
    truth = [Segment(0.0, 100.0)]
    detected = [Segment(0.0, 100.0), Segment(1.0, 99.0)]
    assert len(match_takes(truth, detected)) == 1


def test_boundary_stats_reports_absolute_edge_errors():
    truth = [Segment(0.0, 100.0), Segment(200.0, 300.0)]
    detected = [Segment(2.0, 106.0), Segment(196.0, 302.0)]
    s = boundary_stats(truth, detected)
    assert s.matched == 2
    assert s.start_p50 == pytest.approx(3.0)   # median of |2|, |4|
    assert s.end_p50 == pytest.approx(4.0)     # median of |6|, |2|
    assert s.truth_count == 2
    assert s.detected_count == 2


def test_boundary_stats_with_no_matches_reports_nan_but_keeps_counts():
    s = boundary_stats([Segment(0.0, 10.0)], [])
    assert s.matched == 0
    assert np.isnan(s.start_p50)
    assert s.truth_count == 1
    assert s.detected_count == 0
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_metrics.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'bandpoc.metrics'`

- [ ] **Step 3: `metrics.py` 구현**

`poc/src/bandpoc/metrics.py`:

```python
"""Evaluation metrics (spec § 6).

Everything is counted, not averaged, so scenes combine by micro-average:
``frame_counts(a) + frame_counts(b)`` is the same as evaluating the two scenes
concatenated. Averaging per-scene rates would over-weight short scenes.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .labels import LABELS, MUSIC_LABEL, FrameMasks
from .postproc import Segment

_LABEL_INDEX = {name: i for i, name in enumerate(LABELS)}
_NON_MUSIC_LABELS = tuple(name for name in LABELS if name != MUSIC_LABEL)


@dataclass(frozen=True)
class FrameCounts:
    music_hit: int
    music_total: int
    false_hit: int
    false_total: int
    per_label_hit: dict[str, int] = field(default_factory=dict)
    per_label_total: dict[str, int] = field(default_factory=dict)

    def __add__(self, other: "FrameCounts") -> "FrameCounts":
        return FrameCounts(
            music_hit=self.music_hit + other.music_hit,
            music_total=self.music_total + other.music_total,
            false_hit=self.false_hit + other.false_hit,
            false_total=self.false_total + other.false_total,
            per_label_hit={
                k: self.per_label_hit.get(k, 0) + other.per_label_hit.get(k, 0)
                for k in _NON_MUSIC_LABELS
            },
            per_label_total={
                k: self.per_label_total.get(k, 0) + other.per_label_total.get(k, 0)
                for k in _NON_MUSIC_LABELS
            },
        )

    @property
    def music_recall(self) -> float:
        if self.music_total == 0:
            return float("nan")
        return self.music_hit / self.music_total

    @property
    def false_music_ratio(self) -> float:
        if self.false_total == 0:
            return float("nan")
        return self.false_hit / self.false_total

    def false_music_seconds(self, hop: float) -> float:
        return self.false_hit * hop

    @property
    def per_label_false_rate(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for name in _NON_MUSIC_LABELS:
            total = self.per_label_total.get(name, 0)
            out[name] = float("nan") if total == 0 else self.per_label_hit.get(name, 0) / total
        return out


def frame_counts(detected_mask: np.ndarray, masks: FrameMasks) -> FrameCounts:
    """Count hits against the ground-truth frame masks.

    Don't-care frames are removed from every numerator and denominator here —
    this is the single place that rule is enforced, so a bug in it is invisible
    in the report. See the dedicated tests.
    """
    detected = np.asarray(detected_mask, dtype=bool)
    keep = ~masks.is_dontcare
    music = masks.is_music & keep
    eligible = ~masks.is_music & keep

    per_hit: dict[str, int] = {}
    per_total: dict[str, int] = {}
    for name in _NON_MUSIC_LABELS:
        sel = (masks.label_idx == _LABEL_INDEX[name]) & keep
        per_total[name] = int(sel.sum())
        per_hit[name] = int((detected & sel).sum())

    return FrameCounts(
        music_hit=int((detected & music).sum()),
        music_total=int(music.sum()),
        false_hit=int((detected & eligible).sum()),
        false_total=int(eligible.sum()),
        per_label_hit=per_hit,
        per_label_total=per_total,
    )


def _iou(a: Segment, b: Segment) -> float:
    inter = max(0.0, min(a.end, b.end) - max(a.start, b.start))
    union = (a.end - a.start) + (b.end - b.start) - inter
    return 0.0 if union <= 0 else inter / union


def match_takes(
    truth: list[Segment], detected: list[Segment], iou_threshold: float = 0.5
) -> list[tuple[int, int, float]]:
    """Greedy one-to-one matching by descending IoU."""
    candidates = [
        (_iou(t, d), ti, di)
        for ti, t in enumerate(truth)
        for di, d in enumerate(detected)
        if _iou(t, d) > iou_threshold
    ]
    candidates.sort(key=lambda c: (-c[0], c[1], c[2]))
    used_t: set[int] = set()
    used_d: set[int] = set()
    pairs: list[tuple[int, int, float]] = []
    for iou, ti, di in candidates:
        if ti in used_t or di in used_d:
            continue
        used_t.add(ti)
        used_d.add(di)
        pairs.append((ti, di, iou))
    return sorted(pairs, key=lambda p: p[0])


@dataclass(frozen=True)
class BoundaryStats:
    start_p50: float
    start_p90: float
    end_p50: float
    end_p90: float
    matched: int
    truth_count: int
    detected_count: int

    @property
    def take_count_error(self) -> int:
        return self.detected_count - self.truth_count


def boundary_stats(
    truth: list[Segment], detected: list[Segment], iou_threshold: float = 0.5
) -> BoundaryStats:
    pairs = match_takes(truth, detected, iou_threshold)
    if not pairs:
        nan = float("nan")
        return BoundaryStats(nan, nan, nan, nan, 0, len(truth), len(detected))
    start_err = np.array([abs(detected[d].start - truth[t].start) for t, d, _ in pairs])
    end_err = np.array([abs(detected[d].end - truth[t].end) for t, d, _ in pairs])
    return BoundaryStats(
        start_p50=float(np.median(start_err)),
        start_p90=float(np.percentile(start_err, 90)),
        end_p50=float(np.median(end_err)),
        end_p90=float(np.percentile(end_err, 90)),
        matched=len(pairs),
        truth_count=len(truth),
        detected_count=len(detected),
    )
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_metrics.py -v
```

Expected: 14 passed

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/metrics.py poc/tests/test_metrics.py
git commit -m "feat(poc): add recall/false-music/boundary metrics with dont-care handling"
```

---

### Task 5: 파라미터 스윕과 최적점 선택

**Files:**
- Create: `poc/src/bandpoc/sweep.py`
- Test: `poc/tests/test_sweep.py`

**Interfaces:**
- Consumes: `bandpoc.postproc.{PostParams, scores_to_segments, segments_to_mask}`, `bandpoc.metrics.{FrameCounts, frame_counts, boundary_stats, BoundaryStats}`, `bandpoc.labels.{HOP, SceneLabels}`
- Produces:
  - `bandpoc.sweep.THRESHOLDS: np.ndarray`, `MIN_DURATIONS: tuple[float,...]`, `MERGE_GAPS: tuple[float,...]`
  - `bandpoc.sweep.SceneInput(scene_id: str, scores: np.ndarray, labels: SceneLabels)` — `scores`는 이미 평가 격자로 리샘플된 곡선
  - `bandpoc.sweep.SweepPoint(params: PostParams, counts: FrameCounts, boundary: BoundaryStats)`
    - `.recall`, `.false_seconds`, `.false_ratio`, `.take_count_error`
  - `bandpoc.sweep.run_sweep(inputs: list[SceneInput], hop: float = HOP) -> list[SweepPoint]`
  - `bandpoc.sweep.best_point(points, min_recall: float = 0.90) -> tuple[SweepPoint | None, SweepPoint]` — `(제약 만족 최적점 또는 None, 최대 recall 지점)`

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_sweep.py`:

```python
import numpy as np
import pytest

from bandpoc.labels import HOP, LabelBlock, SceneLabels
from bandpoc.sweep import (
    MERGE_GAPS,
    MIN_DURATIONS,
    THRESHOLDS,
    SceneInput,
    best_point,
    run_sweep,
)


def make_scene(scene_id="s"):
    """60 s music (take 1), 60 s speech, 60 s music (take 2)."""
    blocks = (
        LabelBlock(0.0, 60.0, "music", 1),
        LabelBlock(60.0, 120.0, "speech", None),
        LabelBlock(120.0, 180.0, "music", 2),
    )
    return SceneLabels(scene_id=scene_id, duration=180.0, blocks=blocks)


def oracle_scores(scene):
    m = scene.frame_masks()
    return np.where(m.is_music, 0.95, 0.05).astype(np.float32)


def test_grid_dimensions_match_the_spec():
    assert len(THRESHOLDS) == 19
    assert THRESHOLDS[0] == pytest.approx(0.05)
    assert THRESHOLDS[-1] == pytest.approx(0.95)
    assert MIN_DURATIONS == (10.0, 20.0, 30.0)
    assert MERGE_GAPS == (5.0, 10.0, 20.0)


def test_sweep_covers_the_whole_grid():
    scene = make_scene()
    points = run_sweep([SceneInput("s", oracle_scores(scene), scene)])
    assert len(points) == 19 * 3 * 3


def test_oracle_scores_reach_perfect_recall_with_no_false_music():
    scene = make_scene()
    points = run_sweep([SceneInput("s", oracle_scores(scene), scene)])
    best, _ = best_point(points, min_recall=0.90)
    assert best is not None
    assert best.recall == pytest.approx(1.0)
    assert best.false_seconds == pytest.approx(0.0)
    assert best.take_count_error == 0


def test_best_point_returns_none_when_the_recall_floor_is_unreachable():
    scene = make_scene()
    flat = np.zeros(scene.n_frames(), dtype=np.float32)
    points = run_sweep([SceneInput("s", flat, scene)])
    best, top_recall = best_point(points, min_recall=0.90)
    assert best is None
    assert top_recall.recall == pytest.approx(0.0)


def test_best_point_prefers_lower_false_music_among_qualifying_points():
    scene = make_scene()
    # Music is clear; speech sits at 0.5 so low thresholds pull it in.
    m = scene.frame_masks()
    scores = np.where(m.is_music, 0.95, 0.5).astype(np.float32)
    points = run_sweep([SceneInput("s", scores, scene)])
    best, _ = best_point(points, min_recall=0.90)
    assert best is not None
    assert best.params.threshold > 0.5
    assert best.false_seconds == pytest.approx(0.0)


def test_scenes_are_combined_by_micro_average():
    a, b = make_scene("a"), make_scene("b")
    scores_a = oracle_scores(a)
    scores_b = np.zeros(b.n_frames(), dtype=np.float32)  # detects nothing
    points = run_sweep([SceneInput("a", scores_a, a), SceneInput("b", scores_b, b)])
    _, top_recall = best_point(points, min_recall=0.90)
    assert top_recall.recall == pytest.approx(0.5)
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_sweep.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'bandpoc.sweep'`

- [ ] **Step 3: `sweep.py` 구현**

`poc/src/bandpoc/sweep.py`:

```python
"""Post-processing parameter sweep (spec § 5, § 6.4).

Runs entirely on cached score curves, so the full 171-point grid over every
scene finishes in seconds. This is what makes it fair to compare detectors at
their own optima rather than at one shared threshold.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .labels import HOP, SceneLabels
from .metrics import BoundaryStats, FrameCounts, boundary_stats, frame_counts
from .postproc import PostParams, Segment, scores_to_segments, segments_to_mask

THRESHOLDS = np.round(np.arange(0.05, 0.955, 0.05), 2)
MIN_DURATIONS: tuple[float, ...] = (10.0, 20.0, 30.0)
MERGE_GAPS: tuple[float, ...] = (5.0, 10.0, 20.0)


@dataclass(frozen=True)
class SceneInput:
    scene_id: str
    scores: np.ndarray  # already on the evaluation grid
    labels: SceneLabels


@dataclass(frozen=True)
class SweepPoint:
    params: PostParams
    counts: FrameCounts
    boundary: BoundaryStats
    segments_by_scene: dict[str, list[Segment]]

    @property
    def recall(self) -> float:
        return self.counts.music_recall

    @property
    def false_seconds(self) -> float:
        return self.counts.false_music_seconds(HOP)

    @property
    def false_ratio(self) -> float:
        return self.counts.false_music_ratio

    @property
    def take_count_error(self) -> int:
        return self.boundary.take_count_error


def run_sweep(inputs: list[SceneInput], hop: float = HOP) -> list[SweepPoint]:
    prepared = [
        (inp, inp.labels.frame_masks(hop), inp.labels.ground_truth_takes())
        for inp in inputs
    ]
    points: list[SweepPoint] = []
    for threshold in THRESHOLDS:
        for merge_gap in MERGE_GAPS:
            for min_duration in MIN_DURATIONS:
                params = PostParams(
                    threshold=float(threshold),
                    min_duration=min_duration,
                    merge_gap=merge_gap,
                )
                total: FrameCounts | None = None
                all_truth: list[Segment] = []
                all_detected: list[Segment] = []
                by_scene: dict[str, list[Segment]] = {}
                offset = 0.0
                for inp, masks, truth in prepared:
                    segs = scores_to_segments(inp.scores, hop, params)
                    by_scene[inp.scene_id] = segs
                    counts = frame_counts(
                        segments_to_mask(segs, len(masks.is_music), hop), masks
                    )
                    total = counts if total is None else total + counts
                    # Shift each scene onto a shared timeline so segment matching
                    # never pairs takes across scene boundaries.
                    all_truth += [Segment(s + offset, e + offset) for s, e in truth]
                    all_detected += [
                        Segment(s.start + offset, s.end + offset) for s in segs
                    ]
                    offset += inp.labels.duration + 3600.0
                if total is None:
                    continue
                points.append(
                    SweepPoint(
                        params=params,
                        counts=total,
                        boundary=boundary_stats(all_truth, all_detected),
                        segments_by_scene=by_scene,
                    )
                )
    return points


def best_point(
    points: list[SweepPoint], min_recall: float = 0.90
) -> tuple[SweepPoint | None, SweepPoint]:
    """Lowest False Music among points meeting the recall floor.

    Returns ``(best_or_none, highest_recall_point)``. When no configuration can
    reach the floor, the caller reports that fact rather than silently showing
    the least-bad point as if it qualified.
    """
    if not points:
        raise ValueError("no sweep points")

    def recall_or_zero(p: SweepPoint) -> float:
        return 0.0 if np.isnan(p.recall) else p.recall

    def false_or_inf(p: SweepPoint) -> float:
        return float("inf") if np.isnan(p.false_ratio) else p.false_seconds

    top_recall = max(points, key=lambda p: (recall_or_zero(p), -false_or_inf(p)))
    qualifying = [p for p in points if recall_or_zero(p) >= min_recall]
    if not qualifying:
        return None, top_recall
    best = min(qualifying, key=lambda p: (false_or_inf(p), abs(p.take_count_error)))
    return best, top_recall
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_sweep.py -v
```

Expected: 6 passed

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/sweep.py poc/tests/test_sweep.py
git commit -m "feat(poc): add parameter sweep with recall-constrained best-point selection"
```

---

### Task 6: 씬 합성기

**Files:**
- Create: `poc/src/bandpoc/synth.py`, `poc/scenes.yaml`
- Test: `poc/tests/test_synth.py`

**Interfaces:**
- Consumes: `bandpoc.audio.{WORK_SR, load_audio, save_audio, normalize_loudness}`, `bandpoc.labels.{LabelBlock, SceneLabels, validate}`
- Produces:
  - `bandpoc.synth.ClipPool` — 풀 이름 → 클립 경로 목록. `ClipPool.from_dir(root: Path)`, `.take(name: str, rng) -> Path`
  - `bandpoc.synth.load_recipes(path) -> list[dict]`
  - `bandpoc.synth.build_scene(recipe: dict, pool: ClipPool, out_dir: Path, sr: int = WORK_SR) -> SceneLabels`
  - 부작용: `out_dir/<id>.wav`, `out_dir/<id>.labels.json`

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_synth.py`:

```python
import numpy as np
import pytest
import soundfile as sf

from bandpoc.audio import WORK_SR
from bandpoc.labels import SceneLabels
from bandpoc.synth import ClipPool, build_scene


@pytest.fixture
def pool(tmp_path):
    """Three pools of short tones so scenes can be built without downloads."""
    root = tmp_path / "clips"
    freqs = {"band_full": 220.0, "conversation": 300.0, "guitar_noodle": 660.0,
             "tuning": 440.0, "room_tone": 80.0}
    for name, freq in freqs.items():
        d = root / name
        d.mkdir(parents=True)
        t = np.arange(WORK_SR * 20) / WORK_SR
        wav = (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
        sf.write(str(d / "a.wav"), wav, WORK_SR)
    return ClipPool.from_dir(root)


def recipe(**over):
    base = {
        "id": "t",
        "seed": 7,
        "blocks": [
            {"label": "speech", "pool": "conversation", "dur": 5.0},
            {"label": "music", "pool": "band_full", "dur": 8.0, "take": 1},
            {"label": "speech", "pool": "conversation", "dur": 2.0, "take": 1},
            {"label": "music", "pool": "band_full", "dur": 8.0, "take": 1},
        ],
    }
    base.update(over)
    return base


def test_audio_length_matches_the_declared_block_total(pool, tmp_path):
    scene = build_scene(recipe(), pool, tmp_path)
    wav, sr = sf.read(str(tmp_path / "t.wav"))
    assert sr == WORK_SR
    assert len(wav) == pytest.approx(23.0 * WORK_SR, abs=WORK_SR * 0.01)
    assert scene.duration == pytest.approx(23.0)


def test_labels_file_round_trips_and_matches_the_recipe(pool, tmp_path):
    scene = build_scene(recipe(), pool, tmp_path)
    loaded = SceneLabels.from_json(tmp_path / "t.labels.json")
    assert loaded == scene
    assert [b.label for b in scene.blocks] == ["speech", "music", "speech", "music"]
    assert [b.take for b in scene.blocks] == [None, 1, 1, 1]


def test_take_group_spans_the_intervening_speech(pool, tmp_path):
    scene = build_scene(recipe(), pool, tmp_path)
    assert scene.ground_truth_takes() == [(5.0, 23.0)]


def test_same_seed_produces_identical_audio(pool, tmp_path):
    a = tmp_path / "a"
    b = tmp_path / "b"
    build_scene(recipe(), pool, a)
    build_scene(recipe(), pool, b)
    wav_a, _ = sf.read(str(a / "t.wav"))
    wav_b, _ = sf.read(str(b / "t.wav"))
    np.testing.assert_allclose(wav_a, wav_b, atol=1e-6)


def test_different_seed_produces_different_audio(pool, tmp_path):
    build_scene(recipe(seed=1), pool, tmp_path / "a")
    build_scene(recipe(seed=2, id="t"), pool, tmp_path / "b")
    wav_a, _ = sf.read(str(tmp_path / "a" / "t.wav"))
    wav_b, _ = sf.read(str(tmp_path / "b" / "t.wav"))
    assert not np.allclose(wav_a, wav_b, atol=1e-6)


def test_overlay_adds_energy_without_changing_the_label(pool, tmp_path):
    plain = recipe(id="plain", blocks=[
        {"label": "speech", "pool": "conversation", "dur": 10.0},
    ])
    mixed = recipe(id="mixed", blocks=[
        {"label": "speech_with_noodling", "pool": "conversation", "dur": 10.0,
         "overlay": {"pool": "guitar_noodle", "snr_db": 6.0}},
    ])
    build_scene(plain, pool, tmp_path)
    scene = build_scene(mixed, pool, tmp_path)
    a, _ = sf.read(str(tmp_path / "plain.wav"))
    b, _ = sf.read(str(tmp_path / "mixed.wav"))
    assert float(np.sqrt(np.mean(b ** 2))) > float(np.sqrt(np.mean(a ** 2)))
    assert scene.blocks[0].label == "speech_with_noodling"
    assert not scene.frame_masks().is_music.any()


def test_music_block_without_take_is_rejected(pool, tmp_path):
    bad = recipe(blocks=[{"label": "music", "pool": "band_full", "dur": 8.0}])
    with pytest.raises(ValueError, match="take"):
        build_scene(bad, pool, tmp_path)


def test_missing_pool_is_reported_by_name(pool, tmp_path):
    bad = recipe(blocks=[{"label": "music", "pool": "nope", "dur": 8.0, "take": 1}])
    with pytest.raises(KeyError, match="nope"):
        build_scene(bad, pool, tmp_path)
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_synth.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'bandpoc.synth'`

- [ ] **Step 3: `synth.py` 구현**

`poc/src/bandpoc/synth.py`:

```python
"""Assemble labelled test scenes from tagged clip pools (spec § 4).

Ground truth is exact by construction: the recipe declares both the label and
the Take grouping, so nothing is ever hand-labelled.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import yaml

from .audio import WORK_SR, load_audio, normalize_loudness, save_audio
from .labels import LabelBlock, SceneLabels, validate

_AUDIO_SUFFIXES = {".wav", ".flac", ".ogg", ".m4a", ".mp3"}
_ROOM_TONE_POOL = "room_tone"
_ROOM_TONE_GAIN = 0.02
_CROSSFADE_RANGE = (0.3, 1.0)


@dataclass(frozen=True)
class ClipPool:
    clips: dict[str, tuple[Path, ...]]

    @classmethod
    def from_dir(cls, root: str | Path) -> "ClipPool":
        root = Path(root)
        clips: dict[str, tuple[Path, ...]] = {}
        if not root.is_dir():
            return cls(clips=clips)
        for sub in sorted(p for p in root.iterdir() if p.is_dir()):
            files = tuple(
                sorted(f for f in sub.iterdir() if f.suffix.lower() in _AUDIO_SUFFIXES)
            )
            if files:
                clips[sub.name] = files
        return cls(clips=clips)

    def has(self, name: str) -> bool:
        return name in self.clips

    def take(self, name: str, rng: np.random.Generator) -> Path:
        if name not in self.clips:
            raise KeyError(f"clip pool {name!r} is empty or missing under the clips dir")
        files = self.clips[name]
        return files[int(rng.integers(len(files)))]


def load_recipes(path: str | Path) -> list[dict]:
    payload = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    return list(payload["scenes"])


def _draw(pool: ClipPool, name: str, n_samples: int, sr: int, rng) -> np.ndarray:
    """Pull ``n_samples`` from a random clip in ``name``, looping if too short."""
    wav, _ = load_audio(pool.take(name, rng), target_sr=sr)
    if wav.size == 0:
        return np.zeros(n_samples, dtype=np.float32)
    if wav.size < n_samples:
        wav = np.tile(wav, int(np.ceil(n_samples / wav.size)))
    start = int(rng.integers(max(1, wav.size - n_samples)))
    return np.array(wav[start : start + n_samples], dtype=np.float32)


def _mix_at_snr(base: np.ndarray, overlay: np.ndarray, snr_db: float) -> np.ndarray:
    base_rms = float(np.sqrt(np.mean(base**2))) + 1e-9
    over_rms = float(np.sqrt(np.mean(overlay**2))) + 1e-9
    target = base_rms / (10.0 ** (snr_db / 20.0))
    return (base + overlay * (target / over_rms)).astype(np.float32)


def _crossfade(prev: np.ndarray, nxt: np.ndarray, n: int) -> None:
    """Fade the tail of ``prev`` into the head of ``nxt``, in place."""
    n = min(n, len(prev), len(nxt))
    if n <= 1:
        return
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
    prev[-n:] *= 1.0 - ramp
    nxt[:n] *= ramp


def build_scene(
    recipe: dict, pool: ClipPool, out_dir: str | Path, sr: int = WORK_SR
) -> SceneLabels:
    rng = np.random.default_rng(int(recipe.get("seed", 0)))
    scene_id = str(recipe["id"])
    parts: list[np.ndarray] = []
    blocks: list[LabelBlock] = []
    t = 0.0

    for spec in recipe["blocks"]:
        dur = float(spec["dur"])
        n = int(round(dur * sr))
        label = str(spec["label"])
        if label == "silence":
            audio = np.zeros(n, dtype=np.float32)
        else:
            audio = normalize_loudness(_draw(pool, str(spec["pool"]), n, sr, rng), sr)
        overlay = spec.get("overlay")
        if overlay:
            over = normalize_loudness(_draw(pool, str(overlay["pool"]), n, sr, rng), sr)
            audio = _mix_at_snr(audio, over, float(overlay["snr_db"]))
        if parts:
            fade = int(rng.uniform(*_CROSSFADE_RANGE) * sr)
            _crossfade(parts[-1], audio, fade)
        parts.append(audio)
        blocks.append(
            LabelBlock(
                start=round(t, 6),
                end=round(t + dur, 6),
                label=label,
                take=None if spec.get("take") is None else int(spec["take"]),
            )
        )
        t += dur

    scene = SceneLabels(scene_id=scene_id, duration=round(t, 6), blocks=tuple(blocks))
    validate(scene)

    wav = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
    if pool.has(_ROOM_TONE_POOL) and wav.size:
        tone = normalize_loudness(_draw(pool, _ROOM_TONE_POOL, wav.size, sr, rng), sr)
        wav = (wav + tone * _ROOM_TONE_GAIN).astype(np.float32)
    peak = float(np.max(np.abs(wav))) if wav.size else 0.0
    if peak > 0.99:
        wav = (wav * (0.99 / peak)).astype(np.float32)

    out_dir = Path(out_dir)
    save_audio(out_dir / f"{scene_id}.wav", wav, sr)
    scene.to_json(out_dir / f"{scene_id}.labels.json")
    return scene
```

- [ ] **Step 4: `scenes.yaml` 작성 후 테스트 통과 확인**

`poc/scenes.yaml`:

```yaml
# Test scene recipes (spec § 4.2, § 4.3).
#
#   label   — ground-truth label, one of the six in bandpoc.labels.LABELS
#   pool    — which clip folder to draw material from (independent of label)
#   take    — Take group id; blocks sharing one id form a single ground-truth
#             Take even across an intervening block. Every music block needs one.
#   overlay — mix a second pool in at the given SNR

scenes:
  # Sanity check: unambiguous alternation.
  - id: clean_basic
    seed: 11
    blocks:
      - {label: speech,  pool: conversation, dur: 45}
      - {label: music,   pool: band_full,    dur: 190, take: 1}
      - {label: speech,  pool: conversation, dur: 60}
      - {label: music,   pool: band_full,    dur: 220, take: 2}
      - {label: ambient, pool: room_tone,    dur: 40}
      - {label: music,   pool: band_full,    dur: 175, take: 3}
      - {label: speech,  pool: conversation, dur: 70}

  # Risk 1-①: members chatting while someone keeps noodling on guitar.
  - id: hard_noodling
    seed: 22
    blocks:
      - {label: speech, pool: conversation, dur: 90}
      - {label: speech_with_noodling, pool: conversation, dur: 120,
         overlay: {pool: guitar_noodle, snr_db: 6}}
      - {label: music,  pool: band_full,    dur: 210, take: 1}
      - {label: speech_with_noodling, pool: conversation, dur: 150,
         overlay: {pool: guitar_noodle, snr_db: 3}}
      - {label: music,  pool: band_full,    dur: 180, take: 2}
      - {label: speech_with_noodling, pool: conversation, dur: 100,
         overlay: {pool: guitar_noodle, snr_db: 9}}
      - {label: speech, pool: conversation, dur: 50}

  # Risk 1-③: tuning and gear setup.
  - id: tuning_setup
    seed: 33
    blocks:
      - {label: ambient, pool: room_tone,    dur: 40}
      - {label: tuning,  pool: tuning,       dur: 120}
      - {label: speech,  pool: conversation, dur: 45}
      - {label: tuning,  pool: tuning,       dur: 90}
      - {label: music,   pool: band_full,    dur: 200, take: 1}
      - {label: tuning,  pool: tuning,       dur: 75}
      - {label: music,   pool: band_full,    dur: 185, take: 2}
      - {label: ambient, pool: room_tone,    dur: 45}

  # Risk 1-②④: one instrument practising alone. Still music, still a Take.
  - id: partial_practice
    seed: 44
    blocks:
      - {label: speech, pool: conversation, dur: 50}
      - {label: music,  pool: drums_only,   dur: 165, take: 1}
      - {label: speech, pool: conversation, dur: 55}
      - {label: music,  pool: guitar_only,  dur: 150, take: 2}
      - {label: speech, pool: conversation, dur: 40}
      - {label: music,  pool: drums_only,   dur: 130, take: 3}
      - {label: music,  pool: band_full,    dur: 160, take: 4}
      - {label: speech, pool: conversation, dur: 50}

  # Stopping mid-song and restarting. Gaps of 3/8 s stay inside one Take;
  # gaps of 15/30 s start a new one. This is what pins down merge_gap.
  - id: restart_stop
    seed: 55
    blocks:
      - {label: speech, pool: conversation, dur: 40}
      - {label: music,  pool: band_full,    dur: 75,  take: 1}
      - {label: speech, pool: conversation, dur: 3,   take: 1}
      - {label: music,  pool: band_full,    dur: 90,  take: 1}
      - {label: speech, pool: conversation, dur: 8,   take: 1}
      - {label: music,  pool: band_full,    dur: 110, take: 1}
      - {label: speech, pool: conversation, dur: 15}
      - {label: music,  pool: band_full,    dur: 95,  take: 2}
      - {label: speech, pool: conversation, dur: 30}
      - {label: music,  pool: band_full,    dur: 120, take: 3}
      - {label: speech, pool: conversation, dur: 8,   take: 3}
      - {label: music,  pool: band_full,    dur: 85,  take: 3}
      - {label: speech, pool: conversation, dur: 45}

  # Everything mixed, 60 min. Also the RTF and memory measurement scene.
  - id: realistic_long
    seed: 66
    blocks:
      - {label: ambient, pool: room_tone,    dur: 60}
      - {label: speech,  pool: conversation, dur: 120}
      - {label: tuning,  pool: tuning,       dur: 90}
      - {label: music,   pool: band_full,    dur: 240, take: 1}
      - {label: speech,  pool: conversation, dur: 10,  take: 1}
      - {label: music,   pool: band_full,    dur: 200, take: 1}
      - {label: speech_with_noodling, pool: conversation, dur: 140,
         overlay: {pool: guitar_noodle, snr_db: 6}}
      - {label: music,   pool: guitar_only,  dur: 170, take: 2}
      - {label: speech,  pool: conversation, dur: 95}
      - {label: music,   pool: band_full,    dur: 265, take: 3}
      - {label: tuning,  pool: tuning,       dur: 70}
      - {label: music,   pool: drums_only,   dur: 155, take: 4}
      - {label: speech_with_noodling, pool: conversation, dur: 110,
         overlay: {pool: guitar_noodle, snr_db: 3}}
      - {label: music,   pool: band_full,    dur: 285, take: 5}
      - {label: speech,  pool: conversation, dur: 5,   take: 5}
      - {label: music,   pool: band_full,    dur: 190, take: 5}
      - {label: ambient, pool: room_tone,    dur: 150}
      - {label: speech,  pool: conversation, dur: 105}
      - {label: music,   pool: band_full,    dur: 230, take: 6}
      - {label: tuning,  pool: tuning,       dur: 55}
      - {label: music,   pool: band_full,    dur: 245, take: 7}
      - {label: speech,  pool: conversation, dur: 105}
```

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_synth.py -v
cd poc && .venv/Scripts/python.exe -c "from bandpoc.synth import load_recipes; r = load_recipes('scenes.yaml'); print([(s['id'], sum(b['dur'] for b in s['blocks'])) for s in r])"
```

Expected: 8 passed. 두 번째 명령은 6개 씬과 총 길이를 출력하며 `realistic_long`이 3600초 근처여야 한다.

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/synth.py poc/scenes.yaml poc/tests/test_synth.py
git commit -m "feat(poc): add scene synthesiser and the six test scene recipes"
```

---

### Task 7: 클립 수집 (yt-dlp)

**Files:**
- Create: `poc/src/bandpoc/fetch.py`, `poc/sources.yaml`
- Test: `poc/tests/test_fetch.py`

**Interfaces:**
- Consumes: `bandpoc.audio.{WORK_SR, load_audio, save_audio, normalize_loudness}`
- Produces:
  - `bandpoc.fetch.PoolSpec(name, queries: tuple[str,...], urls: tuple[str,...], max_results: int, clips_per_video: int, clip_seconds: float)`
  - `bandpoc.fetch.load_sources(path) -> list[PoolSpec]`
  - `bandpoc.fetch.ffmpeg_available() -> bool`
  - `bandpoc.fetch.slice_clips(src_wav, sr, spec, rng) -> list[np.ndarray]` — 순수 함수, 테스트 대상
  - `bandpoc.fetch.fetch_pool(spec, raw_dir, clips_dir, sr=WORK_SR) -> int` — 네트워크. 생성된 클립 수 반환

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_fetch.py`:

```python
import numpy as np
import pytest

from bandpoc.audio import WORK_SR
from bandpoc.fetch import PoolSpec, load_sources, slice_clips


def spec(**over):
    base = dict(name="band_full", queries=("a",), urls=(), max_results=2,
                clips_per_video=3, clip_seconds=30.0)
    base.update(over)
    return PoolSpec(**base)


def test_slice_clips_returns_the_requested_count_and_length():
    wav = np.random.RandomState(0).randn(WORK_SR * 300).astype(np.float32)
    clips = slice_clips(wav, WORK_SR, spec(), np.random.default_rng(0))
    assert len(clips) == 3
    assert all(len(c) == int(30.0 * WORK_SR) for c in clips)


def test_slice_clips_skips_the_first_and_last_ten_percent():
    # Intros and outros are usually titles or silence, not rehearsal.
    wav = np.zeros(WORK_SR * 300, dtype=np.float32)
    wav[: WORK_SR * 20] = 1.0
    wav[-WORK_SR * 20 :] = 1.0
    clips = slice_clips(wav, WORK_SR, spec(clips_per_video=8), np.random.default_rng(1))
    assert all(float(np.max(np.abs(c))) == 0.0 for c in clips)


def test_slice_clips_returns_nothing_when_the_source_is_too_short():
    wav = np.zeros(WORK_SR * 10, dtype=np.float32)
    assert slice_clips(wav, WORK_SR, spec(), np.random.default_rng(0)) == []


def test_slice_clips_is_deterministic_for_a_given_seed():
    wav = np.random.RandomState(2).randn(WORK_SR * 300).astype(np.float32)
    a = slice_clips(wav, WORK_SR, spec(), np.random.default_rng(5))
    b = slice_clips(wav, WORK_SR, spec(), np.random.default_rng(5))
    for x, y in zip(a, b):
        np.testing.assert_array_equal(x, y)


def test_load_sources_parses_queries_and_urls(tmp_path):
    p = tmp_path / "sources.yaml"
    p.write_text(
        "pools:\n"
        "  band_full:\n"
        "    queries: ['밴드 합주']\n"
        "    urls: ['https://youtu.be/abc']\n"
        "    max_results: 3\n"
        "    clips_per_video: 4\n"
        "    clip_seconds: 25\n",
        encoding="utf-8",
    )
    pools = load_sources(p)
    assert len(pools) == 1
    assert pools[0].name == "band_full"
    assert pools[0].queries == ("밴드 합주",)
    assert pools[0].urls == ("https://youtu.be/abc",)
    assert pools[0].clip_seconds == 25.0


def test_load_sources_applies_defaults_for_omitted_fields(tmp_path):
    p = tmp_path / "sources.yaml"
    p.write_text("pools:\n  tuning:\n    queries: ['guitar tuning']\n", encoding="utf-8")
    pool = load_sources(p)[0]
    assert pool.urls == ()
    assert pool.max_results >= 1
    assert pool.clips_per_video >= 1
    assert pool.clip_seconds > 0


def test_load_sources_rejects_a_pool_with_neither_queries_nor_urls(tmp_path):
    p = tmp_path / "sources.yaml"
    p.write_text("pools:\n  empty: {}\n", encoding="utf-8")
    with pytest.raises(ValueError, match="empty"):
        load_sources(p)
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_fetch.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'bandpoc.fetch'`

- [ ] **Step 3: `fetch.py` 구현**

`poc/src/bandpoc/fetch.py`:

```python
"""Collect raw material for scene synthesis from YouTube (spec § 4.1).

Pools are defined by search queries rather than fixed URLs so the harness works
without anyone hand-curating a link list. Search results are unvetted, which is
why the CLI tells you to audition the clips and delete the bad ones before
building scenes — see ``bandpoc fetch --help``.
"""

from __future__ import annotations

import shutil
import subprocess
import zlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import yaml

from .audio import WORK_SR, load_audio, normalize_loudness, save_audio

_EDGE_TRIM = 0.10  # skip the first and last 10% of a video
_DEFAULTS = dict(max_results=3, clips_per_video=4, clip_seconds=30.0)


@dataclass(frozen=True)
class PoolSpec:
    name: str
    queries: tuple[str, ...]
    urls: tuple[str, ...]
    max_results: int
    clips_per_video: int
    clip_seconds: float


def load_sources(path: str | Path) -> list[PoolSpec]:
    payload = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    pools: list[PoolSpec] = []
    for name, cfg in (payload.get("pools") or {}).items():
        cfg = cfg or {}
        queries = tuple(cfg.get("queries") or ())
        urls = tuple(cfg.get("urls") or ())
        if not queries and not urls:
            raise ValueError(f"pool {name!r} has neither queries nor urls")
        pools.append(
            PoolSpec(
                name=str(name),
                queries=queries,
                urls=urls,
                max_results=int(cfg.get("max_results", _DEFAULTS["max_results"])),
                clips_per_video=int(
                    cfg.get("clips_per_video", _DEFAULTS["clips_per_video"])
                ),
                clip_seconds=float(cfg.get("clip_seconds", _DEFAULTS["clip_seconds"])),
            )
        )
    return pools


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def slice_clips(
    wav: np.ndarray, sr: int, spec: PoolSpec, rng: np.random.Generator
) -> list[np.ndarray]:
    """Cut non-overlapping clips from the middle 80% of a source recording."""
    n = int(round(spec.clip_seconds * sr))
    lo = int(len(wav) * _EDGE_TRIM)
    hi = len(wav) - lo
    if hi - lo < n:
        return []
    candidates = np.arange(lo, hi - n + 1, n)
    if candidates.size == 0:
        return []
    order = rng.permutation(candidates.size)[: spec.clips_per_video]
    return [
        np.array(wav[s : s + n], dtype=np.float32) for s in sorted(candidates[order])
    ]


def _targets(spec: PoolSpec) -> list[str]:
    out = list(spec.urls)
    out += [f"ytsearch{spec.max_results}:{q}" for q in spec.queries]
    return out


def fetch_pool(
    spec: PoolSpec, raw_dir: str | Path, clips_dir: str | Path, sr: int = WORK_SR
) -> int:
    """Download this pool's sources and write normalised clips. Returns clip count."""
    if not ffmpeg_available():
        raise RuntimeError("ffmpeg not found on PATH. Install it: winget install Gyan.FFmpeg")
    raw_pool = Path(raw_dir) / spec.name
    raw_pool.mkdir(parents=True, exist_ok=True)
    for target in _targets(spec):
        subprocess.run(
            [
                "yt-dlp", "-x", "--audio-format", "wav", "--no-playlist",
                "--match-filter", "duration>120 & duration<3600",
                "-o", str(raw_pool / "%(id)s.%(ext)s"), target,
            ],
            check=False,
        )
    out_dir = Path(clips_dir) / spec.name
    out_dir.mkdir(parents=True, exist_ok=True)
    # crc32, not hash(): Python string hashing is salted per process, so hash()
    # would pick different clips on every run.
    rng = np.random.default_rng(zlib.crc32(spec.name.encode("utf-8")))
    count = 0
    for src in sorted(raw_pool.glob("*.wav")):
        wav, _ = load_audio(src, target_sr=sr)
        for i, clip in enumerate(slice_clips(wav, sr, spec, rng)):
            save_audio(out_dir / f"{src.stem}_{i:02d}.wav", normalize_loudness(clip, sr), sr)
            count += 1
    return count
```

- [ ] **Step 4: `sources.yaml` 작성 후 테스트 통과 확인**

`poc/sources.yaml`:

```yaml
# Material pools for scene synthesis (spec § 4.1).
#
# Each pool is filled from YouTube search queries and/or explicit URLs.
# Search results are UNVETTED — after `bandpoc fetch`, listen through
# data/clips/<pool>/ and delete anything that does not match the pool's
# intent. Bad material silently corrupts every downstream metric.

pools:
  band_full:
    queries:
      - "밴드 합주실 합주 영상"
      - "합주실 밴드 연습 브이로그"
      - "band rehearsal room full band practice"
    max_results: 4
    clips_per_video: 4
    clip_seconds: 30

  drums_only:
    queries:
      - "드럼 연습실 개인연습"
      - "drum practice room solo"
    max_results: 3
    clips_per_video: 4
    clip_seconds: 30

  guitar_only:
    queries:
      - "일렉기타 연습 합주실"
      - "electric guitar practice amp room"
    max_results: 3
    clips_per_video: 4
    clip_seconds: 30

  conversation:
    queries:
      - "한국어 일상 대화 실내"
      - "밴드 합주 브이로그 대화"
    max_results: 4
    clips_per_video: 5
    clip_seconds: 30

  guitar_noodle:
    queries:
      - "기타 노들링 무의미하게 치기"
      - "guitar noodling riffs practice idle"
    max_results: 3
    clips_per_video: 5
    clip_seconds: 30

  tuning:
    queries:
      - "기타 튜닝 소리"
      - "guitar tuning sound drum tuning"
    max_results: 3
    clips_per_video: 4
    clip_seconds: 20

  room_tone:
    queries:
      - "room tone ambience empty room"
      - "air conditioner hum room tone"
    max_results: 2
    clips_per_video: 4
    clip_seconds: 30
```

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_fetch.py -v
cd poc && .venv/Scripts/python.exe -c "from bandpoc.fetch import load_sources, ffmpeg_available; print(len(load_sources('sources.yaml')), 'pools; ffmpeg:', ffmpeg_available())"
```

Expected: 7 passed. 두 번째 명령은 `7 pools; ffmpeg: True`를 출력해야 한다. `False`면 `winget install Gyan.FFmpeg` 후 새 셸에서 재시도.

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/fetch.py poc/sources.yaml poc/tests/test_fetch.py
git commit -m "feat(poc): add query-driven YouTube clip collection"
```

---

### Task 8: Detector 인터페이스, 레지스트리, DSP 베이스라인

**Files:**
- Create: `poc/src/bandpoc/detectors/__init__.py`, `poc/src/bandpoc/detectors/base.py`, `poc/src/bandpoc/detectors/dsp.py`, `poc/src/bandpoc/registry.py`
- Test: `poc/tests/test_detectors_base.py`

**Interfaces:**
- Consumes: `bandpoc.audio.{resample, iter_chunks}`
- Produces:
  - `bandpoc.detectors.base.Detector` (ABC) — 속성 `name`, `version`, `variant`, `requires`; `.key -> str` (`"{name}:{variant}"`), `.is_available() -> tuple[bool,str]`, `.load()`, 추상 `.music_score(wav, sr) -> tuple[np.ndarray,float]`
  - `bandpoc.detectors.base.chunked_scores(wav, sr, chunk_s, overlap_s, fn, hop_s) -> np.ndarray` — 청크별 점수 배열을 이어붙임
  - `bandpoc.detectors.dsp.DspBaseline`
  - `bandpoc.registry.register(key, factory)`, `bandpoc.registry.get(key) -> Detector`, `bandpoc.registry.all_keys() -> list[str]`

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_detectors_base.py`:

```python
import numpy as np
import pytest

from bandpoc import registry
from bandpoc.detectors.base import Detector, chunked_scores
from bandpoc.detectors.dsp import DspBaseline

SR = 16000


def tone(freq, seconds, sr=SR, amp=0.3):
    t = np.arange(int(seconds * sr)) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def noise(seconds, sr=SR, amp=0.3, seed=0):
    return (amp * np.random.RandomState(seed).randn(int(seconds * sr))).astype(np.float32)


def test_chunked_scores_concatenates_in_order_and_trims_overlap():
    wav = np.zeros(SR * 10, dtype=np.float32)

    def fn(chunk):
        return np.full(int(len(chunk) / SR / 0.5), 0.5, dtype=np.float32)

    out = chunked_scores(wav, SR, chunk_s=4.0, overlap_s=1.0, fn=fn, hop_s=0.5)
    assert len(out) == pytest.approx(20, abs=2)
    assert np.allclose(out, 0.5)


def test_dsp_baseline_returns_a_bounded_curve_of_the_right_length():
    det = DspBaseline()
    det.load()
    scores, hop = det.music_score(tone(220, 6.0), SR)
    assert hop == pytest.approx(0.1)
    assert len(scores) == pytest.approx(60, abs=3)
    assert scores.min() >= 0.0 and scores.max() <= 1.0
    assert scores.dtype == np.float32


def test_dsp_baseline_scores_a_tone_above_white_noise():
    det = DspBaseline()
    det.load()
    tonal, _ = det.music_score(tone(220, 6.0), SR)
    noisy, _ = det.music_score(noise(6.0), SR)
    assert float(np.median(tonal)) > float(np.median(noisy))


def test_dsp_baseline_scores_silence_near_zero():
    det = DspBaseline()
    det.load()
    scores, _ = det.music_score(np.zeros(SR * 6, dtype=np.float32), SR)
    assert float(np.max(scores)) < 0.05


def test_dsp_baseline_memory_does_not_grow_with_length():
    det = DspBaseline()
    det.load()
    short, _ = det.music_score(tone(220, 5.0), SR)
    long, _ = det.music_score(tone(220, 60.0), SR)
    assert len(long) > len(short) * 10
    assert float(np.median(long)) == pytest.approx(float(np.median(short)), abs=0.15)


def test_registry_round_trips_a_detector():
    registry.register("fake:default", lambda: DspBaseline())
    assert "fake:default" in registry.all_keys()
    assert isinstance(registry.get("fake:default"), Detector)


def test_registry_raises_on_an_unknown_key():
    with pytest.raises(KeyError, match="nope"):
        registry.get("nope")


def test_dsp_baseline_reports_itself_available():
    ok, reason = DspBaseline().is_available()
    assert ok and reason == ""


def test_detector_reports_unavailable_when_a_required_package_is_missing():
    class Missing(Detector):
        name = "missing"
        version = "1"
        requires = ("definitely_not_installed_xyz",)

        def music_score(self, wav, sr):
            raise AssertionError("should never run")

    ok, reason = Missing().is_available()
    assert not ok
    assert "definitely_not_installed_xyz" in reason


def test_dsp_baseline_is_registered_by_default():
    import bandpoc.detectors  # noqa: F401 — registration happens on import

    assert "dsp_baseline:default" in registry.all_keys()
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_detectors_base.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'bandpoc.detectors'`

- [ ] **Step 3: `base.py`, `registry.py`, `dsp.py` 구현**

`poc/src/bandpoc/detectors/base.py`:

```python
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
```

`poc/src/bandpoc/registry.py`:

```python
"""Lazy detector registry. Factories defer heavy imports until instantiation."""

from __future__ import annotations

from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:  # importing Detector for real would make this circular:
    from .detectors.base import Detector  # registry → detectors/__init__ → registry

_FACTORIES: dict[str, "Callable[[], Detector]"] = {}


def register(key: str, factory: "Callable[[], Detector]") -> None:
    _FACTORIES[key] = factory


def get(key: str) -> "Detector":
    if key not in _FACTORIES:
        raise KeyError(f"unknown detector {key!r}; known: {sorted(_FACTORIES)}")
    return _FACTORIES[key]()


def all_keys() -> list[str]:
    return sorted(_FACTORIES)
```

`poc/src/bandpoc/detectors/dsp.py`:

```python
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
```

`poc/src/bandpoc/detectors/__init__.py`:

```python
"""Importing this package registers every detector.

Factories are lambdas so a backend that is not installed costs nothing until
someone actually asks for it.
"""

from .. import registry


def _register_all() -> None:
    from .dsp import DspBaseline

    registry.register("dsp_baseline:default", DspBaseline)


_register_all()
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_detectors_base.py -v
```

Expected: 10 passed

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/detectors/ poc/src/bandpoc/registry.py poc/tests/test_detectors_base.py
git commit -m "feat(poc): add detector interface, lazy registry and DSP baseline"
```

---

### Task 9: 점수 곡선 캐시

**Files:**
- Create: `poc/src/bandpoc/cache.py`
- Test: `poc/tests/test_cache.py`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `bandpoc.cache.CachedScores(scores: np.ndarray, hop: float, meta: dict)`
  - `bandpoc.cache.cache_path(root, scene_id: str, detector_key: str, version: str) -> Path`
  - `bandpoc.cache.save(path, scores, hop, meta) -> None`
  - `bandpoc.cache.load(path) -> CachedScores`
  - `bandpoc.cache.exists(root, scene_id, detector_key, version) -> bool`

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_cache.py`:

```python
import numpy as np
import pytest

from bandpoc.cache import cache_path, exists, load, save


def test_save_load_round_trip(tmp_path):
    scores = np.linspace(0, 1, 50).astype(np.float32)
    path = cache_path(tmp_path, "clean_basic", "panns_cnn14:music_group", "1")
    save(path, scores, 0.1, {"rtf": 0.05, "device": "cuda"})
    out = load(path)
    np.testing.assert_allclose(out.scores, scores)
    assert out.hop == pytest.approx(0.1)
    assert out.meta["rtf"] == pytest.approx(0.05)
    assert out.meta["device"] == "cuda"


def test_version_change_produces_a_different_path(tmp_path):
    a = cache_path(tmp_path, "s", "d:v", "1")
    b = cache_path(tmp_path, "s", "d:v", "2")
    assert a != b


def test_variant_change_produces_a_different_path(tmp_path):
    a = cache_path(tmp_path, "s", "d:music_only", "1")
    b = cache_path(tmp_path, "s", "d:music_group", "1")
    assert a != b


def test_path_has_no_characters_that_break_on_windows(tmp_path):
    p = cache_path(tmp_path, "s", "panns_cnn14:music_group", "1")
    assert ":" not in p.name
    assert p.suffix == ".npz"


def test_exists_is_false_before_save_and_true_after(tmp_path):
    assert not exists(tmp_path, "s", "d:v", "1")
    save(cache_path(tmp_path, "s", "d:v", "1"), np.zeros(3, dtype=np.float32), 0.1, {})
    assert exists(tmp_path, "s", "d:v", "1")


def test_empty_meta_round_trips(tmp_path):
    path = cache_path(tmp_path, "s", "d:v", "1")
    save(path, np.zeros(3, dtype=np.float32), 0.5, {})
    assert load(path).meta == {}
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_cache.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'bandpoc.cache'`

- [ ] **Step 3: `cache.py` 구현**

`poc/src/bandpoc/cache.py`:

```python
"""The cache boundary between slow inference and fast post-processing.

Keying on the detector version means bumping ``Detector.version`` after a logic
change invalidates exactly the affected curves and nothing else.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass(frozen=True)
class CachedScores:
    scores: np.ndarray
    hop: float
    meta: dict


def _sanitize(text: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in text)


def cache_path(root: str | Path, scene_id: str, detector_key: str, version: str) -> Path:
    return Path(root) / f"{_sanitize(scene_id)}__{_sanitize(detector_key)}__v{_sanitize(version)}.npz"


def save(path: str | Path, scores: np.ndarray, hop: float, meta: dict) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        p,
        scores=np.asarray(scores, dtype=np.float32),
        hop=np.float64(hop),
        meta=np.str_(json.dumps(meta, ensure_ascii=False)),
    )


def load(path: str | Path) -> CachedScores:
    with np.load(Path(path), allow_pickle=False) as data:
        return CachedScores(
            scores=np.asarray(data["scores"], dtype=np.float32),
            hop=float(data["hop"]),
            meta=json.loads(str(data["meta"])),
        )


def exists(root: str | Path, scene_id: str, detector_key: str, version: str) -> bool:
    return cache_path(root, scene_id, detector_key, version).exists()
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_cache.py -v
```

Expected: 6 passed

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/cache.py poc/tests/test_cache.py
git commit -m "feat(poc): add version-keyed score curve cache"
```

---

### Task 10: PyTorch 어댑터 — PANNs와 Silero VAD

**Files:**
- Create: `poc/src/bandpoc/detectors/audioset_classes.py`, `poc/src/bandpoc/detectors/panns.py`, `poc/src/bandpoc/detectors/silero.py`
- Modify: `poc/src/bandpoc/detectors/__init__.py`
- Test: `poc/tests/test_audioset_classes.py`, `poc/tests/test_detectors_torch.py`

**Interfaces:**
- Consumes: `bandpoc.detectors.base.{Detector, chunked_scores}`, `bandpoc.audio.resample`
- Produces:
  - `bandpoc.detectors.audioset_classes.MUSIC_ONLY: tuple[str,...]`, `MUSIC_GROUP: tuple[str,...]`, `VARIANTS: dict[str, tuple[str,...]]`
  - `bandpoc.detectors.audioset_classes.indices_for(labels: Sequence[str], names: Sequence[str]) -> list[int]`
  - `bandpoc.detectors.audioset_classes.score_from_logits(probs: np.ndarray, idx: list[int]) -> np.ndarray`
  - `bandpoc.detectors.panns.PannsCnn14(variant: str = "music_group", device: str = "cuda")`
  - `bandpoc.detectors.silero.SileroVad(device: str = "cpu")`
  - 등록 키: `panns_cnn14:music_only`, `panns_cnn14:music_group`, `silero_vad:default`

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_audioset_classes.py`:

```python
import numpy as np
import pytest

from bandpoc.detectors.audioset_classes import (
    MUSIC_GROUP,
    MUSIC_ONLY,
    VARIANTS,
    indices_for,
    score_from_logits,
)


def test_music_only_is_the_single_music_class():
    assert MUSIC_ONLY == ("Music",)


def test_music_group_contains_music_and_instrument_classes():
    assert "Music" in MUSIC_GROUP
    assert "Drum kit" in MUSIC_GROUP
    assert "Singing" in MUSIC_GROUP
    assert len(MUSIC_GROUP) > len(MUSIC_ONLY)


def test_variants_expose_both_definitions():
    assert set(VARIANTS) == {"music_only", "music_group"}


def test_indices_for_maps_names_to_positions():
    labels = ["Speech", "Music", "Guitar"]
    assert indices_for(labels, ("Music", "Guitar")) == [1, 2]


def test_indices_for_skips_names_absent_from_this_models_ontology():
    labels = ["Speech", "Music"]
    assert indices_for(labels, ("Music", "Theremin")) == [1]


def test_indices_for_raises_when_nothing_matches():
    with pytest.raises(ValueError, match="no matching"):
        indices_for(["Speech"], ("Music",))


def test_score_takes_the_max_over_selected_classes():
    probs = np.array([[0.1, 0.7, 0.3], [0.9, 0.2, 0.4]], dtype=np.float32)
    np.testing.assert_allclose(score_from_logits(probs, [1, 2]), [0.7, 0.4])


def test_score_handles_a_single_frame():
    probs = np.array([[0.1, 0.8]], dtype=np.float32)
    np.testing.assert_allclose(score_from_logits(probs, [1]), [0.8])
```

`poc/tests/test_detectors_torch.py`:

```python
"""Smoke tests. Skipped unless the torch backend is installed."""

import numpy as np
import pytest

from bandpoc import registry
import bandpoc.detectors  # noqa: F401 — triggers registration

SR = 16000


def tone(freq, seconds, sr=SR):
    t = np.arange(int(seconds * sr)) / sr
    return (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def get_or_skip(key):
    det = registry.get(key)
    ok, reason = det.is_available()
    if not ok:
        pytest.skip(f"{key} unavailable: {reason}")
    det.load()
    return det


@pytest.mark.parametrize(
    "key", ["panns_cnn14:music_only", "panns_cnn14:music_group", "silero_vad:default"]
)
def test_returns_a_bounded_curve_with_a_positive_hop(key):
    det = get_or_skip(key)
    scores, hop = det.music_score(tone(220, 12.0), SR)
    assert hop > 0
    assert scores.dtype == np.float32
    assert scores.min() >= 0.0 and scores.max() <= 1.0
    assert len(scores) >= 1


@pytest.mark.parametrize("key", ["panns_cnn14:music_group", "silero_vad:default"])
def test_curve_length_grows_with_audio_length(key):
    det = get_or_skip(key)
    short, hop = det.music_score(tone(220, 12.0), SR)
    long, _ = det.music_score(tone(220, 60.0), SR)
    assert len(long) > len(short)
    assert len(long) == pytest.approx(60.0 / hop, rel=0.25)


def test_panns_scores_a_musical_tone_above_silence():
    det = get_or_skip("panns_cnn14:music_group")
    music, _ = det.music_score(tone(220, 12.0), SR)
    quiet, _ = det.music_score(np.zeros(SR * 12, dtype=np.float32), SR)
    assert float(np.median(music)) > float(np.median(quiet))


@pytest.mark.parametrize("key", ["panns_cnn14:music_only", "panns_cnn14:music_group"])
def test_registered_keys_report_their_variant(key):
    assert registry.get(key).key == key
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_audioset_classes.py tests/test_detectors_torch.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'bandpoc.detectors.audioset_classes'`

- [ ] **Step 3: 세 모듈 구현**

`poc/src/bandpoc/detectors/audioset_classes.py`:

```python
"""Which AudioSet classes count as music (spec § 3.2).

Names, not indices: YAMNet has 521 classes and PANNs/AST have 527, so a
hardcoded index would silently mean a different class in a different model.
Names absent from a given ontology are skipped rather than erroring, which is
what lets one variant definition serve all three AudioSet detectors.
"""

from __future__ import annotations

from typing import Sequence

import numpy as np

MUSIC_ONLY: tuple[str, ...] = ("Music",)

MUSIC_GROUP: tuple[str, ...] = (
    "Music",
    "Musical instrument",
    "Plucked string instrument",
    "Guitar",
    "Electric guitar",
    "Acoustic guitar",
    "Bass guitar",
    "Drum kit",
    "Drum",
    "Snare drum",
    "Bass drum",
    "Cymbal",
    "Hi-hat",
    "Percussion",
    "Keyboard (musical)",
    "Piano",
    "Electric piano",
    "Organ",
    "Synthesizer",
    "Singing",
    "Rock music",
    "Pop music",
)

VARIANTS: dict[str, tuple[str, ...]] = {
    "music_only": MUSIC_ONLY,
    "music_group": MUSIC_GROUP,
}


def indices_for(labels: Sequence[str], names: Sequence[str]) -> list[int]:
    lookup = {name: i for i, name in enumerate(labels)}
    idx = [lookup[n] for n in names if n in lookup]
    if not idx:
        raise ValueError(f"no matching AudioSet classes for {tuple(names)!r}")
    return idx


def score_from_logits(probs: np.ndarray, idx: list[int]) -> np.ndarray:
    """Max probability over the selected classes, per frame."""
    return np.asarray(probs, dtype=np.float32)[:, idx].max(axis=1).astype(np.float32)
```

`poc/src/bandpoc/detectors/panns.py`:

```python
"""PANNs CNN14 AudioSet tagger (spec § 3.2).

CNN14 emits one clip-level vector per forward pass, so a time series comes from
sliding a window. 2 s windows at 1 s hop trade a little smoothing for a frame
rate fine enough to place Take boundaries within the ±5-10 s target.
"""

from __future__ import annotations

import numpy as np

from ..audio import resample
from .audioset_classes import VARIANTS, indices_for, score_from_logits
from .base import Detector, chunked_scores

_SR = 32000
_WIN_S = 2.0
_HOP_S = 1.0
_CHUNK_S = 60.0


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
        from panns_inference import AudioTagging, labels

        device = self._device if torch.cuda.is_available() else "cpu"
        self._device = device
        self._model = AudioTagging(checkpoint_path=None, device=device)
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
```

`poc/src/bandpoc/detectors/silero.py`:

```python
"""Silero VAD as an inverted axis (spec § 3.2).

This is a speech detector, not a music detector: the score is ``1 - speech``.
Silence and room noise will therefore read as music, so poor standalone numbers
are the expected result — the point is to see whether the speech axis adds
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
```

- [ ] **Step 4: 레지스트리 등록 후 테스트 통과 확인**

`poc/src/bandpoc/detectors/__init__.py`의 `_register_all` 본문을 다음으로 교체:

```python
def _register_all() -> None:
    from .dsp import DspBaseline

    registry.register("dsp_baseline:default", DspBaseline)

    def _panns(variant: str):
        def factory():
            from .panns import PannsCnn14

            return PannsCnn14(variant=variant)

        return factory

    registry.register("panns_cnn14:music_only", _panns("music_only"))
    registry.register("panns_cnn14:music_group", _panns("music_group"))

    def _silero():
        from .silero import SileroVad

        return SileroVad()

    registry.register("silero_vad:default", _silero)
```

`panns_inference`가 `torch`를 임포트 시점에 요구하므로 팩토리 안에서 임포트해야 미설치 환경에서도 레지스트리가 뜬다. 다만 `Detector.is_available()`은 인스턴스가 있어야 호출되므로, 미설치 시 `registry.get()`이 `ImportError`를 던진다. 이를 CLI에서 잡도록 Task 14에서 처리한다.

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_audioset_classes.py -v
cd poc && .venv/Scripts/python.exe -m pip install -e ".[torch]"
cd poc && .venv/Scripts/python.exe -m pytest tests/test_detectors_torch.py -v
```

Expected: `test_audioset_classes.py` 8 passed. torch 설치 후 `test_detectors_torch.py` 8 passed (최초 실행 시 PANNs 체크포인트 ~300MB, Silero 가중치 다운로드로 몇 분 소요).

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/detectors/ poc/tests/test_audioset_classes.py poc/tests/test_detectors_torch.py
git commit -m "feat(poc): add PANNs CNN14 and Silero VAD adapters"
```

---

### Task 11: transformers 어댑터 — AST와 CLAP

**Files:**
- Create: `poc/src/bandpoc/detectors/ast.py`, `poc/src/bandpoc/detectors/clap.py`
- Modify: `poc/src/bandpoc/detectors/__init__.py`
- Test: `poc/tests/test_detectors_hf.py`

**Interfaces:**
- Consumes: `bandpoc.detectors.base.{Detector, chunked_scores}`, `bandpoc.detectors.audioset_classes.*`
- Produces:
  - `bandpoc.detectors.ast.AstAudioSet(variant: str = "music_group", device: str = "cuda")`
  - `bandpoc.detectors.clap.ClapZeroShot(device: str = "cuda")` — `POSITIVE_PROMPTS`, `NEGATIVE_PROMPTS` 모듈 상수
  - 등록 키: `ast:music_only`, `ast:music_group`, `clap_zeroshot:default`

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_detectors_hf.py`:

```python
"""Smoke tests. Skipped unless the transformers backend is installed."""

import numpy as np
import pytest

from bandpoc import registry
import bandpoc.detectors  # noqa: F401

SR = 16000


def tone(freq, seconds, sr=SR):
    t = np.arange(int(seconds * sr)) / sr
    return (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def get_or_skip(key):
    try:
        det = registry.get(key)
    except ImportError as exc:
        pytest.skip(f"{key} unavailable: {exc}")
    ok, reason = det.is_available()
    if not ok:
        pytest.skip(f"{key} unavailable: {reason}")
    det.load()
    return det


@pytest.mark.parametrize("key", ["ast:music_only", "ast:music_group", "clap_zeroshot:default"])
def test_returns_a_bounded_curve_with_a_positive_hop(key):
    det = get_or_skip(key)
    scores, hop = det.music_score(tone(220, 30.0), SR)
    assert hop > 0
    assert scores.dtype == np.float32
    assert scores.min() >= 0.0 and scores.max() <= 1.0
    assert len(scores) >= 2


@pytest.mark.parametrize("key", ["ast:music_group", "clap_zeroshot:default"])
def test_curve_length_grows_with_audio_length(key):
    det = get_or_skip(key)
    short, _ = det.music_score(tone(220, 30.0), SR)
    long, _ = det.music_score(tone(220, 120.0), SR)
    assert len(long) > len(short) * 2


def test_ast_scores_a_musical_tone_above_silence():
    det = get_or_skip("ast:music_group")
    music, _ = det.music_score(tone(220, 30.0), SR)
    quiet, _ = det.music_score(np.zeros(SR * 30, dtype=np.float32), SR)
    assert float(np.median(music)) > float(np.median(quiet))


def test_clap_prompt_sets_are_non_empty_and_disjoint():
    from bandpoc.detectors.clap import NEGATIVE_PROMPTS, POSITIVE_PROMPTS

    assert POSITIVE_PROMPTS and NEGATIVE_PROMPTS
    assert not set(POSITIVE_PROMPTS) & set(NEGATIVE_PROMPTS)
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_detectors_hf.py -v
```

Expected: FAIL — collection error, `No module named 'bandpoc.detectors.clap'`

- [ ] **Step 3: 두 어댑터 구현**

`poc/src/bandpoc/detectors/ast.py`:

```python
"""Audio Spectrogram Transformer, AudioSet-finetuned (spec § 3.2).

AST takes a fixed 10.24 s window, which is coarse next to the ±5-10 s boundary
target — hence a 2.5 s hop, accepting ~4x redundant compute to buy resolution.
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
```

`poc/src/bandpoc/detectors/clap.py`:

```python
"""CLAP zero-shot music detection (spec § 3.2).

The only adapter whose notion of "music" can be aimed at this product's edge
cases directly, because it is written in the prompts rather than baked into a
label set. Note the negatives deliberately name tuning and idle noodling —
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
            emb = self._model.get_text_features(**inputs)
        self._text_emb = torch.nn.functional.normalize(emb, dim=-1)

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
            audios=windows, sampling_rate=_SR, return_tensors="pt", padding=True
        )
        inputs = {k: v.to(self._device) for k, v in inputs.items()}
        with torch.no_grad():
            audio_emb = self._model.get_audio_features(**inputs)
            audio_emb = torch.nn.functional.normalize(audio_emb, dim=-1)
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
```

- [ ] **Step 4: 레지스트리 등록 후 테스트 통과 확인**

`poc/src/bandpoc/detectors/__init__.py`의 `_register_all` 끝에 추가:

```python
    def _ast(variant: str):
        def factory():
            from .ast import AstAudioSet

            return AstAudioSet(variant=variant)

        return factory

    registry.register("ast:music_only", _ast("music_only"))
    registry.register("ast:music_group", _ast("music_group"))

    def _clap():
        from .clap import ClapZeroShot

        return ClapZeroShot()

    registry.register("clap_zeroshot:default", _clap)
```

```bash
cd poc && .venv/Scripts/python.exe -m pip install -e ".[hf]"
cd poc && .venv/Scripts/python.exe -m pytest tests/test_detectors_hf.py -v
```

Expected: 8 passed (최초 실행 시 AST ~350MB, CLAP ~600MB 다운로드)

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/detectors/ poc/tests/test_detectors_hf.py
git commit -m "feat(poc): add AST and CLAP zero-shot adapters"
```

---

### Task 12: TensorFlow 어댑터 — YAMNet과 inaSpeechSegmenter

**Files:**
- Create: `poc/src/bandpoc/detectors/yamnet.py`, `poc/src/bandpoc/detectors/ina.py`
- Modify: `poc/src/bandpoc/detectors/__init__.py`
- Test: `poc/tests/test_detectors_tf.py`

**Interfaces:**
- Consumes: `bandpoc.detectors.base.{Detector, chunked_scores}`, `bandpoc.audio.{resample, save_audio}`
- Produces:
  - `bandpoc.detectors.yamnet.Yamnet(variant: str = "music_group")`
  - `bandpoc.detectors.ina.InaSegmenter()`
  - 등록 키: `yamnet:music_only`, `yamnet:music_group`, `ina_segmenter:default`

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_detectors_tf.py`:

```python
"""Smoke tests. Skipped unless the TensorFlow backend is installed."""

import numpy as np
import pytest

from bandpoc import registry
import bandpoc.detectors  # noqa: F401

SR = 16000


def tone(freq, seconds, sr=SR):
    t = np.arange(int(seconds * sr)) / sr
    return (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def get_or_skip(key):
    try:
        det = registry.get(key)
    except ImportError as exc:
        pytest.skip(f"{key} unavailable: {exc}")
    ok, reason = det.is_available()
    if not ok:
        pytest.skip(f"{key} unavailable: {reason}")
    det.load()
    return det


@pytest.mark.parametrize(
    "key", ["yamnet:music_only", "yamnet:music_group", "ina_segmenter:default"]
)
def test_returns_a_bounded_curve_with_a_positive_hop(key):
    det = get_or_skip(key)
    scores, hop = det.music_score(tone(220, 20.0), SR)
    assert hop > 0
    assert scores.dtype == np.float32
    assert scores.min() >= 0.0 and scores.max() <= 1.0
    assert len(scores) >= 2


@pytest.mark.parametrize("key", ["yamnet:music_group", "ina_segmenter:default"])
def test_curve_length_grows_with_audio_length(key):
    det = get_or_skip(key)
    short, hop = det.music_score(tone(220, 20.0), SR)
    long, _ = det.music_score(tone(220, 90.0), SR)
    assert len(long) > len(short) * 3
    assert len(long) == pytest.approx(90.0 / hop, rel=0.25)


def test_yamnet_hop_is_the_documented_0_48_seconds():
    det = get_or_skip("yamnet:music_group")
    _, hop = det.music_score(tone(220, 20.0), SR)
    assert hop == pytest.approx(0.48, abs=0.01)


def test_yamnet_scores_a_musical_tone_above_silence():
    det = get_or_skip("yamnet:music_group")
    music, _ = det.music_score(tone(220, 20.0), SR)
    quiet, _ = det.music_score(np.zeros(SR * 20, dtype=np.float32), SR)
    assert float(np.median(music)) > float(np.median(quiet))


def test_ina_produces_a_hard_binary_curve():
    det = get_or_skip("ina_segmenter:default")
    scores, _ = det.music_score(tone(220, 20.0), SR)
    assert set(np.unique(scores)) <= {0.0, 1.0}
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_detectors_tf.py -v
```

Expected: FAIL — collection error, `No module named 'bandpoc.detectors.yamnet'`

- [ ] **Step 3: 두 어댑터 구현**

`poc/src/bandpoc/detectors/yamnet.py`:

```python
"""YAMNet AudioSet tagger (spec § 3.2).

Already frame-wise — 0.96 s windows at 0.48 s hop — so no sliding window is
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
```

`poc/src/bandpoc/detectors/ina.py`:

```python
"""inaSpeechSegmenter — the one model built for exactly this task (spec § 3.2).

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
```

- [ ] **Step 4: 레지스트리 등록 후 테스트 통과 확인**

`poc/src/bandpoc/detectors/__init__.py`의 `_register_all` 끝에 추가:

```python
    def _yamnet(variant: str):
        def factory():
            from .yamnet import Yamnet

            return Yamnet(variant=variant)

        return factory

    registry.register("yamnet:music_only", _yamnet("music_only"))
    registry.register("yamnet:music_group", _yamnet("music_group"))

    def _ina():
        from .ina import InaSegmenter

        return InaSegmenter()

    registry.register("ina_segmenter:default", _ina)
```

```bash
cd poc && .venv/Scripts/python.exe -m pip install -e ".[tf]"
cd poc && .venv/Scripts/python.exe -c "import numpy; print('numpy', numpy.__version__)"
cd poc && .venv/Scripts/python.exe -m pytest tests/test_detectors_tf.py -v
```

Expected: 8 passed. `numpy`가 2.x로 올라갔다면 R1 대응대로 되돌린다: `.venv/Scripts/python.exe -m pip install "numpy<2"` 후 재실행. TF 설치가 끝내 깨지면 이 두 어댑터는 skip 처리되고 나머지 5개로 진행한다 — 계획대로의 graceful degradation이며 실패가 아니다.

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/detectors/ poc/tests/test_detectors_tf.py
git commit -m "feat(poc): add YAMNet and inaSpeechSegmenter adapters"
```

---

### Task 13: HTML 리포트

**Files:**
- Create: `poc/src/bandpoc/report.py`
- Test: `poc/tests/test_report.py`

**Interfaces:**
- Consumes: `bandpoc.sweep.{SweepPoint, SceneInput}`, `bandpoc.labels.{SceneLabels, LABELS, HOP}`, `bandpoc.postproc.Segment`
- Produces:
  - `bandpoc.report.DetectorResult(key, available: bool, reason: str, best: SweepPoint | None, top_recall: SweepPoint | None, points: list[SweepPoint], curves: dict[str, np.ndarray], meta: dict)`
  - `bandpoc.report.build_report(results: list[DetectorResult], scenes: dict[str, SceneLabels], out_dir, notes: str = "") -> Path`
  - `bandpoc.report.fig_to_data_uri(fig) -> str`

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_report.py`:

```python
import numpy as np
import pytest

from bandpoc.labels import LabelBlock, SceneLabels
from bandpoc.report import DetectorResult, build_report, fig_to_data_uri
from bandpoc.sweep import SceneInput, best_point, run_sweep


@pytest.fixture
def scene():
    return SceneLabels(
        scene_id="s",
        duration=180.0,
        blocks=(
            LabelBlock(0.0, 60.0, "music", 1),
            LabelBlock(60.0, 120.0, "speech", None),
            LabelBlock(120.0, 180.0, "music", 2),
        ),
    )


def result_for(scene, key="dsp_baseline:default", available=True):
    masks = scene.frame_masks()
    curve = np.where(masks.is_music, 0.95, 0.05).astype(np.float32)
    if not available:
        return DetectorResult(key, False, "missing package: tensorflow", None, None, [], {}, {})
    points = run_sweep([SceneInput("s", curve, scene)])
    best, top = best_point(points)
    return DetectorResult(key, True, "", best, top, points, {"s": curve},
                          {"rtf": 0.02, "device": "cpu"})


def test_report_file_is_created(scene, tmp_path):
    out = build_report([result_for(scene)], {"s": scene}, tmp_path)
    assert out.exists()
    assert out.name == "index.html"


def test_report_is_self_contained(scene, tmp_path):
    out = build_report([result_for(scene)], {"s": scene}, tmp_path)
    html = out.read_text(encoding="utf-8")
    assert "http://" not in html
    assert "https://" not in html
    assert "data:image/png;base64," in html


def test_report_names_every_detector(scene, tmp_path):
    results = [result_for(scene, "dsp_baseline:default"),
               result_for(scene, "yamnet:music_group", available=False)]
    html = build_report(results, {"s": scene}, tmp_path).read_text(encoding="utf-8")
    assert "dsp_baseline:default" in html
    assert "yamnet:music_group" in html


def test_unavailable_detector_is_marked_with_its_reason(scene, tmp_path):
    results = [result_for(scene, "yamnet:music_group", available=False)]
    html = build_report(results, {"s": scene}, tmp_path).read_text(encoding="utf-8")
    assert "unavailable" in html.lower()
    assert "missing package: tensorflow" in html


def test_report_states_when_the_recall_floor_was_not_reached(scene, tmp_path):
    masks = scene.frame_masks()
    points = run_sweep([SceneInput("s", np.zeros(len(masks.is_music), np.float32), scene)])
    best, top = best_point(points)
    assert best is None
    res = DetectorResult("dsp_baseline:default", True, "", None, top, points,
                         {"s": np.zeros(len(masks.is_music), np.float32)}, {})
    html = build_report([res], {"s": scene}, tmp_path).read_text(encoding="utf-8")
    assert "90% recall not reached" in html


def test_report_carries_the_synthetic_data_caveat(scene, tmp_path):
    html = build_report([result_for(scene)], {"s": scene}, tmp_path).read_text(encoding="utf-8")
    assert "합성" in html


def test_fig_to_data_uri_returns_an_inline_png():
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots()
    ax.plot([0, 1], [0, 1])
    uri = fig_to_data_uri(fig)
    assert uri.startswith("data:image/png;base64,")
    assert len(uri) > 100
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_report.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'bandpoc.report'`

- [ ] **Step 3: `report.py` 구현**

`poc/src/bandpoc/report.py`:

```python
"""Self-contained HTML report (spec § 7).

Everything is inlined as data URIs so the file can be opened from disk, copied
around, or attached to a message with no server and no broken images.
"""

from __future__ import annotations

import base64
import html
import io
from dataclasses import dataclass, field
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from .labels import HOP, LABELS, SceneLabels  # noqa: E402
from .sweep import SweepPoint  # noqa: E402

_RECALL_FLOOR = 0.90
_CAVEAT = (
    "이 리포트의 수치는 유튜브 클립을 조립한 <b>합성 씬</b>에서 나온 것이다. "
    "블록 경계가 실제 합주보다 깔끔하므로 <b>모델 간 상대 비교</b>로만 읽어야 하며, "
    "절대 정확도는 실제 합주 녹음을 확보한 뒤 재검증해야 한다."
)
_LABEL_COLORS = {
    "music": "#2e7d32",
    "speech": "#c62828",
    "silence": "#bdbdbd",
    "tuning": "#ef6c00",
    "ambient": "#8d8d8d",
    "speech_with_noodling": "#6a1b9a",
}


@dataclass
class DetectorResult:
    key: str
    available: bool
    reason: str
    best: SweepPoint | None
    top_recall: SweepPoint | None
    points: list[SweepPoint]
    curves: dict[str, np.ndarray]
    meta: dict = field(default_factory=dict)


def fig_to_data_uri(fig) -> str:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110, bbox_inches="tight")
    plt.close(fig)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _fmt(value: float, digits: int = 3) -> str:
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return "—"
    return f"{value:.{digits}f}"


def _summary_rows(results: list[DetectorResult]) -> str:
    rows = []
    for r in results:
        if not r.available:
            rows.append(
                f"<tr class='na'><td>{html.escape(r.key)}</td>"
                f"<td colspan='8'>unavailable — {html.escape(r.reason)}</td></tr>"
            )
            continue
        point = r.best or r.top_recall
        if point is None:
            rows.append(
                f"<tr class='na'><td>{html.escape(r.key)}</td>"
                f"<td colspan='8'>no sweep points</td></tr>"
            )
            continue
        note = "" if r.best else " <span class='warn'>90% recall not reached</span>"
        cls = "ok" if r.best else "warn-row"
        p = point.params
        rows.append(
            f"<tr class='{cls}'><td>{html.escape(r.key)}{note}</td>"
            f"<td>{p.threshold:.2f} / {p.min_duration:.0f}s / {p.merge_gap:.0f}s</td>"
            f"<td>{_fmt(point.recall)}</td>"
            f"<td>{point.false_seconds:.0f}s</td>"
            f"<td>{_fmt(point.false_ratio)}</td>"
            f"<td>{_fmt(point.boundary.start_p50, 1)} / {_fmt(point.boundary.start_p90, 1)}</td>"
            f"<td>{_fmt(point.boundary.end_p50, 1)} / {_fmt(point.boundary.end_p90, 1)}</td>"
            f"<td>{point.take_count_error:+d}</td>"
            f"<td>{_fmt(r.meta.get('rtf'), 4)}</td></tr>"
        )
    return "\n".join(rows)


def _heatmap(results: list[DetectorResult]) -> str:
    usable = [r for r in results if r.available and (r.best or r.top_recall)]
    labels = [name for name in LABELS if name != "music"]
    if not usable:
        return ""
    data = np.array(
        [
            [(r.best or r.top_recall).counts.per_label_false_rate.get(n, np.nan) for n in labels]
            for r in usable
        ],
        dtype=float,
    )
    fig, ax = plt.subplots(figsize=(1.4 * len(labels) + 2, 0.5 * len(usable) + 1.6))
    im = ax.imshow(data, cmap="Reds", vmin=0.0, vmax=1.0, aspect="auto")
    ax.set_xticks(range(len(labels)), labels, rotation=30, ha="right", fontsize=8)
    ax.set_yticks(range(len(usable)), [r.key for r in usable], fontsize=8)
    for i in range(data.shape[0]):
        for j in range(data.shape[1]):
            if not np.isnan(data[i, j]):
                ax.text(j, i, f"{data[i, j]:.2f}", ha="center", va="center", fontsize=7,
                        color="white" if data[i, j] > 0.5 else "black")
    ax.set_title("라벨별 오검출률 (낮을수록 좋음)", fontsize=10)
    fig.colorbar(im, ax=ax, shrink=0.8)
    return fig_to_data_uri(fig)


def _timeline(scene: SceneLabels, results: list[DetectorResult]) -> str:
    usable = [r for r in results if r.available and scene.scene_id in r.curves]
    fig, axes = plt.subplots(
        len(usable) + 1, 1, figsize=(13, 1.1 * (len(usable) + 1) + 1),
        sharex=True, gridspec_kw={"hspace": 0.35},
    )
    axes = np.atleast_1d(axes)
    truth_ax = axes[0]
    masks = scene.frame_masks()
    for block in scene.blocks:
        truth_ax.axvspan(block.start, block.end, color=_LABEL_COLORS[block.label], alpha=0.75)
    times = np.arange(len(masks.is_dontcare)) * HOP
    for start, end in _runs(masks.is_dontcare, times):
        truth_ax.axvspan(start, end, facecolor="none", edgecolor="white", hatch="///",
                         linewidth=0.0)
    truth_ax.set_yticks([])
    truth_ax.set_ylabel("truth", fontsize=8, rotation=0, ha="right", va="center")
    truth_ax.set_xlim(0, scene.duration)

    for ax, r in zip(axes[1:], usable):
        curve = r.curves[scene.scene_id]
        ax.plot(np.arange(len(curve)) * HOP, curve, linewidth=0.7, color="#1565c0")
        point = r.best or r.top_recall
        if point is not None:
            ax.axhline(point.params.threshold, color="#999", linewidth=0.6, linestyle="--")
            for seg in point.segments_by_scene.get(scene.scene_id, []):
                ax.axvspan(seg.start, seg.end, color="#2e7d32", alpha=0.20)
        ax.set_ylim(0, 1)
        ax.set_yticks([0, 1])
        ax.set_ylabel(r.key.split(":")[0], fontsize=7, rotation=0, ha="right", va="center")
    axes[-1].set_xlabel("seconds")
    return fig_to_data_uri(fig)


def _runs(mask: np.ndarray, times: np.ndarray) -> list[tuple[float, float]]:
    padded = np.concatenate(([False], mask.astype(bool), [False]))
    edges = np.diff(padded.astype(np.int8))
    starts = np.flatnonzero(edges == 1)
    ends = np.flatnonzero(edges == -1)
    hop = times[1] - times[0] if len(times) > 1 else HOP
    return [(float(s) * hop, float(e) * hop) for s, e in zip(starts, ends)]


def _sweep_curves(results: list[DetectorResult]) -> str:
    fig, ax = plt.subplots(figsize=(7.5, 5))
    plotted = False
    for r in results:
        if not r.available or not r.points:
            continue
        # One line per detector: hold merge/min-duration at the spec defaults so
        # the curve traces threshold alone.
        pts = sorted(
            (p for p in r.points if p.params.min_duration == 20.0 and p.params.merge_gap == 10.0),
            key=lambda p: p.params.threshold,
        )
        if not pts:
            continue
        ax.plot([p.false_seconds for p in pts], [p.recall for p in pts], marker="o",
                markersize=3, linewidth=1.0, label=r.key)
        plotted = True
    if not plotted:
        plt.close(fig)
        return ""
    ax.axhline(_RECALL_FLOOR, color="#c62828", linestyle="--", linewidth=0.8)
    ax.set_xlabel("False Music (seconds)")
    ax.set_ylabel("Music Recall")
    ax.set_title("threshold 스윕 트레이드오프 (min_duration=20s, merge_gap=10s)", fontsize=10)
    ax.set_ylim(0, 1.02)
    ax.legend(fontsize=7)
    ax.grid(alpha=0.25)
    return fig_to_data_uri(fig)


_CSS = """
body{font-family:system-ui,'Segoe UI',sans-serif;margin:0;padding:2rem;
     background:#fafafa;color:#1a1a1a;line-height:1.6}
h1{font-size:1.6rem}h2{font-size:1.2rem;margin-top:2.5rem;border-bottom:1px solid #ddd;
   padding-bottom:.3rem}
table{border-collapse:collapse;width:100%;font-size:.85rem;background:#fff}
th,td{border:1px solid #e0e0e0;padding:.4rem .6rem;text-align:left}
th{background:#f0f0f0}
tr.ok td:first-child{border-left:3px solid #2e7d32}
tr.warn-row td:first-child{border-left:3px solid #ef6c00}
tr.na{color:#999}
.warn{color:#c62828;font-weight:600;font-size:.8rem}
.caveat{background:#fff8e1;border-left:4px solid #ffb300;padding:.8rem 1rem;margin:1rem 0}
img{max-width:100%;height:auto;display:block;margin:1rem 0;background:#fff}
.meta{font-size:.8rem;color:#666}
"""


def build_report(
    results: list[DetectorResult],
    scenes: dict[str, SceneLabels],
    out_dir: str | Path,
    notes: str = "",
) -> Path:
    parts = [
        "<!doctype html><html lang='ko'><head><meta charset='utf-8'>",
        "<title>Band Feedback — 음악 구간 검출 모델 비교</title>",
        f"<style>{_CSS}</style></head><body>",
        "<h1>Band Feedback — 음악 구간 검출 모델 비교</h1>",
        f"<div class='caveat'>{_CAVEAT}</div>",
        "<h2>요약</h2>",
        "<table><tr><th>Detector</th><th>최적 파라미터 (th / min / gap)</th>"
        "<th>Music Recall</th><th>False Music</th><th>False 비율</th>"
        "<th>Start err p50/p90</th><th>End err p50/p90</th>"
        "<th>Take Count Err</th><th>RTF</th></tr>",
        _summary_rows(results),
        "</table>",
        f"<p class='meta'>Recall 하한 {_RECALL_FLOOR:.0%} 제약 하에 False Music이 "
        "최소인 지점을 골랐다. 제약을 만족하는 조합이 없으면 최대 Recall 지점을 "
        "보여주고 경고를 붙인다.</p>",
    ]

    heatmap = _heatmap(results)
    if heatmap:
        parts += ["<h2>라벨별 오검출 히트맵</h2>", f"<img src='{heatmap}' alt='heatmap'>"]

    sweep_img = _sweep_curves(results)
    if sweep_img:
        parts += ["<h2>threshold 스윕</h2>", f"<img src='{sweep_img}' alt='sweep'>"]

    parts.append("<h2>씬별 타임라인</h2>")
    legend = " · ".join(
        f"<span style='color:{c}'>■</span> {html.escape(n)}" for n, c in _LABEL_COLORS.items()
    )
    parts.append(f"<p class='meta'>{legend} · 빗금 = don't-care (감점 없음)</p>")
    for scene_id, scene in scenes.items():
        parts += [
            f"<h3>{html.escape(scene_id)} ({scene.duration / 60:.1f} min)</h3>",
            f"<img src='{_timeline(scene, results)}' alt='{html.escape(scene_id)}'>",
        ]

    if notes:
        parts += ["<h2>실행 메타</h2>", f"<pre class='meta'>{html.escape(notes)}</pre>"]
    parts.append("</body></html>")

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "index.html"
    path.write_text("\n".join(parts), encoding="utf-8")
    return path
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_report.py -v
```

Expected: 7 passed

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/report.py poc/tests/test_report.py
git commit -m "feat(poc): add self-contained HTML comparison report"
```

---

### Task 14: CLI 배선과 엔드투엔드 실행

**Files:**
- Create: `poc/src/bandpoc/cli.py`
- Modify: `poc/pyproject.toml` (psutil 추가), `poc/README.md` (워크플로 보강)
- Test: `poc/tests/test_cli.py`

**Interfaces:**
- Consumes: 전 모듈
- Produces:
  - `bandpoc.cli.main(argv: list[str] | None = None) -> int`
  - 서브커맨드: `fetch`, `build-scenes`, `run`, `report`
  - `bandpoc.cli.score_scene(detector, wav, sr) -> tuple[np.ndarray, float, dict]` — 계측 포함

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_cli.py`:

```python
import numpy as np
import pytest
import soundfile as sf

from bandpoc.audio import WORK_SR
from bandpoc.cli import main, score_scene
from bandpoc.detectors.dsp import DspBaseline


def write_pools(root):
    freqs = {"band_full": 220.0, "conversation": 300.0, "guitar_noodle": 660.0,
             "tuning": 440.0, "room_tone": 80.0, "drums_only": 110.0,
             "guitar_only": 550.0}
    for name, freq in freqs.items():
        d = root / name
        d.mkdir(parents=True)
        t = np.arange(WORK_SR * 30) / WORK_SR
        sf.write(str(d / "a.wav"), (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32),
                 WORK_SR)


def write_recipes(path):
    path.write_text(
        "scenes:\n"
        "  - id: tiny\n"
        "    seed: 1\n"
        "    blocks:\n"
        "      - {label: speech, pool: conversation, dur: 20}\n"
        "      - {label: music, pool: band_full, dur: 40, take: 1}\n"
        "      - {label: speech, pool: conversation, dur: 20}\n"
        "      - {label: music, pool: band_full, dur: 40, take: 2}\n",
        encoding="utf-8",
    )


def test_score_scene_reports_timing_metadata():
    det = DspBaseline()
    det.load()
    wav = np.zeros(WORK_SR * 5, dtype=np.float32)
    scores, hop, meta = score_scene(det, wav, WORK_SR)
    assert hop > 0
    assert len(scores) > 0
    assert meta["wall_s"] >= 0.0
    assert meta["duration_s"] == pytest.approx(5.0, abs=0.1)
    assert meta["rtf"] >= 0.0
    assert "peak_rss_mb" in meta


def test_build_scenes_writes_audio_and_labels(tmp_path):
    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    code = main(["build-scenes", "--data-dir", str(tmp_path),
                 "--recipes", str(tmp_path / "scenes.yaml")])
    assert code == 0
    assert (tmp_path / "scenes" / "tiny.wav").exists()
    assert (tmp_path / "scenes" / "tiny.labels.json").exists()


def test_run_caches_scores_and_skips_on_a_second_pass(tmp_path, capsys):
    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])

    assert main(["run", "--data-dir", str(tmp_path),
                 "--detectors", "dsp_baseline:default"]) == 0
    cached = list((tmp_path / "cache").glob("*.npz"))
    assert len(cached) == 1

    capsys.readouterr()
    assert main(["run", "--data-dir", str(tmp_path),
                 "--detectors", "dsp_baseline:default"]) == 0
    assert "cached" in capsys.readouterr().out


def test_run_force_recomputes(tmp_path, capsys):
    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])
    main(["run", "--data-dir", str(tmp_path), "--detectors", "dsp_baseline:default"])
    capsys.readouterr()
    main(["run", "--data-dir", str(tmp_path), "--detectors", "dsp_baseline:default",
          "--force"])
    assert "cached" not in capsys.readouterr().out


def test_run_survives_an_unavailable_detector(tmp_path, capsys):
    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])
    code = main(["run", "--data-dir", str(tmp_path),
                 "--detectors", "dsp_baseline:default,does_not_exist:default"])
    assert code == 0, "one bad detector must not fail the whole run"
    out = capsys.readouterr().out
    assert "does_not_exist:default" in out
    assert len(list((tmp_path / "cache").glob("*.npz"))) == 1


def test_report_produces_html_from_the_cache(tmp_path):
    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])
    main(["run", "--data-dir", str(tmp_path), "--detectors", "dsp_baseline:default"])
    code = main(["report", "--data-dir", str(tmp_path),
                 "--out-dir", str(tmp_path / "reports")])
    assert code == 0
    pages = list((tmp_path / "reports").rglob("index.html"))
    assert len(pages) == 1
    assert "dsp_baseline:default" in pages[0].read_text(encoding="utf-8")


def test_report_without_any_cache_fails_with_a_clear_message(tmp_path, capsys):
    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])
    assert main(["report", "--data-dir", str(tmp_path),
                 "--out-dir", str(tmp_path / "reports")]) == 1
    assert "bandpoc run" in capsys.readouterr().out
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_cli.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'bandpoc.cli'`

- [ ] **Step 3: `cli.py` 구현 및 `psutil` 추가**

`poc/pyproject.toml`의 `dependencies` 배열에 한 줄 추가:

```toml
    "psutil>=5.9",
```

`poc/src/bandpoc/cli.py`:

```python
"""Command line: fetch → build-scenes → run → report."""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import numpy as np

from . import cache, registry
from .audio import WORK_SR, load_audio
from .detectors.base import Detector
from .fetch import fetch_pool, ffmpeg_available, load_sources
from .labels import HOP, SceneLabels
from .postproc import resample_scores
from .report import DetectorResult, build_report
from .synth import ClipPool, build_scene, load_recipes
from .sweep import SceneInput, best_point, run_sweep

import bandpoc.detectors  # noqa: F401 — registers every adapter

_DEFAULT_DATA = Path("data")


def _peak_rss_mb() -> float:
    import psutil

    return psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)


def _peak_vram_mb() -> float | None:
    try:
        import torch

        if torch.cuda.is_available():
            return torch.cuda.max_memory_allocated() / (1024 * 1024)
    except Exception:
        pass
    return None


def score_scene(detector: Detector, wav: np.ndarray, sr: int) -> tuple[np.ndarray, float, dict]:
    """Run one detector over one scene, measuring wall time and memory."""
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
    except Exception:
        pass
    started = time.perf_counter()
    scores, hop = detector.music_score(wav, sr)
    wall = time.perf_counter() - started
    duration = len(wav) / sr
    return (
        scores,
        hop,
        {
            "wall_s": round(wall, 3),
            "duration_s": round(duration, 3),
            "rtf": round(wall / duration, 5) if duration > 0 else 0.0,
            "peak_rss_mb": round(_peak_rss_mb(), 1),
            "peak_vram_mb": _peak_vram_mb(),
            "detector_version": detector.version,
        },
    )


def _scene_ids(data_dir: Path, requested: str) -> list[str]:
    available = sorted(p.stem.replace(".labels", "")
                       for p in (data_dir / "scenes").glob("*.labels.json"))
    if requested == "all":
        return available
    return [s for s in requested.split(",") if s in available]


def cmd_fetch(args) -> int:
    if not ffmpeg_available():
        print("ffmpeg not found on PATH. Install it: winget install Gyan.FFmpeg")
        return 1
    data_dir = Path(args.data_dir)
    total = 0
    for spec in load_sources(args.sources):
        n = fetch_pool(spec, data_dir / "raw", data_dir / "clips")
        print(f"{spec.name}: {n} clips")
        total += n
    print(f"\n{total} clips written to {data_dir / 'clips'}")
    print(
        "Search results are UNVETTED. Listen through each pool and delete anything "
        "that does not match its intent before running build-scenes — bad material "
        "silently corrupts every metric downstream."
    )
    return 0


def cmd_build_scenes(args) -> int:
    data_dir = Path(args.data_dir)
    pool = ClipPool.from_dir(data_dir / "clips")
    if not pool.clips:
        print(f"no clips under {data_dir / 'clips'}; run `bandpoc fetch` first")
        return 1
    for recipe in load_recipes(args.recipes):
        scene = build_scene(recipe, pool, data_dir / "scenes")
        takes = len(scene.ground_truth_takes())
        print(f"{scene.scene_id}: {scene.duration / 60:.1f} min, {takes} takes")
    return 0


def cmd_run(args) -> int:
    data_dir = Path(args.data_dir)
    cache_dir = data_dir / "cache"
    scene_ids = _scene_ids(data_dir, args.scenes)
    if not scene_ids:
        print(f"no scenes under {data_dir / 'scenes'}; run `bandpoc build-scenes` first")
        return 1
    keys = registry.all_keys() if args.detectors == "all" else args.detectors.split(",")

    for scene_id in scene_ids:
        wav, sr = load_audio(data_dir / "scenes" / f"{scene_id}.wav", target_sr=WORK_SR)
        for key in keys:
            try:
                detector = registry.get(key)
            except (KeyError, ImportError) as exc:
                print(f"[skip] {key}: {exc}")
                continue
            ok, reason = detector.is_available()
            if not ok:
                print(f"[skip] {key}: {reason}")
                continue
            if not args.force and cache.exists(cache_dir, scene_id, key, detector.version):
                print(f"[cached] {scene_id} × {key}")
                continue
            try:
                detector.load()
                scores, hop, meta = score_scene(detector, wav, sr)
            except Exception as exc:  # a broken backend must not end the run
                print(f"[fail] {scene_id} × {key}: {type(exc).__name__}: {exc}")
                continue
            cache.save(
                cache.cache_path(cache_dir, scene_id, key, detector.version), scores, hop, meta
            )
            print(f"[done] {scene_id} × {key}  RTF={meta['rtf']:.4f}  "
                  f"RSS={meta['peak_rss_mb']:.0f}MB")
    return 0


def cmd_report(args) -> int:
    data_dir = Path(args.data_dir)
    cache_dir = data_dir / "cache"
    scene_ids = _scene_ids(data_dir, args.scenes)
    scenes = {
        sid: SceneLabels.from_json(data_dir / "scenes" / f"{sid}.labels.json")
        for sid in scene_ids
    }
    if not scenes:
        print(f"no scenes under {data_dir / 'scenes'}; run `bandpoc build-scenes` first")
        return 1

    results: list[DetectorResult] = []
    for key in registry.all_keys():
        try:
            detector = registry.get(key)
            version = detector.version
            ok, reason = detector.is_available()
        except (KeyError, ImportError) as exc:
            results.append(DetectorResult(key, False, str(exc), None, None, [], {}, {}))
            continue

        inputs: list[SceneInput] = []
        curves: dict[str, np.ndarray] = {}
        meta: dict = {}
        for sid, scene in scenes.items():
            path = cache.cache_path(cache_dir, sid, key, version)
            if not path.exists():
                continue
            cached = cache.load(path)
            curve = resample_scores(cached.scores, cached.hop, scene.n_frames(), HOP)
            curves[sid] = curve
            inputs.append(SceneInput(sid, curve, scene))
            meta = cached.meta
        if not inputs:
            results.append(
                DetectorResult(key, False, reason or "no cached scores", None, None, [], {}, {})
            )
            continue
        points = run_sweep(inputs)
        best, top = best_point(points)
        results.append(DetectorResult(key, True, "", best, top, points, curves, meta))

    if not any(r.available for r in results):
        print("no cached scores found — run `bandpoc run` first")
        return 1

    stamp = time.strftime("%Y%m%d-%H%M%S")
    notes = "\n".join(
        [f"scenes: {', '.join(scenes)}", f"frame hop: {HOP}s", f"generated: {stamp}"]
    )
    path = build_report(results, scenes, Path(args.out_dir) / stamp, notes=notes)
    print(f"report written to {path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bandpoc")
    parser.add_argument("--data-dir", default=str(_DEFAULT_DATA))
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("fetch", help="download YouTube material into data/clips")
    p.add_argument("--sources", default="sources.yaml")
    p.add_argument("--data-dir", default=str(_DEFAULT_DATA))
    p.set_defaults(func=cmd_fetch)

    p = sub.add_parser("build-scenes", help="assemble labelled scenes from clips")
    p.add_argument("--recipes", default="scenes.yaml")
    p.add_argument("--data-dir", default=str(_DEFAULT_DATA))
    p.set_defaults(func=cmd_build_scenes)

    p = sub.add_parser("run", help="run detectors and cache their score curves")
    p.add_argument("--detectors", default="all")
    p.add_argument("--scenes", default="all")
    p.add_argument("--force", action="store_true")
    p.add_argument("--data-dir", default=str(_DEFAULT_DATA))
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("report", help="sweep, evaluate and write the HTML report")
    p.add_argument("--scenes", default="all")
    p.add_argument("--out-dir", default="reports")
    p.add_argument("--data-dir", default=str(_DEFAULT_DATA))
    p.set_defaults(func=cmd_report)

    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 전체 테스트 통과 확인 후 엔드투엔드 실행**

```bash
cd poc && .venv/Scripts/python.exe -m pip install -e ".[dev]"
cd poc && .venv/Scripts/python.exe -m pytest -v
```

Expected: 전 테스트 통과 (미설치 백엔드의 스모크 테스트는 skip)

이어서 실제 파이프라인을 돌린다:

```bash
cd poc && .venv/Scripts/bandpoc.exe fetch
```

여기서 멈추고 `data/clips/` 각 폴더를 **직접 들어본다.** 풀 의도와 다른 클립(광고, 나레이션, 무음, 스튜디오 마스터 음원 등)은 삭제한다. 이 단계를 건너뛰면 이후 모든 수치가 조용히 오염된다.

```bash
cd poc && .venv/Scripts/bandpoc.exe build-scenes
cd poc && .venv/Scripts/bandpoc.exe run
cd poc && .venv/Scripts/bandpoc.exe report
```

Expected: `reports/<timestamp>/index.html` 생성. 브라우저로 열어 § 11 완료 기준을 확인한다 — 요약 테이블에 모델별 지표가 채워져 있고, 히트맵과 6개 씬 타임라인이 보이며, 설치하지 않은 백엔드는 `unavailable`로 표시된다.

- [ ] **Step 5: README 갱신 후 커밋**

`poc/README.md`의 "사용" 절 끝에 추가:

```markdown
### fetch 이후 반드시 할 일

`sources.yaml`은 고정 URL이 아니라 **검색 쿼리**로 클립을 모은다. 검색 결과는
검증되지 않았으므로, `bandpoc build-scenes` 전에 `data/clips/` 각 폴더를 직접
들어보고 풀 의도와 다른 클립을 삭제한다. 재료가 오염되면 리포트의 모든 수치가
조용히 틀어진다.

### 새 모델 추가하기

1. `src/bandpoc/detectors/<name>.py`에 `Detector` 서브클래스를 하나 만든다.
2. `src/bandpoc/detectors/__init__.py`의 `_register_all()`에 팩토리를 등록한다.
   팩토리 안에서 임포트해야 미설치 환경에서 레지스트리가 깨지지 않는다.
3. `tests/`에 스모크 테스트를 추가한다. 나머지 파이프라인은 손대지 않는다.

### 결과 읽는 법

수치는 합성 씬에서 나온 것이므로 **모델 간 상대 비교**로만 읽는다. 실제 합주
녹음을 확보하면 같은 하네스로 재검증한다 — `data/scenes/`에 wav와
`.labels.json`을 직접 넣으면 `run`/`report`가 그대로 동작한다.
```

```bash
git add poc/
git commit -m "feat(poc): wire up the fetch/build/run/report CLI"
```

---

## Self-Review

**1. 스펙 커버리지**

| 스펙 절 | 담당 태스크 |
|---|---|
| § 2 추론/후처리 분리, 캐시 경계 | 3, 5, 9, 14 |
| § 3.1 Detector 인터페이스, 100ms 격자, 청크 스트리밍 | 8 (`base.py`, `chunked_scores`), 3 (`resample_scores`) |
| § 3.2 어댑터 7종, music_only/music_group variant | 8, 10, 11, 12 |
| § 3.3 확장성 | 8 (레지스트리), 14 (README 절차) |
| § 4.1 유튜브 수집, 라우드니스 정규화 | 7 |
| § 4.2 레시피 (label/pool/take/overlay/seed) | 6 |
| § 4.3 씬 6종 | 6 (`scenes.yaml`) |
| § 4.4 라벨 6종, noodling ≠ music | 2, 6 |
| § 4.5 don't-care | 2, 4 |
| § 5 후처리 룰, 파라미터 격자 | 3, 5 |
| § 6.1 Recall / False Music / 라벨별 분해 | 4 |
| § 6.2 Boundary Error, Take Count Error, 정답 Take 정의 | 2, 4 |
| § 6.3 RTF, VRAM/RSS | 14 (`score_scene`) |
| § 6.4 Recall 제약 하 최적점 | 5 (`best_point`) |
| § 7 HTML 리포트 5개 구성요소 | 13 |
| § 8 프로젝트 구조, CLI 4개 | 1, 14 |
| § 9 테스트 전략 (don't-care 검증 포함) | 2, 3, 4, 6, 8 |
| § 10 R1 의존성 격리 | 8 (지연 임포트), 12 (numpy 확인), 14 (skip 처리) |
| § 10 R2 크로스페이드·룸톤·리포트 경고문 | 6, 13 |
| § 10 R3 체크포인트 다운로드 안내 | 10, 11 |
| § 10 R4 ffmpeg 확인 | 7, 14 |
| § 11 완료 기준 | 14 Step 4 |

누락 없음.

**2. 플레이스홀더 스캔**

TBD/TODO 없음. 모든 코드 단계에 실제 코드가 들어 있고, "적절한 에러 처리를 추가하라" 류의 지시는 없다. `sources.yaml`의 검색 쿼리는 실제 실행 가능한 값이며, 결과 검증 단계가 Task 14 Step 4에 명시되어 있다.

**3. 타입 일관성 확인**

- `Detector.music_score` 반환 `(np.ndarray, float)` — 7개 어댑터 전부 일치.
- `Detector.key` = `f"{name}:{variant}"` — 레지스트리 등록 키와 일치 (`dsp_baseline:default`, `panns_cnn14:music_group`, …).
- `PostParams(threshold, min_duration, merge_gap)` — Task 3 정의, Task 5·13에서 동일 필드명 사용.
- `FrameMasks(label_idx, is_music, is_dontcare)` — Task 2 정의, Task 4에서 동일 필드 접근.
- `SweepPoint.segments_by_scene` — Task 5에서 정의하고 Task 13 `_timeline`에서 사용. 일치.
- `SceneInput(scene_id, scores, labels)` — Task 5 정의, Task 14 `cmd_report`에서 동일 순서로 생성.
- `DetectorResult(key, available, reason, best, top_recall, points, curves, meta)` — Task 13 정의, Task 14에서 8개 인자 위치 일치.
- `cache.cache_path(root, scene_id, detector_key, version)` — Task 9 정의, Task 14에서 동일 순서.
- `best_point` 반환 `(best_or_none, top_recall)` — Task 5 정의, Task 13 테스트·Task 14에서 동일 언패킹.
