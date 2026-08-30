import { HttpApiClient, MockApiClient, type RehearsalApiClient } from "@bandapp/api-client";
import { createContext, useContext, useRef, type ReactNode } from "react";
import { sessionEvents } from "@/services/session-events";
import { tokenStorage } from "@/services/token-storage";

const ApiContext = createContext<RehearsalApiClient | null>(null);

export function createDefaultClient(): RehearsalApiClient {
  const baseUrl = process.env.EXPO_PUBLIC_API_URL;
  if (!baseUrl) return new MockApiClient();
  return new HttpApiClient({
    baseUrl,
    tokens: tokenStorage,
    onSessionExpired: () => sessionEvents.emitExpired(),
  });
}

export function ApiProvider({
  client,
  children,
}: {
  client?: RehearsalApiClient;
  children: ReactNode;
}) {
  const defaultClient = useRef<RehearsalApiClient | null>(null);
  if (!client && !defaultClient.current) defaultClient.current = createDefaultClient();
  return (
    <ApiContext.Provider value={client ?? defaultClient.current}>{children}</ApiContext.Provider>
  );
}

export function useApi(): RehearsalApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used within ApiProvider");
  return api;
}
