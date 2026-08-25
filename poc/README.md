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

### fetch 이후 반드시 할 일

`sources.yaml`은 고정 URL이 아니라 **검색 쿼리**로 클립을 모은다. 검색 결과는
검증되지 않았으므로, `bandpoc build-scenes` 전에 `data/clips/` 각 폴더를 직접
들어보고 풀 의도와 다른 클립을 삭제한다. 재료가 오염되면 리포트의 모든 수치가
조용히 틀어진다.

### 새 모델 추가하기

`bandpoc.detectors.base.Detector`를 상속해 `music_score`를 구현하고,
`bandpoc/detectors/__init__.py`의 `_register_all`에 팩토리를 등록한다. 무거운
임포트는 팩토리 안에 두어야 미설치 환경에서도 레지스트리가 뜬다.

### 결과 읽는 법

요약 테이블은 **Recall 90% 하한 제약 아래 False Music이 최소인 지점**을 모델별로
보여준다. 제약을 만족하는 조합이 없으면 최대 Recall 지점에 `90% recall not
reached` 경고가 붙는다. `ina_segmenter`와 `silero_vad`는 하드 라벨만 내놓으므로
점수 곡선이 이진값이고 threshold 스윕이 무의미하다 — 이 두 모델의 threshold
칼럼은 최적화 결과가 아니다.

수치는 모두 **합성 씬** 기준이므로 모델 간 상대 비교로만 읽는다.
