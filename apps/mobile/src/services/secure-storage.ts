import * as SecureStore from "expo-secure-store";

const KEYS = {
  refreshToken: "auth.refreshToken",
  pendingInviteToken: "invite.pendingToken",
  lastBandId: "band.lastId",
} as const;

export type SecureKey = keyof typeof KEYS;

export const secureStorage = {
  get: (key: SecureKey): Promise<string | null> => SecureStore.getItemAsync(KEYS[key]),
  set: (key: SecureKey, value: string): Promise<void> => SecureStore.setItemAsync(KEYS[key], value),
  remove: (key: SecureKey): Promise<void> => SecureStore.deleteItemAsync(KEYS[key]),
};
