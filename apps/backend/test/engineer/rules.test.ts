import { describe, expect, test } from "bun:test";
import type { LivePitData } from "@raceiq/shared/racing/live/types";
import { formatDelta, formatLapTime, lapCompleteCallouts, sectorCallout, sessionEndCallout, topMistake } from "../../src/engineer/rules";
import type { LapIssueTally } from "../../src/engineer/state";

const pit = (overrides: Partial<LivePitData> = {}): LivePitData => ({
  fuelPerLap: 2.5, fuelLapsRemaining: 12.4, currentLapFuelUsed: 1, tireLapsToBad: 20, tireLapsToCritical: 25,
  tireEstimates: { toCliff: [null, null, null, null], toDead: [null, null, null, null], wearPerLap: [0, 0, 0, 0] },
  tireWearPerLap: 0.5, pitInLaps: 12, limitedBy: "fuel", trackLength: 5000, estimateSource: "session", cliffPct: 40, deadPct: 20, tireLapsRemaining: 20,
  ...overrides,
});

const tally = (entries: [string, number, [string, number][]][]): LapIssueTally =>
  new Map(entries.map(([kind, count, corners]) => [kind as never, { count, corners: new Map(corners) }]));

const first = () => 0;

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
    expect(lapCompleteCallouts("quiet", base, first)).toEqual([]);
  });

  test("quiet mode still makes critical fuel calls", () => {
    const calls = lapCompleteCallouts("quiet", { ...base, pit: pit({ fuelLapsRemaining: 1.4 }) }, first);
    expect(calls).toEqual([{ key: "fuel-critical", priority: 2, text: "Box, box. Fuel is critical, about 1.4 laps left." }]);
  });

  test("normal mode summarises the lap against the best", () => {
    expect(lapCompleteCallouts("normal", base, first).map((call) => call.text)).toEqual(["1:42.3, plus 0.4."]);
  });

  test("calls a personal best as a purple lap", () => {
    const [call] = lapCompleteCallouts("normal", { ...base, lapTime: 101.5 }, first);
    expect(call.text).toBe("Purple lap. 1:41.5. Up by 0.4. Good job.");
  });

  test("tells the driver to push when well off the best", () => {
    expect(lapCompleteCallouts("normal", { ...base, lapTime: 103 }, first).map((call) => call.text)).toEqual(["1:43.0, plus 1.1. Push now."]);
  });

  test("adds a status check every five laps", () => {
    const texts = lapCompleteCallouts("normal", { ...base, lapsSinceStatus: 5 }, first).map((call) => call.text);
    expect(texts).toContain("Status check: fuel for 12 laps, tyres good for about 25.");
  });

  test("coach mode names the most repeated mistake and corner", () => {
    const issues = tally([["brake-lockup", 3, [["Turn 1", 2], ["Turn 4", 1]]], ["understeer", 1, [["Turn 7", 1]]]]);
    const texts = lapCompleteCallouts("coach", { ...base, lastLapIssues: issues }, first).map((call) => call.text);
    expect(texts).toContain("Lock-up into Turn 1. Ease the initial brake pressure.");
    expect(topMistake(new Map())).toBeNull();
  });

  test("sector split against the best sector", () => {
    const sectors = { sectorCount: 3, currentSector: 1, currentSectorTime: 0, currentTimes: [31.42, 0, 0], lastTimes: [31.2, 35, 36], bestTimes: [31.2, 34.9, 35.8], lastLapTime: 102, bestLapTime: 101.9, estimatedLap: 102, deltaToBest: 0.2, deltaToLast: 0 };
    expect(sectorCallout(0, sectors)?.text).toBe("Sector 1, plus 0.2.");
  });
});

describe("race engineer phrasing", () => {
  test("varies lines instead of repeating one template", () => {
    const texts = new Set([0, 0.3, 0.6, 0.9].map((value) => lapCompleteCallouts("normal", { ...base, lapTime: 101.5 }, () => value)[0]!.text));
    expect(texts.size).toBeGreaterThan(2);
  });

  test("celebrates a win, a podium and supports a bad result", () => {
    expect(sessionEndCallout(1, true, first).text).toBe("That's P1! Brilliant job.");
    expect(sessionEndCallout(3, true, first).text).toBe("P3, that's a podium. Well driven.");
    expect(sessionEndCallout(15, true, first).text).toBe("P15. Tough one today, we'll regroup.");
    expect(sessionEndCallout(null, false, first).text).toBe("Session complete. Good work, let's review the data.");
  });
});
