import { afterAll, describe, expect, test } from "bun:test";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
import { CapturingDbAdapter, CapturingWsAdapter, NullSessionRecorderAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { LiveTelemetryPipeline, stopMaintenanceTasks } from "@raceiq/backend-core/telemetry/live-pipeline";

initGameAdapters();
initServerGameAdapters();
afterAll(() => stopMaintenanceTasks());

function packet(distance: number): TelemetryPacket {
  return {
    gameId: "fm-2023", IsRaceOn: 1, TimestampMS: 1000, LapNumber: 1, CurrentLap: 30, LastLap: 0,
    BestLap: 0, DistanceTraveled: distance, carId: "100", trackId: "5",
    Speed: 50, PositionX: 10, PositionZ: 20, Brake: 0, Throttle: 1,
  } as unknown as TelemetryPacket;
}

describe("LiveTelemetryPipeline backlog", () => {
  test("a 3 second stall at F1 rates (360 packets/s) queues instead of failing", async () => {
    const pipeline = new LiveTelemetryPipeline(new CapturingDbAdapter(), new CapturingWsAdapter(), {
      bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
    });
    let release!: () => void;
    const stall = new Promise<void>((resolve) => { release = resolve; });
    let stalled = false;
    const detector = {
      session: { sessionId: 77, trackId: "5", gameId: "fm-2023" },
      // The first packet blocks, like a slow lap save, while the rest keep arriving.
      feed: async () => { if (!stalled) { stalled = true; await stall; } },
    };
    const seams = pipeline as unknown as { _getOrCreateDetector: () => typeof detector; sectorTracker: unknown };
    seams._getOrCreateDetector = () => detector;
    seams.sectorTracker = { feed: () => null, getTrackLength: () => 1000, getLapDistStart: () => 0 };

    // F1 datagrams are up to about 1.4 KB each.
    const pending = Array.from({ length: 360 * 3 }, (_, index) => pipeline.processPacket(packet(index), Buffer.alloc(1400)));
    release();
    const results = await Promise.allSettled(pending);
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
  });
});
