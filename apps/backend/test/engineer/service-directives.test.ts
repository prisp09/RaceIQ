import { describe, expect, test } from "bun:test";
import { emitLiveNotification } from "@raceiq/backend-core/live-engineer/tap";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import { wsManager } from "@raceiq/backend-core/runtime/websocket-manager";
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
  test("lap-saved produces a lap summary, then a purple lap", () => {
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
      expect(said).toEqual(["Purple lap, mate. 1:42.3. Good job.", "1:42.8, plus 0.5.", "Purple lap, mate. 1:41.9. Up by 0.4. Good job."]);
    } finally {
      service.stop();
      wsManager.broadcastNotification = original;
    }
  });
});

describe("race engineer coach calls", () => {
  const capture = () => {
    const said: string[] = [];
    const original = wsManager.broadcastNotification.bind(wsManager);
    wsManager.broadcastNotification = ((event: Record<string, unknown>) => { if (event.type === "engineer-say") said.push(String(event.text)); }) as typeof wsManager.broadcastNotification;
    return { said, restore: () => { wsManager.broadcastNotification = original; } };
  };
  const lap = { lapNumber: 3, lapTime: 102.34, isValid: true, previousBest: 102.1 };

  test("speaks Claude's debrief and sends it the lap's mistakes by corner", async () => {
    const { said, restore } = capture();
    let prompt = "";
    const service = new EngineerService(async (_system, lapPrompt) => { prompt = lapPrompt; return "1:42.3, two tenths off. Brake a touch earlier into Turn 1, you're running wide on exit."; });
    service.state.lastLapIssues = new Map([["brake-lockup", { count: 2, corners: new Map([["Turn 1", 2]]) }]]);
    try {
      await service.coachLap(lap);
      expect(said).toEqual(["1:42.3, two tenths off. Brake a touch earlier into Turn 1, you're running wide on exit."]);
      expect(prompt).toContain('"mistakesByCorner":{"brake-lockup":{"Turn 1":2}}');
      expect(prompt).toContain('"previousBestLapS":102.1');
    } finally {
      restore();
    }
  });

  test("says nothing when Claude fails", async () => {
    const { said, restore } = capture();
    const service = new EngineerService(async () => { throw new Error("AI_FAILED"); });
    try {
      await service.coachLap(lap);
      expect(said).toEqual([]);
    } finally {
      restore();
    }
  });

  test("coach mode skips the lap-summary template and keeps critical calls", async () => {
    saveSettings({ ...loadSettings(), engineerEnabled: true, engineerMode: "coach" });
    const { said, restore } = capture();
    let asked = 0;
    const service = new EngineerService(async () => { asked++; return ""; });
    service.state.pit = { fuelPerLap: 2.5, fuelLapsRemaining: 1.2, tireLapsToCritical: 20 } as never;
    try {
      service.start();
      emitLiveNotification({ type: "lap-saved", sessionId: 7, lapNumber: 1, lapTime: 102.34, isValid: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(said).toEqual(["Box, box. Fuel is critical, about 1.2 laps left."]);
      expect(asked).toBe(1);
    } finally {
      service.stop();
      restore();
      saveSettings({ ...loadSettings(), engineerMode: "normal" });
    }
  });
});
