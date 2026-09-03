# Google 로그인 셋업 기록 (iOS · Android)

- **날짜:** 2026-09-03
- **상태:** iOS 설정 완료 · Android 설정 완료, **Android 런타임 검증 미완**
- **선행 문서:** [2026-08-31-apple-token-revocation-design.md](2026-08-31-apple-token-revocation-design.md)

설계 문서가 아니라 **운영 기록**이다. 무엇을 등록했고, 무엇이 검증됐고, 무엇이 막혀 있는지를 남겨 다음에 이어서 할 때 처음부터 다시 파지 않기 위한 것이다.

## Google Cloud Console (프로젝트 `Band`)

| 클라이언트 | 용도 |
|---|---|
| **Take N Web** | `GoogleSignin.configure({ webClientId })`에 쓰이고 **idToken의 `aud`가 된다.** 서버 `GOOGLE_CLIENT_IDS`가 검증하는 값 |
| **Take N iOS** | 번들 `com.projectn.taken`. reversed client ID가 `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` |
| **Take N Android debug (Mac)** | 패키지 `com.projectn.taken` + 맥 디버그 키스토어 SHA-1 `78:FC:3D:…:38:C3` |
| **Take N Android debug (Windows)** | 같은 패키지 + Windows 디버그 키스토어 SHA-1 `0D:E6:9C:…:FF:3F` |

**Android 클라이언트 ID는 코드 어디에도 안 들어간다.** 패키지명과 SHA-1이 정당하다는 걸 구글에 등록하는 용도이고, 라이브러리 문서도 "생성된 ID는 나중에 필요 없다"고 명시한다. 그래서 Android 지원에는 **리포 변경이 전혀 없었다.**

**SHA-1은 서명 키마다 다르다.** 머신별 디버그 키스토어가 다르므로 빌드하는 머신마다 클라이언트가 필요하고, 스토어 배포 시에는 **릴리스 키스토어의 SHA-1로 하나 더** 만들어야 한다.

## 검증 상태

| 항목 | 상태 |
|---|---|
| iOS — Apple 로그인 · 탈퇴 revoke | ✅ 실제 Apple 서버로 전 구간 확인 (선행 문서 참조) |
| iOS — Google 로그인 | ⬜ 미검증 (설정만 완료) |
| Android — 빌드 | ✅ 맥에서 성공 · ❌ Windows 실패(아래) |
| Android — Google 로그인 | ❌ 실패, 원인 미확정 |

## Android 로그인 실패 — 확인된 사실

`Continue with Google` → 앱이 "로그인에 실패했어요"를 띄운다. 조사해서 **배제한 것**들:

- **네트워크 아님.** `HttpApiClient`는 HTTP 상태 에러만 `ApiError`로 감싸고 fetch 실패는 `TypeError`로 올라가는데, 화면에 뜬 건 `TypeError` 분기가 아닌 일반 분기였다.
- **서버 문제 아님.** 요청이 API에 **도달조차 하지 않았다** (DB에 새 identity 없음, API 로그에 요청 흔적 없음). 실패는 기기의 구글 SDK 단계에서 끝난다.
- **빌드 누락 아님.** Gradle 프로젝트 포함(`:react-native-google-signin_google-signin`), `PackageList.java`에 `RNGoogleSigninPackage` 등록, codegen 산출물(`react_codegen_RNGoogleSignInCGen`) 모두 확인.
- **autolinking 아님.** RN autolinking 목록에 정상 포함. (`expo-modules-autolinking`에는 안 잡히는데, 이 패키지의 `expo-module.config.json`이 `"platforms": ["ios"]`라 **정상**이다.)

logcat상 Google의 `SignInActivity`가 **열렸다가 사용자 입력 없이 즉시 파괴**된다. `DEVELOPER_ERROR`(statusCode 10)의 전형적인 모습이다.

**남은 후보 둘:**

1. **설정 전파 지연** — Console이 "5분에서 몇 시간"이라고 안내한다. 클라이언트를 만든 당일이라 유력하다. **다음 날 재시도가 첫 번째 액션.**
2. **APK 서명 키 불일치** — 등록한 SHA-1은 `~/.android/debug.keystore`에서 읽은 값이고, **APK가 실제로 그 키로 서명됐는지는 확인하지 못했다.** 다음에 이걸 먼저 확인할 것:

   ```bash
   keytool -printcert -jarfile android/app/build/outputs/apk/debug/app-debug.apk
   ```

   나온 SHA-1이 등록값과 다르면 그게 원인이다.

## 환경에서 배운 것

**Windows에서는 Android 빌드가 안 된다 (현재 설정 기준).** RN의 C++ 코드젠이 오브젝트 파일 경로에 소스 절대 경로를 미러링해서 **390자**가 되고 Windows의 260자 제한에 걸린다. 실패 지점은 `:app:buildCMakeDebug`.

리포를 짧은 경로로 옮기는 것만으로는 부족하다(계산상 332자). 해결하려면 `LongPathsEnabled` 레지스트리 설정 + 재부팅이 필요하다. Flutter에서 문제가 없었던 이유는 Flutter가 미리 빌드된 엔진을 쓰고 패키지마다 C++를 컴파일하지 않기 때문이다.

**에뮬레이터 이미지 구분이 중요하다.**

| 이미지 | Play 서비스 | 구글 계정 로그인 |
|---|---|---|
| `default` / AOSP | ❌ | ❌ |
| `google_apis` | ✅ | ⚠️ 자주 실패 |
| `google_apis_playstore` | ✅ | ✅ |

`google_apis`는 Play 서비스는 있지만 **계정 추가가 실패하는 경우가 많다.** 구글 로그인을 검증하려면 `google_apis_playstore` 이미지나 실기기를 쓸 것.

## 다음에 할 일 (순서대로)

1. `keytool -printcert -jarfile`로 APK 실제 서명 SHA-1 확인
2. 같다면 하루 뒤 재시도 (전파 지연 가설)
3. 그래도 실패하면 logcat에서 `statusCode=` 값을 잡아 원인 확정
4. iOS Google 로그인도 아직 미검증 — 맥 시뮬레이터에서 확인 가능
5. 스토어 배포 시 릴리스 키스토어 SHA-1로 Android 클라이언트 추가
