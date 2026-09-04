import { Platform } from "react-native";
import { EncodingType, getInfoAsync, readAsStringAsync } from "expo-file-system/legacy";
import type { UploadSource } from "@bandapp/api-client";

/**
 * RN의 Blob은 게으른 핸들이 아니다 — fetch(uri).blob()은 파일 전체를 네이티브 메모리에 올리고
 * (안드로이드는 복사까지 한 번 더 한다) slice()만 범위를 바꾼 새 핸들을 준다. 3시간 170MB를
 * 그대로 올리면 안드로이드에서 OOM이 난다. 그래서 네이티브에서는 파트마다 필요한 범위만
 * base64로 읽는다 — 한 번에 메모리에 남는 건 파트 하나뿐이다(10MB 파트면 base64 4/3 부풀림까지
 * 쳐서 약 13MB). 네이티브가 base64로 인코딩한 걸 JS가 디코딩하고 RN fetch가 다시 base64로
 * 인코딩해 보내는 왕복 비용은 감수한다 — OOM을 막는 대가로는 싸다.
 */
export async function fileUploadSource(uri: string): Promise<UploadSource> {
  // 웹 프리뷰는 blob: URI라 expo-file-system/legacy가 다루지 못한다. 브라우저 Blob은 slice가
  // 실제로 게으르고 웹에서는 작은 파일만 다루므로 예전 경로를 그대로 쓴다.
  if (Platform.OS === "web") {
    const blob = await (await fetch(uri)).blob();
    return {
      sizeBytes: blob.size,
      readPart: async ({ start, end }) => blob.slice(start, end, "audio/mp4"),
    };
  }

  const info = await getInfoAsync(uri);
  if (!info.exists) throw new Error("recording file not found");
  if (typeof info.size !== "number") throw new Error("recording file size is unknown");
  return {
    sizeBytes: info.size,
    readPart: async ({ start, end }) =>
      base64ToBytes(
        await readAsStringAsync(uri, {
          encoding: EncodingType.Base64,
          position: start,
          length: end - start,
        }),
      ),
  };
}

/** Hermes/RN 0.74+의 전역 atob을 쓴다 — 의존성을 늘리지 않으려고 직접 바이트로 편다. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
