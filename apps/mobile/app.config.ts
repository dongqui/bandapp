import type { ConfigContext, ExpoConfig } from "expo/config";

type Plugins = NonNullable<ExpoConfig["plugins"]>;

// google-signin의 iosUrlScheme은 Google Cloud Console iOS 클라이언트의 reversed client ID다.
// (com.googleusercontent.apps.<번호>-<해시> 형태)
// 아직 발급 전이면 플러그인을 빼서 prebuild/빌드가 깨지지 않게 한다 — 애플 로그인만 먼저
// 검증하는 dev build를 만들 수 있어야 하기 때문.
const googleIosUrlScheme = process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME;

export default ({ config }: ConfigContext): ExpoConfig => {
  const plugins: Plugins = [
    ...((config.plugins ?? []) as Plugins),
    ["expo-dev-client", { launchMode: "most-recent" }],
  ];

  if (googleIosUrlScheme) {
    plugins.push(["@react-native-google-signin/google-signin", { iosUrlScheme: googleIosUrlScheme }]);
  } else {
    console.warn(
      "[app.config] EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME이 없어 google-signin 플러그인을 건너뛴다 — 이 빌드에서 구글 로그인은 동작하지 않는다.",
    );
  }

  return { ...config, plugins } as ExpoConfig;
};
