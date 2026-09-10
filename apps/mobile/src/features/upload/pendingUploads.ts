import { Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { createMemoryFs, createPendingUploads, type UploadFs } from "./createPendingUploads";

/** expo-file-system/legacy를 스토어가 요구하는 최소 인터페이스로 좁힌다 */
const expoFs: UploadFs = {
  documentDirectory: FileSystem.documentDirectory,
  moveAsync: (o) => FileSystem.moveAsync(o),
  deleteAsync: (uri, o) => FileSystem.deleteAsync(uri, o),
  readAsStringAsync: (uri) => FileSystem.readAsStringAsync(uri),
  writeAsStringAsync: (uri, contents) => FileSystem.writeAsStringAsync(uri, contents),
  makeDirectoryAsync: (uri, o) => FileSystem.makeDirectoryAsync(uri, o),
  readDirectoryAsync: (uri) => FileSystem.readDirectoryAsync(uri),
  getInfoAsync: (uri) => FileSystem.getInfoAsync(uri),
};

// 웹 프리뷰는 documentDirectory가 null이고 blob: URI를 옮길 수 없다 — 메모리 fs를 쓰면 stage는 실패해
// (훅이 원래 URI로 진행) 레코드만 메모리에 남는다. 페이지를 새로 고치면 사라지지만 프리뷰 용도로 충분하다.
export const pendingUploads = createPendingUploads(
  Platform.OS === "web" || FileSystem.documentDirectory === null ? createMemoryFs() : expoFs,
);
