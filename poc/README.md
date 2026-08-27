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
winget으로 설치했다면 **터미널을 새로 열어야** PATH 갱신이 반영된다.
`inaSpeechSegmenter`는 실행 중에 `ffmpeg`을 직접 호출하므로 이게 없으면 이
어댑터만 실패한다.

## 사용

```bash
bandpoc fetch          # 유튜브 → data/clips/
bandpoc build-scenes   # data/clips/ → data/scenes/
bandpoc run            # 추론 → data/cache/
bandpoc report         # 스윕 + 메트릭 → reports/<timestamp>/index.html
```

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

#### 저장 공간

`bandpoc add-session`이 유튜브 URL을 받으면 변환 전 원본을
`data/raw_sessions/<id>.wav`에 남겨둔다 (45분 녹음 기준 약 500 MB). 변환된
`data/scenes/<id>.wav`, `bandpoc explore`가 캐시하는 mp3, 그리고 `bandpoc
report`가 리포트마다 남기는 mp3 사본까지 더하면 세션 하나가 금방 커진다.
`raw_sessions/`는 자동으로 지우지 않는다 — 지울지 말지는 사용자가 정한다.
(`bandpoc report`는 `.wav` 없이 라벨과 캐시만으로 동작하므로, 채점이 끝난 뒤라면
`data/scenes/<id>.wav`를 지워도 리포트 재생성에는 지장이 없다.)

### 브라우저에서 넣기

터미널 대신 브라우저로 세션을 투입할 수 있다.

```bash
bandpoc serve      # http://127.0.0.1:8765
```

유튜브 URL을 넣거나 오디오 파일을 떨어뜨리면 다운로드 - 추론 - 리포트 생성이
이어서 돈다. 진행 상황이 페이지에 흐르고, 끝나면 탐색 페이지 링크가 뜬다.
작업은 하나씩 순서대로 처리된다 - 동시에 두 세션을 추론하면 모델이 두 벌
로드되기 때문이다.

**이 서버를 네트워크에 노출하지 말 것.** 임의 URL을 다운로드하고 임의 경로에
파일을 쓰므로 `127.0.0.1`에만 바인딩하며, 그래서 `--host` 옵션이 없다.

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
