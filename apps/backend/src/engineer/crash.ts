/**
 * Crash detection for the race engineer. Pure functions and small state
 * machines: no AI, no I/O. An impact is a deceleration no brakes can produce,
 * a g-force spike, a jump in the game's damage values or (iRacing) a 4x
 * contact incident. After an impact the service waits a moment for damage
 * telemetry to settle, then asks `assessCrash` for at most one call.
 *
 * Damage data per game:
 * - F1 25: per part, 0-100 (wings, floor, diffuser, sidepod, tyres, engine, gearbox).
 * - ACC and AC Evo: bodywork by zone (front, rear, left, right, centre); scale is not documented.
 * - AMS2: aero, engine, suspension and brakes, 0-1.
 * - iRacing: no damage telemetry; incident points only.
 * - LMU and Forza Motorsport: no damage telemetry.
 */
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { pick, type Callout, type Rng } from "./rules";

const G = 9.81;
/** Speed lost inside the window that no car's brakes can manage (about 6 g). */
export const IMPACT_SPEED_DROP_MS = 15;
export const IMPACT_WINDOW_MS = 250;
/** Horizontal g that only a hit produces, confirmed by some speed loss so kerb noise doesn't count. */
export const IMPACT_G = 8;
const SPIKE_CONFIRM_DROP_MS = 4;
/** Impacts this big are worth a word even when nothing broke. */
export const HEAVY_SPEED_DROP_MS = 25;
export const HEAVY_G = 12;
/** A damage part rising this much (percent) counts as real damage, not a scrape. */
export const DAMAGE_STEP = 8;
/** A part this damaged costs real pace: box. */
export const SEVERE_DAMAGE = 50;
/** The lap after damage this much slower than usual means the damage is costing too much. */
export const CRASH_PACE_LOSS_RATIO = 1.03;

export type Impact = { at: number; speedLossMs: number; peakG: number; heavy: boolean };

/** Part label -> damage 0-100. `severity` is false when the game's scale is unknown, so values can't decide a pit call. */
export type DamageReading = { parts: Record<string, number>; severity: boolean };

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function readDamage(packet: TelemetryPacket): DamageReading | null {
  const f1 = packet.f1;
  if (f1) {
    return {
      severity: true,
      parts: {
        "front wing": Math.max(num(f1.frontLeftWingDamage), num(f1.frontRightWingDamage)),
        "rear wing": num(f1.rearWingDamage),
        floor: num(f1.floorDamage),
        diffuser: num(f1.diffuserDamage),
        sidepod: num(f1.sidepodDamage),
        "front-left tyre": num(f1.tyresDamageFL),
        "front-right tyre": num(f1.tyresDamageFR),
        "rear-left tyre": num(f1.tyresDamageRL),
        "rear-right tyre": num(f1.tyresDamageRR),
        engine: num(f1.engineDamage),
        gearbox: num(f1.gearBoxDamage),
      },
    };
  }
  const kunos = packet.acc?.carDamage;
  if (kunos) {
    // Scale isn't documented (the parser reads it as 0-1), so treat it as a fraction for size but never for a pit call.
    return { severity: false, parts: { front: num(kunos.front) * 100, rear: num(kunos.rear) * 100, "left side": num(kunos.left) * 100, "right side": num(kunos.right) * 100, bodywork: num(kunos.centre) * 100 } };
  }
  const ams2 = packet.ams2?.damage;
  if (ams2) {
    const wheels = ["front-left", "front-right", "rear-left", "rear-right"];
    const parts: Record<string, number> = { aero: num(ams2.aero) * 100, engine: num(ams2.engine) * 100 };
    wheels.forEach((wheel, index) => {
      parts[`${wheel} suspension`] = num(ams2.suspension[index]) * 100;
      parts[`${wheel} brake`] = num(ams2.brake[index]) * 100;
    });
    return { severity: true, parts };
  }
  return null;
}

type Sample = { at: number; speed: number; x: number; z: number };

/**
 * Watches speed, g-force and incidents for a hit. One impact per event; call
 * `update` with every packet. The returned impact keeps growing (speed lost,
 * peak g) for a second after the hit, so read it when the crash has settled.
 */
export class ImpactDetector {
  private samples: Sample[] = [];
  private incidents: number | null = null;
  private lastImpactAt = Number.NEGATIVE_INFINITY;
  private current: { impact: Impact; startSpeed: number } | null = null;

  update(packet: TelemetryPacket, now: number): Impact | null {
    if (packet.IsRaceOn === 0) { this.reset(); return null; }
    const sample = { at: now, speed: num(packet.Speed), x: num(packet.PositionX), z: num(packet.PositionZ) };
    const previous = this.samples.at(-1);
    // A gap in data or a jump in position is a reset or teleport to the pits, not a crash.
    if (previous) {
      const dt = (now - previous.at) / 1000;
      const moved = Math.hypot(sample.x - previous.x, sample.z - previous.z);
      if (dt > 0.5 || dt < 0 || moved > Math.max(previous.speed, sample.speed) * dt * 3 + 20) { this.samples = []; this.current = null; }
    }
    this.samples.push(sample);
    while (this.samples.length > 0 && now - this.samples[0]!.at > IMPACT_WINDOW_MS) this.samples.shift();

    const incidents = packet.iracing?.incidents;
    const incidentJump = typeof incidents === "number" && this.incidents !== null ? incidents - this.incidents : 0;
    if (typeof incidents === "number") this.incidents = incidents;

    const fastest = Math.max(...this.samples.map((entry) => entry.speed));
    const speedLossMs = Math.max(0, fastest - sample.speed);
    const peakG = Math.hypot(num(packet.AccelerationX), num(packet.AccelerationZ)) / G;
    if (this.current && now - this.current.impact.at <= 1000) {
      const impact = this.current.impact;
      impact.speedLossMs = Math.max(impact.speedLossMs, this.current.startSpeed - sample.speed);
      impact.peakG = Math.max(impact.peakG, peakG);
      impact.heavy = impact.speedLossMs >= HEAVY_SPEED_DROP_MS || impact.peakG >= HEAVY_G;
    }
    const hit = speedLossMs >= IMPACT_SPEED_DROP_MS || (peakG >= IMPACT_G && speedLossMs >= SPIKE_CONFIRM_DROP_MS) || incidentJump >= 4;
    // One impact per crash: ignore the rest of the same event (spins, second hits) for a few seconds.
    if (!hit || now - this.lastImpactAt < 3000) return null;
    this.lastImpactAt = now;
    const impact = { at: now, speedLossMs, peakG, heavy: speedLossMs >= HEAVY_SPEED_DROP_MS || peakG >= HEAVY_G };
    this.current = { impact, startSpeed: fastest };
    return impact;
  }

  reset(): void {
    this.samples = [];
    this.current = null;
  }
}

const PART_CALLS: [RegExp, string[]][] = [
  [/tyre$/, ["Puncture on the {part}. Box, box.", "That's a puncture, {part}. Box this lap."]],
  [/^front wing$|^front$/, ["{Part} damage, expect understeer. Brake a touch earlier.", "We've got {part} damage. It'll push in the slow stuff, brake a bit earlier."]],
  [/^rear wing$|^rear$/, ["{Part} damage, the rear will be loose in the quick corners. Smooth on the throttle.", "{Part} damage. Expect a nervous rear, easy on the power."]],
  [/^floor$|^diffuser$|^aero$/, ["{Part} damage, you've lost some downforce. Less grip in the fast corners.", "We've got {part} damage. Expect less grip through the quick stuff."]],
  [/side|sidepod|bodywork/, ["Some {part} damage. Small aero loss, keep going.", "{Part} damage, nothing major. Carry on."]],
  [/suspension/, ["{Part} damage. It'll feel off, take it easy over the kerbs.", "Looks like {part} damage. Stay off the kerbs."]],
  [/brake/, ["{Part} damage. Brake earlier and a bit softer.", "{Part} looks damaged, give yourself more room into the braking zones."]],
  [/engine|gearbox/, ["{Part} damage. Look after it, short-shift where you can.", "We've got {part} damage. Be gentle with it."]],
];

function partCall(part: string, rng: Rng): string {
  const options = PART_CALLS.find(([pattern]) => pattern.test(part))?.[1] ?? ["{Part} damage."];
  return pick(options, rng).replaceAll("{part}", part).replaceAll("{Part}", part.charAt(0).toUpperCase() + part.slice(1));
}

/**
 * The one call after an impact, or null when there is nothing useful to say
 * (light contact). Boxes only for damage that costs real pace or a puncture.
 */
export function assessCrash(impact: Impact, before: DamageReading | null, after: DamageReading | null, rng: Rng = Math.random): Callout | null {
  let worst: { part: string; step: number; value: number } | null = null;
  if (after) {
    for (const [part, value] of Object.entries(after.parts)) {
      const step = value - (before?.parts[part] ?? 0);
      if (step >= DAMAGE_STEP && (!worst || step > worst.step)) worst = { part, step, value };
    }
  }
  if (worst) {
    const puncture = /tyre$/.test(worst.part);
    const severe = puncture || (after!.severity && worst.value >= SEVERE_DAMAGE);
    let text = partCall(worst.part, rng);
    if (severe && !puncture) text = `${text} ${pick(["It's costing too much, box this lap.", "That's heavy, box, box."], rng)}`;
    return { key: "crash", priority: severe ? 2 : 1, text };
  }
  if (!impact.heavy) return null;
  if (after) return { key: "crash", priority: 1, text: pick(["Big hit, but the car looks fine from here. Carry on.", "That was a big one. No damage showing, keep going.", "Car looks okay after that. Carry on."], rng) };
  return { key: "crash", priority: 1, text: pick(["Big impact there. I can't see damage on this car, so tell me if it feels off.", "That was a big hit. I've got no damage data, let me know how it feels."], rng) };
}

/** After damage, a lap this much slower than usual means the car needs fixing. */
export function crashPaceCallout(lapTimeS: number, usualLapS: number, rng: Rng = Math.random): Callout | null {
  if (!(usualLapS > 0) || !(lapTimeS > usualLapS * CRASH_PACE_LOSS_RATIO)) return null;
  const loss = (lapTimeS - usualLapS).toFixed(1);
  return { key: "crash-pace", priority: 2, text: pick([`That damage is costing ${loss} a lap. Box this lap.`, `We're ${loss} off the usual pace since the hit. Box, box.`], rng) };
}
