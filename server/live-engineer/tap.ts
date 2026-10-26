/**
 * Read-only taps on the live telemetry stream.
 *
 * The live pipeline publishes every broadcast packet and notification here so
 * features outside backend-core (the live race engineer) can observe the
 * session without reaching into pipeline internals. Taps run synchronously on
 * the telemetry path, so they must stay cheap and never throw.
 */
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { LivePitData, LiveSectorData } from "@raceiq/shared/racing/live/types";

export type LiveTelemetryTap = {
  onTelemetry?(packet: TelemetryPacket, sectors: LiveSectorData | null | undefined, pit: LivePitData | null | undefined): void;
  onNotification?(event: { type: string } & Record<string, unknown>): void;
};

const taps = new Set<LiveTelemetryTap>();

export function addLiveTelemetryTap(tap: LiveTelemetryTap): () => void {
  taps.add(tap);
  return () => { taps.delete(tap); };
}

export function emitLiveTelemetry(packet: TelemetryPacket, sectors?: LiveSectorData | null, pit?: LivePitData | null): void {
  for (const tap of taps) {
    try { tap.onTelemetry?.(packet, sectors, pit); } catch (error) { console.warn("[LiveTap] telemetry tap failed:", error); }
  }
}

export function emitLiveNotification(event: unknown): void {
  if (!event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") return;
  for (const tap of taps) {
    try { tap.onNotification?.(event as { type: string } & Record<string, unknown>); } catch (error) { console.warn("[LiveTap] notification tap failed:", error); }
  }
}
