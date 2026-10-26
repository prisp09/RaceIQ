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
import { CornerLapRecorder, groupCorners, parseTips, speechSeconds, TipScheduler, type CornerGroup, type CornerGroupStats } from "./co-driver";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

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
- If the driver asks you to talk more or less, add a last line exactly "MODE: quiet", "MODE: normal", "MODE: coach" or "MODE: co-driver".`;

const COACH_PROMPT = `You are the driver's race engineer on team radio, British and calm, like a Formula 1 race engineer. After each lap you give a short debrief for the next lap.
Rules:
- Two or three short sentences, under 40 words. No lists, no markdown.
- Start with the lap time against their best in a few words (e.g. "1:42.3, two tenths off.", "Purple lap, mate."). Say "lap invalidated" if it was invalid.
- Then one or two incremental improvements: name the corner and what to change (braking point, entry speed, throttle timing, line, kerbs). Coach, don't list stats.
- Radio style: "mate", "copy", "push now" where they fit. Example: "1:42.3, two tenths off. Brake a touch earlier into Turn 2, you're running wide on exit."
- Use only the lap data given. If there are no mistakes, tell them to keep the rhythm and push in their weakest sector.`;

const CO_DRIVER_PROMPT = `You are a co-driver on team radio, British and calm. From the driver's last lap you write short tips that will be read out just before each corner group on the next lap.
Rules:
- Reply with ONLY a JSON array: [{"group":"G1","tip":"..."}]. No other text.
- Each tip is 6 to 12 words, radio style, one concrete change: braking point, entry speed, line, kerbs or throttle. Example: "Brake ten metres later, use the kerb on exit."
- Do not repeat the corner name; it is added for you.
- Only include groups with real time to gain (slower than the best lap through that group, or a mistake there). Skip the rest. At most 5 tips.
- Use only the data given. If no group has time to gain, reply [].`;

/** Tip generation runs in the background while the next lap starts. */
const CO_DRIVER_TIMEOUT_MS = 15_000;
/** Lap-saved arrives just before the first packet of the new lap; let the recorder close the lap first. */
const CO_DRIVER_SETTLE_MS = 300;

/** Coach debriefs are skipped if Claude takes longer than this. */
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
  readonly tips = new TipScheduler();
  private coGroups: CornerGroup[] = [];
  private coGroupsKey = "";
  private coRecorder: CornerLapRecorder | null = null;
  private coLapNumber = -1;
  private coLastTick = 0;
  lastLapCornerStats: CornerGroupStats[] = [];
  bestLapCornerStats: CornerGroupStats[] = [];

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
      onTelemetry: (packet, sectors, pit) => {
        if (!this.settings.engineerEnabled) return;
        this.state.update(packet, sectors, pit);
        if (this.mode === "co-driver") this.coDriverTick(packet);
      },
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
    this.tips.setLeadSeconds(this.settings.engineerTipLeadSeconds);
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
    this.tips.markBusy(now + speechSeconds(callout.text) * 1000);
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
      const mode = /^\s*MODE:\s*(quiet|normal|coach|co-driver)/i.exec(line);
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
    const previousBest = this.bestLap;
    this.lapsSinceStatus++;
    const mode = this.mode === "quiet" && this.instructions.has("lap-delta") ? "normal" : this.mode;
    const calls = lapCompleteCallouts(mode, {
      lapNumber: Number(event.lapNumber) || 0,
      lapTime,
      isValid,
      previousBest,
      pit: this.state.pit,
      lastLapIssues: this.state.lastLapIssues.size > 0 ? this.state.lastLapIssues : this.state.lapIssues,
      lapsSinceStatus: this.lapsSinceStatus,
    });
    if (calls.some((call) => call.key === "status")) this.lapsSinceStatus = 0;
    if (isValid && (this.bestLap <= 0 || lapTime < this.bestLap)) this.bestLap = lapTime;
    if (mode !== "coach" && mode !== "co-driver") {
      for (const call of calls) this.say(call);
      return;
    }
    // Coach and Co-driver: critical calls stay instant; AI replaces every other after-lap call.
    for (const call of calls) if (call.priority === 2) this.say(call);
    const lap = { lapNumber: Number(event.lapNumber) || 0, lapTime, isValid, previousBest };
    // Co-driver without a corner map (or before one loads) behaves like Coach.
    const coDriver = mode === "co-driver" && this.coGroups.length > 0;
    void this.coachLap(lap, coDriver);
    if (coDriver) setTimeout(() => void this.refreshCornerTips(lap), CO_DRIVER_SETTLE_MS);
  }

  /** Co-driver: records each corner group and plays cached tips ahead of braking zones. */
  coDriverTick(packet: TelemetryPacket, nowMs = Date.now()): void {
    const trackLength = this.state.trackLength;
    const segments = this.state.cornerSegments;
    const key = `${packet.gameId}|${packet.trackId}|${segments.length}|${Math.round(trackLength)}`;
    if (key !== this.coGroupsKey) {
      this.coGroupsKey = key;
      this.coGroups = trackLength > 0 ? groupCorners(segments, trackLength) : [];
      this.coRecorder = null;
      this.tips.setTips([]);
      this.lastLapCornerStats = [];
      this.bestLapCornerStats = [];
    }
    if (this.coGroups.length === 0) return;
    if (packet.LapNumber !== this.coLapNumber || !this.coRecorder) {
      if (this.coRecorder && packet.LapNumber !== this.coLapNumber) this.lastLapCornerStats = this.coRecorder.finish();
      this.coRecorder = new CornerLapRecorder(this.coGroups, trackLength);
      this.coLapNumber = packet.LapNumber;
      this.tips.newLap();
    }
    const frac = this.state.lapFraction;
    if (frac === null) return;
    this.coRecorder.update(packet, frac);
    if (nowMs - this.coLastTick < 100) return;
    this.coLastTick = nowMs;
    const tip = this.tips.update(frac, packet.Speed, trackLength, nowMs);
    if (tip) this.say({ key: `tip-${tip.groupId}`, priority: 0, text: tip.text });
  }

  /** One AI call per lap: a short tip per corner group with time to gain. Keeps the last good tips on failure. */
  async refreshCornerTips(lap: { lapTime: number; isValid: boolean; previousBest: number }): Promise<void> {
    const last = this.lastLapCornerStats;
    if (last.length === 0) return;
    const best = new Map(this.bestLapCornerStats.map((entry) => [entry.id, entry]));
    const labels = new Map(this.coGroups.map((group) => [group.id, group.label]));
    const groups = last.map(({ brakeFrac: _b, ...entry }) => {
      const ref = best.get(entry.id);
      return {
        ...entry,
        label: labels.get(entry.id),
        best: ref ? { entryKph: ref.entryKph, minKph: ref.minKph, exitKph: ref.exitKph, brakeMetresBeforeEntry: ref.brakeMetresBeforeEntry, timeS: ref.timeS } : null,
        timeLostS: ref ? Number((entry.timeS - ref.timeS).toFixed(2)) : null,
      };
    });
    const isBest = lap.isValid && (lap.previousBest <= 0 || lap.lapTime < lap.previousBest);
    let raw = "";
    try {
      raw = await Promise.race([
        this.generate(CO_DRIVER_PROMPT, `Last lap corner groups (JSON): ${JSON.stringify({ lapTimeS: Number(lap.lapTime.toFixed(3)), bestLapS: lap.previousBest > 0 ? Number(lap.previousBest.toFixed(3)) : null, groups })}`),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), CO_DRIVER_TIMEOUT_MS)),
      ]);
    } catch {
      raw = "";
    }
    const tips = parseTips(raw, this.coGroups, last);
    if (tips.length > 0 || raw.trim().startsWith("[")) this.tips.setTips(tips);
    if (isBest || this.bestLapCornerStats.length === 0) this.bestLapCornerStats = last;
  }

  /** Coach mode: a Claude-written lap debrief. Says nothing if Claude fails or is too slow. */
  async coachLap(lap: { lapNumber: number; lapTime: number; isValid: boolean; previousBest: number }, brief = false): Promise<void> {
    const issues = this.state.lastLapIssues.size > 0 ? this.state.lastLapIssues : this.state.lapIssues;
    const sectors = this.state.sectors;
    const context = {
      lap: lap.lapNumber,
      lapTimeS: Number(lap.lapTime.toFixed(3)),
      valid: lap.isValid,
      previousBestLapS: lap.previousBest > 0 ? Number(lap.previousBest.toFixed(3)) : null,
      personalBest: lap.isValid && (lap.previousBest <= 0 || lap.lapTime < lap.previousBest),
      sectorDeltasToBestS: sectors?.lastTimes.map((time, index) => {
        const best = sectors.bestTimes[index];
        return time > 0 && Number.isFinite(best) && best > 0 ? Number((time - best).toFixed(2)) : null;
      }) ?? null,
      mistakesByCorner: Object.fromEntries([...issues].map(([kind, entry]) => [kind, Object.fromEntries(entry.corners)])),
    };
    let text = "";
    try {
      text = await Promise.race([
        this.generate(brief ? `${COACH_PROMPT}\n- Co-driver tips cover individual corners, so keep this to ONE sentence under 15 words.` : COACH_PROMPT, `Lap data (JSON): ${JSON.stringify(context)}`),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), COACH_TIMEOUT_MS)),
      ]);
    } catch {
      text = "";
    }
    const reply = text.replace(/\s+/g, " ").trim();
    if (reply) this.say({ key: "coach-lap", priority: 1, text: reply });
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
