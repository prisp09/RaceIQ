import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { PitTracker } from "@raceiq/backend-core/live-strategy/pit-tracker";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

const PIT = { seedFuelFromHistory: true, seedTireWearFromHistory: true, useDistanceBasedWearCurves: false };
const created: number[] = [];

async function sessionWithLaps(fuelPerLap: (number | null)[]): Promise<void> {
  const session = await db.insert(sessions).values({ gameId: "acc", carId: "seed-car", trackId: "seed-track" }).returning({ id: sessions.id }).get();
  created.push(session!.id);
  for (const [index, fuel] of fuelPerLap.entries()) {
    await db.insert(laps).values({ sessionId: session!.id, lapNumber: index + 1, lapTime: 100 + index, isValid: true, pi: 0, fuelPerLap: fuel }).run();
  }
}

function fuelPerLapAfterSeed(tracker: PitTracker): number {
  return tracker.feed({ LapNumber: 0, Fuel: 50, CurrentLap: 1, DistanceTraveled: 10, TireWearFL: 0, TireWearFR: 0, TireWearRL: 0, TireWearRR: 0 } as TelemetryPacket, 5000).fuelPerLap;
}

afterEach(async () => {
  for (const id of created.splice(0)) await db.delete(sessions).where(eq(sessions.id, id)).run();
});

describe("pit tracker history seeding", () => {
  test("seeds fuel from the stored per-lap fuel use of the two most recent matching laps", async () => {
    await sessionWithLaps([2.5, null, 2.7, 2.6]);
    const tracker = new PitTracker();
    tracker.setTireWearAvailable(false);
    await tracker.seedFromHistory("seed-track", "seed-car", 0, "acc", PIT);
    expect(fuelPerLapAfterSeed(tracker)).toBeCloseTo(2.65, 5);
  });

  test("a reset while history is loading drops the stale seed", async () => {
    await sessionWithLaps([2.5, 2.7]);
    const tracker = new PitTracker();
    tracker.setTireWearAvailable(false);
    const seeding = tracker.seedFromHistory("seed-track", "seed-car", 0, "acc", PIT);
    tracker.reset();
    await seeding;
    expect(fuelPerLapAfterSeed(tracker)).toBe(0);
  });
});
