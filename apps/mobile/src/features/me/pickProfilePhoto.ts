import type { ProfilePhotoUpload } from "@bandapp/api-client";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";

/** 아바타는 68px로 보이므로 512px이면 충분하다. 원본을 그대로 올리면 수 MB가 된다 */
const PHOTO_SIZE = 512;
const JPEG_QUALITY = 0.8;

export class PhotoPermissionDeniedError extends Error {
  constructor() {
    super("photo permission denied");
    this.name = "PhotoPermissionDeniedError";
  }
}

/**
 * 카메라 또는 라이브러리에서 정사각형으로 고른 뒤 512px JPEG로 줄여 업로드 조각을 만든다.
 * 사용자가 취소하면 null. 권한 거부는 PhotoPermissionDeniedError.
 */
export async function pickProfilePhoto(source: "camera" | "library"): Promise<ProfilePhotoUpload | null> {
  const permission =
    source === "camera"
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new PhotoPermissionDeniedError();

  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1, // 압축은 아래 리사이즈 단계에서 한 번만 한다
  };
  const picked =
    source === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  if (picked.canceled || !picked.assets[0]) return null;

  const rendered = await ImageManipulator.manipulate(picked.assets[0].uri).resize({ width: PHOTO_SIZE }).renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY });

  // 웹의 FormData는 Blob만 파일로 보낸다. 네이티브 fetch는 { uri, name, type }를 파일로 읽는다
  if (Platform.OS === "web") return (await fetch(saved.uri)).blob();
  return { uri: saved.uri, name: "photo.jpg", type: "image/jpeg" };
}
