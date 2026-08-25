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
