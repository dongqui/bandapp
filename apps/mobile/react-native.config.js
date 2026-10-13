// Firebase 설정 파일이 없는 빌드에서는 react-native-firebase를 오토링크하지 않는다 — iOS 포드가 static frameworks를
// 요구해 pod install이 깨진다. push.ts는 네이티브 모듈이 없으면 "unavailable"로 돈다 (2026-10-12 스펙 롤아웃 2).
const firebaseEnabled = Boolean(process.env.GOOGLE_SERVICES_JSON && process.env.GOOGLE_SERVICES_PLIST);
const off = { platforms: { ios: null, android: null } };
module.exports = {
  dependencies: firebaseEnabled ? {} : { "@react-native-firebase/app": off, "@react-native-firebase/messaging": off },
};
