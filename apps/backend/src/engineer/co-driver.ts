/**
 * Co-driver mode: turn-by-turn tips before each corner.
 *
 * AI latency is far too high to react inside a corner, so the plan is:
 * group nearby corners (chicanes, esses) from the track map, record how the
 * driver took each group on the last lap, ask the AI once per lap for a short
 * tip per group, then play cached tips just before each group's braking zone.
 */
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { NamedSegment } from "@raceiq/shared/racing/tracks/named-segments";
import { turnNumbers } from "@raceiq/shared/racing/tracks/segment-label";

export type CornerGroup = { id: string; label: string; startFrac: number; endFrac: number };
export type CornerGroupStats = {
  id: string;
  entryKph: number;
  minKph: number;
  exitKph: number;
  /** Metres before the group's entry where the brake first went past 20%, or null for no braking. */
  brakeMetresBeforeEntry: number | null;
  timeS: number;
  /** Lap fraction of the brake point (or the group entry when no braking). */
  brakeFrac: number;
};

/** Corners closer than this (end of one to start of the next) are called out together. */
export const GROUP_GAP_METRES = 150;
/** Default for "Tip timing": speech finishes this many seconds before the braking point. */
export const DEFAULT_TIP_LEAD_S = 5;
/** Speaking rate used to estimate how long a tip takes to say. */
const WORDS_PER_SECOND = 2.7;
const BRAKE_ON = 0.2;
/** How far before a group's entry we look for the braking point, as metres. */
const BRAKE_SEARCH_METRES = 250;

function joinNumbers(numbers: number[]): string {
  if (numbers.length <= 1) return `Turn ${numbers[0]}`;
  return `Turns ${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
}

/** Merge corner segments separated by less than `gapMetres` into one call-out group. */
export function groupCorners(segments: readonly NamedSegment[], trackLength: number, gapMetres = GROUP_GAP_METRES): CornerGroup[] {
  const corners = segments.filter((segment) => segment.type === "corner" && segment.endFrac > segment.startFrac)
    .sort((a, b) => a.startFrac - b.startFrac);
  const groups: { segments: NamedSegment[]; startFrac: number; endFrac: number }[] = [];
  for (const corner of corners) {
    const last = groups.at(-1);
    const gapMetresToLast = last && trackLength > 0 ? (corner.startFrac - last.endFrac) * trackLength : Infinity;
    if (last && gapMetresToLast < gapMetres) {
      last.segments.push(corner);
      last.endFrac = Math.max(last.endFrac, corner.endFrac);
    } else {
      groups.push({ segments: [corner], startFrac: corner.startFrac, endFrac: corner.endFrac });
    }
  }
  let fallbackNumber = 0;
  return groups.map((group, index) => {
    const numbers = group.segments.flatMap((segment) => {
      const found = turnNumbers(segment);
      if (found.length > 0) return found;
      fallbackNumber++;
      return [fallbackNumber];
    });
    const unique = [...new Set(numbers)].sort((a, b) => a - b);
    return { id: `G${index + 1}`, label: joinNumbers(unique), startFrac: group.startFrac, endFrac: group.endFrac };
  });
}

/** Records how each corner group was driven during the current lap. */
export class CornerLapRecorder {
  private readonly groups: CornerGroup[];
  private readonly trackLength: number;
  private stats = new Map<string, CornerGroupStats & { entered: boolean; exited: boolean; entryTime: number }>();
  private brakeCandidate = new Map<string, number>();

  constructor(groups: CornerGroup[], trackLength: number) {
    this.groups = groups;
    this.trackLength = trackLength;
  }

  update(packet: TelemetryPacket, frac: number): void {
    const kph = packet.Speed * 3.6;
    const braking = packet.Brake / 255 > BRAKE_ON;
    const searchFrac = this.trackLength > 0 ? BRAKE_SEARCH_METRES / this.trackLength : 0;
    for (const group of this.groups) {
      if (braking && frac >= group.startFrac - searchFrac && frac < group.startFrac && !this.brakeCandidate.has(group.id)) {
        this.brakeCandidate.set(group.id, frac);
      }
      const inside = frac >= group.startFrac && frac <= group.endFrac;
      let entry = this.stats.get(group.id);
      if (inside && !entry) {
        const brakeFrac = this.brakeCandidate.get(group.id) ?? null;
        entry = {
          id: group.id, entryKph: kph, minKph: kph, exitKph: kph, timeS: 0, entered: true, exited: false, entryTime: packet.CurrentLap,
          brakeFrac: brakeFrac ?? group.startFrac,
          brakeMetresBeforeEntry: brakeFrac === null ? null : Math.round((group.startFrac - brakeFrac) * this.trackLength),
        };
        this.stats.set(group.id, entry);
      }
      if (!entry || entry.exited) continue;
      if (inside) {
        entry.minKph = Math.min(entry.minKph, kph);
        entry.exitKph = kph;
      } else if (frac > group.endFrac) {
        entry.exited = true;
        entry.timeS = Math.max(0, packet.CurrentLap - entry.entryTime);
      }
    }
  }

  /** Groups that were fully driven this lap. */
  finish(): CornerGroupStats[] {
    return [...this.stats.values()].filter((entry) => entry.exited).map(({ entered: _e, exited: _x, entryTime: _t, ...stats }) => ({
      ...stats,
      entryKph: Math.round(stats.entryKph),
      minKph: Math.round(stats.minKph),
      exitKph: Math.round(stats.exitKph),
      timeS: Number(stats.timeS.toFixed(2)),
    }));
  }
}

/** Seconds needed to say a tip out loud. */
export function speechSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1.5, words / WORDS_PER_SECOND);
}

/** Lap fraction at which to start a tip so it finishes `leadSeconds` before the braking point at the current speed. */
export function tipTriggerFrac(brakeFrac: number, speedMps: number, trackLength: number, text: string, leadSeconds = DEFAULT_TIP_LEAD_S): number {
  if (trackLength <= 0) return brakeFrac;
  const leadMetres = Math.max(0, speedMps) * (speechSeconds(text) + leadSeconds);
  return brakeFrac - leadMetres / trackLength;
}

export type CachedTip = { groupId: string; label: string; text: string; brakeFrac: number };

/**
 * Plays cached tips once per lap, ahead of each group's braking point. Never
 * overlaps speech; a tip that can no longer finish before the braking point is
 * dropped for this lap.
 */
export class TipScheduler {
  private tips: CachedTip[] = [];
  private handled = new Set<string>();
  private busyUntil = 0;
  private leadSeconds = DEFAULT_TIP_LEAD_S;

  setLeadSeconds(seconds: number): void {
    this.leadSeconds = Math.min(10, Math.max(2, seconds));
  }

  setTips(tips: CachedTip[]): void {
    this.tips = [...tips].sort((a, b) => a.brakeFrac - b.brakeFrac);
  }

  get size(): number {
    return this.tips.length;
  }

  newLap(): void {
    this.handled.clear();
  }

  /** Returns the tip to speak now, if any. */
  update(frac: number, speedMps: number, trackLength: number, nowMs: number): CachedTip | null {
    for (const tip of this.tips) {
      if (this.handled.has(tip.groupId)) continue;
      const trigger = tipTriggerFrac(tip.brakeFrac, speedMps, trackLength, tip.text, this.leadSeconds);
      if (frac < trigger) continue;
      const secondsToBrake = speedMps > 0 ? ((tip.brakeFrac - frac) * trackLength) / speedMps : 0;
      // Stale: at or past the braking point, or too late to finish speaking before it.
      if (frac >= tip.brakeFrac || secondsToBrake < speechSeconds(tip.text)) { this.handled.add(tip.groupId); continue; }
      if (nowMs < this.busyUntil) {
        // Still speaking. Drop the tip if waiting would make it finish after the braking point.
        if ((this.busyUntil - nowMs) / 1000 + speechSeconds(tip.text) > secondsToBrake) this.handled.add(tip.groupId);
        continue;
      }
      this.handled.add(tip.groupId);
      this.busyUntil = nowMs + speechSeconds(tip.text) * 1000;
      return tip;
    }
    return null;
  }

  /** Other speech (answers, callouts) also occupies the radio. */
  markBusy(untilMs: number): void {
    this.busyUntil = Math.max(this.busyUntil, untilMs);
  }
}

/** Parses the AI reply: JSON array of {group, tip}, tolerating surrounding text. */
export function parseTips(raw: string, groups: readonly CornerGroup[], stats: readonly CornerGroupStats[]): CachedTip[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const byId = new Map(groups.map((group) => [group.id, group]));
  const brakeById = new Map(stats.map((entry) => [entry.id, entry.brakeFrac]));
  const tips: CachedTip[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const id = String((item as { group?: unknown }).group ?? "");
    const text = String((item as { tip?: unknown }).tip ?? "").replace(/\s+/g, " ").trim();
    const group = byId.get(id);
    if (!group || !text) continue;
    tips.push({ groupId: id, label: group.label, text: text.toLowerCase().startsWith(group.label.toLowerCase()) ? text : `${group.label}: ${text}`, brakeFrac: brakeById.get(id) ?? group.startFrac });
  }
  return tips;
}
