import { describe, expect, test } from "bun:test";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { punctureCallout, PunctureDetector, readPressures, type PressureSample } from "../../src/engineer/puncture";

const sample = (psi: [number, number, number, number], speedMs = 50, inPits = false): PressureSample => ({ psi, speedMs, inPits });

/** Feeds `seconds` of samples at 10 Hz from `startMs`; returns the first wheel reported and the time. */
function drive(detector: PunctureDetector, startMs: number, seconds: number, psiAt: (t: number) => [number, number, number, number], speedMs = 50) {
  for (let ms = 0; ms <= seconds * 1000; ms += 100) {
    const wheel = detector.update(sample(psiAt(ms / 1000), speedMs), startMs + ms);
    if (wheel !== null) return { wheel, atMs: startMs + ms };
  }
  return null;
}

describe("puncture detection", () => {
  test("a fast deflation on one tyre is reported once", () => {
    const detector = new PunctureDetector();
    expect(drive(detector, 0, 30, () => [27.5, 27.6, 27.2, 27.3])).toBeNull();
    // Rear left loses 10 psi over 3 seconds.
    const hit = drive(detector, 30_000, 10, (t) => [27.5, 27.6, Math.max(12, 27.2 - t * 3.3), 27.3]);
    expect(hit?.wheel).toBe(2);
    expect(hit!.atMs - 30_000).toBeLessThan(4000);
    expect(drive(detector, 45_000, 10, () => [27.5, 27.6, 12, 27.3])).toBeNull();
  });

  test("a slow puncture is found once it is clearly below the others", () => {
    const detector = new PunctureDetector();
    drive(detector, 0, 30, () => [27.5, 27.6, 27.2, 27.3]);
    // Front right leaks 0.1 psi a second.
    const hit = drive(detector, 30_000, 120, (t) => [27.5, 27.6 - t * 0.1, 27.2, 27.3]);
    expect(hit?.wheel).toBe(1);
  });

  test("all four tyres warming or cooling together is never a puncture", () => {
    const detector = new PunctureDetector();
    // Out of a slow lap: every tyre gains 3 psi in 40 s, then a safety car drops them 4 psi.
    expect(drive(detector, 0, 40, (t) => [24 + t * 0.075, 24.2 + t * 0.075, 23.8 + t * 0.075, 24 + t * 0.075])).toBeNull();
    expect(drive(detector, 40_000, 60, (t) => [27 - t * 0.066, 27.2 - t * 0.066, 26.8 - t * 0.07, 27 - t * 0.066])).toBeNull();
  });

  test("a front-to-rear pressure split that builds slowly is not a puncture", () => {
    const detector = new PunctureDetector();
    // Fronts heat up 2 psi more than rears over a stint.
    expect(drive(detector, 0, 300, (t) => [26 + t * 0.01, 26 + t * 0.01, 26, 26])).toBeNull();
  });

  test("ignores the pit lane and slow running, and starts fresh after a stop", () => {
    const detector = new PunctureDetector();
    drive(detector, 0, 30, () => [27.5, 27.6, 27.2, 27.3]);
    // Spinning to a stop on the grass, the tyre reads low: not judged.
    expect(drive(detector, 30_000, 5, () => [27.5, 27.6, 20, 27.3], 3)).toBeNull();
    // New cold tyres in the pits, then back out.
    detector.update(sample([22, 22, 22, 22], 10, true), 40_000);
    expect(drive(detector, 41_000, 15, () => [22, 22, 18, 22])).toBeNull(); // still warming up the baseline
  });
});

describe("pressure sources", () => {
  test("uses live pressures; iRacing's cold pressures and empty channels are skipped", () => {
    const packet = (fields: Record<string, unknown>) => ({ Speed: 40, TirePressureFrontLeft: 27, TirePressureFrontRight: 27.1, TirePressureRearLeft: 26.5, TirePressureRearRight: 26.4, ...fields }) as unknown as TelemetryPacket;
    expect(readPressures(packet({ gameId: "acc", acc: { pitStatus: "out" } }))).toEqual({ psi: [27, 27.1, 26.5, 26.4], speedMs: 40, inPits: false });
    expect(readPressures(packet({ gameId: "acc", acc: { pitStatus: "pit_lane" } }))?.inPits).toBe(true);
    expect(readPressures(packet({ gameId: "iracing" }))).toBeNull();
    expect(readPressures(packet({ gameId: "lmu", TirePressureFrontLeft: Number.NaN }))).toBeNull();
    expect(readPressures(packet({ gameId: "fm-2023", TirePressureFrontLeft: 0, TirePressureFrontRight: 0, TirePressureRearLeft: 0, TirePressureRearRight: 0 }))).toBeNull();
  });

  test("names the wheel and boxes", () => {
    expect(punctureCallout(2, () => 0)).toEqual({ key: "puncture-2", priority: 2, text: "Puncture, rear left. Box this lap." });
  });
});
