import type { HealthStatus } from "@bandapp/types";

export async function getHealth(baseUrl: string): Promise<HealthStatus> {
  const res = await fetch(`${baseUrl}/health`);
  if (!res.ok) {
    throw new Error(`health check failed: ${res.status}`);
  }
  return (await res.json()) as HealthStatus;
}
