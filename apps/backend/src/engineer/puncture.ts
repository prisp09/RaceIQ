/**
 * Puncture detection from tyre pressures, for games that send live pressures
 * (ACC, AC Evo, AMS2, LMU and F1; iRacing only sends cold pressures).
 *
 * Normal pressure changes move all four tyres together (heat build-up, a slow
 * lap, a safety car), or arrive with new tyres in the pits. A puncture is one
 * tyre losing pressure the others don't: so each tyre is compared with its
 * own recent baseline, after removing the change the other three share.
 */
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { pick, type Callout, type Rng } from "./rules";

const WHEELS = ["front left", "front right", "rear left", "rear right"] as const;
/** Pressures are sampled this often; faster adds nothing. */
const SAMPLE_MS = 100;
/** The baseline follows slow pressure changes with this time constant. */
const BASELINE_TAU_MS = 60_000;
/** Below this speed (pit lane, spins, grid) pressures aren't judged. */
const MIN_SPEED_MS = 15;
/** Seconds of driving before a baseline is trusted (after a start or a pit stop). */
const WARMUP_MS = 20_000;
/** One tyre down this far on its baseline, beyond what the others moved... */
export const PUNCTURE_DROP_PSI = 4;
/** ...for this long, is a puncture. */
export const PUNCTURE_HOLD_MS = 1500;
/** A tyre under half its axle partner's pressure is deflated, no waiting. */
const DEFLATED_RATIO = 0.5;

export type PressureSample = { psi: [number, number, number, number]; speedMs: number; inPits: boolean };

/** Live pressures in psi, or null when the game doesn't send them. */
export function readPressures(packet: TelemetryPacket): PressureSample | null {
  if (packet.gameId === "iracing") return null; // cold pressures only
  const psi = [packet.TirePressureFrontLeft, packet.TirePressureFrontRight, packet.TirePressureRearLeft, packet.TirePressureRearRight];
  if (psi.some((value) => typeof value !== "number" || !Number.isFinite(value))) return null;
  // All zero: the game isn't filling the channel (menus, replays, some cars).
  if (psi.every((value) => value === 0)) return null;
  return { psi: psi as PressureSample["psi"], speedMs: packet.Speed, inPits: inPits(packet) };
}

function inPits(packet: TelemetryPacket): boolean {
  if (packet.acc?.pitStatus && packet.acc.pitStatus !== "out") return true;
  if (packet.ams2?.inPits || packet.lmu?.inPits) return true;
  const grid = packet.f1?.grid;
  const me = grid?.find((entry) => entry.position === packet.RacePosition);
  return (me?.pitStatus ?? 0) > 0;
}

function median3(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[1]!;
}

/** Tracks per-tyre baselines and reports at most one puncture per tyre per stint. */
export class PunctureDetector {
  private baseline: number[] | null = null;
  private lastSample = 0;
  private drivingMs = 0;
  private below: (number | null)[] = [null, null, null, null];
  private reported = [false, false, false, false];
  /** Largest relative drop seen per tyre (psi), for tuning. */
  readonly worstDrop = [0, 0, 0, 0];

  reset(): void {
    this.baseline = null;
    this.lastSample = 0;
    this.drivingMs = 0;
    this.below = [null, null, null, null];
    this.reported = [false, false, false, false];
    this.worstDrop.fill(0);
  }

  /** Returns the punctured wheel index, once, when a puncture is found. */
  update(sample: PressureSample | null, nowMs: number): number | null {
    if (!sample) return null;
    const dt = this.lastSample === 0 ? SAMPLE_MS : nowMs - this.lastSample;
    if (dt < SAMPLE_MS) return null;
    this.lastSample = nowMs;
    if (sample.inPits) {
      // New tyres or a pressure change: start again once back on track.
      this.baseline = null;
      this.drivingMs = 0;
      this.below = [null, null, null, null];
      this.reported = [false, false, false, false];
      return null;
    }
    if (!this.baseline) {
      this.baseline = [...sample.psi];
      return null;
    }
    const moving = sample.speedMs >= MIN_SPEED_MS;
    if (moving) this.drivingMs += Math.min(dt, 1000);
    const deltas = sample.psi.map((psi, index) => psi - this.baseline![index]!);
    let found: number | null = null;
    for (let index = 0; index < 4; index++) {
      const shared = median3(deltas.filter((_, other) => other !== index));
      const drop = shared - deltas[index]!;
      if (moving && this.drivingMs >= WARMUP_MS) this.worstDrop[index] = Math.max(this.worstDrop[index]!, drop);
      const partner = sample.psi[index ^ 1]!;
      const deflated = partner > 0 && sample.psi[index]! < partner * DEFLATED_RATIO;
      if (!moving || this.drivingMs < WARMUP_MS || this.reported[index]) {
        this.below[index] = null;
        continue;
      }
      if (deflated || drop >= PUNCTURE_DROP_PSI) {
        this.below[index] ??= nowMs;
        if ((deflated || nowMs - this.below[index]! >= PUNCTURE_HOLD_MS) && found === null) found = index;
      } else {
        this.below[index] = null;
      }
    }
    // The baseline follows slow changes while driving, but not a tyre that is going down.
    const alpha = moving ? Math.min(1, dt / BASELINE_TAU_MS) : 0;
    this.baseline = this.baseline.map((base, index) => (this.below[index] !== null ? base : base + (sample.psi[index]! - base) * alpha));
    if (found !== null) this.reported[found] = true;
    return found;
  }
}

export function punctureCallout(wheel: number, rng: Rng = Math.random): Callout {
  const name = WHEELS[wheel]!;
  return { key: `puncture-${wheel}`, priority: 2, text: pick([`Puncture, ${name}. Box this lap.`, `We're losing pressure on the ${name}, looks like a puncture. Box, box.`], rng) };
}
