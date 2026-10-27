import { describe, expect, test } from "bun:test";
import type { LivePitData } from "@raceiq/shared/racing/live/types";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { FuelTracker, fuelPlan, isRaceSession, lapsToGo, raceLength, StrategyCaller, strategyContext, worstTyre } from "../../src/engineer/strategy";

const packet = (fields: Record<string, unknown>) => fields as unknown as TelemetryPacket;

describe("race length from the game", () => {
  test("reads laps or time left where the game sends them", () => {
    expect(raceLength(packet({ f1: { totalLaps: 25 } }))).toEqual({ lapsTotal: 25, timeLeftS: null });
    expect(raceLength(packet({ acc: { sessionTotalLaps: 0, sessionTimeLeftMs: 1_800_000 } }))).toEqual({ lapsTotal: null, timeLeftS: 1800 });
    expect(raceLength(packet({ acc: { sessionTotalLaps: 12, sessionTimeLeftMs: 0 } }))).toEqual({ lapsTotal: 12, timeLeftS: null });
    expect(raceLength(packet({ acc: { acEvo: { isTimedRace: true, sessionTimeLeftMs: 600_000, sessionTotalLaps: 0 } } }))).toEqual({ lapsTotal: null, timeLeftS: 600 });
    expect(raceLength(packet({ ams2: { lapsInEvent: 0, eventTimeRemainingS: 900 } }))).toEqual({ lapsTotal: null, timeLeftS: 900 });
    expect(raceLength(packet({ ams2: { lapsInEvent: 10, eventTimeRemainingS: -1 } }))).toEqual({ lapsTotal: 10, timeLeftS: null });
    expect(raceLength(packet({ gameId: "fm-2023" }))).toEqual({ lapsTotal: null, timeLeftS: null });
  });

  test("turns it into laps to go, rounding timed races up", () => {
    expect(lapsToGo({ lapsTotal: 25, timeLeftS: null }, 10, null)).toBe(15);
    expect(lapsToGo({ lapsTotal: null, timeLeftS: 230 }, 4, 100)).toBe(3);
    expect(lapsToGo({ lapsTotal: null, timeLeftS: 230 }, 4, null)).toBeNull();
    expect(lapsToGo({ lapsTotal: null, timeLeftS: null }, 4, 100)).toBeNull();
  });

  test("knows a race from the driver's choice or the game", () => {
    expect(isRaceSession(packet({ f1: { sessionType: "race" } }), null)).toBe(true);
    expect(isRaceSession(packet({ f1: { sessionType: "qualifying-1" } }), null)).toBe(false);
    expect(isRaceSession(packet({ f1: { sessionType: "qualifying-1" } }), "race")).toBe(true);
    expect(isRaceSession(packet({ acc: { sessionType: "race" } }), "practice")).toBe(false);
    expect(isRaceSession(null, null)).toBe(false);
  });
});

describe("fuel per lap", () => {
  const drive = (tracker: FuelTracker, lap: number, startFuel: number, endFuel: number) => {
    tracker.update(packet({ LapNumber: lap, Fuel: startFuel }));
    tracker.update(packet({ LapNumber: lap, Fuel: endFuel }));
  };

  test("uses clean laps only and skips the lap we joined part-way", () => {
    const tracker = new FuelTracker();
    drive(tracker, 1, 60, 58); // joined mid-lap
    tracker.lapComplete(false);
    drive(tracker, 2, 58, 55);
    tracker.lapComplete(false);
    expect(tracker.perLap).toBeNull(); // one clean lap isn't enough
    drive(tracker, 3, 55, 50); // crash lap
    tracker.lapComplete(true);
    drive(tracker, 4, 50, 46.8);
    tracker.lapComplete(false);
    expect(tracker.cleanLaps).toBe(2);
    expect(tracker.perLap).toBeCloseTo(3.1);
    expect(tracker.fuel).toBe(46.8);
  });

  test("works when the new lap's first packet arrives before lap-saved, and ignores refuelling", () => {
    const tracker = new FuelTracker();
    drive(tracker, 1, 60, 58);
    drive(tracker, 2, 58, 55);
    tracker.update(packet({ LapNumber: 3, Fuel: 55 }));
    tracker.lapComplete(false); // lap 2: 3 used
    tracker.update(packet({ LapNumber: 3, Fuel: 52 }));
    tracker.update(packet({ LapNumber: 3, Fuel: 90 })); // refuelled in the pits
    tracker.lapComplete(false);
    drive(tracker, 4, 90, 87);
    tracker.lapComplete(false);
    expect(tracker.cleanLaps).toBe(2);
    expect(tracker.perLap).toBe(3);
  });
});

describe("fuel plan", () => {
  test("rates the fuel against laps to go", () => {
    expect(fuelPlan(30, 3, 9, "litre", 100).status).toBe("ok");
    expect(fuelPlan(28, 3, 9, "litre", 100).status).toBe("tight");
    const save = fuelPlan(26, 3, 9, "litre", 100);
    expect(save.status).toBe("save");
    expect(save.savePerLap).toBeCloseTo(0.111, 3);
    const stop = fuelPlan(15, 3, 20, "litre", 100);
    expect(stop.status).toBe("stop");
    expect(stop.pitWindowOpen).toBe(true);
    expect(fuelPlan(15, 3, 40, "litre", 100).pitWindowOpen).toBe(false);
    expect(fuelPlan(15, 3, 20, "litre", null).pitWindowOpen).toBeNull();
    expect(fuelPlan(0.2, 0.05, 6, "fraction", null).pitWindowOpen).toBe(true);
    expect(fuelPlan(30, 3, null, "litre", 100)).toMatchObject({ status: null, lapsOfFuel: 10, marginLaps: null });
  });
});

describe("strategy calls", () => {
  const plan = (fuelLeft: number, perLap: number, toGo: number | null) => fuelPlan(fuelLeft, perLap, toGo, "litre", 100);

  test("speaks when the fuel picture changes, not every lap", () => {
    const caller = new StrategyCaller();
    expect(caller.afterLap({ lapsCompleted: 3, plan: plan(60, 3, 15), tyre: null, pitWindow: null }, () => 0).map((call) => call.text))
      .toEqual(["Fuel for 20 more laps, 15 to go. We're fine on fuel."]);
    expect(caller.afterLap({ lapsCompleted: 4, plan: plan(57, 3, 14), tyre: null, pitWindow: null }, () => 0)).toEqual([]);
    expect(caller.afterLap({ lapsCompleted: 5, plan: plan(38, 3, 13), tyre: null, pitWindow: null }, () => 0)).toEqual([
      { key: "strategy-fuel", priority: 2, text: "Need to save 0.1 litres a lap, about 3 percent to finish. Lift and coast into the big stops." },
    ]);
    expect(caller.afterLap({ lapsCompleted: 6, plan: plan(35, 3, 12), tyre: null, pitWindow: null }, () => 0)).toEqual([]);
    expect(caller.afterLap({ lapsCompleted: 7, plan: plan(20, 3, 11), tyre: null, pitWindow: null }, () => 0).map((call) => call.text))
      .toEqual(["We can't make the end on fuel. Pit window's open, box in the next 6 laps."]);
  });

  test("without a race length, reports the estimate once and warns once when low", () => {
    const caller = new StrategyCaller();
    expect(caller.afterLap({ lapsCompleted: 3, plan: plan(30, 3, null), tyre: null, pitWindow: null }, () => 0).map((call) => call.text)).toEqual(["Fuel for 10 more laps."]);
    expect(caller.afterLap({ lapsCompleted: 4, plan: plan(27, 3, null), tyre: null, pitWindow: null }, () => 0)).toEqual([]);
    expect(caller.afterLap({ lapsCompleted: 8, plan: plan(14, 3, null), tyre: null, pitWindow: null }, () => 0).map((call) => call.text))
      .toEqual(["Fuel for 4 more laps, start thinking about a stop."]);
    expect(caller.afterLap({ lapsCompleted: 9, plan: plan(11, 3, null), tyre: null, pitWindow: null }, () => 0)).toEqual([]);
  });

  test("calls the F1 pit window once, from the lap before the ideal lap", () => {
    const caller = new StrategyCaller();
    const pitWindow = { idealLap: 12, latestLap: 16 };
    expect(caller.afterLap({ lapsCompleted: 9, plan: null, tyre: null, pitWindow }, () => 0)).toEqual([]);
    expect(caller.afterLap({ lapsCompleted: 10, plan: null, tyre: null, pitWindow }, () => 0).map((call) => call.text)).toEqual(["Pit window's open. Ideal is lap 12, latest lap 16."]);
    expect(caller.afterLap({ lapsCompleted: 11, plan: null, tyre: null, pitWindow }, () => 0)).toEqual([]);
  });

  test("warns once per stint when a tyre won't last to the flag", () => {
    const caller = new StrategyCaller();
    const tyre = (lapsToCliff: number) => ({ wheel: "front left", lapsToCliff, wearPerLapPct: 1.2 });
    // The fuel call takes this lap; the tyre call waits.
    expect(caller.afterLap({ lapsCompleted: 3, plan: plan(60, 3, 15), tyre: tyre(9), pitWindow: null }, () => 0).map((call) => call.key)).toEqual(["strategy-fuel"]);
    expect(caller.afterLap({ lapsCompleted: 4, plan: plan(57, 3, 14), tyre: tyre(8.4), pitWindow: null }, () => 0).map((call) => call.text))
      .toEqual(["Tyres: the front left is wearing fastest, about 8 laps before it drops off, 14 to go. Look after it."]);
    expect(caller.afterLap({ lapsCompleted: 5, plan: plan(54, 3, 13), tyre: tyre(7.5), pitWindow: null }, () => 0)).toEqual([]);
    // New tyres, then they wear again.
    expect(caller.afterLap({ lapsCompleted: 6, plan: plan(51, 3, 12), tyre: tyre(30), pitWindow: null }, () => 0)).toEqual([]);
    expect(caller.afterLap({ lapsCompleted: 20, plan: plan(12, 3, 3), tyre: tyre(2), pitWindow: null }, () => 0).map((call) => call.key)).toEqual(["strategy-tyres"]);
  });
});

describe("strategy facts", () => {
  test("picks the tyre that reaches its cliff first and explains missing data", () => {
    const pit = { tireEstimates: { toCliff: [12, 8.5, null, 20], toDead: [null, null, null, null], wearPerLap: [0.01, 0.015, 0.008, 0.009] } } as unknown as LivePitData;
    expect(worstTyre(pit)).toEqual({ wheel: "front right", lapsToCliff: 8.5, wearPerLapPct: 1.5 });
    expect(worstTyre(null)).toBeNull();
    expect(strategyContext(null, { lapsTotal: null, timeLeftS: null }, null, null, 1)).toEqual({
      raceLength: "not reported by the game",
      fuel: "not enough clean laps yet (1 of 2)",
      tyres: "no wear data",
      gamePitWindow: null,
    });
    expect(strategyContext(fuelPlan(26, 3, 9, "litre", 100), { lapsTotal: 20, timeLeftS: null }, null, null, 3).fuel).toMatchObject({ unit: "litres", lapsOfFuel: 8.7, lapsToGo: 9, status: "save", savePerLap: 0.11 });
  });
});
