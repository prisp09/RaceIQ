/**
 * Driver dossier: a stable block of what RaceIQ knows about the driver, given
 * to every engineer AI call (questions, Coach debriefs, Co-driver tips).
 *
 * Built once per session from the stored driver profile (most specific scope
 * first), the driver's history with this car at this track, and the track's
 * corner groups. It stays byte-identical within a session so providers with
 * prompt caching can reuse it.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { readDb } from "@raceiq/backend-core/db/index";
import { driverProfiles, laps, sessions } from "@raceiq/backend-core/db/schema";
import { driverProfileScopeKey } from "@raceiq/backend-core/db/driver-profile-queries";
import type { GameId } from "@raceiq/shared/games/ids";
import type { CornerGroup } from "./co-driver";

export type DossierScope = { gameId: string; carId: string | null; trackId: string | null };

type StoredFingerprint = {
  confidence?: unknown;
  laps?: { analyzed?: number };
  style?: Record<string, unknown> | null;
  trend?: Record<string, unknown> | null;
  weaknesses?: Array<{ id?: string; label?: string; perLapFrequency?: number; medianTimeLossS?: number | null; sampleDetail?: string }>;
};

function formatLap(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "none";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(3).padStart(6, "0")}`;
}

/** Most specific stored profile for the scope: car+track, track, car, then game-wide. */
async function findProfile(scope: DossierScope) {
  const candidates: DossierScope[] = [
    scope,
    { ...scope, carId: null },
    { ...scope, trackId: null },
    { gameId: scope.gameId, carId: null, trackId: null },
  ];
  for (const candidate of candidates) {
    const key = driverProfileScopeKey({ gameId: candidate.gameId as GameId, carId: candidate.carId, trackId: candidate.trackId });
    const rows = await readDb.select().from(driverProfiles).where(eq(driverProfiles.scopeKey, key)).limit(1);
    if (rows[0]) return { row: rows[0], scope: candidate };
  }
  return null;
}

async function trackHistory(scope: DossierScope): Promise<string> {
  if (!scope.trackId) return "No track history yet.";
  const conditions = [eq(sessions.gameId, scope.gameId), eq(sessions.trackId, scope.trackId), eq(laps.isValid, true)];
  if (scope.carId) conditions.push(eq(sessions.carId, scope.carId));
  const where = and(...conditions);
  const [stats] = await readDb
    .select({ count: sql<number>`count(*)`, best: sql<number | null>`min(${laps.lapTime})` })
    .from(laps).innerJoin(sessions, eq(laps.sessionId, sessions.id)).where(where);
  if (!stats || Number(stats.count) === 0) return "No valid laps with this car at this track yet.";
  const recent = await readDb.select({ lapTime: laps.lapTime }).from(laps).innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(where).orderBy(desc(laps.id)).limit(10);
  const average = recent.length > 0 ? recent.reduce((sum, row) => sum + row.lapTime, 0) / recent.length : null;
  return `${stats.count} valid laps with this car here. Personal best ${formatLap(stats.best)}; average of the last ${recent.length} valid laps ${formatLap(average)}.`;
}

function profileText(found: Awaited<ReturnType<typeof findProfile>>): string {
  if (!found) return "No driver profile yet (it builds up as the driver records laps).";
  let fingerprint: StoredFingerprint = {};
  let plan: { headline?: string; summary?: string } = {};
  try { fingerprint = JSON.parse(found.row.fingerprint) as StoredFingerprint; } catch { /* keep empty */ }
  try { plan = JSON.parse(found.row.plan) as typeof plan; } catch { /* keep empty */ }
  const scopeLabel = found.scope.carId && found.scope.trackId ? "this car at this track" : found.scope.trackId ? "this track (any car)" : found.scope.carId ? "this car (any track)" : "all tracks in this game";
  const lines = [`Profile scope: ${scopeLabel}. Laps analysed: ${fingerprint.laps?.analyzed ?? "unknown"}. Confidence: ${JSON.stringify(fingerprint.confidence ?? "unknown")}.`];
  if (plan.headline || plan.summary) lines.push(`Trend: ${[plan.headline, plan.summary].filter(Boolean).join(" - ")}`);
  if (fingerprint.style) lines.push(`Driving style axes: ${JSON.stringify(fingerprint.style)}`);
  const weaknesses = (fingerprint.weaknesses ?? []).slice(0, 6);
  if (weaknesses.length > 0) {
    lines.push("Recurring weaknesses (most costly first):");
    for (const weakness of weaknesses) {
      const frequency = typeof weakness.perLapFrequency === "number" ? `${Math.round(weakness.perLapFrequency * 100)}% of laps` : "frequency unknown";
      const loss = typeof weakness.medianTimeLossS === "number" ? `, ~${weakness.medianTimeLossS.toFixed(2)} s lost when it happens` : "";
      const detail = weakness.sampleDetail ? ` (e.g. ${weakness.sampleDetail})` : "";
      lines.push(`- ${weakness.label ?? weakness.id ?? "unknown"}: ${frequency}${loss}${detail}`);
    }
  }
  return lines.join("\n");
}

/** Renders the dossier text. Deterministic for the same stored data, so it caches well. */
export async function buildDriverDossier(scope: DossierScope, groups: readonly CornerGroup[]): Promise<string> {
  const [found, history] = await Promise.all([findProfile(scope).catch(() => null), trackHistory(scope).catch(() => "Track history unavailable.")]);
  const corners = groups.length > 0
    ? groups.map((group) => `${group.id} ${group.label} (${Math.round(group.startFrac * 100)}-${Math.round(group.endFrac * 100)}% of the lap)`).join("; ")
    : "No corner map for this track.";
  return [
    "DRIVER DOSSIER (what RaceIQ knows about this driver; use it to personalise advice, never read it out)",
    `Game: ${scope.gameId}. Track: ${scope.trackId ?? "unknown"}. Car: ${scope.carId ?? "unknown"}.`,
    profileText(found),
    `History: ${history}`,
    `Corner groups: ${corners}`,
  ].join("\n");
}
