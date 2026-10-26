import { describe, expect, test } from "bun:test";
import { saveDriverProfile } from "@raceiq/backend-core/db/driver-profile-queries";
import { buildDriverDossier } from "../../src/engineer/dossier";
import { generateWithClaude } from "../../src/engineer/claude-native";

const groups = [
  { id: "G1", label: "Turns 1 and 2", startFrac: 0.1, endFrac: 0.15 },
  { id: "G2", label: "Turn 3", startFrac: 0.25, endFrac: 0.28 },
];

describe("driver dossier", () => {
  test("explains when there is no profile or history yet and lists the corner groups", async () => {
    const dossier = await buildDriverDossier({ gameId: "acc", carId: "dossier-empty-car", trackId: "dossier-empty-track" }, groups);
    expect(dossier).toContain("No driver profile yet");
    expect(dossier).toContain("No valid laps with this car at this track yet.");
    expect(dossier).toContain("G1 Turns 1 and 2 (10-15% of the lap)");
  });

  test("uses the most specific stored profile and lists recurring weaknesses", async () => {
    await saveDriverProfile({ gameId: "acc", carId: null, trackId: "dossier-track" }, {
      poolKey: "pool",
      fingerprint: JSON.stringify({
        laps: { analyzed: 24 },
        confidence: "medium",
        style: { brakingStyle: "late" },
        weaknesses: [{ id: "driving-early-braking", label: "Early braking", perLapFrequency: 0.42, medianTimeLossS: 0.18, sampleDetail: "T1 brake 25 m early" }],
      }),
      plan: JSON.stringify({ headline: "Pace improving", summary: "Lap times dropped over the last sessions." }),
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, model: "test" },
    });
    const dossier = await buildDriverDossier({ gameId: "acc", carId: "dossier-car", trackId: "dossier-track" }, groups);
    expect(dossier).toContain("Profile scope: this track (any car). Laps analysed: 24.");
    expect(dossier).toContain("Trend: Pace improving - Lap times dropped over the last sessions.");
    expect(dossier).toContain("- Early braking: 42% of laps, ~0.18 s lost when it happens (e.g. T1 brake 25 m early)");
    // Deterministic, so it can be cached.
    expect(await buildDriverDossier({ gameId: "acc", carId: "dossier-car", trackId: "dossier-track" }, groups)).toBe(dossier);
  });
});

describe("native Claude engineer call", () => {
  test("caches the dossier and instructions, sends no sampling parameters and reports cache usage", async () => {
    let body: Record<string, unknown> = {};
    let headers = new Headers();
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      body = JSON.parse(init?.body ? String(init.body) : await request!.text());
      headers = new Headers(init?.headers ?? request?.headers);
      return new Response(JSON.stringify({
        id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: "end_turn", stop_sequence: null,
        content: [{ type: "text", text: "Copy, mate." }],
        usage: { input_tokens: 40, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 820 },
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const result = await generateWithClaude({ apiKey: "test-key", model: "claude-haiku-5-5", stablePrefix: "DRIVER DOSSIER", instructions: "You are the race engineer.", prompt: "Radio check", maxTokens: 2000 });
      expect(result).toEqual({ text: "Copy, mate.", usage: { inputTokens: 40, cacheWriteTokens: 0, cacheReadTokens: 820, outputTokens: 12 } });
      expect(headers.get("authorization")).toBe("Bearer test-key"); // current SDKs send API keys as a bearer token
      expect(body.system).toEqual([
        { type: "text", text: "DRIVER DOSSIER" },
        { type: "text", text: "You are the race engineer.", cache_control: { type: "ephemeral" } },
      ]);
      expect(body).not.toHaveProperty("temperature");
      expect(body.output_config).toEqual({ effort: "low" });
    } finally {
      globalThis.fetch = original;
    }
  });
});
