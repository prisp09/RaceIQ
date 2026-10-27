import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { engineerService } from "../engineer/service";
import { captureBinding, INPUT_HELPER_SUPPORTED, listInputDevices } from "../engineer/input-helper";
import { synthesizeEngineerSpeech } from "../engineer/azure-tts";
import { loadSettings } from "@raceiq/backend-core/runtime/config/settings";
import { getEngineerDebrief } from "@raceiq/backend-core/db/engineer-debrief-queries";

let bindInProgress = false;

export const engineerRoutes = new Hono()
  .get("/api/engineer/state", (c) => c.json({ ...engineerService.status(), inputHelperSupported: INPUT_HELPER_SUPPORTED }))

  .post("/api/engineer/ask", zValidator("json", z.object({ text: z.string().min(1).max(500) }).strict()), async (c) => {
    const result = await engineerService.ask(c.req.valid("json").text);
    return "error" in result ? c.json(result, result.code === "EMPTY" ? 400 : 502) : c.json(result);
  })

  .post("/api/engineer/new-session", zValidator("json", z.object({ type: z.enum(["practice", "qualifying", "race"]) }).strict()), (c) => {
    engineerService.newSession(c.req.valid("json").type);
    return c.json({ ok: true });
  })

  .post("/api/engineer/tts", zValidator("json", z.object({ text: z.string().min(1).max(400) }).strict()), async (c) => {
    const settings = loadSettings({ syncLaunchOnLogin: false });
    try {
      const audio = await synthesizeEngineerSpeech(settings.engineerAzureRegion, c.req.valid("json").text, settings.engineerVoiceRate, settings.engineerVoicePitch);
      return c.body(audio, 200, { "content-type": "audio/mpeg", "cache-control": "no-store" });
    } catch (error) {
      return c.json({ code: "TTS_FAILED", error: error instanceof Error ? error.message : "Speech failed" }, 502);
    }
  })

  .get("/api/engineer/debrief/:sessionId", async (c) => {
    const sessionId = Number(c.req.param("sessionId"));
    if (!Number.isInteger(sessionId) || sessionId <= 0) return c.json({ code: "BAD_SESSION", error: "Invalid session id." }, 400);
    const debrief = await getEngineerDebrief(sessionId);
    return debrief ? c.json(debrief) : c.json({ code: "NOT_FOUND", error: "No engineer debrief for this session." }, 404);
  })

  .post("/api/engineer/repeat", (c) => {
    const entry = engineerService.repeatLast();
    return entry ? c.json({ text: entry.text }) : c.json({ code: "NOTHING_SAID", error: "Nothing to repeat yet." }, 404);
  })

  .post("/api/engineer/test", zValidator("json", z.object({ text: z.string().max(200).optional() }).strict()), (c) => {
    const text = c.req.valid("json").text?.trim() || "Radio check. Loud and clear. Let's go racing.";
    engineerService.say({ key: "test", priority: 1, text }, "ack");
    return c.json({ ok: true });
  })

  .get("/api/engineer/devices", async (c) => c.json({ supported: INPUT_HELPER_SUPPORTED, devices: await listInputDevices() }))

  .post("/api/engineer/bind", async (c) => {
    if (!INPUT_HELPER_SUPPORTED) return c.json({ code: "UNSUPPORTED", error: "Global push-to-talk is only available on Windows." }, 400);
    if (bindInProgress) return c.json({ code: "BUSY", error: "Already waiting for a button press." }, 409);
    bindInProgress = true;
    try {
      const binding = await captureBinding();
      return binding ? c.json({ binding }) : c.json({ code: "TIMEOUT", error: "No key or button was pressed." }, 408);
    } finally {
      bindInProgress = false;
    }
  });
