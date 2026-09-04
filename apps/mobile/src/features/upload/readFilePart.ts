import type { UploadSource } from "@bandapp/api-client";

/**
 * RN의 Blob은 네이티브 파일을 가리키는 핸들이라 fetch(uri).blob()이 파일을 JS 메모리에
 * 올리지 않는다. slice()도 범위만 바꾼 새 핸들을 돌려주고, fetch body로 넘기면 네이티브가
 * 그 범위만 읽어 보낸다 (스펙 결정 15). 3시간 170MB도 파트 단위로만 메모리를 쓴다.
 */
export async function fileUploadSource(uri: string): Promise<UploadSource> {
  const res = await fetch(uri);
  const blob = await res.blob();
  return {
    sizeBytes: blob.size,
    readPart: async ({ start, end }) => blob.slice(start, end, "audio/mp4"),
  };
}
