import type { ConfigContext, ExpoConfig } from "expo/config";

type Plugins = NonNullable<ExpoConfig["plugins"]>;

// google-signin의 iosUrlScheme은 Google Cloud Console iOS 클라이언트의 reversed client ID다.
// (com.googleusercontent.apps.<번호>-<해시> 형태)
// 아직 발급 전이면 플러그인을 빼서 prebuild/빌드가 깨지지 않게 한다 — 애플 로그인만 먼저
// 검증하는 dev build를 만들 수 있어야 하기 때문.
const googleIosUrlScheme = process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME;

export default ({ config }: ConfigContext): ExpoConfig => {
  // EXPO_PUBLIC_API_URL이 비면 ApiProvider가 MockApiClient를 고른다 — 로그인이 가짜 데이터를
  // 반환하는 빌드가 스토어에 올라가는 것이 최악이므로 production 빌드는 여기서 끊는다.
  // dev build는 JS를 로컬 Metro가 제공하고 Metro는 .env를 읽으므로 이 검사에서 제외한다.
  if (process.env.EAS_BUILD_PROFILE === "production" && !process.env.EXPO_PUBLIC_API_URL) {
    throw new Error(
      "[app.config] production 빌드인데 EXPO_PUBLIC_API_URL이 없다 — 앱이 mock 데이터로 동작한다. EAS 환경변수를 설정하라.",
    );
  }

  const plugins: Plugins = [
    ...((config.plugins ?? []) as Plugins),
    ["expo-dev-client", { launchMode: "most-recent" }],
  ];

  if (googleIosUrlScheme) {
    plugins.push(["@react-native-google-signin/google-signin", { iosUrlScheme: googleIosUrlScheme }]);
  } else if (process.env.EAS_BUILD_PROFILE === "production") {
    // production EAS 빌드는 구글 로그인이 조용히 빠지면 안 된다 — green build 로그는 아무도 안 읽으므로
    // 여기서 빌드 자체를 실패시켜야 배포 전에 걸린다.
    // 값은 EAS 환경변수(production)에 plaintext로 등록돼 있다 — 비었다면 그쪽이 지워진 것이다.
    throw new Error(
      "[app.config] production 빌드인데 EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME이 없다 — 구글 로그인이 빠진 채 배포된다. EAS 환경변수를 설정하라.",
    );
  } else {
    console.warn(
      "[app.config] EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME이 없어 google-signin 플러그인을 건너뛴다 — 이 빌드에서 구글 로그인은 동작하지 않는다.",
    );
  }

  return { ...config, plugins } as ExpoConfig;
};
