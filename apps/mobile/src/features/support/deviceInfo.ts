import Constants from "expo-constants";
import { Platform } from "react-native";

/** 디자인: "Your app version and device model are attached" — 문의에 붙는 두 값 */
export function appVersionLabel(): string {
  const version = Constants.expoConfig?.version ?? "";
  const build = Constants.nativeBuildVersion;
  return build ? `${version} (${build})` : version;
}

export function deviceLabel(): string {
  if (Platform.OS === "android") {
    const { Brand, Model } = Platform.constants;
    return `android ${Platform.Version} · ${Brand} ${Model}`;
  }
  if (Platform.OS === "ios") return `${Platform.constants.systemName} ${Platform.Version}`;
  return Platform.OS;
}
