import { eq } from "drizzle-orm";
import { db, readDb } from "./index";
import { engineerDebriefs } from "./schema";
import { withDatabaseWrite } from "./write-coordination";

export type EngineerDebriefCall = { at: string; text: string };
export type EngineerDebrief = {
  sessionId: number;
  debrief: string;
  sessionType: string | null;
  finalPosition: number | null;
  calls: EngineerDebriefCall[];
  createdAt: string;
};

/** Saves (or replaces) the race engineer's debrief for a session. */
export async function saveEngineerDebrief(debrief: EngineerDebrief): Promise<void> {
  const row = {
    sessionId: debrief.sessionId,
    debrief: debrief.debrief,
    sessionType: debrief.sessionType,
    finalPosition: debrief.finalPosition,
    calls: JSON.stringify(debrief.calls),
    createdAt: debrief.createdAt,
  };
  await withDatabaseWrite(() => db.insert(engineerDebriefs).values(row).onConflictDoUpdate({ target: engineerDebriefs.sessionId, set: row }).run(), undefined, "save engineer debrief");
}

export async function getEngineerDebrief(sessionId: number): Promise<EngineerDebrief | null> {
  const row = await readDb.select().from(engineerDebriefs).where(eq(engineerDebriefs.sessionId, sessionId)).get();
  if (!row) return null;
  let calls: EngineerDebriefCall[] = [];
  try {
    const parsed: unknown = JSON.parse(row.calls);
    if (Array.isArray(parsed)) calls = parsed.filter((call): call is EngineerDebriefCall => typeof call?.text === "string" && typeof call?.at === "string");
  } catch {
    calls = [];
  }
  return { sessionId: row.sessionId, debrief: row.debrief, sessionType: row.sessionType, finalPosition: row.finalPosition, calls, createdAt: row.createdAt };
}
