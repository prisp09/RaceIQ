/**
 * Rule-based race engineer callouts. Pure functions: no AI, no I/O, so
 * proactive calls are instant and free. The service applies mode filtering,
 * cooldowns and the speech queue.
 */
import type { TuneIssueKind } from "@raceiq/shared/racing/tuning/issues";
import type { LivePitData, LiveSectorData } from "@raceiq/shared/racing/live/types";
import type { IssueEvent, LapIssueTally } from "./state";

export type EngineerMode = "quiet" | "normal" | "coach" | "co-driver";
export type CalloutPriority = 0 | 1 | 2;
export type Callout = { key: string; priority: CalloutPriority; text: string };

/** Standing instructions the driver can switch on by voice. */
export const INSTRUCTION_KINDS = ["brake-lockup", "understeer", "oversteer", "bottoming", "sector-delta", "lap-delta"] as const;
export type InstructionKind = (typeof INSTRUCTION_KINDS)[number];

export function formatLapTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "no time";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return minutes > 0 ? `${minutes}:${rest.toFixed(1).padStart(4, "0")}` : `${rest.toFixed(1)} seconds`;
}

export function formatDelta(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs < 0.05) return "dead on your best";
  return `${seconds > 0 ? "plus" : "minus"} ${abs.toFixed(abs < 10 ? 1 : 0)}`;
}

const ISSUE_WORDS: Record<TuneIssueKind, string> = {
  "brake-lockup": "Lock-up",
  understeer: "Understeer",
  oversteer: "Oversteer",
  bottoming: "Bottoming out",
  "tyre-pressure": "Tyre pressures",
  "tyre-temp": "Tyre temps",
};

const ISSUE_ADVICE: Partial<Record<TuneIssueKind, string>> = {
  "brake-lockup": "Ease the initial brake pressure.",
  understeer: "Slower in, let the front bite.",
  oversteer: "Smoother on the throttle out.",
  bottoming: "Watch the kerbs there.",
};

export type LapCompleteInput = {
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  previousBest: number;
  pit: LivePitData | null;
  lastLapIssues: LapIssueTally;
  lapsSinceStatus: number;
};

/** Calls after a completed lap, filtered by mode. */
export function lapCompleteCallouts(mode: EngineerMode, input: LapCompleteInput): Callout[] {
  const calls: Callout[] = [];
  const { lapTime, isValid, previousBest, pit } = input;

  if (pit?.fuelLapsRemaining != null && pit.fuelLapsRemaining > 0 && pit.fuelLapsRemaining < 2) {
    calls.push({ key: "fuel-critical", priority: 2, text: `Box, box. Fuel is critical, about ${pit.fuelLapsRemaining.toFixed(1)} laps left.` });
  }
  if (pit?.tireLapsToCritical != null && pit.tireLapsToCritical <= 2) {
    calls.push({ key: "tyres-critical", priority: 2, text: `Box, box. Tyres are almost gone, roughly ${Math.max(0, Math.round(pit.tireLapsToCritical))} laps left in them.` });
  }
  if (mode === "quiet") return calls;

  if (!isValid) {
    calls.push({ key: "lap-summary", priority: 1, text: `Copy, lap ${input.lapNumber} invalidated. ${formatLapTime(lapTime)}.` });
  } else if (previousBest <= 0 || lapTime < previousBest - 0.0005) {
    const gain = previousBest > 0 ? ` Up by ${(previousBest - lapTime).toFixed(1)}.` : "";
    calls.push({ key: "lap-summary", priority: 1, text: `Purple lap, mate. ${formatLapTime(lapTime)}.${gain} Good job.` });
  } else {
    const delta = lapTime - previousBest;
    const nudge = delta > 0.5 ? " Push now." : "";
    calls.push({ key: "lap-summary", priority: 1, text: `${formatLapTime(lapTime)}, ${formatDelta(delta)}.${nudge}` });
  }

  if (input.lapsSinceStatus >= 5 && pit) {
    const parts: string[] = [];
    if (pit.fuelLapsRemaining != null && pit.fuelLapsRemaining >= 2) parts.push(`fuel for ${Math.floor(pit.fuelLapsRemaining)} laps`);
    if (pit.tireLapsToCritical != null && pit.tireLapsToCritical > 2) parts.push(`tyres good for about ${Math.round(pit.tireLapsToCritical)}`);
    if (parts.length > 0) calls.push({ key: "status", priority: 0, text: `Status check: ${parts.join(", ")}.` });
  }

  if (mode === "coach") {
    const note = topMistake(input.lastLapIssues);
    if (note) calls.push({ key: "coach-lap", priority: 0, text: note });
  }
  return calls;
}

/** The most repeated issue of the lap, phrased as one short coaching line. */
export function topMistake(tally: LapIssueTally): string | null {
  let best: { kind: TuneIssueKind; count: number; corner: string | null; cornerCount: number } | null = null;
  for (const [kind, entry] of tally) {
    if (kind === "tyre-pressure" || kind === "tyre-temp") continue;
    let corner: string | null = null;
    let cornerCount = 0;
    for (const [label, count] of entry.corners) if (count > cornerCount) { corner = label; cornerCount = count; }
    if (!best || entry.count > best.count) best = { kind, count: entry.count, corner, cornerCount };
  }
  if (!best) return null;
  const where = best.corner ? ` into ${best.corner}` : "";
  return `${ISSUE_WORDS[best.kind]}${where}. ${ISSUE_ADVICE[best.kind] ?? ""}`.trim();
}

/** Immediate call for a live issue the driver asked to hear about. */
export function issueCallout(event: IssueEvent): Callout {
  return { key: `issue-${event.kind}`, priority: 1, text: event.corner ? `${ISSUE_WORDS[event.kind]}, ${event.corner}.` : `${ISSUE_WORDS[event.kind]}.` };
}

/** Sector split versus the driver's best sector. */
export function sectorCallout(completedSector: number, sectors: LiveSectorData): Callout | null {
  const time = sectors.currentTimes[completedSector] || sectors.lastTimes[completedSector];
  const best = sectors.bestTimes[completedSector];
  if (!Number.isFinite(time) || time <= 0) return null;
  const label = `Sector ${completedSector + 1}`;
  if (!Number.isFinite(best) || best <= 0) return { key: "sector", priority: 0, text: `${label}, ${time.toFixed(1)}.` };
  const delta = time - best;
  return { key: "sector", priority: 0, text: delta <= 0 ? `${label}, purple, ${formatDelta(delta)}.` : `${label}, ${formatDelta(delta)}.` };
}
