import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { getEngineerDebrief, saveEngineerDebrief, type EngineerDebrief } from "@raceiq/backend-core/db/engineer-debrief-queries";
import { wsManager } from "@raceiq/backend-core/runtime/websocket-manager";
import { EngineerService } from "../../src/engineer/service";
import { engineerRoutes } from "../../src/routes/engineer-routes";

const created: number[] = [];
async function createSession(): Promise<number> {
  const row = await db.insert(sessions).values({ gameId: "acc", carId: "1", trackId: "2" }).returning({ id: sessions.id }).get();
  created.push(row!.id);
  return row!.id;
}

afterEach(async () => {
  for (const id of created.splice(0)) await db.delete(sessions).where(eq(sessions.id, id)).run();
});

describe("saved engineer debriefs", () => {
  test("saves, replaces and reads a debrief with its key calls; deleting the session removes it", async () => {
    const sessionId = await createSession();
    const debrief: EngineerDebrief = { sessionId, debrief: "P3, that's a podium. Well driven.", sessionType: "race", finalPosition: 3, calls: [{ at: "2026-10-27T18:00:00.000Z", text: "Car behind within a second. Defend into Turn 1." }], createdAt: "2026-10-27T18:30:00.000Z" };
    await saveEngineerDebrief(debrief);
    expect(await getEngineerDebrief(sessionId)).toEqual(debrief);
    await saveEngineerDebrief({ ...debrief, debrief: "P2 at the flag.", finalPosition: 2 });
    expect((await getEngineerDebrief(sessionId))?.debrief).toBe("P2 at the flag.");
    const res = await engineerRoutes.request(`/api/engineer/debrief/${sessionId}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as EngineerDebrief).finalPosition).toBe(2);
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    expect(await getEngineerDebrief(sessionId)).toBeNull();
    expect((await engineerRoutes.request(`/api/engineer/debrief/${sessionId}`)).status).toBe(404);
  });

  test("the end-of-session debrief is stored with the session and its key calls", async () => {
    const saved: EngineerDebrief[] = [];
    const original = wsManager.broadcastNotification.bind(wsManager);
    wsManager.broadcastNotification = (() => {}) as typeof wsManager.broadcastNotification;
    const service = new EngineerService(async () => "P1! Brilliant drive, tidy all race.", () => 0, async (debrief) => { saved.push(debrief); });
    try {
      service.newSession("race");
      (service as unknown as { onLapSaved: (event: Record<string, unknown>) => void }).onLapSaved({ type: "lap-saved", sessionId: 42, lapNumber: 1, lapTime: 100, isValid: true });
      service.say({ key: "race-defend", priority: 1, text: "Car behind within a second. Defend into Turn 1." });
      service.say({ key: "lap-summary", priority: 1, text: "1:40.0." });
      service.say({ key: "answer", priority: 1, text: "We're fine on fuel." }, "answer");
      await service.endOfSession();
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ sessionId: 42, debrief: "P1! Brilliant drive, tidy all race.", sessionType: "race" });
      expect(saved[0]!.calls.map((call) => call.text)).toEqual(["Car behind within a second. Defend into Turn 1.", "We're fine on fuel."]);
    } finally {
      wsManager.broadcastNotification = original;
    }
  });
});
