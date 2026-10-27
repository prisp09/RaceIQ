import { describe, expect, test } from "bun:test";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { POSITION_SETTLE_MS, RaceGapCaller, readGaps, type GapReading } from "../../src/engineer/race-gaps";

const packet = (fields: Record<string, unknown>) => fields as unknown as TelemetryPacket;
const reading = (position: number, aheadS: number | null, behindS: number | null): GapReading => ({ position, aheadS, behindS });

describe("reading gaps from each game", () => {
  test("F1 uses the game's delta to the car in front for us and the car behind", () => {
    const grid = [{ position: 1, deltaToCarInFront: 0 }, { position: 2, deltaToCarInFront: 1.43 }, { position: 3, deltaToCarInFront: 0.8 }];
    expect(readGaps(packet({ RacePosition: 2, f1: { grid } }))).toEqual({ position: 2, aheadS: 1.43, behindS: 0.8 });
    expect(readGaps(packet({ RacePosition: 1, f1: { grid } }))).toEqual({ position: 1, aheadS: null, behindS: 1.43 });
    expect(readGaps(packet({ RacePosition: 3, f1: { grid } }))).toEqual({ position: 3, aheadS: 0.8, behindS: null });
  });

  test("ACC, AMS2 and LMU gaps; zero means the game sent nothing", () => {
    expect(readGaps(packet({ RacePosition: 7, acc: { gapAheadS: 1.2, gapBehindS: -0.6 } }))).toEqual({ position: 7, aheadS: 1.2, behindS: 0.6 });
    expect(readGaps(packet({ RacePosition: 7, acc: { gapAheadS: 0, gapBehindS: 0 } }))).toEqual({ position: 7, aheadS: null, behindS: null });
    expect(readGaps(packet({ RacePosition: 4, ams2: { splitTimeAheadS: 2.5, splitTimeBehindS: 3.1 } }))).toEqual({ position: 4, aheadS: 2.5, behindS: 3.1 });
    expect(readGaps(packet({ RacePosition: 4, lmu: { timeGapPlaceAhead: 0.9, timeGapPlaceBehind: 4 } }))).toEqual({ position: 4, aheadS: 0.9, behindS: 4 });
    // AC Evo shares ACC's packet shape but sends no gaps; FM sends position only.
    expect(readGaps(packet({ RacePosition: 3, acc: { acEvo: {}, gapAheadS: 1 } }))).toEqual({ position: 3, aheadS: null, behindS: null });
    expect(readGaps(packet({ RacePosition: 5 }))).toEqual({ position: 5, aheadS: null, behindS: null });
    expect(readGaps(packet({ RacePosition: 0 }))).toBeNull();
  });
});

describe("position calls", () => {
  test("calls a settled position change once, ignoring a quick swap back", () => {
    const caller = new RaceGapCaller();
    expect(caller.tick(reading(6, null, null), 0, null, false, () => 0)).toBeNull();
    expect(caller.tick(reading(5, null, null), 1000, null, false, () => 0)).toBeNull();
    expect(caller.tick(reading(6, null, null), 2000, null, false, () => 0)).toBeNull(); // swapped back
    expect(caller.tick(reading(5, null, null), 3000, null, false, () => 0)).toBeNull();
    expect(caller.tick(reading(5, null, null), 3000 + POSITION_SETTLE_MS, null, false, () => 0)?.text).toBe("P5. Nice move.");
    expect(caller.tick(reading(5, null, null), 9000, null, false, () => 0)).toBeNull();
    caller.tick(reading(6, null, null), 30_000, null, false, () => 0);
    expect(caller.tick(reading(6, null, null), 30_000 + POSITION_SETTLE_MS, null, false, () => 0)?.text).toBe("Lost a place, P6.");
  });

  test("stays silent on the opening lap", () => {
    const caller = new RaceGapCaller();
    caller.tick(reading(12, 0.3, 0.2), 0, null, true);
    expect(caller.tick(reading(8, 0.4, 0.2), 10_000, null, true)).toBeNull();
    // Lap 1 is done: P8 is now the baseline, not a gain to call.
    expect(caller.tick(reading(8, 3, 3), 20_000, null, false)).toBeNull();
  });
});

describe("battle calls", () => {
  test("defend once when the car behind gets within a second, again only after it drops back", () => {
    const caller = new RaceGapCaller();
    caller.tick(reading(4, 3, 2), 0, "Turn 1");
    expect(caller.tick(reading(4, 3, 0.9), 1000, "Turn 1", false, () => 0)?.text).toBe("Car behind within a second. Defend into Turn 1.");
    expect(caller.tick(reading(4, 3, 0.7), 2000, "Turn 1", false, () => 0)).toBeNull();
    expect(caller.tick(reading(4, 3, 1.2), 100_000, "Turn 3", false, () => 0)).toBeNull(); // not far enough back to re-arm
    expect(caller.tick(reading(4, 3, 0.8), 101_000, "Turn 3", false, () => 0)).toBeNull();
    caller.tick(reading(4, 3, 1.8), 102_000, "Turn 3", false, () => 0);
    expect(caller.tick(reading(4, 3, 0.9), 200_000, null, false, () => 0)?.text).toBe("Car behind within a second. Defend into the next braking zone.");
  });

  test("attack when within a second of the car ahead", () => {
    const caller = new RaceGapCaller();
    caller.tick(reading(3, 1.6, null), 0, null);
    expect(caller.tick(reading(3, 0.95, null), 1000, "Turns 8, 9 and 10", false, () => 0)?.text).toBe("Within a second of P2. Have a look into Turns 8, 9 and 10.");
  });
});

describe("gap trend at lap end", () => {
  test("says when the gap ahead is closing, at most every other lap", () => {
    const caller = new RaceGapCaller();
    expect(caller.lapEnd(reading(3, 2.1, 4))).toBeNull();
    expect(caller.lapEnd(reading(3, 1.8, 4))?.text).toBe("Gap to P2 is 1.8, closing. 0.3 that lap.");
    expect(caller.lapEnd(reading(3, 1.4, 4))).toBeNull(); // too soon
    expect(caller.lapEnd(reading(3, 1.1, 4))?.text).toBe("Gap to P2 is 1.1, closing. 0.3 that lap.");
  });

  test("a closing car behind comes first; a stale or far gap says nothing", () => {
    const caller = new RaceGapCaller();
    caller.lapEnd(reading(3, 2.1, 2));
    expect(caller.lapEnd(reading(3, 1.8, 1.6))?.text).toBe("Car behind is closing, gap 1.6. They took 0.4 that lap.");
    const quiet = new RaceGapCaller();
    quiet.lapEnd(reading(3, 1.8, 6));
    expect(quiet.lapEnd(reading(3, 1.8, 5.5))).toBeNull(); // ahead unchanged (stale), behind too far
    quiet.lapEnd(reading(4, 1, 1)); // position changed: no trend
    expect(quiet.lapEnd(reading(4, 1.6, 1))?.text).toBe("P3 is pulling away, gap 1.6.");
  });
});
