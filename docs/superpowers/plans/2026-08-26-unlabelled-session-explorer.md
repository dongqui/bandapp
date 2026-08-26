# 정답 없는 실제 세션 탐색기 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 실제 합주 녹음을 통째로 넣고 7개 모델을 돌린 뒤, 오디오를 들으며 모델별 검출 구간을 눈으로 비교해 모델과 커트라인을 고르는 HTML 도구를 만든다.

**Architecture:** 기존 파이프라인을 확장한다. `data/scenes/`의 `.labels.json`을 선택사항으로 만들면 정답 있는 합성 씬과 정답 없는 실제 세션이 한 디렉터리에 공존한다. detector 레지스트리·점수 캐시·RTF 계측은 전부 재사용하고, 새로 만드는 것은 세션 수집·자동 커트라인·탐색 HTML 세 가지다. 커트라인 탐색은 서버 없이 브라우저에서 일어난다 — 점수 곡선을 페이지에 실어두고 JS가 후처리를 다시 돌린다.

**Tech Stack:** Python 3.11, numpy, soundfile, yt-dlp, ffmpeg, 바닐라 JS (프레임워크·번들러 없음), pytest

**Spec:** `docs/superpowers/specs/2026-08-26-unlabelled-session-explorer-design.md`

## Global Constraints

- 모든 작업은 `poc/` 하위. `numpy<2` 유지. Python 3.11.
- **프레임 격자 hop은 0.1초 고정** (`bandpoc.labels.HOP`). 모든 점수 곡선은 표시 전에 이 격자로 리샘플된다.
- **후처리 비교 연산자는 전부 등호 포함:** `score >= threshold`, `gap <= merge_gap`, `duration >= min_duration`. 파이썬(`bandpoc.postproc`)과 JS 두 구현이 **정확히 같아야 한다.**
- **CLI가 출력하는 모든 문자열은 cp949로 인코딩 가능해야 한다.** 한국어 Windows 콘솔 기본 코드페이지다. em dash(`—`)는 cp949에 없다. `tests/test_cli.py::test_cli_messages_encode_on_a_cp949_console`이 이걸 강제한다.
- **`yt-dlp`는 반드시 `[sys.executable, "-m", "yt_dlp", ...]`로 호출한다.** 콘솔 스크립트는 venv를 activate해야만 PATH에 있다.
- **세션 오디오에는 라우드니스 정규화를 하지 않는다.** 실제 음량 변화는 모델이 마주할 신호의 일부다.
- `data/`와 `reports/`는 커밋하지 않는다 (`poc/.gitignore`에 이미 있음).
- 커밋 메시지는 영어, Conventional Commits.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `poc/src/bandpoc/session.py` | 통짜 녹음 수집: slug 정규화, 유튜브/로컬 → `data/scenes/<id>.wav` |
| `poc/src/bandpoc/autothresh.py` | 정답 없이 커트라인 자동 결정 (Otsu + 단봉 폴백) |
| `poc/src/bandpoc/explore.py` | 탐색 리포트: 세션별 데이터 조립, mp3 인코딩, HTML/JS 생성 |
| `poc/src/bandpoc/cli.py` | `add-session`, `explore` 서브커맨드 추가, `_scene_ids`를 wav 기준으로 |
| `poc/tests/test_session.py` | slug 규칙, 유튜브 호출 형태, 로컬 변환, 중복 거부 |
| `poc/tests/test_autothresh.py` | 이봉/단봉/이진/상수 곡선 |
| `poc/tests/test_explore.py` | HTML 생성, 임베드 데이터, mp3 캐시 |
| `poc/tests/test_cli.py` | 기존 + `add-session`/`explore` 배선, 라벨 없는 세션 처리 |

---

### Task 1: 세션 수집 — slug와 add_session

**Files:**
- Create: `poc/src/bandpoc/session.py`
- Test: `poc/tests/test_session.py`

**Interfaces:**
- Consumes: `bandpoc.audio.{WORK_SR, load_audio, save_audio}`
- Produces:
  - `bandpoc.session.slugify(text: str) -> str`
  - `bandpoc.session.derive_id(source: str) -> str`
  - `bandpoc.session.add_session(source: str, scenes_dir: str | Path, session_id: str | None = None) -> Path`
  - `bandpoc.session.SessionExists` (ValueError 서브클래스)

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_session.py`:

```python
import sys

import numpy as np
import pytest
import soundfile as sf

from bandpoc.audio import WORK_SR
from bandpoc.session import (
    SessionExists,
    add_session,
    derive_id,
    slugify,
)


def test_slugify_lowercases_and_keeps_safe_characters():
    assert slugify("Session_01-A") == "session_01-a"


def test_slugify_replaces_unsafe_characters_with_underscore():
    assert slugify("밴드 합주 (1차)") == "_"


def test_slugify_collapses_runs_of_underscores():
    assert slugify("a   b___c") == "a_b_c"


def test_slugify_trims_leading_and_trailing_underscores():
    assert slugify("  hello  ") == "hello"


def test_derive_id_uses_the_youtube_video_id():
    assert derive_id("https://www.youtube.com/watch?v=igMctbh0pT8") == "igMctbh0pT8"


def test_derive_id_handles_short_youtube_links():
    assert derive_id("https://youtu.be/igMctbh0pT8") == "igMctbh0pT8"


def test_derive_id_uses_the_filename_stem_for_local_paths():
    assert derive_id(r"C:\recordings\Practice Take 2.wav") == "practice_take_2"


def test_derive_id_rejects_a_name_that_slugifies_to_nothing(tmp_path):
    with pytest.raises(ValueError, match="--id"):
        derive_id(str(tmp_path / "밴드.wav"))


def test_add_session_converts_a_local_file_to_the_work_sample_rate(tmp_path):
    src = tmp_path / "take.wav"
    t = np.arange(8000 * 3) / 8000
    sf.write(str(src), (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), 8000)

    out = add_session(str(src), tmp_path / "scenes")

    assert out == tmp_path / "scenes" / "take.wav"
    wav, sr = sf.read(str(out), always_2d=True)
    assert sr == WORK_SR
    assert wav.shape[1] == 1
    assert len(wav) / sr == pytest.approx(3.0, abs=0.05)


def test_add_session_honours_an_explicit_id(tmp_path):
    src = tmp_path / "take.wav"
    sf.write(str(src), np.zeros(8000, dtype=np.float32), 8000)

    out = add_session(str(src), tmp_path / "scenes", session_id="session_01")

    assert out.name == "session_01.wav"


def test_add_session_refuses_to_overwrite_an_existing_session(tmp_path):
    src = tmp_path / "take.wav"
    sf.write(str(src), np.zeros(8000, dtype=np.float32), 8000)
    add_session(str(src), tmp_path / "scenes")

    with pytest.raises(SessionExists, match="take"):
        add_session(str(src), tmp_path / "scenes")


def test_add_session_does_not_normalise_loudness(tmp_path):
    """Real level changes are part of the signal the model will face."""
    src = tmp_path / "quiet.wav"
    sf.write(str(src), np.full(WORK_SR, 0.01, dtype=np.float32), WORK_SR)

    out = add_session(str(src), tmp_path / "scenes")

    wav, _ = sf.read(str(out), always_2d=True)
    assert float(np.abs(wav).max()) == pytest.approx(0.01, abs=0.002)


def test_add_session_downloads_a_youtube_url_through_the_running_interpreter(
    tmp_path, monkeypatch
):
    """The yt-dlp console script is only on PATH inside an activated venv."""
    import subprocess

    from bandpoc import session as session_mod

    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        # yt-dlp would have written this; stand in for it.
        target = tmp_path / "raw" / "igMctbh0pT8.wav"
        target.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(target), np.zeros(WORK_SR, dtype=np.float32), WORK_SR)

    monkeypatch.setattr(session_mod, "_raw_dir", lambda scenes_dir: tmp_path / "raw")
    monkeypatch.setattr(subprocess, "run", fake_run)

    out = add_session(
        "https://www.youtube.com/watch?v=igMctbh0pT8", tmp_path / "scenes"
    )

    assert out.name == "igMctbh0pT8.wav"
    assert calls[0][:3] == [sys.executable, "-m", "yt_dlp"]
    assert "yt-dlp" not in calls[0]
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_session.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'bandpoc.session'`

- [ ] **Step 3: `session.py` 구현**

`poc/src/bandpoc/session.py`:

```python
"""Whole recordings, not clips (spec § 3.1).

`bandpoc fetch` is a 30-second clip factory for building synthetic scenes.
A real rehearsal session goes in intact: the point is to see what the models
do with material nobody curated.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .audio import WORK_SR, load_audio, save_audio

_YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}


class SessionExists(ValueError):
    """Raised rather than overwriting: the score cache is keyed by session id,
    so a silent replacement would attach stale curves to new audio."""


def slugify(text: str) -> str:
    """Lowercase, keep [a-z0-9_-], collapse the rest into single underscores.

    Session ids become both file paths and cache keys, so Hangul, spaces and
    brackets must not survive into them.
    """
    lowered = str(text).strip().lower()
    replaced = re.sub(r"[^a-z0-9_-]+", "_", lowered)
    return re.sub(r"_+", "_", replaced).strip("_")


def is_url(source: str) -> bool:
    return urlparse(str(source)).scheme in {"http", "https"}


def _youtube_id(source: str) -> str | None:
    parsed = urlparse(str(source))
    if parsed.netloc not in _YOUTUBE_HOSTS:
        return None
    if parsed.netloc == "youtu.be":
        return parsed.path.lstrip("/") or None
    return (parse_qs(parsed.query).get("v") or [None])[0]


def derive_id(source: str) -> str:
    """Video id for YouTube, slugified filename stem otherwise."""
    video_id = _youtube_id(source)
    if video_id:
        return video_id
    stem = Path(str(source).replace("\\", "/")).stem
    slug = slugify(stem)
    if not slug:
        raise ValueError(
            f"cannot derive a session id from {source!r}; pass --id explicitly"
        )
    return slug


def _raw_dir(scenes_dir: str | Path) -> Path:
    return Path(scenes_dir).parent / "raw_sessions"


def _download(source: str, session_id: str, raw_dir: Path) -> Path:
    raw_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            # See fetch.py: the console script is not on PATH unless the venv
            # is activated, and bandpoc.exe does not activate it.
            sys.executable, "-m", "yt_dlp",
            "-x", "--audio-format", "wav", "--no-playlist",
            "-o", str(raw_dir / f"{session_id}.%(ext)s"), source,
        ],
        check=False,
    )
    downloaded = raw_dir / f"{session_id}.wav"
    if not downloaded.exists():
        raise RuntimeError(f"yt-dlp produced no audio for {source!r}")
    return downloaded


def add_session(
    source: str, scenes_dir: str | Path, session_id: str | None = None
) -> Path:
    """Put one whole recording under ``scenes_dir`` as ``<id>.wav``."""
    session_id = slugify(session_id) if session_id else derive_id(source)
    out = Path(scenes_dir) / f"{session_id}.wav"
    if out.exists():
        raise SessionExists(
            f"session {session_id!r} already exists at {out}; "
            "delete it or pass a different --id"
        )
    src = (
        _download(source, session_id, _raw_dir(scenes_dir))
        if is_url(source)
        else Path(source)
    )
    wav, _ = load_audio(src, target_sr=WORK_SR)
    save_audio(out, wav, WORK_SR)
    return out
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_session.py -v
```

Expected: 12 passed

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/session.py poc/tests/test_session.py
git commit -m "feat(poc): collect whole recordings as sessions"
```

---

### Task 2: 라벨을 선택사항으로

**Files:**
- Modify: `poc/src/bandpoc/cli.py` (`_scene_ids`, `cmd_report`)
- Test: `poc/tests/test_cli.py`

**Interfaces:**
- Consumes: 없음 (기존 코드 수정)
- Produces:
  - `bandpoc.cli._scene_ids(data_dir: Path, requested: str) -> list[str]` — `*.wav` 기준으로 스캔
  - `bandpoc.cli._labelled_ids(data_dir: Path, scene_ids: list[str]) -> list[str]` — `.labels.json`이 있는 것만

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_cli.py` 끝에 추가:

```python
def write_session(root, session_id="session_01", seconds=4.0):
    """A wav with no labels.json beside it."""
    scenes = root / "scenes"
    scenes.mkdir(parents=True, exist_ok=True)
    t = np.arange(int(WORK_SR * seconds)) / WORK_SR
    sf.write(str(scenes / f"{session_id}.wav"),
             (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), WORK_SR)


def test_scene_ids_finds_a_wav_without_labels(tmp_path):
    from bandpoc.cli import _scene_ids

    write_session(tmp_path)
    assert _scene_ids(tmp_path, "all") == ["session_01"]


def test_scene_ids_lists_labelled_and_unlabelled_together(tmp_path):
    from bandpoc.cli import _scene_ids

    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])
    write_session(tmp_path)

    assert _scene_ids(tmp_path, "all") == ["session_01", "tiny"]


def test_labelled_ids_keeps_only_scenes_with_a_labels_file(tmp_path):
    from bandpoc.cli import _labelled_ids, _scene_ids

    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])
    write_session(tmp_path)

    assert _labelled_ids(tmp_path, _scene_ids(tmp_path, "all")) == ["tiny"]


def test_run_scores_a_session_that_has_no_labels(tmp_path):
    write_session(tmp_path)

    assert main(["run", "--data-dir", str(tmp_path),
                 "--detectors", "dsp_baseline:default"]) == 0
    assert len(list((tmp_path / "cache").glob("*.npz"))) == 1


def test_report_skips_unlabelled_sessions_instead_of_failing(tmp_path, capsys):
    write_pools(tmp_path / "clips")
    write_recipes(tmp_path / "scenes.yaml")
    main(["build-scenes", "--data-dir", str(tmp_path),
          "--recipes", str(tmp_path / "scenes.yaml")])
    write_session(tmp_path)
    main(["run", "--data-dir", str(tmp_path), "--detectors", "dsp_baseline:default"])

    assert main(["report", "--data-dir", str(tmp_path),
                 "--out-dir", str(tmp_path / "reports")]) == 0
    pages = list((tmp_path / "reports").rglob("index.html"))
    assert "session_01" not in pages[0].read_text(encoding="utf-8")


def test_report_says_so_when_every_scene_is_unlabelled(tmp_path, capsys):
    write_session(tmp_path)
    main(["run", "--data-dir", str(tmp_path), "--detectors", "dsp_baseline:default"])

    assert main(["report", "--data-dir", str(tmp_path),
                 "--out-dir", str(tmp_path / "reports")]) == 1
    assert "bandpoc explore" in capsys.readouterr().out
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_cli.py -v -k "scene_ids or labelled or session"
```

Expected: FAIL — `_scene_ids`가 `.labels.json`을 스캔하므로 `[]`를 반환하고, `_labelled_ids`는 존재하지 않는다

- [ ] **Step 3: `cli.py` 수정**

`_scene_ids`를 다음으로 **교체**한다:

```python
def _scene_ids(data_dir: Path, requested: str) -> list[str]:
    """Every wav under scenes/, labelled or not.

    A session with no labels.json is still something `run` can score; only
    `report` needs the ground truth.
    """
    available = sorted(p.stem for p in (data_dir / "scenes").glob("*.wav"))
    if requested == "all":
        return available
    return [s for s in requested.split(",") if s in available]


def _labelled_ids(data_dir: Path, scene_ids: list[str]) -> list[str]:
    return [
        sid for sid in scene_ids
        if (data_dir / "scenes" / f"{sid}.labels.json").exists()
    ]
```

`cmd_report`의 `scenes` 딕셔너리 생성 부분을 다음으로 **교체**한다 (기존:
`scene_ids = _scene_ids(...)` 다음의 `scenes = {...}` 와 그 뒤 `if not scenes:` 블록):

```python
    scene_ids = _labelled_ids(data_dir, _scene_ids(data_dir, args.scenes))
    scenes = {
        sid: SceneLabels.from_json(data_dir / "scenes" / f"{sid}.labels.json")
        for sid in scene_ids
    }
    if not scenes:
        print(
            f"no labelled scenes under {data_dir / 'scenes'}; "
            "run `bandpoc build-scenes`, or use `bandpoc explore` for sessions "
            "that have no ground truth"
        )
        return 1
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_cli.py -v
```

Expected: 전부 통과 (기존 8개 + 신규 6개 = 14개). 특히
`test_report_produces_html_from_the_cache`와
`test_report_without_any_cache_fails_with_a_clear_message`가 여전히 통과해야 한다 —
합성 씬 경로가 깨지지 않았다는 뜻이다.

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/cli.py poc/tests/test_cli.py
git commit -m "feat(poc): make ground-truth labels optional"
```

---

### Task 3: 자동 커트라인

**Files:**
- Create: `poc/src/bandpoc/autothresh.py`
- Test: `poc/tests/test_autothresh.py`

**Interfaces:**
- Consumes: 없음 (numpy만)
- Produces:
  - `bandpoc.autothresh.AutoThreshold` — `dataclass(value: float, reason: str, separated: bool)`
  - `bandpoc.autothresh.auto_threshold(scores: np.ndarray) -> AutoThreshold`
  - `bandpoc.autothresh.FALLBACK = 0.5`

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_autothresh.py`:

```python
import numpy as np
import pytest

from bandpoc.autothresh import FALLBACK, auto_threshold


def bimodal(low=0.1, high=0.9, n=500):
    return np.concatenate([np.full(n, low), np.full(n, high)]).astype(np.float32)


def test_bimodal_scores_get_a_threshold_between_the_two_modes():
    result = auto_threshold(bimodal())
    assert 0.1 < result.value < 0.9
    assert result.separated is True


def test_a_noisy_bimodal_curve_still_separates():
    rng = np.random.default_rng(0)
    quiet = rng.normal(0.15, 0.05, 800)
    loud = rng.normal(0.85, 0.05, 800)
    result = auto_threshold(np.clip(np.concatenate([quiet, loud]), 0, 1).astype(np.float32))
    assert 0.3 < result.value < 0.7
    assert result.separated is True


def test_a_constant_curve_falls_back_and_says_why():
    result = auto_threshold(np.full(500, 0.8, dtype=np.float32))
    assert result.value == FALLBACK
    assert result.separated is False
    assert "separate" in result.reason


def test_a_unimodal_curve_falls_back():
    rng = np.random.default_rng(1)
    scores = np.clip(rng.normal(0.5, 0.02, 1000), 0, 1).astype(np.float32)
    result = auto_threshold(scores)
    assert result.value == FALLBACK
    assert result.separated is False


def test_a_binary_curve_lands_between_zero_and_one():
    scores = np.array([0.0] * 300 + [1.0] * 300, dtype=np.float32)
    result = auto_threshold(scores)
    assert 0.0 < result.value < 1.0
    assert result.separated is True


def test_an_empty_curve_falls_back_without_raising():
    result = auto_threshold(np.zeros(0, dtype=np.float32))
    assert result.value == FALLBACK
    assert result.separated is False


def test_the_reason_string_is_ascii_for_a_cp949_console():
    for scores in (bimodal(), np.full(100, 0.3, dtype=np.float32)):
        auto_threshold(scores).reason.encode("cp949")


def test_the_threshold_is_reported_to_two_decimals():
    value = auto_threshold(bimodal()).value
    assert value == pytest.approx(round(value, 2))
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_autothresh.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'bandpoc.autothresh'`

- [ ] **Step 3: `autothresh.py` 구현**

`poc/src/bandpoc/autothresh.py`:

```python
"""Pick a cutoff without ground truth (spec § 3.2).

Models disagree on scale: one reports 0.95 over a rehearsal take, another 0.55
over the same audio. A single fixed cutoff would punish the second one for
nothing. Otsu's method finds the valley between the two humps of whatever
distribution a model actually produced, which needs no labels.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

FALLBACK = 0.5
_BINS = 256
# Between-class variance below this means the histogram is one hump, not two.
# Calibrated so a normal(0.5, 0.02) blob stays under it while two separated
# clusters clear it by an order of magnitude.
_MIN_SEPARATION = 0.005


@dataclass(frozen=True)
class AutoThreshold:
    value: float
    reason: str
    separated: bool


def auto_threshold(scores: np.ndarray) -> AutoThreshold:
    scores = np.asarray(scores, dtype=np.float64).ravel()
    if scores.size == 0:
        return AutoThreshold(FALLBACK, "empty curve; cannot separate", False)

    counts, edges = np.histogram(scores, bins=_BINS, range=(0.0, 1.0))
    weight = counts / counts.sum()
    centres = (edges[:-1] + edges[1:]) / 2.0

    # Otsu: maximise between-class variance over every split point.
    w0 = np.cumsum(weight)
    w1 = 1.0 - w0
    mean_total = float((weight * centres).sum())
    mean0 = np.cumsum(weight * centres)
    with np.errstate(divide="ignore", invalid="ignore"):
        between = (mean_total * w0 - mean0) ** 2 / (w0 * w1)
    between = np.nan_to_num(between, nan=0.0, posinf=0.0, neginf=0.0)

    best = int(np.argmax(between))
    separation = float(between[best])
    if separation < _MIN_SEPARATION:
        return AutoThreshold(
            FALLBACK,
            f"scores do not separate into two groups (spread {separation:.4f}); "
            f"using {FALLBACK}",
            False,
        )
    value = round(float(edges[best + 1]), 2)
    return AutoThreshold(value, f"Otsu split (spread {separation:.4f})", True)
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_autothresh.py -v
```

Expected: 8 passed

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/autothresh.py poc/tests/test_autothresh.py
git commit -m "feat(poc): pick a per-model cutoff without ground truth"
```

---

### Task 4: 탐색 데이터 조립과 mp3 캐시

**Files:**
- Create: `poc/src/bandpoc/explore.py`
- Test: `poc/tests/test_explore.py`

**Interfaces:**
- Consumes: `bandpoc.cache.{cache_path, load}`, `bandpoc.postproc.{PostParams, resample_scores, scores_to_segments}`, `bandpoc.labels.HOP`, `bandpoc.autothresh.auto_threshold`, `bandpoc.registry`
- Produces:
  - `bandpoc.explore.ModelView` — `dataclass(key, scores: list[float], threshold: float, reason: str, separated: bool, segments: list[tuple[float, float]], meta: dict)`
  - `bandpoc.explore.SessionView` — `dataclass(session_id: str, duration: float, models: list[ModelView])`
  - `bandpoc.explore.DEFAULTS: PostParams`
  - `bandpoc.explore.collect_session(data_dir, session_id, keys) -> SessionView`
  - `bandpoc.explore.encode_mp3(wav_path, mp3_path) -> Path`

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_explore.py`:

```python
import numpy as np
import pytest
import soundfile as sf

from bandpoc import cache
from bandpoc.audio import WORK_SR
from bandpoc.explore import (
    DEFAULTS,
    collect_session,
    encode_mp3,
)


def write_session_wav(data_dir, session_id="s", seconds=120.0):
    scenes = data_dir / "scenes"
    scenes.mkdir(parents=True, exist_ok=True)
    path = scenes / f"{session_id}.wav"
    t = np.arange(int(WORK_SR * seconds)) / WORK_SR
    sf.write(str(path), (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), WORK_SR)
    return path


def cache_curve(data_dir, session_id, key, curve, hop=0.1, version="1"):
    cache.save(
        cache.cache_path(data_dir / "cache", session_id, key, version),
        np.asarray(curve, dtype=np.float32),
        hop,
        {"rtf": 0.01, "detector_version": version},
    )


def square_curve(n=1200):
    """Half quiet, half loud - two clear modes 60 s apart at 0.1 s hop."""
    return np.concatenate([np.full(n // 2, 0.05), np.full(n // 2, 0.95)]).astype(
        np.float32
    )


def test_collect_session_returns_one_model_view_per_cached_detector(tmp_path):
    write_session_wav(tmp_path)
    cache_curve(tmp_path, "s", "dsp_baseline:default", square_curve())

    view = collect_session(tmp_path, "s", ["dsp_baseline:default"])

    assert view.session_id == "s"
    assert view.duration == pytest.approx(120.0, abs=0.2)
    assert [m.key for m in view.models] == ["dsp_baseline:default"]


def test_collect_session_skips_detectors_with_no_cached_scores(tmp_path):
    write_session_wav(tmp_path)
    cache_curve(tmp_path, "s", "dsp_baseline:default", square_curve())

    view = collect_session(
        tmp_path, "s", ["dsp_baseline:default", "yamnet:music_group"]
    )

    assert [m.key for m in view.models] == ["dsp_baseline:default"]


def test_scores_are_resampled_onto_the_evaluation_grid(tmp_path):
    write_session_wav(tmp_path, seconds=100.0)
    # 1 s hop: a tenth of the frames the 0.1 s grid needs.
    cache_curve(tmp_path, "s", "dsp_baseline:default",
                np.linspace(0, 1, 100, dtype=np.float32), hop=1.0)

    view = collect_session(tmp_path, "s", ["dsp_baseline:default"])

    assert len(view.models[0].scores) == pytest.approx(1000, abs=2)


def test_a_separating_curve_gets_an_automatic_threshold(tmp_path):
    write_session_wav(tmp_path)
    cache_curve(tmp_path, "s", "dsp_baseline:default", square_curve())

    model = collect_session(tmp_path, "s", ["dsp_baseline:default"]).models[0]

    assert 0.05 < model.threshold < 0.95
    assert model.separated is True


def test_segments_use_the_automatic_threshold(tmp_path):
    write_session_wav(tmp_path)
    cache_curve(tmp_path, "s", "dsp_baseline:default", square_curve())

    model = collect_session(tmp_path, "s", ["dsp_baseline:default"]).models[0]

    assert len(model.segments) == 1
    start, end = model.segments[0]
    assert start == pytest.approx(60.0, abs=0.5)
    assert end == pytest.approx(120.0, abs=0.5)


def test_models_are_sorted_by_take_count_ascending(tmp_path):
    write_session_wav(tmp_path)
    cache_curve(tmp_path, "s", "dsp_baseline:default", square_curve())
    # Three separated bursts, each well over the 20 s minimum.
    busy = np.zeros(1200, dtype=np.float32)
    for lo in (0, 400, 800):
        busy[lo : lo + 300] = 0.95
    cache_curve(tmp_path, "s", "silero_vad:default", busy)

    view = collect_session(
        tmp_path, "s", ["silero_vad:default", "dsp_baseline:default"]
    )

    counts = [len(m.segments) for m in view.models]
    assert counts == sorted(counts)


def test_scores_are_rounded_to_keep_the_page_small(tmp_path):
    write_session_wav(tmp_path)
    cache_curve(tmp_path, "s", "dsp_baseline:default",
                np.full(1200, 0.123456, dtype=np.float32))

    model = collect_session(tmp_path, "s", ["dsp_baseline:default"]).models[0]

    assert model.scores[0] == pytest.approx(0.12, abs=1e-9)


def test_defaults_match_the_post_processing_spec():
    assert DEFAULTS.min_duration == 20.0
    assert DEFAULTS.merge_gap == 10.0


def test_encode_mp3_writes_a_file_and_reuses_it(tmp_path):
    wav = write_session_wav(tmp_path, seconds=2.0)
    mp3 = tmp_path / "s.mp3"

    encode_mp3(wav, mp3)
    assert mp3.exists()
    first = mp3.stat().st_mtime_ns

    encode_mp3(wav, mp3)
    assert mp3.stat().st_mtime_ns == first, "an up-to-date mp3 must not be re-encoded"


def test_encode_mp3_re_encodes_when_the_wav_is_newer(tmp_path):
    import os
    import time

    wav = write_session_wav(tmp_path, seconds=2.0)
    mp3 = tmp_path / "s.mp3"
    encode_mp3(wav, mp3)
    first = mp3.stat().st_mtime_ns

    time.sleep(0.01)
    os.utime(wav, None)
    encode_mp3(wav, mp3)

    assert mp3.stat().st_mtime_ns != first
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_explore.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'bandpoc.explore'`

- [ ] **Step 3: `explore.py` 구현 (데이터 부분)**

`poc/src/bandpoc/explore.py`:

```python
"""Explore model output on a recording with no ground truth (spec § 3.3).

Nothing here scores anything. It assembles what a human needs to judge:
the score curve, a starting cutoff, and the segments that cutoff produces.
The actual comparison happens in a browser, against the audio.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import cache, registry
from .audio import load_audio
from .autothresh import auto_threshold
from .labels import HOP
from .postproc import PostParams, resample_scores, scores_to_segments

DEFAULTS = PostParams(threshold=0.5, min_duration=20.0, merge_gap=10.0)
"""min_duration and merge_gap follow the post-processing spec; threshold is
per-model and comes from autothresh."""

_SCORE_DECIMALS = 2
"""0.01 resolution on a 0-1 curve is finer than a screen pixel and roughly
halves the page size against full float repr."""


@dataclass(frozen=True)
class ModelView:
    key: str
    scores: list[float]
    threshold: float
    reason: str
    separated: bool
    segments: list[tuple[float, float]]
    meta: dict = field(default_factory=dict)


@dataclass(frozen=True)
class SessionView:
    session_id: str
    duration: float
    models: list[ModelView]


def _detector_version(key: str) -> str:
    try:
        return registry.get(key).version
    except (KeyError, ImportError):
        return "1"


def collect_session(
    data_dir: str | Path, session_id: str, keys: list[str]
) -> SessionView:
    """Gather every cached curve for one session, ready for rendering."""
    data_dir = Path(data_dir)
    wav, sr = load_audio(data_dir / "scenes" / f"{session_id}.wav")
    duration = len(wav) / sr
    n_frames = int(np.floor(round(duration / HOP, 6)))

    models: list[ModelView] = []
    for key in keys:
        path = cache.cache_path(
            data_dir / "cache", session_id, key, _detector_version(key)
        )
        if not path.exists():
            continue
        cached = cache.load(path)
        curve = resample_scores(cached.scores, cached.hop, n_frames, HOP)
        chosen = auto_threshold(curve)
        params = PostParams(
            threshold=chosen.value,
            min_duration=DEFAULTS.min_duration,
            merge_gap=DEFAULTS.merge_gap,
        )
        models.append(
            ModelView(
                key=key,
                scores=[round(float(v), _SCORE_DECIMALS) for v in curve],
                threshold=chosen.value,
                reason=chosen.reason,
                separated=chosen.separated,
                segments=[
                    (s.start, s.end) for s in scores_to_segments(curve, HOP, params)
                ],
                meta=cached.meta,
            )
        )

    # Ascending take count: whichever model over-detects sinks to the bottom
    # where it is obvious. Fixed at load time - see the renderer.
    models.sort(key=lambda m: (len(m.segments), m.key))
    return SessionView(session_id=session_id, duration=duration, models=models)


def encode_mp3(wav_path: str | Path, mp3_path: str | Path) -> Path:
    """Encode once and keep it: a report folder is timestamped, so caching the
    mp3 beside the report would re-encode a 47-minute file every run."""
    wav_path, mp3_path = Path(wav_path), Path(mp3_path)
    if mp3_path.exists() and mp3_path.stat().st_mtime_ns >= wav_path.stat().st_mtime_ns:
        return mp3_path
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH. Install it: winget install Gyan.FFmpeg")
    mp3_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path),
         "-ac", "1", "-b:a", "128k", str(mp3_path)],
        check=True,
    )
    return mp3_path
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_explore.py -v
```

Expected: 11 passed. ffmpeg가 PATH에 없으면 `encode_mp3` 테스트 2개가 RuntimeError로
실패한다 — 새 터미널을 열거나 `winget install Gyan.FFmpeg` 후 재시도한다.

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/explore.py poc/tests/test_explore.py
git commit -m "feat(poc): assemble per-session model views for exploration"
```

---

### Task 5: 탐색 HTML과 브라우저 후처리

**Files:**
- Modify: `poc/src/bandpoc/explore.py` (렌더링 함수 추가)
- Test: `poc/tests/test_explore.py` (추가)

**Interfaces:**
- Consumes: Task 4의 `SessionView`, `ModelView`, `DEFAULTS`, `encode_mp3`
- Produces:
  - `bandpoc.explore.render_session(view: SessionView, mp3_name: str, out_dir: str | Path) -> Path`
  - `bandpoc.explore.render_index(views: list[SessionView], out_dir: str | Path) -> Path`

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_explore.py` 끝에 추가:

```python
import json
import re

from bandpoc.explore import render_index, render_session


def built_view(tmp_path, session_id="s"):
    write_session_wav(tmp_path, session_id)
    cache_curve(tmp_path, session_id, "dsp_baseline:default", square_curve())
    return collect_session(tmp_path, session_id, ["dsp_baseline:default"])


def embedded_payload(html):
    match = re.search(r'<script id="session-data" type="application/json">(.*?)</script>',
                      html, re.S)
    assert match, "session data must be embedded as JSON"
    return json.loads(match.group(1))


def test_render_session_writes_a_page_named_after_the_session(tmp_path):
    view = built_view(tmp_path)
    out = render_session(view, "s.mp3", tmp_path / "out")
    assert out == tmp_path / "out" / "s.html"
    assert out.exists()


def test_the_page_references_the_mp3_relatively(tmp_path):
    html = render_session(built_view(tmp_path), "s.mp3", tmp_path / "out").read_text(
        encoding="utf-8"
    )
    assert '<audio' in html
    assert 'src="s.mp3"' in html


def test_the_page_names_every_model(tmp_path):
    html = render_session(built_view(tmp_path), "s.mp3", tmp_path / "out").read_text(
        encoding="utf-8"
    )
    assert "dsp_baseline:default" in html


def test_the_page_embeds_scores_and_the_python_reference_segments(tmp_path):
    view = built_view(tmp_path)
    html = render_session(view, "s.mp3", tmp_path / "out").read_text(encoding="utf-8")

    payload = embedded_payload(html)
    model = payload["models"][0]
    assert len(model["scores"]) == len(view.models[0].scores)
    assert model["threshold"] == view.models[0].threshold
    # The cross-check baseline for the JS reimplementation (spec § 5 R1).
    assert model["reference"] == [list(s) for s in view.models[0].segments]


def test_the_page_carries_the_post_processing_defaults(tmp_path):
    payload = embedded_payload(
        render_session(built_view(tmp_path), "s.mp3", tmp_path / "out").read_text(
            encoding="utf-8"
        )
    )
    assert payload["minDuration"] == 20.0
    assert payload["mergeGap"] == 10.0
    assert payload["hop"] == 0.1


def test_a_model_that_could_not_separate_is_flagged_in_the_page(tmp_path):
    write_session_wav(tmp_path, "flat")
    cache_curve(tmp_path, "flat", "dsp_baseline:default",
                np.full(1200, 0.4, dtype=np.float32))
    view = collect_session(tmp_path, "flat", ["dsp_baseline:default"])

    html = render_session(view, "flat.mp3", tmp_path / "out").read_text(encoding="utf-8")

    assert "do not separate" in html


def test_the_page_has_no_external_requests(tmp_path):
    html = render_session(built_view(tmp_path), "s.mp3", tmp_path / "out").read_text(
        encoding="utf-8"
    )
    assert "http://" not in html
    assert "https://" not in html


def test_render_index_lists_every_session(tmp_path):
    views = [built_view(tmp_path, "one"), built_view(tmp_path, "two")]
    out = render_index(views, tmp_path / "out")
    html = out.read_text(encoding="utf-8")

    assert out.name == "index.html"
    assert 'href="one.html"' in html
    assert 'href="two.html"' in html
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_explore.py -v -k "render or page or embed"
```

Expected: FAIL — `ImportError: cannot import name 'render_session' from 'bandpoc.explore'`

- [ ] **Step 3: 렌더링 구현**

`poc/src/bandpoc/explore.py` 상단 import에 `html`과 `json`을 추가한다:

```python
import html as html_mod
import json
```

파일 끝에 다음을 추가한다:

```python
_CSS = """
:root{color-scheme:light}
body{font-family:system-ui,'Segoe UI','Malgun Gothic',sans-serif;margin:0;
     padding:1.5rem;background:#fafafa;color:#1a1a1a}
h1{font-size:1.3rem;margin:0 0 1rem}
a{color:#1565c0}
audio{width:100%;margin-bottom:1rem}
.controls{background:#fff;border:1px solid #e0e0e0;padding:.6rem .9rem;
          margin-bottom:1rem;display:flex;gap:1.5rem;align-items:center;
          flex-wrap:wrap;font-size:.85rem}
.controls input[type=number]{width:5rem}
.model{background:#fff;border:1px solid #e0e0e0;margin-bottom:.9rem;padding:.6rem .9rem}
.model header{display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
.key{font-weight:600;font-size:.9rem;min-width:16rem}
.count{font-size:.85rem;color:#555}
.flag{color:#c62828;font-size:.78rem}
canvas{width:100%;height:64px;display:block;margin-top:.4rem;cursor:pointer}
.segs{font-size:.75rem;color:#555;margin-top:.3rem;
      font-family:ui-monospace,Consolas,monospace;word-break:break-all}
.banner{background:#c62828;color:#fff;padding:.7rem 1rem;margin-bottom:1rem;
        font-weight:600;display:none}
"""

_JS = """
const DATA = JSON.parse(document.getElementById('session-data').textContent);
const audio = document.getElementById('player');

// Mirror of bandpoc.postproc.scores_to_segments. Every comparison keeps its
// equality exactly as the Python does: >= threshold, <= merge_gap,
// >= min_duration. The reference cross-check below guards this.
function toSegments(scores, hop, threshold, mergeGap, minDuration) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < scores.length; i++) {
    const on = scores[i] >= threshold;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { runs.push([start * hop, i * hop]); start = -1; }
  }
  if (start >= 0) runs.push([start * hop, scores.length * hop]);

  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run[0] - last[1] <= mergeGap + 1e-9) last[1] = run[1];
    else merged.push([run[0], run[1]]);
  }
  return merged.filter(s => s[1] - s[0] >= minDuration - 1e-9);
}

function mmss(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function sameSegments(a, b) {
  if (a.length !== b.length) return false;
  return a.every((s, i) =>
    Math.abs(s[0] - b[i][0]) < 1e-6 && Math.abs(s[1] - b[i][1]) < 1e-6);
}

const rows = DATA.models.map((model, index) => {
  const canvas = document.getElementById('canvas-' + index);
  const slider = document.getElementById('thresh-' + index);
  const readout = document.getElementById('value-' + index);
  const count = document.getElementById('count-' + index);
  const list = document.getElementById('segs-' + index);
  return { model, canvas, slider, readout, count, list, segments: [] };
});

function draw(row) {
  const { canvas, model, segments } = row;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const perSecond = width / DATA.duration;

  ctx.fillStyle = 'rgba(46,125,50,0.20)';
  for (const [start, end] of segments) {
    ctx.fillRect(start * perSecond, 0, Math.max(1, (end - start) * perSecond), height);
  }

  ctx.strokeStyle = '#1565c0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(model.scores.length / width));
  for (let i = 0; i < model.scores.length; i += step) {
    const x = (i * DATA.hop) * perSecond;
    const y = height - model.scores[i] * height;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.strokeStyle = '#999';
  ctx.setLineDash([4, 3]);
  const cut = height - parseFloat(row.slider.value) * height;
  ctx.beginPath(); ctx.moveTo(0, cut); ctx.lineTo(width, cut); ctx.stroke();
  ctx.setLineDash([]);

  const playhead = audio.currentTime * perSecond;
  ctx.strokeStyle = '#c62828';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(playhead, 0); ctx.lineTo(playhead, height); ctx.stroke();
}

function recompute(row) {
  const minDuration = parseFloat(document.getElementById('min-duration').value);
  const mergeGap = parseFloat(document.getElementById('merge-gap').value);
  row.segments = toSegments(
    row.model.scores, DATA.hop, parseFloat(row.slider.value), mergeGap, minDuration);
  row.readout.textContent = parseFloat(row.slider.value).toFixed(2);
  row.count.textContent = row.segments.length + ' takes';
  row.list.textContent = row.segments
    .map(s => mmss(s[0]) + '-' + mmss(s[1])).join(' · ');
  draw(row);
}

for (const row of rows) {
  row.slider.addEventListener('input', () => recompute(row));
  row.canvas.addEventListener('click', event => {
    const box = row.canvas.getBoundingClientRect();
    audio.currentTime = ((event.clientX - box.left) / box.width) * DATA.duration;
    audio.play();
  });
}
for (const id of ['min-duration', 'merge-gap']) {
  document.getElementById(id).addEventListener('input',
    () => rows.forEach(recompute));
}
audio.addEventListener('timeupdate', () => rows.forEach(draw));
window.addEventListener('resize', () => rows.forEach(draw));

rows.forEach(recompute);

// Spec § 5 R1: two implementations of the same post-processing will drift.
// Compare against what Python computed at the same parameters and say so
// loudly rather than showing a quietly wrong picture.
const drifted = rows.filter(row => !sameSegments(
  toSegments(row.model.scores, DATA.hop, row.model.threshold,
             DATA.mergeGap, DATA.minDuration),
  row.model.reference));
if (drifted.length) {
  const banner = document.getElementById('drift');
  banner.textContent =
    'WARNING: browser post-processing disagrees with Python for ' +
    drifted.map(r => r.model.key).join(', ') +
    '. The timelines below cannot be trusted.';
  banner.style.display = 'block';
}
"""


def _model_block(index: int, model: ModelView) -> str:
    flag = (
        f"<span class='flag'>{html_mod.escape(model.reason)}</span>"
        if not model.separated
        else ""
    )
    return f"""<section class='model'>
  <header>
    <span class='key'>{html_mod.escape(model.key)}</span>
    <label>cutoff <input type='range' id='thresh-{index}' min='0' max='1'
      step='0.01' value='{model.threshold}'></label>
    <span id='value-{index}'>{model.threshold:.2f}</span>
    <span class='count' id='count-{index}'></span>
    {flag}
  </header>
  <canvas id='canvas-{index}'></canvas>
  <div class='segs' id='segs-{index}'></div>
</section>"""


def render_session(view: SessionView, mp3_name: str, out_dir: str | Path) -> Path:
    payload = {
        "sessionId": view.session_id,
        "duration": view.duration,
        "hop": HOP,
        "minDuration": DEFAULTS.min_duration,
        "mergeGap": DEFAULTS.merge_gap,
        "models": [
            {
                "key": m.key,
                "scores": m.scores,
                "threshold": m.threshold,
                "reason": m.reason,
                "separated": m.separated,
                "reference": [list(s) for s in m.segments],
            }
            for m in view.models
        ],
    }
    blocks = "\n".join(_model_block(i, m) for i, m in enumerate(view.models))
    page = f"""<!doctype html><html lang='ko'><head><meta charset='utf-8'>
<title>{html_mod.escape(view.session_id)} - 모델 비교</title>
<style>{_CSS}</style></head><body>
<h1>{html_mod.escape(view.session_id)} · {view.duration / 60:.1f} min</h1>
<div class='banner' id='drift'></div>
<audio id='player' controls src="{html_mod.escape(mp3_name)}"></audio>
<div class='controls'>
  <label>min duration <input type='number' id='min-duration'
    value='{DEFAULTS.min_duration}' min='0' step='1'> s</label>
  <label>merge gap <input type='number' id='merge-gap'
    value='{DEFAULTS.merge_gap}' min='0' step='1'> s</label>
  <span>타임라인을 클릭하면 그 시점부터 재생된다.</span>
</div>
{blocks}
<script id='session-data' type='application/json'>{json.dumps(payload)}</script>
<script>{_JS}</script>
</body></html>"""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{view.session_id}.html"
    path.write_text(page, encoding="utf-8")
    return path


def render_index(views: list[SessionView], out_dir: str | Path) -> Path:
    rows = "\n".join(
        f"<li><a href='{html_mod.escape(v.session_id)}.html'>"
        f"{html_mod.escape(v.session_id)}</a> — {v.duration / 60:.1f} min, "
        f"{len(v.models)} models</li>"
        for v in views
    )
    page = f"""<!doctype html><html lang='ko'><head><meta charset='utf-8'>
<title>세션 탐색</title><style>{_CSS}</style></head><body>
<h1>세션 탐색</h1>
<p>정답 라벨이 없는 실제 녹음이다. 오디오를 들으며 모델별 검출 구간을 직접 비교한다.</p>
<ul>{rows}</ul>
</body></html>"""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "index.html"
    path.write_text(page, encoding="utf-8")
    return path
```

주의: `render_session`은 `href`에 `session_id`를 그대로 쓴다. Task 1의 slug
정규화가 `[a-z0-9_-]`만 남기므로 경로 주입이나 인코딩 문제가 생기지 않는다.

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_explore.py -v
```

Expected: 19 passed

- [ ] **Step 5: 커밋**

```bash
git add poc/src/bandpoc/explore.py poc/tests/test_explore.py
git commit -m "feat(poc): render the interactive session explorer page"
```

---

### Task 6: CLI 배선과 엔드투엔드

**Files:**
- Modify: `poc/src/bandpoc/cli.py`, `poc/README.md`
- Test: `poc/tests/test_cli.py`

**Interfaces:**
- Consumes: Task 1의 `add_session`, Task 4-5의 `collect_session`/`encode_mp3`/`render_session`/`render_index`
- Produces: `bandpoc add-session`, `bandpoc explore` 서브커맨드

- [ ] **Step 1: 실패하는 테스트 작성**

`poc/tests/test_cli.py` 끝에 추가:

```python
def test_add_session_command_imports_a_local_file(tmp_path):
    src = tmp_path / "take.wav"
    t = np.arange(WORK_SR * 2) / WORK_SR
    sf.write(str(src), (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), WORK_SR)

    code = main(["add-session", str(src), "--data-dir", str(tmp_path),
                 "--id", "session_01"])

    assert code == 0
    assert (tmp_path / "scenes" / "session_01.wav").exists()


def test_add_session_reports_a_duplicate_without_a_traceback(tmp_path, capsys):
    src = tmp_path / "take.wav"
    sf.write(str(src), np.zeros(WORK_SR, dtype=np.float32), WORK_SR)
    main(["add-session", str(src), "--data-dir", str(tmp_path), "--id", "s"])

    assert main(["add-session", str(src), "--data-dir", str(tmp_path),
                 "--id", "s"]) == 1
    assert "already exists" in capsys.readouterr().out


def test_explore_builds_a_page_per_session_plus_an_index(tmp_path):
    src = tmp_path / "take.wav"
    t = np.arange(WORK_SR * 60) / WORK_SR
    sf.write(str(src), (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), WORK_SR)
    main(["add-session", str(src), "--data-dir", str(tmp_path), "--id", "s"])
    main(["run", "--data-dir", str(tmp_path), "--detectors", "dsp_baseline:default"])

    code = main(["explore", "--data-dir", str(tmp_path),
                 "--out-dir", str(tmp_path / "reports")])

    assert code == 0
    pages = sorted(p.name for p in (tmp_path / "reports").rglob("*.html"))
    assert pages == ["index.html", "s.html"]
    assert list((tmp_path / "reports").rglob("s.mp3"))


def test_explore_without_any_cached_scores_fails_clearly(tmp_path, capsys):
    src = tmp_path / "take.wav"
    sf.write(str(src), np.zeros(WORK_SR * 2, dtype=np.float32), WORK_SR)
    main(["add-session", str(src), "--data-dir", str(tmp_path), "--id", "s"])

    assert main(["explore", "--data-dir", str(tmp_path),
                 "--out-dir", str(tmp_path / "reports")]) == 1
    assert "bandpoc run" in capsys.readouterr().out
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd poc && .venv/Scripts/python.exe -m pytest tests/test_cli.py -v -k "add_session or explore"
```

Expected: FAIL — argparse가 `invalid choice: 'add-session'`으로 SystemExit

- [ ] **Step 3: `cli.py`에 두 명령 추가**

import 블록에 추가:

```python
from .explore import collect_session, encode_mp3, render_index, render_session
from .session import SessionExists, add_session
```

`cmd_report` 다음에 두 함수를 추가한다:

```python
def cmd_add_session(args) -> int:
    data_dir = Path(args.data_dir)
    try:
        path = add_session(args.source, data_dir / "scenes", session_id=args.id)
    except (SessionExists, ValueError, RuntimeError) as exc:
        print(f"[fail] {exc}")
        return 1
    wav, sr = load_audio(path)
    print(f"{path.stem}: {len(wav) / sr / 60:.1f} min -> {path}")
    print("next: bandpoc run   (then: bandpoc explore)")
    return 0


def cmd_explore(args) -> int:
    data_dir = Path(args.data_dir)
    scene_ids = _scene_ids(data_dir, args.scenes)
    if not scene_ids:
        print(f"no recordings under {data_dir / 'scenes'}; run `bandpoc add-session` first")
        return 1
    keys = registry.all_keys() if args.detectors == "all" else args.detectors.split(",")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_dir = Path(args.out_dir) / stamp
    views = []
    for scene_id in scene_ids:
        view = collect_session(data_dir, scene_id, keys)
        if not view.models:
            print(f"[skip] {scene_id}: no cached scores")
            continue
        mp3 = encode_mp3(
            data_dir / "scenes" / f"{scene_id}.wav",
            data_dir / "scenes" / f"{scene_id}.mp3",
        )
        out_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(mp3, out_dir / mp3.name)
        render_session(view, mp3.name, out_dir)
        views.append(view)
        print(f"[done] {scene_id}: {len(view.models)} models")

    if not views:
        print("no cached scores found -- run `bandpoc run` first")
        return 1
    print(f"explorer written to {render_index(views, out_dir)}")
    return 0
```

파일 상단 import에 `shutil`을 추가한다:

```python
import shutil
```

`main()`의 `report` 서브파서 다음에 추가한다:

```python
    p = sub.add_parser("add-session", help="import one whole recording (URL or file)")
    p.add_argument("source")
    p.add_argument("--id", default=None)
    p.add_argument("--data-dir", default=str(_DEFAULT_DATA))
    p.set_defaults(func=cmd_add_session)

    p = sub.add_parser("explore", help="browse model output against the audio")
    p.add_argument("--detectors", default="all")
    p.add_argument("--scenes", default="all")
    p.add_argument("--out-dir", default="reports/explore")
    p.add_argument("--data-dir", default=str(_DEFAULT_DATA))
    p.set_defaults(func=cmd_explore)
```

- [ ] **Step 4: 전체 테스트 통과 확인 후 엔드투엔드**

```bash
cd poc && .venv/Scripts/python.exe -m pytest -q
```

Expected: 전부 통과. 특히 `test_cli_messages_encode_on_a_cp949_console`이 새 문자열을
검사하므로, em dash를 쓰면 여기서 잡힌다.

실제로 돌린다 (**새 터미널**에서 — winget으로 설치한 ffmpeg의 PATH 갱신이 필요하다):

```bash
cd poc && .venv/Scripts/bandpoc.exe add-session "<유튜브 URL>" --id session_01
cd poc && .venv/Scripts/bandpoc.exe run --scenes session_01
cd poc && .venv/Scripts/bandpoc.exe explore --scenes session_01
```

Expected: `reports/explore/<timestamp>/index.html` 생성. 브라우저로 열어 스펙 § 7의
완료 기준을 확인한다 — 오디오가 재생되고, 타임라인 클릭으로 그 시점이 재생되며,
슬라이더를 밀면 Take 개수와 목록이 즉시 바뀌고, 빨간 경고 배너가 **뜨지 않는다.**

- [ ] **Step 5: README 갱신 후 커밋**

`poc/README.md`의 "사용" 절 코드블록 아래에 추가한다:

```markdown
### 정답 라벨 없이 실제 녹음 비교하기

합성 씬 대신 실제 합주 녹음을 통째로 넣고, 오디오를 들으며 모델을 고른다.

```bash
bandpoc add-session "https://www.youtube.com/watch?v=..."   # 또는 로컬 파일 경로
bandpoc run          # 라벨이 없어도 점수를 캐시한다
bandpoc explore      # reports/explore/<timestamp>/index.html
```

정답이 없으므로 Recall·False Music 같은 수치는 나오지 않는다. 판단은 사람이 한다 —
재생하면서 각 모델이 어느 구간을 연주로 봤는지 보고, 커트라인 슬라이더를 밀어
"선을 옮기면 나아지는 모델"과 "옮겨도 안 되는 모델"을 가른다.

모델별 커트라인은 점수 분포에서 자동으로 잡힌다. 분포가 한 덩어리라 가를 수 없으면
0.5로 물러나고 그 사실이 페이지에 표시된다 — 그 모델이 신호를 분리하지 못한다는
뜻이므로 그것도 결과다.
```

```bash
git add poc/src/bandpoc/cli.py poc/tests/test_cli.py poc/README.md
git commit -m "feat(poc): wire add-session and explore into the CLI"
```

---

## Self-Review

**스펙 커버리지**

| 스펙 항목 | 담당 |
|---|---|
| § 2 라벨 선택사항 | Task 2 |
| § 3.1 세션 수집, slug, 중복 거부, 정규화 안 함 | Task 1 |
| § 3.2 Otsu + 단봉 폴백 | Task 3 |
| § 3.3 출력 구조 (index + `<id>.html` + `<id>.mp3`) | Task 5, 6 |
| § 3.3 슬라이더·클릭 재생·playhead·정렬 고정 | Task 5 |
| § 3.4 mp3 캐시와 복사 | Task 4 (`encode_mp3`), Task 6 (복사) |
| § 4 데이터 흐름 (0.1s 리샘플) | Task 4 `collect_session` |
| § 5 R1 파이썬/JS 대조 배너 | Task 5 (`reference` 임베드 + `sameSegments`) |
| § 5 R3 `--detectors` 부분 실행 | Task 6 |
| § 6 테스트 전략 전 항목 | Task 1~6의 테스트 |
| § 7 완료 기준 1~10 | Task 6 Step 4 |

**타입 일관성** — `ModelView.segments`는 `list[tuple[float, float]]`이고 JSON
직렬화 시 `[list(s) for s in ...]`로 리스트가 된다. 테스트가 양쪽 형태를 각각
정확히 검사한다(`test_segments_use_the_automatic_threshold`는 튜플,
`test_the_page_embeds_scores_and_the_python_reference_segments`는 리스트).
`auto_threshold`는 Task 3에서 `AutoThreshold`를 반환하고 Task 4가
`.value`/`.reason`/`.separated`로만 접근한다.

**남은 위험** — `_MIN_SEPARATION = 0.005`는 계산이 아니라 보정값이다. Task 3의
단봉/이봉 테스트가 양쪽 경계를 고정하므로, 실제 모델 곡선에서 오작동하면 그
테스트에 케이스를 추가하고 값을 조정한다.
