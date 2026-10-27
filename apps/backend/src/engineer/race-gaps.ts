/**
 * Race position and gaps for the race engineer: position changes, a car
 * closing in behind, a car ahead in reach, and the gap trend lap by lap.
 * Gaps are by position (not lapped traffic) and only where the game sends them.
 */
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { pick, type Callout, type Rng } from "./rules";

export type GapReading = { position: number; aheadS: number | null; behindS: number | null };

/** A new position must hold this long before it's called (overtakes swap back and forth). */
export const POSITION_SETTLE_MS = 3000;
const POSITION_COOLDOWN_MS = 15_000;
/** Within this many seconds of the car behind or ahead: defend or attack. */
export const BATTLE_GAP_S = 1;
/** The gap must open past this before another defend/attack call (no flapping at 1.0 s). */
const BATTLE_RESET_S = 1.5;
/** One defend or attack call per this long: in a pack both would fire constantly. */
const BATTLE_COOLDOWN_MS = 90_000;
/** Let a position call finish before a battle call. */
const AFTER_POSITION_MS = 5000;
/** Lap-end gap trends only matter when the gap is this small. */
const TREND_MAX_GAP_S = 5;
const TREND_MIN_CHANGE_S = 0.2;
const TREND_EVERY_LAPS = 2;
/** A bigger change in one lap is a pit stop, an incident or a stale reading, not a trend. */
const TREND_MAX_CHANGE_S = 2;

const gap = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value !== 0 ? Math.abs(value) : null);

/** Gaps to the cars one position ahead and behind: F1, ACC, AMS2 and LMU. Other games give position only. */
export function readGaps(packet: TelemetryPacket): GapReading | null {
  const position = packet.RacePosition;
  if (!Number.isFinite(position) || position <= 0) return null;
  let aheadS: number | null = null;
  let behindS: number | null = null;
  if (packet.f1?.grid?.length) {
    aheadS = gap(packet.f1.grid.find((entry) => entry.position === position)?.deltaToCarInFront);
    behindS = gap(packet.f1.grid.find((entry) => entry.position === position + 1)?.deltaToCarInFront);
  } else if (packet.lmu) {
    aheadS = gap(packet.lmu.timeGapPlaceAhead);
    behindS = gap(packet.lmu.timeGapPlaceBehind);
  } else if (packet.ams2) {
    aheadS = gap(packet.ams2.splitTimeAheadS);
    behindS = gap(packet.ams2.splitTimeBehindS);
  } else if (packet.acc && !packet.acc.acEvo) {
    aheadS = gap(packet.acc.gapAheadS);
    behindS = gap(packet.acc.gapBehindS);
  }
  return { position, aheadS: position === 1 ? null : aheadS, behindS };
}

function tenths(seconds: number): string {
  return seconds.toFixed(1);
}

/** Decides which position and gap calls are worth the radio time. */
export class RaceGapCaller {
  private confirmed: number | null = null;
  private candidate: { position: number; since: number } | null = null;
  private lastPositionCall = -Infinity;
  private defendArmed = true;
  private attackArmed = true;
  private lastBattle = -Infinity;
  private lastLapEnd: GapReading | null = null;
  private lapsSinceTrend = TREND_EVERY_LAPS;
  latest: GapReading | null = null;

  reset(): void {
    this.confirmed = null;
    this.candidate = null;
    this.lastPositionCall = -Infinity;
    this.defendArmed = true;
    this.attackArmed = true;
    this.lastBattle = -Infinity;
    this.lastLapEnd = null;
    this.lapsSinceTrend = TREND_EVERY_LAPS;
    this.latest = null;
  }

  /**
   * Every packet. `nextCorner` names the next corner, for defend/attack calls.
   * On the opening lap (`opening`) the grid and first corners shuffle
   * everything: positions are tracked silently and battles aren't called.
   */
  tick(reading: GapReading | null, nowMs: number, nextCorner: string | null, opening = false, rng: Rng = Math.random): Callout | null {
    if (!reading) return null;
    this.latest = reading;
    if (opening) {
      this.confirmed = reading.position;
      this.candidate = null;
      return null;
    }
    const position = this.positionCall(reading.position, nowMs, rng);
    if (position) return position;
    const into = nextCorner ? `into ${nextCorner}` : "into the next braking zone";
    if (reading.behindS !== null && reading.behindS > BATTLE_RESET_S) this.defendArmed = true;
    if (reading.aheadS !== null && reading.aheadS > BATTLE_RESET_S) this.attackArmed = true;
    if (nowMs - this.lastBattle < BATTLE_COOLDOWN_MS || nowMs - this.lastPositionCall < AFTER_POSITION_MS) return null;
    // Defending comes first: losing a place costs more than a pass gains.
    if (reading.behindS !== null) {
      if (this.defendArmed && reading.behindS < BATTLE_GAP_S) {
        this.defendArmed = false;
        this.lastBattle = nowMs;
        return { key: "race-defend", priority: 1, text: pick([`Car behind within a second. Defend ${into}.`, `${tenths(reading.behindS)} to the car behind. Cover ${into}.`], rng) };
      }
    }
    if (reading.aheadS !== null && reading.position > 1) {
      if (this.attackArmed && reading.aheadS < BATTLE_GAP_S) {
        this.attackArmed = false;
        this.lastBattle = nowMs;
        return { key: "race-attack", priority: 1, text: pick([`Within a second of P${reading.position - 1}. Have a look ${into}.`, `${tenths(reading.aheadS)} to P${reading.position - 1}. Get it done ${into}.`], rng) };
      }
    }
    return null;
  }

  private positionCall(position: number, nowMs: number, rng: Rng): Callout | null {
    if (this.confirmed === null) {
      this.confirmed = position;
      return null;
    }
    if (position === this.confirmed) {
      this.candidate = null;
      return null;
    }
    if (!this.candidate || this.candidate.position !== position) {
      this.candidate = { position, since: nowMs };
      return null;
    }
    if (nowMs - this.candidate.since < POSITION_SETTLE_MS) return null;
    const previous = this.confirmed;
    this.confirmed = position;
    this.candidate = null;
    // Several places in quick succession (start, pit cycle): only the settled result is new information.
    if (nowMs - this.lastPositionCall < POSITION_COOLDOWN_MS) return null;
    this.lastPositionCall = nowMs;
    if (position < previous) {
      const places = previous - position;
      return { key: "race-position", priority: 1, text: places > 1 ? `Up ${places} places, P${position}. Good work.` : pick([`P${position}. Nice move.`, `Up to P${position}, well done.`, `That's P${position}. Lovely.`], rng) };
    }
    const places = position - previous;
    return { key: "race-position", priority: 1, text: places > 1 ? `Down to P${position}. Reset and go again.` : pick([`Lost a place, P${position}.`, `P${position} now. Stay with them.`], rng) };
  }

  /** At each lap end: is the gap ahead or behind changing? At most every other lap. */
  lapEnd(reading: GapReading | null): Callout | null {
    const previous = this.lastLapEnd;
    this.lastLapEnd = reading;
    this.lapsSinceTrend++;
    if (!reading || !previous || previous.position !== reading.position || this.lapsSinceTrend < TREND_EVERY_LAPS) return null;
    const change = (now: number | null, before: number | null) =>
      now !== null && before !== null && now !== before && now < TREND_MAX_GAP_S && Math.abs(before - now) <= TREND_MAX_CHANGE_S ? before - now : null;
    const ahead = change(reading.aheadS, previous.aheadS);
    const behind = change(reading.behindS, previous.behindS);
    let call: Callout | null = null;
    // Under threat comes first; then the chase.
    if (behind !== null && behind >= TREND_MIN_CHANGE_S) {
      call = { key: "race-gap", priority: 1, text: `Car behind is closing, gap ${tenths(reading.behindS!)}. They took ${tenths(behind)} that lap.` };
    } else if (ahead !== null && ahead >= TREND_MIN_CHANGE_S) {
      call = { key: "race-gap", priority: 1, text: `Gap to P${reading.position - 1} is ${tenths(reading.aheadS!)}, closing. ${tenths(ahead)} that lap.` };
    } else if (ahead !== null && -ahead >= TREND_MIN_CHANGE_S * 2) {
      call = { key: "race-gap", priority: 1, text: `P${reading.position - 1} is pulling away, gap ${tenths(reading.aheadS!)}.` };
    }
    if (call) this.lapsSinceTrend = 0;
    return call;
  }

  /** Position and gaps for driver questions. */
  context(): Record<string, unknown> {
    const reading = this.latest;
    if (!reading) return { position: "not reported by the game" };
    return { position: reading.position, gapAheadS: reading.aheadS === null ? null : Number(reading.aheadS.toFixed(1)), gapBehindS: reading.behindS === null ? null : Number(reading.behindS.toFixed(1)) };
  }
}
