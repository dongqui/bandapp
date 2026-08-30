import type { TokenStorage } from "@bandapp/api-client";
import { secureStorage } from "./secure-storage";

// Access token은 짧게 살다 가므로 메모리에만, refresh token만 SecureStore에 (기획서 7·8장)
let accessToken: string | null = null;

export const tokenStorage: TokenStorage = {
  getAccessToken: async () => accessToken,
  getRefreshToken: () => secureStorage.get("refreshToken"),
  setTokens: async (tokens) => {
    accessToken = tokens.accessToken;
    await secureStorage.set("refreshToken", tokens.refreshToken);
  },
  clear: async () => {
    accessToken = null;
    await secureStorage.remove("refreshToken");
  },
};
