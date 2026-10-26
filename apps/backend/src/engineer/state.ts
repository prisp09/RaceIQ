/**
 * Rolling live state for the race engineer.
 *
 * Fed from the live telemetry tap at the broadcast rate. Keeps only what the
 * engineer talks about: lap/delta/fuel/tyre summaries and the driving issues
 * seen this lap, attributed to track corners when the track has named segments.
 */
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { LivePitData, LiveSectorData } from "@raceiq/shared/racing/live/types";
import type { TuneIssueKind } from "@raceiq/shared/racing/tuning/issues";
import type { NamedSegment } from "@raceiq/shared/racing/tracks/named-segments";
import { formatTurnNumbers, turnNumbers } from "@raceiq/shared/racing/tracks/segment-label";
import { detectLiveIssues } from "@raceiq/backend-core/ai/tune-issues";
import { resolveLapSegments } from "../tracks/corner-resolution";

export type IssueEvent = { kind: TuneIssueKind; corner: string | null; detail: string; lapNumber: number; at: number };
export type LapIssueTally = Map<TuneIssueKind, { count: number; corners: Map<string, number> }>;

/** Same issue kind closer together than this counts as one event. */
const ISSUE_DEBOUNCE_MS = 1500;

function tallyAdd(tally: LapIssueTally, event: IssueEvent): void {
  const entry = tally.get(event.kind) ?? { count: 0, corners: new Map<string, number>() };
  entry.count++;
  if (event.corner) entry.corners.set(event.corner, (entry.corners.get(event.corner) ?? 0) + 1);
  tally.set(event.kind, entry);
}

export class EngineerLiveState {
  packet: TelemetryPacket | null = null;
  sectors: LiveSectorData | null = null;
  pit: LivePitData | null = null;
  lastPacketAt = 0;
  lapIssues: LapIssueTally = new Map();
  lastLapIssues: LapIssueTally = new Map();
  lastLapNumber = -1;
  private lapStartDistance = 0;
  private segments: NamedSegment[] = [];
  private segmentsKey = "";
  private lastIssueAt = new Map<TuneIssueKind, number>();
  private lastSector = -1;

  private readonly onIssue: (event: IssueEvent) => void;
  private readonly onSector: (completedSector: number, sectors: LiveSectorData) => void;

  constructor(
    onIssue: (event: IssueEvent) => void = () => {},
    onSector: (completedSector: number, sectors: LiveSectorData) => void = () => {},
  ) {
    this.onIssue = onIssue;
    this.onSector = onSector;
  }

  get live(): boolean {
    return this.packet !== null && Date.now() - this.lastPacketAt < 5000 && this.packet.IsRaceOn !== 0;
  }

  update(packet: TelemetryPacket, sectors: LiveSectorData | null | undefined, pit: LivePitData | null | undefined): void {
    const now = Date.now();
    this.packet = packet;
    this.lastPacketAt = now;
    if (sectors) this.sectors = sectors;
    if (pit) this.pit = pit;

    const key = `${packet.gameId}|${packet.trackId}`;
    if (key !== this.segmentsKey) {
      this.segmentsKey = key;
      this.segments = [];
      void resolveLapSegments(packet.trackId, packet.gameId).then((segments) => {
        if (this.segmentsKey === key) this.segments = segments;
      });
    }

    if (packet.LapNumber !== this.lastLapNumber) {
      if (this.lastLapNumber >= 0) this.lastLapIssues = this.lapIssues;
      this.lapIssues = new Map();
      this.lastLapNumber = packet.LapNumber;
      this.lapStartDistance = packet.DistanceTraveled;
    }

    if (sectors && sectors.currentSector !== this.lastSector) {
      if (this.lastSector >= 0 && sectors.currentSector !== 0) this.onSector(this.lastSector, sectors);
      this.lastSector = sectors.currentSector;
    }

    if (packet.IsRaceOn === 0) return;
    const trackLength = this.trackLength;
    for (const issue of detectLiveIssues(packet, trackLength || undefined)) {
      if (issue.kind === "tyre-pressure" || issue.kind === "tyre-temp") continue;
      const previous = this.lastIssueAt.get(issue.kind) ?? 0;
      this.lastIssueAt.set(issue.kind, now);
      if (now - previous < ISSUE_DEBOUNCE_MS) continue;
      const event: IssueEvent = { kind: issue.kind, corner: this.cornerAt(this.lapFraction), detail: issue.detail, lapNumber: packet.LapNumber, at: now };
      tallyAdd(this.lapIssues, event);
      this.onIssue(event);
    }
  }

  /** Named track segments for the current track (empty until loaded or when the track has no map). */
  get cornerSegments(): readonly NamedSegment[] {
    return this.segments;
  }

  get trackLength(): number {
    return this.pit?.trackLength ?? 0;
  }

  /** Fraction of the current lap completed, or null when the track length is unknown. */
  get lapFraction(): number | null {
    if (!this.packet || this.trackLength <= 0) return null;
    const frac = (this.packet.DistanceTraveled - this.lapStartDistance) / this.trackLength;
    return Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : null;
  }

  cornerAt(frac: number | null): string | null {
    if (frac === null) return null;
    let count = 0;
    for (const segment of this.segments) {
      if (segment.type !== "corner") continue;
      count++;
      if (frac >= segment.startFrac && frac <= segment.endFrac) {
        const numbers = turnNumbers(segment);
        return numbers.length > 0 ? `Turn ${formatTurnNumbers(numbers)}` : `Turn ${count}`;
      }
    }
    return null;
  }

  /** Compact, unit-labelled view of the session for the engineer prompt. */
  snapshot(): Record<string, unknown> {
    const p = this.packet;
    if (!p) return { live: false };
    const s = this.sectors;
    const pit = this.pit;
    const round = (value: number | undefined, digits = 1) => value !== undefined && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
    const tallies = (tally: LapIssueTally) => Object.fromEntries([...tally].map(([kind, entry]) => [kind, { count: entry.count, corners: Object.fromEntries(entry.corners) }]));
    return {
      live: this.live,
      game: p.gameId,
      track: p.trackId,
      car: p.carModelName || p.carId,
      lap: p.LapNumber + 1,
      position: p.RacePosition || null,
      speedKph: round(p.Speed * 3.6, 0),
      gear: p.Gear,
      currentLapTimeS: round(p.CurrentLap, 2),
      lastLapTimeS: round(s?.lastLapTime ?? p.LastLap, 3),
      bestLapTimeS: round(s?.bestLapTime ?? p.BestLap, 3),
      deltaToBestS: s ? round(s.deltaToBest, 2) : null,
      predictedLapS: s ? round(s.estimatedLap, 2) : null,
      currentSector: s ? s.currentSector + 1 : null,
      lastSectorTimesS: s?.lastTimes.map((value) => round(value, 3)),
      bestSectorTimesS: s?.bestTimes.map((value) => Number.isFinite(value) ? round(value, 3) : null),
      fuelLitres: round(p.Fuel, 1),
      fuelPerLapLitres: pit ? round(pit.fuelPerLap, 2) : null,
      fuelLapsRemaining: pit?.fuelLapsRemaining != null ? round(pit.fuelLapsRemaining, 1) : null,
      tyreLapsToCritical: pit?.tireLapsToCritical != null ? round(pit.tireLapsToCritical, 1) : null,
      pitInLaps: pit?.pitInLaps ?? null,
      tyreTempsC: { FL: round(p.TireTempFL, 0), FR: round(p.TireTempFR, 0), RL: round(p.TireTempRL, 0), RR: round(p.TireTempRR, 0) },
      tyrePressures: { FL: round(p.TirePressureFrontLeft), FR: round(p.TirePressureFrontRight), RL: round(p.TirePressureRearLeft), RR: round(p.TirePressureRearRight) },
      tyreWearPct: { FL: round(p.TireWearFL * 100, 0), FR: round(p.TireWearFR * 100, 0), RL: round(p.TireWearRL * 100, 0), RR: round(p.TireWearRR * 100, 0) },
      trackTempC: round(p.TrackTemp, 0),
      airTempC: round(p.AirTemp, 0),
      issuesThisLap: tallies(this.lapIssues),
      issuesLastLap: tallies(this.lastLapIssues),
    };
  }
}
