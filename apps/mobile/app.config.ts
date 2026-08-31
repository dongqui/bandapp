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
  } else if (process.env.EAS_BUILD_PROFILE === "production") {
    // production EAS 빌드는 구글 로그인이 조용히 빠지면 안 된다 — green build 로그는 아무도 안 읽으므로
    // 여기서 빌드 자체를 실패시켜야 배포 전에 걸린다. eas.json에 env를 아직 못 넣은 이유는
    // OAuth 클라이언트 ID가 없어서이니, placeholder로 채우지 말고 발급 후 EAS 환경변수로 넣을 것.
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
