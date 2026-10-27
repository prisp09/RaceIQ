/**
 * Fuel and tyre strategy for the race engineer.
 *
 * Fuel use is measured per lap from clean laps only (no out/in laps, idle
 * laps or crash laps), race length comes from whatever the game reports
 * (total laps or time left), and calls are made only when the picture changes.
 */
import type { LivePitData } from "@raceiq/shared/racing/live/types";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { median } from "./session-summary";
import { pick, type Callout, type Rng } from "./rules";

export type FuelUnit = "litre" | "fraction";
/** What the game says about the session length; both null when it says nothing. */
export type RaceLength = { lapsTotal: number | null; timeLeftS: number | null };

/** Clean laps needed before the fuel estimate is trusted. */
export const MIN_FUEL_LAPS = 2;
const FUEL_HISTORY = 5;
/** Fuel saving beyond this share of a lap's use isn't realistic; plan a stop instead. */
export const MAX_SAVE_SHARE = 0.1;
/** Finishing with less than this many laps spare is "tight". */
const TIGHT_MARGIN_LAPS = 0.5;
/** Without a known race length, warn once when this little fuel is left. */
const LOW_FUEL_LAPS = 5;
/** Without a known race length, warn once when a tyre is this close to its cliff. */
const LOW_TYRE_LAPS = 5;
const WHEELS = ["front left", "front right", "rear left", "rear right"] as const;

const positive = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

/** Race length from the game: F1 and AC Evo, ACC and AMS2 (laps or time). Other games report neither. */
export function raceLength(packet: TelemetryPacket): RaceLength {
  const evo = packet.acc?.acEvo;
  if (evo) return evo.isTimedRace ? { lapsTotal: null, timeLeftS: positive(evo.sessionTimeLeftMs / 1000) } : { lapsTotal: positive(evo.sessionTotalLaps), timeLeftS: null };
  if (packet.f1) return { lapsTotal: positive(packet.f1.totalLaps), timeLeftS: null };
  if (packet.acc) {
    const laps = positive(packet.acc.sessionTotalLaps);
    return laps ? { lapsTotal: laps, timeLeftS: null } : { lapsTotal: null, timeLeftS: positive((packet.acc.sessionTimeLeftMs ?? 0) / 1000) };
  }
  if (packet.ams2) {
    const laps = positive(packet.ams2.lapsInEvent);
    return laps ? { lapsTotal: laps, timeLeftS: null } : { lapsTotal: null, timeLeftS: positive(packet.ams2.eventTimeRemainingS) };
  }
  return { lapsTotal: null, timeLeftS: null };
}

/** The driver picked Race, or (when they picked nothing) the game says it's a race. */
export function isRaceSession(packet: TelemetryPacket | null, chosen: "practice" | "qualifying" | "race" | null): boolean {
  if (chosen) return chosen === "race";
  if (!packet) return false;
  const native = packet.acc?.acEvo?.sessionType ?? packet.f1?.sessionType ?? packet.acc?.sessionType ?? packet.ams2?.sessionType ?? packet.lmu?.sessionType ?? "";
  return /^race/i.test(native);
}

/**
 * Laps still to drive, counting the one just started. `lapsCompleted` is the
 * lap that just finished. Timed races finish the lap running when the clock
 * hits zero, so time left is rounded up to whole laps at the driver's pace.
 */
export function lapsToGo(length: RaceLength, lapsCompleted: number, paceS: number | null): number | null {
  if (length.lapsTotal) return Math.max(0, length.lapsTotal - lapsCompleted);
  if (length.timeLeftS && paceS && paceS > 0) return Math.ceil(length.timeLeftS / paceS);
  return null;
}

/** Fuel used per lap, from clean laps only. */
export class FuelTracker {
  private lap = -1;
  private startFuel: number | null = null;
  private lastFuel: number | null = null;
  /** The lap just finished, when its first packet of the next lap arrived before lap-saved. */
  private finished: { start: number | null; end: number | null } | null = null;
  /** lap-saved already closed the lap in progress; its lap change carries nothing new. */
  private closedEarly = false;
  private used: number[] = [];

  update(packet: TelemetryPacket): void {
    if (!Number.isFinite(packet.Fuel)) return;
    if (packet.LapNumber !== this.lap) {
      if (this.lap !== -1 && !this.closedEarly) this.finished = { start: this.startFuel, end: this.lastFuel };
      this.closedEarly = false;
      // The first lap seen may have started before we joined: no start fuel for it.
      this.startFuel = this.lap === -1 ? null : packet.Fuel;
      this.lap = packet.LapNumber;
    }
    this.lastFuel = packet.Fuel;
  }

  /** Called on lap-saved, before or after the new lap's first packet. */
  lapComplete(excluded: boolean): void {
    const lap = this.finished ?? { start: this.startFuel, end: this.lastFuel };
    if (!this.finished) this.closedEarly = true;
    this.finished = null;
    if (excluded || lap.start === null || lap.end === null) return;
    const used = lap.start - lap.end;
    // Negative or zero: refuelled or the game doesn't drain fuel.
    if (used <= 0) return;
    this.used.push(used);
    if (this.used.length > FUEL_HISTORY) this.used.shift();
  }

  get fuel(): number | null {
    return this.lastFuel;
  }

  /** Median use of the recent clean laps, or null before there are enough. */
  get perLap(): number | null {
    return this.used.length >= MIN_FUEL_LAPS ? median(this.used) : null;
  }

  get cleanLaps(): number {
    return this.used.length;
  }

  reset(): void {
    this.lap = -1;
    this.startFuel = null;
    this.lastFuel = null;
    this.finished = null;
    this.closedEarly = false;
    this.used = [];
  }
}

export type FuelStatus = "ok" | "tight" | "save" | "stop";
export type FuelPlan = {
  unit: FuelUnit;
  fuelLeft: number;
  perLap: number;
  lapsOfFuel: number;
  lapsToGo: number | null;
  /** Spare laps of fuel at the flag; negative when short. */
  marginLaps: number | null;
  /** Fuel to save every lap to just make the flag, when short. */
  savePerLap: number | null;
  status: FuelStatus | null;
  /** A full tank covers the rest of the race, so a fuel stop now would be the last one. */
  pitWindowOpen: boolean | null;
};

export function fuelPlan(fuelLeft: number, perLap: number, toGo: number | null, unit: FuelUnit, capacity: number | null): FuelPlan {
  const lapsOfFuel = fuelLeft / perLap;
  if (toGo === null || toGo <= 0) return { unit, fuelLeft, perLap, lapsOfFuel, lapsToGo: toGo, marginLaps: null, savePerLap: null, status: null, pitWindowOpen: null };
  const marginLaps = lapsOfFuel - toGo;
  const savePerLap = marginLaps < 0 ? perLap - fuelLeft / toGo : null;
  const status: FuelStatus = marginLaps >= TIGHT_MARGIN_LAPS ? "ok" : marginLaps >= 0 ? "tight" : savePerLap !== null && savePerLap <= perLap * MAX_SAVE_SHARE ? "save" : "stop";
  const tank = unit === "fraction" ? 1 : capacity;
  const pitWindowOpen = status === "stop" && tank ? toGo * perLap <= tank : null;
  return { unit, fuelLeft, perLap, lapsOfFuel, lapsToGo: toGo, marginLaps, savePerLap, status, pitWindowOpen };
}

function laps(value: number): string {
  const rounded = Math.max(0, Math.floor(value));
  return rounded === 1 ? "1 more lap" : `${rounded} more laps`;
}

function saveAmount(plan: FuelPlan): string {
  const share = Math.max(1, Math.round(((plan.savePerLap ?? 0) / plan.perLap) * 100));
  return plan.unit === "litre" ? `${Math.max(0.1, plan.savePerLap ?? 0).toFixed(1)} litres a lap, about ${share} percent` : `about ${share} percent a lap`;
}

export type TyreTrend = { wheel: string; lapsToCliff: number; wearPerLapPct: number } | null;

/** The tyre that reaches its cliff first, when the game reports wear. */
export function worstTyre(pit: LivePitData | null): TyreTrend {
  const estimates = pit?.tireEstimates;
  if (!estimates) return null;
  let worst: TyreTrend = null;
  estimates.toCliff.forEach((lapsLeft, index) => {
    if (lapsLeft === null || !Number.isFinite(lapsLeft)) return;
    if (!worst || lapsLeft < worst.lapsToCliff) worst = { wheel: WHEELS[index]!, lapsToCliff: lapsLeft, wearPerLapPct: Number(((estimates.wearPerLap[index] ?? 0) * 100).toFixed(2)) };
  });
  return worst;
}

export type StrategyInput = {
  lapsCompleted: number;
  plan: FuelPlan | null;
  tyre: TyreTrend;
  /** F1 only: the game's suggested pit window. */
  pitWindow: { idealLap: number; latestLap: number } | null;
};

/** Decides when a strategy call is worth making: only when the picture changes. */
export class StrategyCaller {
  private lastStatus: FuelStatus | null = null;
  private fuelReported = false;
  private lowFuelSaid = false;
  private saveSaidAt = -Infinity;
  private lastSave = 0;
  private tyreSaid = false;
  private lastTyreLaps: number | null = null;
  private pitWindowSaid = "";

  reset(): void {
    this.lastStatus = null;
    this.fuelReported = false;
    this.lowFuelSaid = false;
    this.saveSaidAt = -Infinity;
    this.lastSave = 0;
    this.tyreSaid = false;
    this.lastTyreLaps = null;
    this.pitWindowSaid = "";
  }

  afterLap(input: StrategyInput, rng: Rng = Math.random): Callout[] {
    const calls: Callout[] = [];
    const fuel = this.fuelCall(input, rng);
    if (fuel) calls.push(fuel);
    const window = this.pitWindowCall(input);
    if (window) calls.push(window);
    // One strategy message per lap is plenty; fuel and the pit window come first.
    if (calls.length === 0) {
      const tyre = this.tyreCall(input);
      if (tyre) calls.push(tyre);
    }
    return calls;
  }

  private fuelCall({ plan, lapsCompleted }: StrategyInput, rng: Rng): Callout | null {
    if (!plan) return null;
    if (plan.status === null) {
      // No race length: report the estimate once, then warn once when it's low.
      if (!this.fuelReported) {
        this.fuelReported = true;
        return { key: "strategy-fuel", priority: 1, text: pick([`Fuel for ${laps(plan.lapsOfFuel)}.`, `We've got fuel for ${laps(plan.lapsOfFuel)}.`], rng) };
      }
      if (!this.lowFuelSaid && plan.lapsOfFuel <= LOW_FUEL_LAPS) {
        this.lowFuelSaid = true;
        return { key: "strategy-fuel", priority: 1, text: `Fuel for ${laps(plan.lapsOfFuel)}, start thinking about a stop.` };
      }
      return null;
    }
    const changed = plan.status !== this.lastStatus;
    // Repeat a save request only when the target grew a lot, and not every lap.
    const saveGrew = plan.status === "save" && (plan.savePerLap ?? 0) > this.lastSave * 1.5 && lapsCompleted - this.saveSaidAt >= 3;
    if (!changed && !saveGrew) return null;
    this.lastStatus = plan.status;
    this.fuelReported = true;
    const toGo = plan.lapsToGo ?? 0;
    switch (plan.status) {
      case "ok":
        return { key: "strategy-fuel", priority: 1, text: pick([`Fuel for ${laps(plan.lapsOfFuel)}, ${toGo} to go. We're fine on fuel.`, `Fuel's good: ${laps(plan.lapsOfFuel)} in the tank, ${toGo} to go.`], rng) };
      case "tight":
        return { key: "strategy-fuel", priority: 1, text: `Fuel's tight: ${laps(plan.lapsOfFuel)} in the tank, ${toGo} to go. Don't waste any.` };
      case "save":
        this.saveSaidAt = lapsCompleted;
        this.lastSave = plan.savePerLap ?? 0;
        return { key: "strategy-fuel", priority: 2, text: `Need to save ${saveAmount(plan)} to finish. Lift and coast into the big stops.` };
      case "stop":
        if (plan.pitWindowOpen) return { key: "strategy-fuel", priority: 2, text: `We can't make the end on fuel. Pit window's open, box in the next ${Math.max(1, Math.floor(plan.lapsOfFuel))} laps.` };
        return { key: "strategy-fuel", priority: 2, text: `We'll need a fuel stop. Fuel for ${laps(plan.lapsOfFuel)}, ${toGo} to go.` };
    }
  }

  private pitWindowCall({ pitWindow, lapsCompleted }: StrategyInput): Callout | null {
    if (!pitWindow || pitWindow.idealLap <= 0) return null;
    const key = `${pitWindow.idealLap}|${pitWindow.latestLap}`;
    // Open from the lap before the ideal lap, so the driver can still choose.
    if (this.pitWindowSaid === key || lapsCompleted + 2 < pitWindow.idealLap || lapsCompleted >= pitWindow.latestLap) return null;
    this.pitWindowSaid = key;
    return { key: "strategy-pit-window", priority: 1, text: pitWindow.latestLap > pitWindow.idealLap ? `Pit window's open. Ideal is lap ${pitWindow.idealLap}, latest lap ${pitWindow.latestLap}.` : `Pit window's open. Box on lap ${pitWindow.idealLap}.` };
  }

  private tyreCall({ tyre, plan }: StrategyInput): Callout | null {
    if (!tyre) return null;
    // Fresh tyres (laps to the cliff jumped up): allow a new warning for this stint.
    if (this.lastTyreLaps !== null && tyre.lapsToCliff > this.lastTyreLaps + 3) this.tyreSaid = false;
    this.lastTyreLaps = tyre.lapsToCliff;
    if (this.tyreSaid) return null;
    const toGo = plan?.lapsToGo ?? null;
    const lapsLeft = Math.max(0, Math.round(tyre.lapsToCliff));
    if (toGo !== null && toGo > 0) {
      if (tyre.lapsToCliff >= toGo) return null;
      this.tyreSaid = true;
      return { key: "strategy-tyres", priority: 1, text: `Tyres: the ${tyre.wheel} is wearing fastest, about ${lapsLeft} laps before it drops off, ${toGo} to go. Look after it.` };
    }
    if (tyre.lapsToCliff > LOW_TYRE_LAPS) return null;
    this.tyreSaid = true;
    return { key: "strategy-tyres", priority: 1, text: `Tyres: the ${tyre.wheel} has about ${lapsLeft} laps before it drops off.` };
  }
}

/** Strategy facts for driver questions ("can we make it on fuel?"). */
export function strategyContext(plan: FuelPlan | null, length: RaceLength, tyre: TyreTrend, pitWindow: StrategyInput["pitWindow"], cleanFuelLaps: number): Record<string, unknown> {
  return {
    raceLength: length.lapsTotal ? { laps: length.lapsTotal } : length.timeLeftS ? { timeLeftMin: Number((length.timeLeftS / 60).toFixed(1)) } : "not reported by the game",
    fuel: plan
      ? {
          unit: plan.unit === "litre" ? "litres" : "fraction of tank",
          left: Number(plan.fuelLeft.toFixed(plan.unit === "litre" ? 1 : 3)),
          perLap: Number(plan.perLap.toFixed(plan.unit === "litre" ? 2 : 4)),
          lapsOfFuel: Number(plan.lapsOfFuel.toFixed(1)),
          lapsToGo: plan.lapsToGo,
          spareLapsAtFlag: plan.marginLaps === null ? null : Number(plan.marginLaps.toFixed(1)),
          savePerLap: plan.savePerLap === null ? null : Number(plan.savePerLap.toFixed(plan.unit === "litre" ? 2 : 4)),
          status: plan.status,
          fuelStopWindowOpen: plan.pitWindowOpen,
          fromCleanLaps: cleanFuelLaps,
        }
      : `not enough clean laps yet (${cleanFuelLaps} of ${MIN_FUEL_LAPS})`,
    tyres: tyre ? { wearingFastest: tyre.wheel, lapsToCliff: Number(tyre.lapsToCliff.toFixed(1)), wearPerLapPct: tyre.wearPerLapPct } : "no wear data",
    gamePitWindow: pitWindow,
  };
}
