/**
 * Whole-session context for the race engineer: every lap so far, pace and
 * consistency, sector trends, recurring mistakes and what went well. Compact
 * enough to send with every question so open-ended answers have real data.
 */
import type { TuneIssueKind } from "@raceiq/shared/racing/tuning/issues";
import type { LapIssueTally } from "./state";

export type SessionLapRecord = {
  lap: number;
  timeS: number;
  valid: boolean;
  sectorTimesS: number[];
  mistakes: Partial<Record<TuneIssueKind, Record<string, number>>>;
  position: number | null;
  /** Why the lap is left out of pace analysis (out lap, idle lap...), or null for a normal lap. */
  excluded?: string | null;
};

/** A lap this much slower than the driver's usual pace is treated as an anomaly (idle, stopped, off track). */
export const ANOMALY_RATIO = 1.4;
export const ANOMALY_EXTRA_SECONDS = 30;

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * Reason to leave a lap out of pace analysis, or null. A lap that takes far
 * longer than the driver's usual lap (e.g. 5 minutes where laps are 2) means
 * they were idle or stopped, so it says nothing about their driving.
 * Needs at least two normal laps to know what "usual" is.
 */
export function anomalyReason(timeS: number, normalLapTimesS: readonly number[]): string | null {
  if (normalLapTimesS.length < 2 || !(timeS > 0)) return null;
  const usual = median(normalLapTimesS);
  if (timeS > usual * ANOMALY_RATIO || timeS > usual + ANOMALY_EXTRA_SECONDS) {
    return `far slower than usual (${timeS.toFixed(0)} s vs ~${usual.toFixed(0)} s): idle, stopped or off track`;
  }
  return null;
}

export function lapRecordFromTally(lap: number, timeS: number, valid: boolean, sectorTimesS: readonly number[], tally: LapIssueTally, position: number | null, excluded: string | null = null): SessionLapRecord {
  const mistakes: SessionLapRecord["mistakes"] = {};
  for (const [kind, entry] of tally) {
    if (kind === "tyre-pressure" || kind === "tyre-temp") continue;
    mistakes[kind] = entry.corners.size > 0 ? Object.fromEntries(entry.corners) : { "(no corner)": entry.count };
  }
  return { lap, timeS, valid, sectorTimesS: sectorTimesS.map((time) => Number(time.toFixed(3))), mistakes, position, excluded };
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

export function summarizeSession(laps: readonly SessionLapRecord[]): Record<string, unknown> {
  if (laps.length === 0) return { laps: 0 };
  // Anomalous laps (out laps, idle laps) are listed but left out of every pace statistic.
  const valid = laps.filter((lap) => lap.valid && lap.timeS > 0 && !lap.excluded);
  const times = valid.map((lap) => lap.timeS);
  const best = times.length > 0 ? Math.min(...times) : null;
  const firstHalf = times.slice(0, Math.ceil(times.length / 2));
  const secondHalf = times.slice(Math.ceil(times.length / 2));
  const average = (values: readonly number[]) => values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  const sectorCount = Math.max(0, ...valid.map((lap) => lap.sectorTimesS.length));
  const sectors = Array.from({ length: sectorCount }, (_, index) => {
    const values = valid.map((lap) => lap.sectorTimesS[index]).filter((time): time is number => typeof time === "number" && time > 0);
    const bestSector = values.length > 0 ? Math.min(...values) : null;
    const mean = average(values);
    return { sector: index + 1, bestS: bestSector === null ? null : round(bestSector, 3), averageLossS: bestSector !== null && mean !== null ? round(mean - bestSector) : null };
  });

  const mistakeCounts = new Map<string, number>();
  for (const lap of laps) {
    if (lap.excluded) continue;
    for (const [kind, corners] of Object.entries(lap.mistakes)) {
      for (const [corner, count] of Object.entries(corners ?? {})) {
        const key = corner === "(no corner)" ? kind : `${kind} at ${corner}`;
        mistakeCounts.set(key, (mistakeCounts.get(key) ?? 0) + count);
      }
    }
  }
  const recurringMistakes = [...mistakeCounts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([what, count]) => ({ what, count }));
  const cleanLaps = laps.filter((lap) => !lap.excluded && Object.keys(lap.mistakes).length === 0).length;
  const positions = laps.map((lap) => lap.position).filter((position): position is number => typeof position === "number" && position > 0);

  return {
    laps: laps.length,
    validLaps: valid.length,
    lapTimesS: laps.map((lap) => lap.excluded ? `${round(lap.timeS, 3)} (excluded: ${lap.excluded})` : lap.valid ? round(lap.timeS, 3) : `${round(lap.timeS, 3)} (invalid)`),
    excludedLaps: laps.filter((lap) => lap.excluded).length,
    bestLapS: best === null ? null : round(best, 3),
    averageValidLapS: average(times) === null ? null : round(average(times)!, 3),
    consistencyStdDevS: round(stdDev(times)),
    paceTrend: firstHalf.length > 0 && secondHalf.length > 0 ? `${round(average(secondHalf)! - average(firstHalf)!)} s second half vs first half (negative = faster)` : null,
    sectors,
    recurringMistakes,
    cleanLaps,
    startPosition: positions[0] ?? null,
    currentPosition: positions.at(-1) ?? null,
  };
}
