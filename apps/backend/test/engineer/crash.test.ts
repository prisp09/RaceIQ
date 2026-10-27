import { describe, expect, test } from "bun:test";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { assessCrash, crashPaceCallout, ImpactDetector, readDamage, type DamageReading, type Impact } from "../../src/engineer/crash";

const packet = (overrides: Partial<TelemetryPacket> = {}): TelemetryPacket =>
  ({ IsRaceOn: 1, Speed: 60, PositionX: 0, PositionZ: 0, AccelerationX: 0, AccelerationZ: 0, ...overrides }) as TelemetryPacket;

/** Drives the car in a straight line at `speeds` (m/s), one packet every 50 ms, and returns any impacts. */
function drive(detector: ImpactDetector, speeds: number[], extra: (index: number) => Partial<TelemetryPacket> = () => ({})): Impact[] {
  const impacts: Impact[] = [];
  let x = 0;
  speeds.forEach((speed, index) => {
    x += speed * 0.05;
    const impact = detector.update(packet({ Speed: speed, PositionX: x, ...extra(index) }), index * 50);
    if (impact) impacts.push(impact);
  });
  return impacts;
}

const first = () => 0;
const light: Impact = { at: 0, speedLossMs: 16, peakG: 5, heavy: false };
const heavy: Impact = { at: 0, speedLossMs: 40, peakG: 15, heavy: true };
const damage = (parts: Record<string, number>, step = 8, severe = 50): DamageReading => ({ parts, step, severe });

describe("impact detection", () => {
  test("hard braking is not a crash", () => {
    // 60 -> 20 m/s over two seconds is about 2 g.
    const speeds = Array.from({ length: 40 }, (_, index) => 60 - index);
    expect(drive(new ImpactDetector(), speeds)).toEqual([]);
  });

  test("a sudden stop is one impact, heavy when big", () => {
    const impacts = drive(new ImpactDetector(), [60, 60, 60, 40, 15, 5, 5, 5, 5], (index) => (index === 3 ? { AccelerationZ: 60 } : {}));
    expect(impacts).toHaveLength(1);
    expect(impacts[0]!.heavy).toBe(true);
  });

  test("a g-force spike needs some speed loss to count", () => {
    expect(drive(new ImpactDetector(), [50, 50, 50, 50], (index) => (index === 2 ? { AccelerationX: 100 } : {}))).toEqual([]);
    expect(drive(new ImpactDetector(), [50, 50, 44, 44], (index) => (index === 2 ? { AccelerationX: 100 } : {}))).toHaveLength(1);
  });

  test("a drop to zero with no g-force is a reset, not a crash", () => {
    expect(drive(new ImpactDetector(), [45, 45, 45, 0, 0, 0])).toEqual([]);
  });

  test("a g glitch on a return to the pits is not a crash, and a teleport cancels a pending impact", () => {
    expect(drive(new ImpactDetector(), [26, 26, 26, 0, 0], (index) => (index === 3 ? { AccelerationZ: 1067 * 9.81 } : {}))).toEqual([]);
    const detector = new ImpactDetector();
    const [impact] = drive(detector, [40, 40, 40, 20, 20], (index) => (index === 3 ? { AccelerationZ: 60 } : {}));
    expect(impact).toBeDefined();
    detector.update(packet({ Speed: 0, PositionX: 9000 }), 300);
    expect(impact!.cancelled).toBe(true);
    expect(assessCrash(impact!, null, null, first)).toBeNull();
  });

  test("a teleport back to the pits is not a crash", () => {
    const detector = new ImpactDetector();
    drive(detector, [60, 60, 60]);
    expect(detector.update(packet({ Speed: 0, PositionX: 5000 }), 200)).toBeNull();
  });

  test("an iRacing 4x incident counts as an impact", () => {
    const detector = new ImpactDetector();
    expect(detector.update(packet({ iracing: { incidents: 2 } as TelemetryPacket["iracing"] }), 0)).toBeNull();
    expect(detector.update(packet({ PositionX: 3, iracing: { incidents: 6 } as TelemetryPacket["iracing"] }), 50)).not.toBeNull();
  });
});

describe("damage readings", () => {
  test("reads F1 parts on a 0-100 scale", () => {
    const reading = readDamage(packet({ f1: { frontLeftWingDamage: 10, frontRightWingDamage: 30, tyresDamageFL: 0 } as TelemetryPacket["f1"] }));
    expect(reading?.severe).toBe(50);
    expect(reading?.parts["front wing"]).toBe(30);
  });

  test("reads ACC zones in raw units, without the centre sum", () => {
    const reading = readDamage(packet({ acc: { carDamage: { front: 12.2, rear: 0, left: 0, right: 0, centre: 12.2 } } as TelemetryPacket["acc"] }));
    expect(reading?.parts).toEqual({ front: 12.2, rear: 0, "left side": 0, "right side": 0 });
    expect(reading?.step).toBe(3);
  });

  test("games without damage telemetry read null", () => {
    expect(readDamage(packet())).toBeNull();
  });
});

describe("crash calls", () => {
  test("light contact with no damage stays silent", () => {
    expect(assessCrash(light, damage({ "front wing": 0 }), damage({ "front wing": 3 }), first)).toBeNull();
  });

  test("front wing damage explains the effect without a pit call", () => {
    const call = assessCrash(light, damage({ "front wing": 0 }), damage({ "front wing": 25 }), first);
    expect(call).toEqual({ key: "crash", priority: 1, text: "Front wing damage, expect understeer. Brake a touch earlier." });
  });

  test("heavy damage calls the car in", () => {
    const call = assessCrash(heavy, damage({ "front wing": 0 }), damage({ "front wing": 70 }), first);
    expect(call?.priority).toBe(2);
    expect(call?.text).toContain("box this lap");
  });

  test("an ACC tap stays silent, real contact is informative, a wreck is a box call", () => {
    expect(assessCrash(light, damage({ front: 0 }, 3, 60), damage({ front: 0.55 }, 3, 60), first)).toBeNull();
    expect(assessCrash(light, damage({ rear: 0 }, 3, 60), damage({ rear: 4.3 }, 3, 60), first)?.priority).toBe(1);
    expect(assessCrash(heavy, damage({ front: 32 }, 3, 60), damage({ front: 159 }, 3, 60), first)?.priority).toBe(2);
  });

  test("a puncture is always a box call", () => {
    const call = assessCrash(light, damage({ "rear-left tyre": 0 }), damage({ "rear-left tyre": 60 }), first);
    expect(call).toEqual({ key: "crash", priority: 2, text: "Puncture on the rear-left tyre. Box, box." });
  });

  test("a big hit with nothing broken says carry on", () => {
    expect(assessCrash(heavy, damage({ floor: 0 }), damage({ floor: 0 }), first)?.text).toBe("Big hit, but the car looks fine from here. Carry on.");
  });

  test("a big hit with no damage data asks the driver", () => {
    expect(assessCrash(heavy, null, null, first)?.text).toContain("tell me if it feels off");
  });

  test("boxes after damage only when the next lap is much slower", () => {
    expect(crashPaceCallout(101, 100, first)).toBeNull();
    expect(crashPaceCallout(105, 100, first)).toEqual({ key: "crash-pace", priority: 2, text: "That damage is costing 5.0 a lap. Box this lap." });
  });
});
