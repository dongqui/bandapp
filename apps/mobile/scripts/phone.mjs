// USB로 꽂힌 안드로이드 폰에서 dev client(Take N)로 테스트할 때 매번 치던 것을 한 번에 한다:
//   1. adb에 기기가 잡혀 있는지 확인 (없으면 바로 종료)
//   2. adb reverse로 폰의 localhost:8081(Metro) / :3001(API)을 PC로 연결 — WiFi·방화벽 무관
//   3. Metro를 dev-client 모드로 띄운다 (API 주소는 localhost로 덮어써서 2번을 타게 한다)
//   4. Metro가 뜨면 폰의 Take N 앱을 자동으로 연다
// 사용: pnpm --filter mobile phone
// 재빌드가 필요한 경우(네이티브 모듈·app.json 변경)는 docs/superpowers/specs/2026-09-03-google-signin-setup-record.md 참고.
import { execFileSync, spawn } from "node:child_process";

const METRO_PORT = 8081;
const API_PORT = Number(process.env.API_PORT ?? 3001);
const APP_SCHEME = "taken"; // app.json의 scheme

function adb(...args) {
  return execFileSync("adb", args, { encoding: "utf8" });
}

function connectedDevices() {
  return adb("devices")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === "device")
    .map(([serial]) => serial);
}

let devices;
try {
  devices = connectedDevices();
} catch {
  console.error("adb를 찾을 수 없다. Android SDK platform-tools가 PATH에 있어야 한다.");
  process.exit(1);
}
if (devices.length === 0) {
  console.error("연결된 폰이 없다. USB를 꽂고 폰에서 'USB 디버깅 허용'을 눌렀는지 확인할 것.");
  process.exit(1);
}
console.log(`기기: ${devices.join(", ")}`);

adb("reverse", `tcp:${METRO_PORT}`, `tcp:${METRO_PORT}`);
adb("reverse", `tcp:${API_PORT}`, `tcp:${API_PORT}`);
console.log(`adb reverse: ${METRO_PORT}(Metro), ${API_PORT}(API) → PC`);

const metro = spawn("expo", ["start", "--dev-client", "--port", String(METRO_PORT)], {
  stdio: "inherit",
  shell: true, // Windows에서 node_modules/.bin/expo.cmd를 찾기 위해
  env: {
    ...process.env,
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL_PHONE ?? `http://localhost:${API_PORT}`,
  },
});
metro.on("exit", (code) => process.exit(code ?? 0));

// Metro가 응답하면 폰의 앱을 연다. 이미 켜져 있으면 그 인스턴스로 URL만 전달된다.
const deadline = Date.now() + 60_000;
const launchUrl = `exp+${APP_SCHEME}://expo-development-client/?url=${encodeURIComponent(`http://localhost:${METRO_PORT}`)}`;
(async function waitAndLaunch() {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${METRO_PORT}/status`);
      if (res.ok) {
        adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", launchUrl);
        console.log("폰에서 Take N 앱을 열었다. 화면이 잠겨 있으면 잠금을 풀 것.");
        return;
      }
    } catch {
      // 아직 안 떴다
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.warn("Metro가 60초 안에 뜨지 않아 앱 자동 실행을 건너뛴다. 폰에서 Take N을 직접 열 것.");
})();
