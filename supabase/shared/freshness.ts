export type RuntimeStatus = "live" | "stale" | "offline";

export function runtimeState(lastHeartbeat: string, now: Date = new Date()): { status: RuntimeStatus; ageSeconds: number } {
  const heartbeatMs = new Date(lastHeartbeat).getTime();
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - heartbeatMs) / 1000));
  const status: RuntimeStatus = ageSeconds <= 60 ? "live" : ageSeconds <= 300 ? "stale" : "offline";
  return { status, ageSeconds };
}
