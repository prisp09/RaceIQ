import { describe, expect, test } from "bun:test";
import { emitLiveNotification } from "@raceiq/backend-core/live-engineer/tap";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import { wsManager } from "@raceiq/backend-core/runtime/websocket-manager";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { CRASH_SETTLE_MS, EngineerService } from "../../src/engineer/service";

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
    const service = new EngineerService(undefined, () => 0);
    try {
      service.start();
      emitLiveNotification({ type: "lap-saved", sessionId: 1, lapNumber: 1, lapTime: 102.34, isValid: true });
      emitLiveNotification({ type: "lap-saved", sessionId: 1, lapNumber: 2, lapTime: 102.8, isValid: true });
      emitLiveNotification({ type: "lap-saved", sessionId: 1, lapNumber: 3, lapTime: 101.9, isValid: true });
      expect(said).toEqual(["Purple lap. 1:42.3. Good job.", "1:42.8, plus 0.5.", "Purple lap. 1:41.9. Up by 0.4. Good job."]);
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
    const service = new EngineerService(async () => { asked++; return ""; }, () => 0);
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

describe("race engineer new session", () => {
  test("clears the radio, standing orders and lap memory, and tells the AI the session type", async () => {
    const events: Record<string, unknown>[] = [];
    const original = wsManager.broadcastNotification.bind(wsManager);
    wsManager.broadcastNotification = ((event: Record<string, unknown>) => { events.push(event); }) as typeof wsManager.broadcastNotification;
    let system = "";
    const service = new EngineerService(async (prompt) => { system = prompt; return "Copy."; });
    try {
      service.applyDirectives("Copy.\nINSTRUCTION: on brake-lockup");
      service.say({ key: "test", priority: 1, text: "Radio check." }, "ack");
      service.state.lapIssues = new Map([["brake-lockup", { count: 1, corners: new Map() }]]);
      service.newSession("qualifying");
      expect(service.transcript).toEqual([]);
      expect(service.instructions.size).toBe(0);
      expect(service.state.lapIssues.size).toBe(0);
      expect(service.tips.size).toBe(0);
      expect(events.at(-1)).toEqual({ type: "engineer-reset", sessionType: "qualifying" });
      await service.ask("How am I doing?");
      expect(system).toContain("Session: qualifying. One-lap pace");
    } finally {
      wsManager.broadcastNotification = original;
    }
  });
});

describe("race engineer ignores anomalous laps", () => {
  test("an idle lap or out lap gets no lap call and doesn't count toward pace", () => {
    saveSettings({ ...loadSettings(), engineerEnabled: true, engineerMode: "normal" });
    const said: string[] = [];
    const original = wsManager.broadcastNotification.bind(wsManager);
    wsManager.broadcastNotification = ((event: Record<string, unknown>) => { if (event.type === "engineer-say") said.push(String(event.text)); }) as typeof wsManager.broadcastNotification;
    const service = new EngineerService(undefined, () => 0);
    try {
      service.start();
      emitLiveNotification({ type: "lap-saved", sessionId: 9, lapNumber: 1, lapTime: 150, isValid: true, classification: "out_lap" });
      emitLiveNotification({ type: "lap-saved", sessionId: 9, lapNumber: 2, lapTime: 120, isValid: true, classification: "pace" });
      emitLiveNotification({ type: "lap-saved", sessionId: 9, lapNumber: 3, lapTime: 121, isValid: true, classification: "pace" });
      emitLiveNotification({ type: "lap-saved", sessionId: 9, lapNumber: 4, lapTime: 300, isValid: true, classification: "pace" });
      expect(said).toEqual(["Purple lap. 2:00.0. Good job.", "2:01.0, plus 1.0. Push now."]);
      expect(service.sessionLaps.map((lap) => Boolean(lap.excluded))).toEqual([true, false, false, true]);
    } finally {
      service.stop();
      wsManager.broadcastNotification = original;
    }
  });
});

describe("race engineer crash calls", () => {
  const f1Packet = (speed: number, x: number, wing: number) =>
    ({ IsRaceOn: 1, Speed: speed, PositionX: x, PositionZ: 0, AccelerationX: 0, AccelerationZ: 0, f1: { frontLeftWingDamage: wing, frontRightWingDamage: 0 } }) as unknown as TelemetryPacket;

  test("one call after the damage settles, and the crash lap is left out of pace stats", () => {
    saveSettings({ ...loadSettings(), engineerEnabled: true, engineerMode: "normal" });
    const said: string[] = [];
    const original = wsManager.broadcastNotification.bind(wsManager);
    wsManager.broadcastNotification = ((event: Record<string, unknown>) => { if (event.type === "engineer-say") said.push(String(event.text)); }) as typeof wsManager.broadcastNotification;
    const service = new EngineerService(undefined, () => 0);
    try {
      service.start();
      emitLiveNotification({ type: "lap-saved", sessionId: 7, lapNumber: 1, lapTime: 100, isValid: true });
      emitLiveNotification({ type: "lap-saved", sessionId: 7, lapNumber: 2, lapTime: 100.4, isValid: true });
      said.length = 0;
      [60, 60, 60, 35, 10, 5].forEach((speed, index) => service.crashTick(f1Packet(speed, index * 2, index >= 4 ? 30 : 0), index * 50));
      expect(said).toEqual([]);
      service.crashTick(f1Packet(30, 20, 30), 300 + CRASH_SETTLE_MS);
      service.crashTick(f1Packet(30, 22, 30), 400 + CRASH_SETTLE_MS);
      expect(said).toEqual(["Front wing damage, expect understeer. Brake a touch earlier."]);
      emitLiveNotification({ type: "lap-saved", sessionId: 7, lapNumber: 3, lapTime: 130, isValid: true });
      expect(service.sessionLaps.at(-1)?.excluded).toBe("crash or heavy impact on this lap");
      emitLiveNotification({ type: "lap-saved", sessionId: 7, lapNumber: 4, lapTime: 104, isValid: true });
      expect(said.at(-2)).toBe("That damage is costing 3.8 a lap. Box this lap.");
    } finally {
      service.stop();
      wsManager.broadcastNotification = original;
    }
  });
});

describe("co-driver tip feedback", () => {
  const trackLength = 5000;
  const pit = { trackLength } as never;
  const segments = [{ type: "corner", name: "T1", number: 1, startFrac: 0.4, endFrac: 0.45 }];
  /** Drives one lap; `groupTimeS` is the time spent between 40% and 45% of the lap. */
  const driveLap = (service: EngineerService, lapNumber: number, groupTimeS: number, startMs: number, steps = 100) => {
    let lapTime = 0;
    let nowMs = startMs;
    for (let step = 0; step <= steps; step++) {
      const frac = step / 100;
      const inGroup = frac > 0.4 && frac <= 0.45;
      lapTime += inGroup ? groupTimeS / 5 : 1;
      nowMs += 200;
      const packet = { gameId: "acc", trackId: 1, IsRaceOn: 1, LapNumber: lapNumber, CurrentLap: lapTime, DistanceTraveled: (lapNumber + frac) * trackLength, Speed: 50, Brake: frac > 0.37 && frac < 0.4 ? 255 : 0 } as unknown as TelemetryPacket;
      service.state.update(packet, null, pit);
      service.coDriverTick(packet, nowMs);
    }
    return nowMs;
  };

  test("confirms a gain from a played tip and tells the next tip prompt", async () => {
    saveSettings({ ...loadSettings(), engineerEnabled: true, engineerMode: "co-driver" });
    const said: string[] = [];
    const original = wsManager.broadcastNotification.bind(wsManager);
    wsManager.broadcastNotification = ((event: Record<string, unknown>) => { if (event.type === "engineer-say") said.push(String(event.text)); }) as typeof wsManager.broadcastNotification;
    const prompts: string[] = [];
    const service = new EngineerService(async (_system, prompt) => { prompts.push(prompt); return '[{"group":"G1","tip":"Brake ten metres later."}]'; }, () => 0);
    try {
      service.state.update({ gameId: "acc", trackId: 1, IsRaceOn: 1, LapNumber: 0, DistanceTraveled: 0 } as unknown as TelemetryPacket, null, pit);
      await new Promise((resolve) => setTimeout(resolve, 10));
      (service.state as unknown as { segments: unknown }).segments = segments;
      let nowMs = driveLap(service, 1, 6.5, 0);
      nowMs = driveLap(service, 2, 6.2, nowMs, 0); // first packet of lap 2 closes lap 1
      await service.refreshCornerTips({ lapTime: 100, isValid: true, previousBest: 0 });
      expect(service.tips.size).toBe(1);
      said.length = 0;
      nowMs = driveLap(service, 2, 6.2, nowMs + 100_000); // the tip plays, then the group is 0.3 s quicker
      driveLap(service, 3, 6.2, nowMs, 0);
      expect(said).toEqual(["Turn 1: Brake ten metres later."]);
      await service.refreshCornerTips({ lapTime: 99.7, isValid: true, previousBest: 100 });
      expect(said.at(-1)).toBe("Good, three tenths better through Turn 1. Best yet through there.");
      expect(prompts.at(-1)).toContain('Earlier tips (JSON): [{"group":"G1","corner":"Turn 1","tip":"Brake ten metres later.","result":"gained 0.30s"}]');
    } finally {
      wsManager.broadcastNotification = original;
      saveSettings({ ...loadSettings(), engineerMode: "normal" });
    }
  });

  test("drops a repeated tip that gained nothing, and says nothing about it", async () => {
    saveSettings({ ...loadSettings(), engineerEnabled: true, engineerMode: "co-driver" });
    const said: string[] = [];
    const original = wsManager.broadcastNotification.bind(wsManager);
    wsManager.broadcastNotification = ((event: Record<string, unknown>) => { if (event.type === "engineer-say") said.push(String(event.text)); }) as typeof wsManager.broadcastNotification;
    const service = new EngineerService(async () => '[{"group":"G1","tip":"Brake ten metres later."}]', () => 0);
    try {
      service.state.update({ gameId: "acc", trackId: 1, IsRaceOn: 1, LapNumber: 0, DistanceTraveled: 0 } as unknown as TelemetryPacket, null, pit);
      await new Promise((resolve) => setTimeout(resolve, 10));
      (service.state as unknown as { segments: unknown }).segments = segments;
      let nowMs = driveLap(service, 1, 6.5, 0);
      nowMs = driveLap(service, 2, 6.6, nowMs, 0);
      await service.refreshCornerTips({ lapTime: 100, isValid: true, previousBest: 0 });
      said.length = 0;
      nowMs = driveLap(service, 2, 6.6, nowMs + 100_000); // tip plays, group gets slower
      driveLap(service, 3, 6.6, nowMs, 0);
      await service.refreshCornerTips({ lapTime: 100.1, isValid: true, previousBest: 100 });
      expect(said).toEqual(["Turn 1: Brake ten metres later."]);
      expect(service.tips.size).toBe(0);
    } finally {
      wsManager.broadcastNotification = original;
      saveSettings({ ...loadSettings(), engineerMode: "normal" });
    }
  });
});
