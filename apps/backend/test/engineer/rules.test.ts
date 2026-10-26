import { describe, expect, test } from "bun:test";
import type { LivePitData } from "@raceiq/shared/racing/live/types";
import { formatDelta, formatLapTime, lapCompleteCallouts, sectorCallout, topMistake } from "../../src/engineer/rules";
import type { LapIssueTally } from "../../src/engineer/state";

const pit = (overrides: Partial<LivePitData> = {}): LivePitData => ({
  fuelPerLap: 2.5, fuelLapsRemaining: 12.4, currentLapFuelUsed: 1, tireLapsToBad: 20, tireLapsToCritical: 25,
  tireEstimates: { toCliff: [null, null, null, null], toDead: [null, null, null, null], wearPerLap: [0, 0, 0, 0] },
  tireWearPerLap: 0.5, pitInLaps: 12, limitedBy: "fuel", trackLength: 5000, estimateSource: "session", cliffPct: 40, deadPct: 20, tireLapsRemaining: 20,
  ...overrides,
});

const tally = (entries: [string, number, [string, number][]][]): LapIssueTally =>
  new Map(entries.map(([kind, count, corners]) => [kind as never, { count, corners: new Map(corners) }]));

const base = { lapNumber: 3, lapTime: 102.34, isValid: true, previousBest: 101.9, pit: pit(), lastLapIssues: new Map() as LapIssueTally, lapsSinceStatus: 1 };

describe("race engineer rules", () => {
  test("formats lap times and deltas for speech", () => {
    expect(formatLapTime(102.34)).toBe("1:42.3");
    expect(formatLapTime(65.04)).toBe("1:05.0");
    expect(formatDelta(0.44)).toBe("plus 0.4");
    expect(formatDelta(-0.21)).toBe("minus 0.2");
    expect(formatDelta(0.01)).toBe("dead on your best");
  });

  test("quiet mode stays silent on a normal lap", () => {
    expect(lapCompleteCallouts("quiet", base)).toEqual([]);
  });

  test("quiet mode still makes critical fuel calls", () => {
    const calls = lapCompleteCallouts("quiet", { ...base, pit: pit({ fuelLapsRemaining: 1.4 }) });
    expect(calls).toEqual([{ key: "fuel-critical", priority: 2, text: "Fuel is critical. About 1.4 laps left." }]);
  });

  test("normal mode summarises the lap against the best", () => {
    expect(lapCompleteCallouts("normal", base).map((call) => call.text)).toEqual(["1:42.3, plus 0.4."]);
  });

  test("calls a personal best as a purple lap", () => {
    const [call] = lapCompleteCallouts("normal", { ...base, lapTime: 101.5 });
    expect(call.text).toBe("Purple lap, 1:41.5. Up by 0.4. Good job.");
  });

  test("adds a status check every five laps", () => {
    const texts = lapCompleteCallouts("normal", { ...base, lapsSinceStatus: 5 }).map((call) => call.text);
    expect(texts).toContain("Status check: fuel for 12 laps, tyres good for about 25.");
  });

  test("coach mode names the most repeated mistake and corner", () => {
    const issues = tally([["brake-lockup", 3, [["Turn 1", 2], ["Turn 4", 1]]], ["understeer", 1, [["Turn 7", 1]]]]);
    const texts = lapCompleteCallouts("coach", { ...base, lastLapIssues: issues }).map((call) => call.text);
    expect(texts).toContain("Lock-up into Turn 1, 3 times that lap. Ease the initial brake pressure.");
    expect(topMistake(new Map())).toBeNull();
  });

  test("sector split against the best sector", () => {
    const sectors = { sectorCount: 3, currentSector: 1, currentSectorTime: 0, currentTimes: [31.42, 0, 0], lastTimes: [31.2, 35, 36], bestTimes: [31.2, 34.9, 35.8], lastLapTime: 102, bestLapTime: 101.9, estimatedLap: 102, deltaToBest: 0.2, deltaToLast: 0 };
    expect(sectorCallout(0, sectors)?.text).toBe("Sector 1, plus 0.2.");
  });
});
