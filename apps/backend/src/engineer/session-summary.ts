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
};

export function lapRecordFromTally(lap: number, timeS: number, valid: boolean, sectorTimesS: readonly number[], tally: LapIssueTally, position: number | null): SessionLapRecord {
  const mistakes: SessionLapRecord["mistakes"] = {};
  for (const [kind, entry] of tally) {
    if (kind === "tyre-pressure" || kind === "tyre-temp") continue;
    mistakes[kind] = entry.corners.size > 0 ? Object.fromEntries(entry.corners) : { "(no corner)": entry.count };
  }
  return { lap, timeS, valid, sectorTimesS: sectorTimesS.map((time) => Number(time.toFixed(3))), mistakes, position };
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

export function summarizeSession(laps: readonly SessionLapRecord[]): Record<string, unknown> {
  if (laps.length === 0) return { laps: 0 };
  const valid = laps.filter((lap) => lap.valid && lap.timeS > 0);
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
    for (const [kind, corners] of Object.entries(lap.mistakes)) {
      for (const [corner, count] of Object.entries(corners ?? {})) {
        const key = corner === "(no corner)" ? kind : `${kind} at ${corner}`;
        mistakeCounts.set(key, (mistakeCounts.get(key) ?? 0) + count);
      }
    }
  }
  const recurringMistakes = [...mistakeCounts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([what, count]) => ({ what, count }));
  const cleanLaps = laps.filter((lap) => Object.keys(lap.mistakes).length === 0).length;
  const positions = laps.map((lap) => lap.position).filter((position): position is number => typeof position === "number" && position > 0);

  return {
    laps: laps.length,
    validLaps: valid.length,
    lapTimesS: laps.map((lap) => (lap.valid ? round(lap.timeS, 3) : `${round(lap.timeS, 3)} (invalid)`)),
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
