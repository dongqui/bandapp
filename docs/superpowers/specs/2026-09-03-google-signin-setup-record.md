# Google 로그인 셋업 기록 (iOS · Android)

- **날짜:** 2026-09-03
- **상태:** iOS 설정 완료 · Android 설정 완료, **Android 런타임 검증 미완**
- **2026-09-11 추가:** Android 실패 원인 확정 — **Console에 등록한 SHA-1이 APK 서명 키와 다르다.** 아래 "원인 확정" 절 참조.
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
| Android — 빌드 | ✅ 맥에서 성공 · ✅ Windows 성공 (2026-09-11, `B:` 매핑 필요 — 아래 "Windows 빌드 절차") |
| Android — Google 로그인 | ✅ 2026-09-11 Windows 빌드 + 실기기(Galaxy)로 전 구간 확인 — 계정 선택 5초 뒤 `user_identities`에 GOOGLE 행 생성 |

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

### 2026-09-11 원인 확정 — 후보 2가 맞았다

`android/app/build.gradle`의 debug signingConfig는 `~/.android/debug.keystore`가 아니라 **`android/app/debug.keystore`**(Expo prebuild가 RN 템플릿에서 복사해 넣는 파일)를 쓴다. `expo run:android`는 debug variant를 빌드하므로 APK는 이 템플릿 키로 서명된다.

| 키스토어 | SHA-1 | 비고 |
|---|---|---|
| `android/app/debug.keystore` (실제 서명 키) | `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25` | RN 템플릿 공용 키. 맥·Windows 모두 prebuild 결과가 같다 |
| `~/.android/debug.keystore` (Windows) | `0D:E6:9C:08:10:47:81:EF:2C:E7:18:E3:FA:AD:7C:0F:88:6B:FF:3F` | Console에 등록했지만 **빌드에 안 쓰인다** |
| `~/.android/debug.keystore` (맥) | `78:FC:3D:…:38:C3` | 위와 같음 |

즉 Console의 Android 클라이언트 둘 다 쓸모없는 SHA-1이고, 맥에서 실패한 것도 같은 이유다. 전파 지연 가설(후보 1)은 기각.

**조치:** Google Cloud Console > 프로젝트 `Band` > 클라이언트 > **Android 클라이언트 추가** — 패키지 `com.projectn.taken`, SHA-1 `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`. 템플릿 키는 머신마다 같으니 하나면 맥·Windows를 다 덮는다. 기존 debug 클라이언트 둘은 지워도 된다. 코드 변경 없음.

2026-09-11 등록 완료: **Take N Android debug (템플릿 키)** — `358314474478-vi7kk0okfm1f2rvgprta7onqd1s0kgmb.apps.googleusercontent.com`. 코드·env 어디에도 넣지 않는다 (위 "Android 클라이언트 ID는 코드 어디에도 안 들어간다" 참조).

주의: `android/`는 git-ignored라 prebuild를 다시 돌려도 같은 템플릿 키가 나온다. 릴리스 키스토어를 따로 만들면 그때 SHA-1을 하나 더 등록한다.

## 환경에서 배운 것

**Windows에서는 Android 빌드가 안 된다 (현재 설정 기준).** RN의 C++ 코드젠이 오브젝트 파일 경로에 소스 절대 경로를 미러링해서 **390자**가 되고 Windows의 260자 제한에 걸린다. 실패 지점은 `:app:buildCMakeDebug`.

리포를 짧은 경로로 옮기는 것만으로는 부족하다(계산상 332자). 해결하려면 `LongPathsEnabled` 레지스트리 설정 + 재부팅이 필요하다. Flutter에서 문제가 없었던 이유는 Flutter가 미리 빌드된 엔진을 쓰고 패키지마다 C++를 컴파일하지 않기 때문이다.

**2026-09-11 정정: `LongPathsEnabled=1`만으로는 안 된다.** Android SDK cmake 3.22.1에 딸린 **ninja 1.10.2가 레지스트리를 안 보고** 자체 260자 검사로 죽는다 (ninja는 1.11부터 `LongPathsEnabled`를 존중). ninja가 검사하는 건 빌드 디렉터리 기준 **상대 경로**이고 그 안에 소스 절대 경로가 `C_/Users/kimwi/OneDrive/Desktop/dev/bandapp/node_modules/...` 형태로 박히므로, 앞부분을 줄이면 된다. 78개 오브젝트 중 gesture-handler 하나가 292자로 넘치고, 리포를 `B:`로 매핑하면 최장 251자.

### Windows 빌드 절차 (2026-09-11 성공, 2분 8초)

```powershell
# 1. 리포를 짧은 드라이브로 매핑 (재부팅하면 풀린다. 되돌리기: subst B: /D)
subst B: C:\Users\kimwi\OneDrive\Desktop\dev\bandapp

# 2. C: 경로 기준 CMake 캐시가 있으면 지운다 (처음 한 번, 또는 경로가 바뀌었을 때)
Remove-Item -Recurse -Force B:\apps\mobile\android\app\.cxx

# 3. B:에서 gradle만 돌린다 (expo run:android는 C: 경로로 다시 configure해서 실패한다)
cmd /c "cd /d B:\apps\mobile\android && B:\apps\mobile\android\gradlew.bat app:assembleDebug -x lint -x test --configure-on-demand --build-cache -PreactNativeArchitectures=arm64-v8a"

# 4. 설치 + USB 포워딩 (WiFi/방화벽 무관)
adb install -r C:\Users\kimwi\OneDrive\Desktop\dev\bandapp\apps\mobile\android\app\build\outputs\apk\debug\app-debug.apk
adb reverse tcp:8081 tcp:8081
adb reverse tcp:3001 tcp:3001

# 5. Metro는 원래 C: 경로에서 (B:에서 띄우면 워크스페이스 패키지 junction이 C: 경로로 풀려 Metro가 헷갈릴 수 있다)
#    API 주소를 localhost로 덮어써서 adb reverse를 타게 한다
$env:CI="1"; $env:EXPO_PUBLIC_API_URL="http://localhost:3001"; pnpm --filter mobile exec expo start --dev-client --port 8081

# 6. 앱 실행
adb shell am start -a android.intent.action.VIEW -d "exp+taken://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
```

- `android/local.properties`에 `sdk.dir=C:/Users/kimwi/AppData/Local/Android/Sdk`가 있어야 한다 (`ANDROID_HOME` 미설정). android/는 git-ignored라 prebuild를 다시 하면 이 파일도 다시 만들어야 한다.
- 폰을 다시 꽂으면 `adb reverse`는 다시 해야 한다.
- 근본 해결 대안: ninja ≥ 1.11을 SDK cmake `bin/ninja.exe`에 덮어쓰면 `subst` 없이 `expo run:android`가 그대로 될 것이다. 미검증.

**에뮬레이터 이미지 구분이 중요하다.**

| 이미지 | Play 서비스 | 구글 계정 로그인 |
|---|---|---|
| `default` / AOSP | ❌ | ❌ |
| `google_apis` | ✅ | ⚠️ 자주 실패 |
| `google_apis_playstore` | ✅ | ✅ |

`google_apis`는 Play 서비스는 있지만 **계정 추가가 실패하는 경우가 많다.** 구글 로그인을 검증하려면 `google_apis_playstore` 이미지나 실기기를 쓸 것.

## 다음에 할 일 (순서대로)

1. ~~`keytool -printcert -jarfile`로 APK 실제 서명 SHA-1 확인~~ → 2026-09-11 완료, 위 "원인 확정" 절
2. Console에 `5E:8F:…:F6:25` SHA-1의 Android 클라이언트 등록 (수 분~수 시간 전파)
3. Windows: `LongPathsEnabled=1`은 이미 설정돼 있다 (2026-09-11 확인). 마지막 빌드 시도는 2026-09-02(실패, APK 없음)이므로 `pnpm --filter mobile android`를 다시 돌려 빌드가 되는지 본다
4. 검증 기기: 이 PC의 에뮬레이터 둘(Nexus_6_API_34, Pixel_3a_API_34)은 모두 `google_apis` 이미지라 계정 추가가 잘 안 된다. `google_apis_playstore` 이미지(android-34)를 SDK Manager에서 받거나 USB 실기기를 쓴다
5. 그래도 실패하면 logcat에서 `statusCode=` 값을 잡는다
6. iOS Google 로그인도 아직 미검증 — 맥 시뮬레이터에서 확인 가능
7. 스토어 배포 시 릴리스 키스토어 SHA-1로 Android 클라이언트 추가
