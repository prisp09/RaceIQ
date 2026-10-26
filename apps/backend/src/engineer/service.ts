/**
 * Live race engineer: rule-based radio calls plus AI answers to driver questions.
 *
 * Observes the live telemetry tap, speaks through `engineer-*` WebSocket
 * notifications (the browser plays them with speech synthesis), and relays
 * global push-to-talk state from the Windows input helper.
 */
import { randomUUID } from "node:crypto";
import { addLiveTelemetryTap } from "@raceiq/backend-core/live-engineer/tap";
import { loadSettings, saveSettings, type AppSettings } from "@raceiq/backend-core/runtime/config/settings";
import { wsManager } from "@raceiq/backend-core/runtime/websocket-manager";
import { resolveAi } from "../ai/ai-runtime";
import { EngineerLiveState, type IssueEvent } from "./state";
import {
  INSTRUCTION_KINDS,
  issueCallout,
  lapCompleteCallouts,
  sectorCallout,
  type Callout,
  type EngineerMode,
  type InstructionKind,
} from "./rules";
import { PushToTalkWatcher, type PushToTalkBinding } from "./input-helper";

export type TranscriptEntry = { id: string; from: "driver" | "engineer"; text: string; at: string };
export type EngineerSayKind = "callout" | "answer" | "ack";

const COOLDOWN_MS: Record<string, number> = { sector: 0, "lap-summary": 0, status: 0, "coach-lap": 0, "fuel-critical": 60_000, "tyres-critical": 60_000 };
const ISSUE_COOLDOWN_MS = 4000;
const TRANSCRIPT_LIMIT = 60;
// Replies are capped at ~35 words by the prompt; the budget is mostly for the
// model's hidden reasoning, which Claude counts against max_tokens.
export const ENGINEER_MAX_OUTPUT_TOKENS = 2000;

const SYSTEM_PROMPT = `You are the driver's race engineer on team radio during a live sim racing session. You are British, calm and concise, like a Formula 1 race engineer.
Rules:
- Reply in at most two short sentences, under 35 words. No lists, no markdown, no emojis.
- Use only the live data provided. If something isn't in the data, say you don't have it.
- Write lap times as 1:42.3 and deltas as "plus 0.4" or "minus 0.2". Round numbers for speech.
- Address the driver as "you" or "mate". Use real radio phrasing where it fits: "Copy.", "Understood.", "Push now.", "Box, box." (only when they should pit).
- If the driver asks you to start or stop calling something out repeatedly, add a last line exactly "INSTRUCTION: on <kind>" or "INSTRUCTION: off <kind>". Kinds: brake-lockup (lock-ups), understeer, oversteer, bottoming, sector-delta (sector splits), lap-delta (lap times).
- If the driver asks you to talk more or less, add a last line exactly "MODE: quiet", "MODE: normal" or "MODE: coach".`;

const COACH_PROMPT = `You are the driver's race engineer on team radio, British and calm, like a Formula 1 race engineer. After each lap you give ONE short, actionable improvement for the next lap.
Rules:
- One or two short sentences, under 30 words. No lists, no markdown, no numbers unless essential.
- Focus on the single biggest incremental gain: name the corner and what to change (braking point, entry speed, throttle timing, line, kerbs).
- Coach, don't report stats. Example: "Brake a touch earlier into Turn 2, you're running wide on exit."
- Use only the lap data given. If there are no mistakes, encourage them to keep the rhythm and push in their weakest sector.`;

/** Coach calls wait this long for Claude before using the template line. */
export const COACH_TIMEOUT_MS = 4000;

export type EngineerGenerate = (system: string, prompt: string) => Promise<string>;

const defaultGenerate: EngineerGenerate = async (system, prompt) => {
  const ai = await resolveAi("liveEngineer");
  const result = await ai.generateText({ system, prompt, temperature: 0.4, maxOutputTokens: ENGINEER_MAX_OUTPUT_TOKENS });
  return String(result.analysis ?? "");
};

export class EngineerService {
  readonly state: EngineerLiveState;
  readonly instructions = new Set<InstructionKind>();
  readonly transcript: TranscriptEntry[] = [];
  private settings: AppSettings = loadSettings({ syncLaunchOnLogin: false });
  private lastSaid = new Map<string, number>();
  private bestLap = 0;
  private sessionKey = "";
  private lapsSinceStatus = 0;
  private thinking = false;
  private untap: (() => void) | null = null;
  private settingsTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ptt: PushToTalkWatcher;

  private readonly generate: EngineerGenerate;

  constructor(generate: EngineerGenerate = defaultGenerate) {
    this.generate = generate;
    this.state = new EngineerLiveState((event) => this.onIssue(event), (sector, sectors) => this.onSector(sector, sectors));
    this.ptt = new PushToTalkWatcher(
      (pressed) => wsManager.broadcastNotification({ type: "engineer-ptt", pressed }),
      (message) => this.error("INPUT_HELPER_FAILED", message),
    );
  }

  start(): void {
    if (this.untap) return;
    this.untap = addLiveTelemetryTap({
      onTelemetry: (packet, sectors, pit) => { if (this.settings.engineerEnabled) this.state.update(packet, sectors, pit); },
      onNotification: (event) => { if (this.settings.engineerEnabled && event.type === "lap-saved") this.onLapSaved(event); },
    });
    this.refreshSettings();
    this.settingsTimer = setInterval(() => this.refreshSettings(), 2000);
  }

  stop(): void {
    this.untap?.();
    this.untap = null;
    if (this.settingsTimer) clearInterval(this.settingsTimer);
    this.settingsTimer = null;
    this.ptt.stop();
  }

  refreshSettings(): void {
    try { this.settings = loadSettings({ syncLaunchOnLogin: false }); } catch { return; }
    const wantsPtt = this.settings.engineerEnabled && this.settings.engineerMicMode === "push-to-talk";
    this.ptt.apply(wantsPtt ? this.settings.engineerPushToTalk as PushToTalkBinding | null : null);
  }

  get mode(): EngineerMode {
    return this.settings.engineerMode;
  }

  status() {
    return {
      enabled: this.settings.engineerEnabled,
      mode: this.mode,
      live: this.state.live,
      thinking: this.thinking,
      instructions: [...this.instructions],
      transcript: this.transcript.slice(-20),
    };
  }

  say(callout: Pick<Callout, "key" | "priority" | "text">, kind: EngineerSayKind = "callout"): void {
    const now = Date.now();
    const cooldown = callout.key.startsWith("issue-") ? ISSUE_COOLDOWN_MS : (COOLDOWN_MS[callout.key] ?? 0);
    const last = this.lastSaid.get(callout.key) ?? 0;
    if (kind === "callout" && cooldown > 0 && now - last < cooldown) return;
    this.lastSaid.set(callout.key, now);
    const entry = this.record("engineer", callout.text);
    wsManager.broadcastNotification({ type: "engineer-say", id: entry.id, kind, priority: callout.priority, text: callout.text, createdAt: entry.at });
  }

  async ask(question: string): Promise<{ text: string } | { error: string; code: string }> {
    const text = question.trim().slice(0, 500);
    if (!text) return { error: "Empty question", code: "EMPTY" };
    this.record("driver", text);
    this.setThinking(true);
    try {
      const recent = this.transcript.slice(-8, -1).map((entry) => `${entry.from === "driver" ? "Driver" : "Engineer"}: ${entry.text}`).join("\n");
      const prompt = [
        `Live data (JSON): ${JSON.stringify(this.state.snapshot())}`,
        `Engineer mode: ${this.mode}. Active callouts: ${[...this.instructions].join(", ") || "none"}.`,
        recent ? `Recent radio:\n${recent}` : "",
        `Driver: ${text}`,
      ].filter(Boolean).join("\n\n");
      const reply = this.applyDirectives(await this.generate(SYSTEM_PROMPT, prompt));
      this.say({ key: "answer", priority: 1, text: reply || "Say again, I didn't get that." }, "answer");
      return { text: reply };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /provider|model|key/i.test(message) ? "NO_PROVIDER" : "AI_FAILED";
      this.error(code, message);
      return { error: message, code };
    } finally {
      this.setThinking(false);
    }
  }

  /** Strips INSTRUCTION/MODE lines from a reply and applies them. */
  applyDirectives(raw: string): string {
    const kept: string[] = [];
    for (const line of raw.split("\n")) {
      const instruction = /^\s*INSTRUCTION:\s*(on|off)\s+([a-z-]+)/i.exec(line);
      const mode = /^\s*MODE:\s*(quiet|normal|coach)/i.exec(line);
      if (instruction) {
        const kind = instruction[2].toLowerCase() as InstructionKind;
        if ((INSTRUCTION_KINDS as readonly string[]).includes(kind)) {
          if (instruction[1].toLowerCase() === "on") this.instructions.add(kind); else this.instructions.delete(kind);
        }
      } else if (mode) {
        this.setMode(mode[1].toLowerCase() as EngineerMode);
      } else if (line.trim()) {
        kept.push(line.trim());
      }
    }
    return kept.join(" ").replace(/\s+/g, " ").trim();
  }

  setMode(mode: EngineerMode): void {
    try {
      const current = loadSettings({ syncLaunchOnLogin: false });
      if (current.engineerMode === mode) return;
      saveSettings({ ...current, engineerMode: mode });
      this.settings = { ...current, engineerMode: mode };
      this.broadcastState();
    } catch (error) {
      console.warn("[Engineer] Could not save mode:", error);
    }
  }

  private onLapSaved(event: Record<string, unknown>): void {
    const lapTime = Number(event.lapTime);
    if (!Number.isFinite(lapTime) || lapTime <= 0) return;
    const sessionKey = String(event.sessionId ?? "");
    if (sessionKey !== this.sessionKey) {
      this.sessionKey = sessionKey;
      this.bestLap = 0;
      this.lapsSinceStatus = 0;
    }
    const isValid = event.isValid !== false;
    this.lapsSinceStatus++;
    const mode = this.mode === "quiet" && this.instructions.has("lap-delta") ? "normal" : this.mode;
    const calls = lapCompleteCallouts(mode, {
      lapNumber: Number(event.lapNumber) || 0,
      lapTime,
      isValid,
      previousBest: this.bestLap,
      pit: this.state.pit,
      lastLapIssues: this.state.lastLapIssues.size > 0 ? this.state.lastLapIssues : this.state.lapIssues,
      lapsSinceStatus: this.lapsSinceStatus,
    });
    if (calls.some((call) => call.key === "status")) this.lapsSinceStatus = 0;
    if (isValid && (this.bestLap <= 0 || lapTime < this.bestLap)) this.bestLap = lapTime;
    const coachTemplate = calls.find((call) => call.key === "coach-lap");
    for (const call of calls) if (call !== coachTemplate) this.say(call);
    if (mode === "coach") void this.coachLap(coachTemplate, { lapNumber: Number(event.lapNumber) || 0, lapTime, isValid });
  }

  /** Coach mode: one Claude-written improvement for the next lap, falling back to the template line. */
  async coachLap(fallback: Callout | undefined, lap: { lapNumber: number; lapTime: number; isValid: boolean }): Promise<void> {
    const issues = this.state.lastLapIssues.size > 0 ? this.state.lastLapIssues : this.state.lapIssues;
    const sectors = this.state.sectors;
    const context = {
      lap: lap.lapNumber,
      lapTimeS: Number(lap.lapTime.toFixed(3)),
      valid: lap.isValid,
      bestLapS: this.bestLap > 0 ? Number(this.bestLap.toFixed(3)) : null,
      sectorDeltasToBestS: sectors?.lastTimes.map((time, index) => {
        const best = sectors.bestTimes[index];
        return time > 0 && Number.isFinite(best) && best > 0 ? Number((time - best).toFixed(2)) : null;
      }) ?? null,
      mistakesByCorner: Object.fromEntries([...issues].map(([kind, entry]) => [kind, Object.fromEntries(entry.corners)])),
    };
    let text = "";
    try {
      text = await Promise.race([
        this.generate(COACH_PROMPT, `Lap data (JSON): ${JSON.stringify(context)}`),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), COACH_TIMEOUT_MS)),
      ]);
    } catch {
      text = "";
    }
    const reply = text.replace(/\s+/g, " ").trim();
    if (reply) this.say({ key: "coach-lap", priority: 0, text: reply });
    else if (fallback) this.say(fallback);
  }

  private onIssue(event: IssueEvent): void {
    if (this.instructions.has(event.kind as InstructionKind)) this.say(issueCallout(event));
  }

  private onSector(sector: number, sectors: Parameters<typeof sectorCallout>[1]): void {
    if (!this.instructions.has("sector-delta")) return;
    const call = sectorCallout(sector, sectors);
    if (call) this.say(call);
  }

  private record(from: TranscriptEntry["from"], text: string): TranscriptEntry {
    const entry = { id: randomUUID(), from, text, at: new Date().toISOString() };
    this.transcript.push(entry);
    if (this.transcript.length > TRANSCRIPT_LIMIT) this.transcript.splice(0, this.transcript.length - TRANSCRIPT_LIMIT);
    if (from === "driver") wsManager.broadcastNotification({ type: "engineer-heard", id: entry.id, text, createdAt: entry.at });
    return entry;
  }

  private setThinking(thinking: boolean): void {
    this.thinking = thinking;
    this.broadcastState();
  }

  private broadcastState(): void {
    wsManager.broadcastNotification({ type: "engineer-state", enabled: this.settings.engineerEnabled, mode: this.mode, live: this.state.live, thinking: this.thinking });
  }

  private error(code: string, message: string): void {
    wsManager.broadcastNotification({ type: "engineer-error", code, message: message.slice(0, 300) });
  }
}

export const engineerService = new EngineerService();
