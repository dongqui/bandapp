import { MockApiClient, type RehearsalApiClient } from "@bandapp/api-client";
import { createContext, useContext, useRef, type ReactNode } from "react";

const ApiContext = createContext<RehearsalApiClient | null>(null);

export function ApiProvider({
  client,
  children,
}: {
  client?: RehearsalApiClient;
  children: ReactNode;
}) {
  const defaultClient = useRef<RehearsalApiClient | null>(null);
  if (!client && !defaultClient.current) defaultClient.current = new MockApiClient();
  return (
    <ApiContext.Provider value={client ?? defaultClient.current}>{children}</ApiContext.Provider>
  );
}

export function useApi(): RehearsalApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used within ApiProvider");
  return api;
}
