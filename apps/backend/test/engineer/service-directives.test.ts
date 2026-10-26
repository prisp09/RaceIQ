import { describe, expect, test } from "bun:test";
import { EngineerService } from "../../src/engineer/service";

describe("race engineer reply directives", () => {
  test("strips and applies instruction lines", () => {
    const service = new EngineerService();
    const reply = service.applyDirectives("Copy, I'll call every lock-up.\nINSTRUCTION: on brake-lockup");
    expect(reply).toBe("Copy, I'll call every lock-up.");
    expect([...service.instructions]).toEqual(["brake-lockup"]);
    expect(service.applyDirectives("Understood.\nINSTRUCTION: off brake-lockup")).toBe("Understood.");
    expect(service.instructions.size).toBe(0);
  });

  test("ignores unknown instruction kinds", () => {
    const service = new EngineerService();
    expect(service.applyDirectives("Okay.\nINSTRUCTION: on everything")).toBe("Okay.");
    expect(service.instructions.size).toBe(0);
  });
});

describe("race engineer lap calls", () => {
  test("lap-saved produces a lap summary, then a purple lap", async () => {
    const { loadSettings, saveSettings } = await import("@raceiq/backend-core/runtime/config/settings");
    const { wsManager } = await import("@raceiq/backend-core/runtime/websocket-manager");
    const { emitLiveNotification } = await import("@raceiq/backend-core/live-engineer/tap");
    saveSettings({ ...loadSettings(), engineerEnabled: true, engineerMode: "normal" });
    const said: string[] = [];
    const original = wsManager.broadcastNotification.bind(wsManager);
    wsManager.broadcastNotification = ((event: Record<string, unknown>) => { if (event.type === "engineer-say") said.push(String(event.text)); }) as typeof wsManager.broadcastNotification;
    const service = new EngineerService();
    try {
      service.start();
      emitLiveNotification({ type: "lap-saved", sessionId: 1, lapNumber: 1, lapTime: 102.34, isValid: true });
      emitLiveNotification({ type: "lap-saved", sessionId: 1, lapNumber: 2, lapTime: 102.8, isValid: true });
      emitLiveNotification({ type: "lap-saved", sessionId: 1, lapNumber: 3, lapTime: 101.9, isValid: true });
      expect(said).toEqual(["Purple lap, 1:42.3. Good job.", "1:42.8, plus 0.5.", "Purple lap, 1:41.9. Up by 0.4. Good job."]);
    } finally {
      service.stop();
      wsManager.broadcastNotification = original;
    }
  });
});
