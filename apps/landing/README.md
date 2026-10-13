# @bandapp/landing

Take N 마케팅 랜딩 페이지. 정적 HTML + CSS를 Vite로 빌드한다. 프레임워크 없음.

```bash
pnpm --filter @bandapp/landing dev      # http://localhost:4321
pnpm --filter @bandapp/landing build    # dist/
```

## 구조

- `index.html` — 페이지 전체 (Nav / Hero / How it works / Pricing / CTA / Footer)
- `src/style.css` — 디자인 토큰(`:root`)과 섹션별 스타일
- `public/screenshots/*.webp` — 앱 스크린샷. `docs/screenshots/`와 같은 파일이며 갱신 시 같이 복사한다.
- `public/favicon.png` — `apps/mobile/assets/favicon.png` 복사본

디자인 원본: Claude Design 프로젝트의 `Landing Page.dc.html`.

## Vercel 배포

모노레포의 한 폴더만 배포한다.

1. Vercel에서 **Add New Project** → 이 GitHub 레포 선택
2. **Root Directory**를 `apps/landing`으로 설정
3. Framework Preset은 `vercel.json`에 적힌 대로 Vite가 자동 선택됨. 빌드/출력 설정은 그대로 둔다.
4. 환경 변수 없음

Vercel은 루트의 `pnpm-lock.yaml`과 `pnpm-workspace.yaml`을 보고 워크스페이스 전체를 설치한 뒤 `apps/landing`에서 `pnpm build`를 실행한다. Ignored Build Step에 아래를 넣으면 랜딩 폴더가 바뀐 커밋만 배포된다.

```bash
git diff --quiet HEAD^ HEAD -- .
```

## TODO

- 스토어 링크(`href="#"`)를 출시 후 실제 App Store / Google Play URL로 교체
- Privacy / Terms / Support 링크 연결
