import { describe, expect, test } from "bun:test";
import type { NamedSegment } from "@raceiq/shared/racing/tracks/named-segments";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { CornerLapRecorder, groupCorners, parseTips, speechSeconds, spokenGain, tipFeedbackCallout, TipHistory, tipOutcomes, TipScheduler, tipTriggerFrac, type CachedTip, type CornerGroupStats } from "../../src/engineer/co-driver";
import { anomalyReason, summarizeSession, type SessionLapRecord } from "../../src/engineer/session-summary";

const corner = (number: number, startFrac: number, endFrac: number): NamedSegment => ({ type: "corner", name: `T${number}`, number, startFrac, endFrac });
const straight = (startFrac: number, endFrac: number): NamedSegment => ({ type: "straight", name: "Straight", startFrac, endFrac });

describe("co-driver corner groups", () => {
  test("merges corners closer than 150 m into one group", () => {
    // 5000 m track: T1-T2 are 50 m apart (chicane), T3 is 500 m later.
    const groups = groupCorners([corner(1, 0.10, 0.12), corner(2, 0.13, 0.15), straight(0.15, 0.25), corner(3, 0.25, 0.28)], 5000);
    expect(groups).toEqual([
      { id: "G1", label: "Turns 1 and 2", startFrac: 0.10, endFrac: 0.15 },
      { id: "G2", label: "Turn 3", startFrac: 0.25, endFrac: 0.28 },
    ]);
  });

  test("names three-corner esses", () => {
    const [group] = groupCorners([corner(4, 0.30, 0.31), corner(5, 0.315, 0.32), corner(6, 0.325, 0.33)], 5000);
    expect(group.label).toBe("Turns 4, 5 and 6");
  });
});

describe("co-driver tip timing", () => {
  test("starts early enough to finish the chosen seconds before braking", () => {
    const text = "Turn 3: brake ten metres later, use the kerb."; // 9 words ≈ 3.3 s
    const speed = 50; // m/s
    const trigger = tipTriggerFrac(0.5, speed, 5000, text, 5);
    const metres = (0.5 - trigger) * 5000;
    expect(metres).toBeCloseTo(speed * (speechSeconds(text) + 5), 5);
  });

  test("plays a tip once inside its window and never overlaps speech", () => {
    const scheduler = new TipScheduler();
    scheduler.setLeadSeconds(2);
    scheduler.setTips([
      { groupId: "G1", label: "Turn 1", text: "Turn 1: brake later.", brakeFrac: 0.2 },
      { groupId: "G2", label: "Turn 2", text: "Turn 2: carry more speed.", brakeFrac: 0.21 },
    ]);
    // 5000 m track at 50 m/s: G1 window opens (1.5 + 2) * 50 = 175 m before 0.2 → 0.165.
    expect(scheduler.update(0.10, 50, 5000, 0)).toBeNull();
    expect(scheduler.update(0.17, 50, 5000, 0)?.groupId).toBe("G1");
    // G2's window is open while G1 is still being spoken: it waits instead of overlapping…
    expect(scheduler.update(0.18, 50, 5000, 500)).toBeNull();
    // …and plays once the radio is free, because it can still finish before braking.
    expect(scheduler.update(0.185, 50, 5000, 1600)?.groupId).toBe("G2");
    expect(scheduler.update(0.19, 50, 5000, 6000)).toBeNull();
  });

  test("drops a waiting tip that could no longer finish before braking", () => {
    const scheduler = new TipScheduler();
    scheduler.setLeadSeconds(2);
    scheduler.setTips([{ groupId: "G2", label: "Turn 2", text: "Turn 2: carry more speed.", brakeFrac: 0.21 }]);
    scheduler.markBusy(10_000); // a long answer is still playing
    expect(scheduler.update(0.18, 50, 5000, 0)).toBeNull(); // 10 s wait + 1.9 s speech > 3 s to braking: dropped
    expect(scheduler.update(0.185, 50, 5000, 20_000)).toBeNull();
  });

  test("drops a tip when the car is already at the braking point", () => {
    const scheduler = new TipScheduler();
    scheduler.setTips([{ groupId: "G1", label: "Turn 1", text: "Turn 1: brake later.", brakeFrac: 0.2 }]);
    expect(scheduler.update(0.2, 50, 5000, 0)).toBeNull();
    scheduler.newLap();
    expect(scheduler.update(0.14, 50, 5000, 0)?.groupId).toBe("G1");
  });
});

describe("co-driver tips from the AI", () => {
  const groups = groupCorners([corner(1, 0.10, 0.12), corner(2, 0.13, 0.15), corner(3, 0.25, 0.28)], 5000);
  test("keeps known groups, prefixes the corner name and uses the recorded brake point", () => {
    const tips = parseTips('Here you go: [{"group":"G1","tip":"Brake ten metres later, use the kerb on exit."},{"group":"G9","tip":"x"}]', groups, [
      { id: "G1", entryKph: 250, minKph: 90, exitKph: 140, brakeMetresBeforeEntry: 120, timeS: 6.2, brakeFrac: 0.076 },
    ]);
    expect(tips).toEqual([{ groupId: "G1", label: "Turns 1 and 2", text: "Turns 1 and 2: Brake ten metres later, use the kerb on exit.", brakeFrac: 0.076, baselineS: 6.2 }]);
    expect(parseTips("no json", groups, [])).toEqual([]);
  });
});

describe("co-driver tip feedback", () => {
  const stats = (id: string, timeS: number): CornerGroupStats => ({ id, entryKph: 200, minKph: 90, exitKph: 150, brakeMetresBeforeEntry: 100, timeS, brakeFrac: 0.1 });
  const tip = (groupId: string, label: string, text: string, baselineS: number | null): CachedTip => ({ groupId, label, text: `${label}: ${text}`, brakeFrac: 0.1, baselineS });

  test("measures each played tip against the lap it was written from", () => {
    const outcomes = tipOutcomes(
      [tip("G1", "Turn 1", "Brake later.", 6.4), tip("G2", "Turns 8, 9 and 10", "Carry more speed.", 12.5), tip("G3", "Turn 12", "Use the kerb.", null)],
      [stats("G1", 6.45), stats("G2", 12.28), stats("G3", 5)],
      new Map([["G2", 12.3]]),
    );
    expect(outcomes).toEqual([
      { groupId: "G1", label: "Turn 1", tip: "Turn 1: Brake later.", gainS: -0.05, groupBest: false },
      { groupId: "G2", label: "Turns 8, 9 and 10", tip: "Turns 8, 9 and 10: Carry more speed.", gainS: 0.22, groupBest: true },
    ]);
  });

  test("ignores a tip whose group wasn't completed", () => {
    expect(tipOutcomes([tip("G1", "Turn 1", "Brake later.", 6.4)], [], new Map())).toEqual([]);
  });

  test("confirms only the biggest real gain", () => {
    const base = { tip: "x", groupBest: false };
    expect(tipFeedbackCallout([{ ...base, groupId: "G1", label: "Turn 1", gainS: 0.12 }, { ...base, groupId: "G2", label: "Turns 8, 9 and 10", gainS: 0.21, groupBest: true }], () => 0))
      .toBe("Good, two tenths better through Turns 8, 9 and 10. Best yet through there.");
    expect(tipFeedbackCallout([{ ...base, groupId: "G1", label: "Turn 1", gainS: 0.08 }], () => 0)).toBeNull();
    expect(tipFeedbackCallout([], () => 0)).toBeNull();
  });

  test("speaks gains the way an engineer would", () => {
    expect(spokenGain(0.12)).toBe("a tenth");
    expect(spokenGain(0.34)).toBe("three tenths");
    expect(spokenGain(0.5)).toBe("half a second");
    expect(spokenGain(1.24)).toBe("1.2 seconds");
  });

  test("remembers results for the prompt and spots advice that already failed", () => {
    const history = new TipHistory();
    history.record([
      { groupId: "G1", label: "Turn 1", tip: "Turn 1: Brake ten metres later.", gainS: -0.1, groupBest: false },
      { groupId: "G2", label: "Turn 4", tip: "Turn 4: Use the exit kerb.", gainS: 0.18, groupBest: false },
      { groupId: "G3", label: "Turn 7", tip: "Turn 7: Earlier on throttle.", gainS: 0.01, groupBest: false },
    ]);
    expect(history.forPrompt()).toEqual([
      { group: "G1", corner: "Turn 1", tip: "Brake ten metres later.", result: "lost 0.10s" },
      { group: "G2", corner: "Turn 4", tip: "Use the exit kerb.", result: "gained 0.18s" },
      { group: "G3", corner: "Turn 7", tip: "Earlier on throttle.", result: "no change" },
    ]);
    expect(history.failedBefore(tip("G1", "Turn 1", "brake ten metres later", 6))).toBe(true);
    expect(history.failedBefore(tip("G1", "Turn 1", "Brake five metres later.", 6))).toBe(false);
    expect(history.failedBefore(tip("G2", "Turn 4", "Use the exit kerb.", 6))).toBe(false);
    history.clear();
    expect(history.forPrompt()).toEqual([]);
  });
});

describe("co-driver corner recording", () => {
  test("records entry, minimum and exit speed, brake point and time through a group", () => {
    const [group] = groupCorners([corner(1, 0.10, 0.12)], 5000);
    const recorder = new CornerLapRecorder([group], 5000);
    const packet = (speedKph: number, brake: number, lapTime: number) => ({ Speed: speedKph / 3.6, Brake: brake * 255, CurrentLap: lapTime }) as TelemetryPacket;
    recorder.update(packet(250, 0, 10), 0.08);
    recorder.update(packet(240, 1, 10.3), 0.09); // brake 50 m before entry
    recorder.update(packet(150, 1, 11), 0.10);
    recorder.update(packet(95, 0, 12), 0.11);
    recorder.update(packet(130, 0, 13), 0.12);
    recorder.update(packet(160, 0, 14), 0.125);
    expect(recorder.finish()).toEqual([{ id: "G1", entryKph: 150, minKph: 95, exitKph: 130, brakeMetresBeforeEntry: 50, timeS: 3, brakeFrac: 0.09 }]);
  });
});

describe("session summary for open questions", () => {
  test("summarises pace, consistency, sectors, recurring mistakes and positions", () => {
    const laps: SessionLapRecord[] = [
      { lap: 1, timeS: 103, valid: true, sectorTimesS: [34, 35, 34], mistakes: { "brake-lockup": { "Turn 1": 2 } }, position: 5 },
      { lap: 2, timeS: 102, valid: true, sectorTimesS: [33.5, 34.5, 34], mistakes: { "brake-lockup": { "Turn 1": 1 }, understeer: { "Turn 6": 1 } }, position: 4 },
      { lap: 3, timeS: 104, valid: false, sectorTimesS: [35, 35, 34], mistakes: {}, position: 4 },
      { lap: 4, timeS: 101.5, valid: true, sectorTimesS: [33.5, 34, 34], mistakes: {}, position: 3 },
    ];
    const summary = summarizeSession(laps);
    expect(summary).toMatchObject({
      laps: 4, validLaps: 3, bestLapS: 101.5, averageValidLapS: 102.167, cleanLaps: 2, startPosition: 5, currentPosition: 3,
      recurringMistakes: [{ what: "brake-lockup at Turn 1", count: 3 }, { what: "understeer at Turn 6", count: 1 }],
    });
    expect(summary.lapTimesS).toEqual([103, 102, "104 (invalid)", 101.5]);
    expect((summary.sectors as Array<{ sector: number; bestS: number; averageLossS: number }>)[0]).toEqual({ sector: 1, bestS: 33.5, averageLossS: 0.17 });
    expect(summarizeSession([])).toEqual({ laps: 0 });
  });
});

describe("anomalous laps", () => {
  test("flags a lap far slower than usual and leaves it out of the session summary", () => {
    expect(anomalyReason(300, [120, 121])).toContain("far slower than usual");
    expect(anomalyReason(125, [120, 121])).toBeNull();
    expect(anomalyReason(300, [120])).toBeNull(); // needs two normal laps first
    const laps: SessionLapRecord[] = [
      { lap: 1, timeS: 120, valid: true, sectorTimesS: [], mistakes: {}, position: null },
      { lap: 2, timeS: 121, valid: true, sectorTimesS: [], mistakes: {}, position: null },
      { lap: 3, timeS: 300, valid: true, sectorTimesS: [], mistakes: { "brake-lockup": { "Turn 1": 1 } }, position: null, excluded: "far slower than usual" },
    ];
    expect(summarizeSession(laps)).toMatchObject({ validLaps: 2, excludedLaps: 1, averageValidLapS: 120.5, recurringMistakes: [] });
  });
});
