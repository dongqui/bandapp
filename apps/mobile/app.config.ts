import type { ConfigContext, ExpoConfig } from "expo/config";

type Plugins = NonNullable<ExpoConfig["plugins"]>;

// google-signin의 iosUrlScheme은 Google Cloud Console iOS 클라이언트의 reversed client ID다
// (com.googleusercontent.apps.<번호>-<해시> 형태). 값이 없으면 플러그인이 조용히 빠져
// "빌드는 성공하는데 구글 로그인 버튼만 죽어 있는" 앱이 나오므로 여기서 빌드를 끊는다.
// 값은 apps/mobile/.env에 있고 형식은 .env.example이 설명한다.
const googleIosUrlScheme = process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME;

export default ({ config }: ConfigContext): ExpoConfig => {
  if (!googleIosUrlScheme) {
    throw new Error(
      "[app.config] EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME이 없다 — 구글 로그인이 빠진 앱이 만들어진다. apps/mobile/.env를 확인하라 (.env.example 참고).",
    );
  }

  // EXPO_PUBLIC_API_URL이 비면 ApiProvider가 MockApiClient를 고른다. 서버 없이 UI만 볼 때
  // 필요한 모드라 막지는 않지만, 스토어에 올릴 빌드에서 비어 있으면 로그인이 가짜 데이터를
  // 반환한다. 빌드 시점에 Debug/Release를 알 수 없어 경고까지만 한다 — 배포 전 수동 확인 필요.
  if (!process.env.EXPO_PUBLIC_API_URL) {
    console.warn(
      "[app.config] EXPO_PUBLIC_API_URL이 없어 이 빌드는 mock 데이터로 동작한다 — 배포용이면 반드시 채울 것.",
    );
  }

  // Firebase(FCM)는 선택이다. 두 설정 파일 경로가 모두 있을 때만 플러그인을 붙인다 — 없으면 push.ts가 "unavailable"로
  // 돌아 인박스·설정만 동작한다 (2026-10-12 스펙 롤아웃 2). 파일은 Firebase 콘솔에서 받는다 (.env.example 참고).
  const googleServicesJson = process.env.GOOGLE_SERVICES_JSON;
  const googleServicesPlist = process.env.GOOGLE_SERVICES_PLIST;
  const firebaseEnabled = Boolean(googleServicesJson && googleServicesPlist);
  if (!firebaseEnabled) {
    console.warn("[app.config] GOOGLE_SERVICES_JSON/PLIST가 없어 이 빌드에는 푸시 알림이 빠진다.");
  }

  const plugins: Plugins = [
    ...((config.plugins ?? []) as Plugins),
    ["expo-dev-client", { launchMode: "most-recent" }],
    ["@react-native-google-signin/google-signin", { iosUrlScheme: googleIosUrlScheme }],
    ...(firebaseEnabled
      ? ([
          "@react-native-firebase/app",
          "@react-native-firebase/messaging",
          // react-native-firebase는 iOS에서 static frameworks가 필요하다
          ["expo-build-properties", { ios: { useFrameworks: "static" } }],
        ] as Plugins)
      : []),
  ];

  return {
    ...config,
    plugins,
    ios: { ...config.ios, ...(firebaseEnabled ? { googleServicesFile: googleServicesPlist } : {}) },
    android: { ...config.android, ...(firebaseEnabled ? { googleServicesFile: googleServicesJson } : {}) },
  } as ExpoConfig;
};
