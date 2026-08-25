# 합주 연주 구간 검출 — 모델 비교 환경 설계

**날짜:** 2026-08-25
**대상:** Band Feedback PRD § 45 "Phase 0 — Audio PoC"
**상태:** 설계 승인됨

---

## 1. 목적

Band Feedback의 핵심 기능은 1~3시간짜리 합주 녹음에서 실제 연주 구간(Take)만 자동으로 뽑아내는 것이다. PRD § 46 Risk 1이 지적하듯, 이 기능이 제품으로 쓸 만한 정확도를 내는지는 **실제 데이터로 검증하기 전까지 알 수 없다.**

이 문서는 그 검증을 위한 **모델 비교 실험 환경**을 정의한다. 목표는 특정 모델을 고르는 것이 아니라, 여러 모델을 동일 조건에서 반복적으로 비교하고 새 모델을 싼값에 추가할 수 있는 **하네스**를 만드는 것이다.

이 환경이 답해야 할 질문:

1. 어떤 사전학습 모델이 합주실 환경에서 음악/비음악을 가장 잘 구분하는가?
2. PRD § 12의 후처리 룰(threshold, min-duration, gap-merge)의 적정값은 얼마인가?
3. PRD § 38의 목표치(Music Recall 90%+, Boundary Error ±5~10초)가 달성 가능한가?
4. 2시간 오디오 처리에 실제로 얼마나 걸리는가? (백엔드 비용 추정)

**비목표:** 모델 학습/파인튜닝, 앱 코드, 백엔드 API. 이 환경은 순수 오프라인 실험용이다.

---

## 2. 핵심 설계 원칙 — 추론과 후처리의 분리

이 환경의 중심 아이디어는 파이프라인을 두 단계로 쪼개서 그 경계에 캐시를 두는 것이다.

```
[느림 · 씬당 1회]
  오디오 → 모델 추론 → 프레임별 music score 곡선 → .npz 캐시

[빠름 · 무한 반복]
  캐시된 곡선 → threshold / min-duration / gap-merge → 구간 → 메트릭 → 리포트
```

**이유.** PRD § 12의 룰(`score > 0.7 AND duration > 20s`, `gap ≤ 10s면 병합`)은 검증 대상이지 상수가 아니다. 후처리를 모델 추론과 묶으면 두 가지 문제가 생긴다.

- threshold 하나 바꿀 때마다 60분 오디오를 재추론해야 해서 실험 반복이 불가능하다.
- "모델 A가 모델 B보다 나쁘다"는 결론이 실제로는 "모델 A에 0.7이라는 값이 안 맞았다"일 수 있다. 모델의 점수 분포는 제각각이므로 고정 threshold로 비교하면 불공정하다.

캐시 경계를 두면 threshold 스윕이 수 초 만에 끝나고, 각 모델의 **최적점끼리** 비교할 수 있다.

---

## 3. 모델 어댑터

### 3.1 공통 인터페이스

모든 모델은 하나의 추상 클래스 뒤에 들어간다.

```python
class Detector(ABC):
    name: str            # "yamnet", "panns_cnn14", ...
    version: str         # 캐시 키에 포함. 로직 바꾸면 올린다.
    requires: list[str]  # 임포트 체크용 패키지명

    def load(self) -> None:
        """모델 가중치 로드. 지연 호출."""

    def music_score(self, wav: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
        """(프레임별 [0,1] 음악 점수, hop 초) 반환"""
```

리샘플링·모노 변환·정규화는 각 어댑터가 자기 요구 사양에 맞춰 내부에서 처리한다. 호출자는 원본 오디오만 넘긴다.

모델마다 프레임 간격이 다르므로(YAMNet 0.48s, AST 10.24s 윈도우 등), 평가 단계에서 모든 점수 곡선을 **100ms 공통 격자**로 선형 보간해 정렬한다.

### 3.2 라인업 (7종)

| 어댑터 | 백엔드 | music score 산출 방식 | 비고 |
|---|---|---|---|
| `dsp_baseline` | numpy/librosa | RMS + 스펙트럼 평탄도 + 하모닉 비율 + 저역 에너지의 가중합 | 설치 비용 0. 모델이 이걸 못 이기면 모델 쓸 이유가 없다 |
| `yamnet` | TensorFlow(CPU) | AudioSet 521클래스 중 음악군 확률 | 0.96s 윈도우 / 0.48s hop |
| `panns_cnn14` | PyTorch | AudioSet 527클래스 중 음악군 확률 | `panns_inference`, 체크포인트 ~300MB |
| `ast` | transformers | AudioSet 527클래스 중 음악군 확률 | `MIT/ast-finetuned-audioset-10-10-0.4593` |
| `ina_segmenter` | TensorFlow(CPU) | `music` 라벨이면 1, 아니면 0 | music/speech/noise 분할 전용 모델 |
| `clap_zeroshot` | transformers | 텍스트 프롬프트 쌍의 유사도 소프트맥스 | `laion/clap-htsat-unfused` |
| `silero_vad` | PyTorch | `1 - p(speech)` | 반대 방향 축. 음악 검출기가 아니라 음성 검출기 |

**AudioSet 계열 3종의 음악군 정의**는 설정 파일로 뺀다. 기본값 두 가지를 모두 계산한다.

- `music_only`: `p(Music)` 단독
- `music_group`: `max(Music, Musical instrument, Guitar, Drum kit, Singing, Bass guitar, Percussion, ...)`

어느 쪽이 나은지는 실험이 답할 문제이므로 둘 다 별개 variant로 취급해 리포트에 나란히 올린다.

**주의 사항 두 가지.**

- `ina_segmenter`는 확률이 아니라 하드 라벨을 뱉는다. 따라서 threshold 스윕이 무의미하고 min-duration/gap-merge만 튜닝된다. 리포트에 이 사실을 명시한다.
- `silero_vad`는 "말소리가 아니면 음악"이라는 거친 가정 위에 있다. 무음·환경음도 음악으로 잡을 것이므로 단독 성능은 나쁠 것으로 예상되지만, **다른 모델과 조합했을 때의 가치**를 보기 위해 포함한다.

### 3.3 확장

새 모델 추가는 `detectors/` 아래에 `Detector` 서브클래스 하나를 두고 레지스트리에 등록하면 끝난다. 나머지 파이프라인은 손대지 않는다.

---

## 4. 테스트 데이터

### 4.1 접근 방식

실제 합주 녹음이 없으므로 **재료 클립을 조립해 합성 씬을 만든다.** 조립 시점에 정답이 초 단위로 확정되므로 수동 라벨링이 전혀 필요 없다.

```
sources.yaml (유튜브 URL + 역할 태그)
    ↓ yt-dlp
data/raw/  ── 구간 잘라내기 + 라우드니스 정규화(EBU R128) ──→ data/clips/
                                                          music/ speech/ tuning/ ambient/
    ↓ scenes.yaml (레시피)
data/scenes/<id>.wav  +  data/scenes/<id>.labels.json
```

유튜브에서 "밴드 합주실", "합주 브이로그" 류 영상을 받는다. 합주실 공간감·마이크 특성·한국어 대화가 함께 들어있어 실제 사용 환경과 가깝다. 개인 PoC 용도로만 사용하며 다운로드 파일은 커밋하지 않는다.

### 4.2 씬 레시피

```yaml
- id: hard_noodling
  duration: 15m
  seed: 42
  blocks:
    - {label: speech, pool: conversation, dur: 90s}
    - {label: speech_with_noodling, pool: conversation, dur: 120s,
       overlay: {pool: guitar_noodle, snr_db: 6}}
    - {label: music,  pool: band_full, dur: 210s}
    - {label: tuning, pool: tuning,    dur: 45s}
    - {label: music,  pool: band_full, dur: 180s}
```

**`label`과 `pool`은 다른 개념이다.** `label`은 정답 라벨(§ 4.4의 6종 중 하나)이고, `pool`은 어느 클립 폴더에서 재료를 꺼낼지다. 하나의 라벨이 여러 풀에서 나올 수 있다 — `music` 라벨은 `band_full`·`drums_only`·`guitar_only` 어디서든 나올 수 있고, 이게 `partial_practice` 씬을 표현하는 방법이다.

`sources.yaml`의 역할 태그가 곧 풀 이름이 된다. 초기 풀: `band_full`, `drums_only`, `guitar_only`, `conversation`, `guitar_noodle`, `tuning`, `room_tone`.

`overlay`는 두 재료를 지정 SNR로 믹싱한다. `seed`로 재료 선택과 크로스페이드 길이를 고정해 재현성을 보장한다.

### 4.3 씬 세트

| 씬 | 길이 | 목적 |
|---|---|---|
| `clean_basic` | 10분 | 정상 동작 확인용 sanity check. 명확한 교대 |
| `hard_noodling` | 15분 | 대화 중 기타 튕김 (Risk 1-①) |
| `tuning_setup` | 15분 | 튜닝·세팅 소음 (Risk 1-③) |
| `partial_practice` | 15분 | 드럼만/기타만 파트 연습 (Risk 1-②④) |
| `realistic_long` | 60분 | 전 요소 혼합. 실전 시뮬레이션 및 RTF 측정 |

### 4.4 라벨 정책 (결정됨)

정답 라벨은 프레임 단위로 다음 값을 갖는다.

```
music | speech | silence | tuning | ambient | speech_with_noodling
```

**`speech_with_noodling`은 음악이 아니다.** 사용자가 다시 듣고 싶은 것은 연주이지 잡담이 아니므로, 이 구간이 Take로 뽑히면 제품 가치가 훼손된다. 모델 입장에서 가장 어려운 조건이지만, 이걸 구분하지 못하는 모델은 실제로 쓸 수 없다.

평가용 이진 정답은 `is_music = (label == "music")`으로 파생된다.

---

## 5. 후처리

캐시된 점수 곡선에 PRD § 12의 룰을 적용해 구간을 만든다.

```
1. score >= threshold 인 프레임을 이진화
2. gap <= merge_gap 인 인접 구간 병합
3. duration >= min_duration 인 구간만 남김
```

파라미터 격자:

- `threshold`: 0.05 ~ 0.95, 0.05 간격 (19개)
- `min_duration`: 10 / 20 / 30 초
- `merge_gap`: 5 / 10 / 20 초

모델 × variant 당 171개 조합. 캐시된 곡선 위에서 도는 벡터 연산이라 씬 하나당 1초 미만이면 끝난다.

---

## 6. 평가 지표

PRD § 38을 그대로 구현하되 프레임 레벨과 구간 레벨을 분리한다.

### 6.1 프레임 레벨 (100ms 격자)

- **Music Recall** = (검출 구간에 포함된 실제 음악 프레임) / (전체 실제 음악 프레임). **목표 90%+. 최우선 지표.**
- **False Music Duration** = 실제 음악이 아닌데 검출 구간에 포함된 시간. 절대 초 + 전체 대비 %.
- **케이스별 오검출 분해** — `speech_with_noodling`, `tuning`, `speech`, `ambient` 각 라벨 구간에서의 오검출률. **모델 순위를 실제로 가르는 지점이므로 리포트의 1급 시민으로 취급한다.**

### 6.2 구간 레벨

- **Boundary Error** — IoU > 0.5로 매칭된 구간 쌍에 대해 `|Δstart|`, `|Δend|`의 중앙값과 p90. **목표 ±5~10초.**
- **Take Count Error** — 검출 Take 수 − 정답 Take 수. 하나의 연주가 여러 개로 쪼개지거나 여러 연주가 하나로 뭉치는 현상을 잡는다.

**정답 Take의 정의:** `labels.json`에서 `label == "music"`인 블록들 중, 시간상 맞닿아 있는 것들을 하나로 합친 구간. 후처리 룰(gap-merge, min-duration)은 여기에 적용하지 않는다 — 정답은 후처리 파라미터와 무관하게 고정되어야 공정한 비교가 된다.

### 6.3 운영 지표

- **RTF (Realtime Factor)** = 처리 시간 / 오디오 길이. GPU·CPU 각각 측정. 2시간 녹음 처리 시간과 백엔드 비용에 직결되며 PRD § 36의 처리 상태 UX 설계 근거가 된다.
- **모델 크기 / 최대 VRAM**

### 6.4 모델 선택 규칙

각 모델·variant마다 **`Music Recall >= 0.90` 제약 하에 `False Music Duration`이 최소인 파라미터 조합**을 자동 탐색한다. 제약을 만족하는 조합이 없으면 그 사실 자체를 리포트에 명시하고 최대 달성 Recall을 보고한다.

모델 간 비교는 각자의 최적점끼리 수행한다.

---

## 7. HTML 리포트

`reports/<timestamp>/index.html` 로 자기완결형(self-contained) HTML을 생성한다. 이미지는 base64 인라인, 외부 요청 없음. 서버 불필요.

**구성:**

1. **요약 테이블** — 모델 × (최적 파라미터, Recall, False Music, Boundary p50/p90, Take Count Error, RTF). Recall 90% 달성 여부를 색으로 표시.
2. **케이스별 오검출 히트맵** — 모델 × 라벨 종류. 어떤 모델이 어떤 상황에 약한지 한눈에.
3. **씬별 타임라인** — 정답 구간 띠를 맨 위에 두고, 그 아래 각 모델의 점수 곡선과 threshold 적용 결과 구간을 동일 x축에 정렬. 어디서 왜 틀렸는지를 눈으로 확인하는 용도.
4. **스윕 곡선** — threshold를 따라 그린 Recall vs False-Music 트레이드오프 곡선. 모델별로 겹쳐 그린다.
5. **실행 메타** — 씬 해시, 모델 버전, 커밋 SHA. 재현성 확보.

matplotlib으로 PNG를 만들어 인라인한다.

---

## 8. 프로젝트 구조

```
bandapp/
└── poc/
    ├── pyproject.toml
    ├── README.md
    ├── sources.yaml              # 유튜브 URL + 역할 태그
    ├── scenes.yaml               # 씬 레시피
    ├── src/bandpoc/
    │   ├── cli.py                # fetch / build-scenes / run / report
    │   ├── audio.py              # 로드·리샘플·정규화 (ffmpeg + soundfile)
    │   ├── fetch.py              # yt-dlp 다운로드
    │   ├── synth.py              # 씬 조립 → wav + labels.json
    │   ├── registry.py           # 어댑터 레지스트리
    │   ├── detectors/
    │   │   ├── base.py
    │   │   └── dsp.py yamnet.py panns.py ast.py ina.py clap.py silero.py
    │   ├── cache.py              # (scene_id, detector, version) → .npz
    │   ├── postproc.py           # threshold / merge / min-duration
    │   ├── metrics.py
    │   └── report.py
    ├── tests/
    ├── data/                     # gitignore
    │   ├── raw/ clips/ scenes/ cache/
    └── reports/                  # gitignore
```

`poc/`는 앱 코드와 격리된다. 검증이 끝나면 확정된 모델 어댑터와 `postproc.py`만 백엔드 워커로 이식한다.

### CLI

```
bandpoc fetch                              # sources.yaml → data/clips/
bandpoc build-scenes                       # scenes.yaml → data/scenes/
bandpoc run --detectors all --scenes all   # 추론 → 캐시
bandpoc report                             # 스윕 + 메트릭 + HTML
```

`run`은 캐시가 있으면 건너뛴다. `--force`로 무시.

---

## 9. 테스트 전략

실험 코드라도 **정답이 확정적인 부분은 테스트한다.** 여기서 버그가 나면 모델 성능 차이로 오독되기 때문이다.

- `postproc` — 합성 점수 배열로 병합·필터 경계 조건 검증 (정확히 gap 10초, 정확히 20초 구간 등)
- `metrics` — 손으로 계산 가능한 작은 케이스로 Recall/False-Music/Boundary 검증
- `synth` — 생성된 wav 길이와 labels.json이 일치하는지, seed 고정 시 재현되는지
- `detectors` — 각 어댑터가 `[0,1]` 범위, 올바른 길이의 배열을 반환하는지 (스모크 테스트, 짧은 합성 신호)

---

## 10. 리스크와 대응

### R1 — 의존성 충돌 (가장 큼)

`yamnet`·`ina_segmenter`는 TensorFlow, 나머지는 PyTorch를 쓴다. 한 환경에 넣으면 numpy 버전 충돌이 잦다.

**대응:**
1. `numpy<2` 고정. TF는 CPU 전용(`tensorflow-cpu`) — YAMNet은 작아서 CPU로 충분하다.
2. 어댑터는 **지연 임포트 + 실패 시 graceful skip.** 한 모델이 설치에 실패해도 나머지는 정상 동작하고 리포트에 `unavailable`로 표시된다.
3. CLAP은 `laion_clap` 패키지 대신 HuggingFace `transformers`의 `ClapModel`을 쓴다. 의존성이 훨씬 얌전하다.

venv를 처음부터 7개로 쪼개는 것은 과설계다. 실제 충돌이 발생하면 그 모델만 subprocess로 격리한다.

### R2 — 합성 데이터와 실제 녹음의 괴리

조립한 씬은 블록 경계가 실제보다 부자연스럽게 깔끔하다. 실제 합주는 대화가 연주로 서서히 넘어간다.

**대응:** 블록 경계에 짧은 크로스페이드(0.3~1초 랜덤)를 넣고, 전체 씬에 합주실 룸톤을 낮은 레벨로 깔아 배경 연속성을 만든다. 그럼에도 이 환경의 결과는 **상대 비교용**이며 절대 정확도는 실제 녹음 확보 후 재검증해야 한다. 이 한계를 리포트 상단에 명시한다.

### R3 — 모델 체크포인트 다운로드

PANNs(~300MB), AST, CLAP은 최초 실행 시 큰 파일을 받는다. 네트워크 실패 시 혼란스러운 에러가 난다.

**대응:** `run` 시작 전 필요한 체크포인트를 확인하고 진행 상황을 명시적으로 출력한다. 실패는 해당 어댑터만 skip.

### R4 — ffmpeg 미설치

현재 환경에 ffmpeg이 없다. yt-dlp와 오디오 변환에 필수다.

**대응:** 설치 단계에서 명시적으로 확인하고, 없으면 winget 설치 명령을 안내한다.

---

## 11. 완료 기준

이 환경은 다음이 되면 완성이다.

1. `bandpoc fetch && bandpoc build-scenes && bandpoc run && bandpoc report` 4개 명령으로 백지 상태에서 HTML 리포트까지 나온다.
2. 7개 어댑터 중 최소 5개가 실제로 동작한다 (DSP 베이스라인 포함).
3. 리포트에 § 6의 모든 지표가 모델별로 채워져 있다.
4. 새 모델 추가가 `detectors/` 파일 하나 + 레지스트리 한 줄로 끝난다.
5. `tests/`가 통과한다.

---

## 12. 후속

이 환경의 결과로 PRD § 50의 미결정 사항 중 8번(서버 분석 vs on-device)에 대한 근거(RTF·모델 크기)가 나온다. 검증이 끝나면 확정 모델과 `postproc.py`를 PRD § 33의 Audio Worker로 이식하고, PRD § 39의 사용자 수정 데이터 수집 설계로 넘어간다.
