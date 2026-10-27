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
import { getAiProviderApiKey } from "@raceiq/backend-core/ai/openai-compatible-provider";
import { generateWithClaude } from "./claude-native";
import { engineerUsage, type UsageSummary } from "./usage";
import { buildDriverDossier } from "./dossier";
import { EngineerLiveState, type IssueEvent } from "./state";
import {
  INSTRUCTION_KINDS,
  issueCallout,
  sessionEndCallout,
  lapCompleteCallouts,
  sectorCallout,
  type Callout,
  type EngineerMode,
  type Rng,
  type InstructionKind,
} from "./rules";
import { PushToTalkWatcher, type PushToTalkBinding } from "./input-helper";
import { anomalyReason, lapRecordFromTally, median, summarizeSession, type SessionLapRecord } from "./session-summary";
import { assessCrash, crashPaceCallout, ImpactDetector, readDamage, type DamageReading, type Impact } from "./crash";
import { isPaceLap } from "@raceiq/shared/racing/lap-classification";
import type { LapClassification } from "@raceiq/shared/racing/lap-classification";
import { CornerLapRecorder, groupCorners, parseTips, speechSeconds, TIP_FEEDBACK_EVERY_LAPS, tipFeedbackCallout, TipHistory, tipOutcomes, TipScheduler, type CachedTip, type CornerGroup, type CornerGroupStats } from "./co-driver";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { tryGetGame } from "@raceiq/shared/games/registry";
import { RaceGapCaller, readGaps } from "./race-gaps";
import { punctureCallout, PunctureDetector, readPressures } from "./puncture";
import { FuelTracker, fuelPlan, isRaceSession, lapsToGo, raceLength, StrategyCaller, strategyContext, worstTyre, type FuelPlan, type StrategyInput } from "./strategy";

export type EngineerSessionType = "practice" | "qualifying" | "race";

const SESSION_GUIDANCE: Record<EngineerSessionType, string> = {
  practice: "Session: practice. Help the driver learn the track and car: try changes, build pace step by step.",
  qualifying: "Session: qualifying. One-lap pace: push every corner, attack braking points, small risks are fine.",
  race: "Session: race. Consistency first: protect tyres and fuel, avoid mistakes, steady lap times over hero laps.",
};

export type TranscriptEntry = { id: string; from: "driver" | "engineer"; text: string; at: string };
export type EngineerSayKind = "callout" | "answer" | "ack";

const COOLDOWN_MS: Record<string, number> = { sector: 0, "lap-summary": 0, status: 0, "coach-lap": 0, "fuel-critical": 60_000, "tyres-critical": 60_000, crash: 45_000, "crash-pace": 120_000 };
/** Damage telemetry lags the hit; wait this long before judging it. */
export const CRASH_SETTLE_MS = 2500;
const DAMAGE_HISTORY_MS = 2000;
const ISSUE_COOLDOWN_MS = 4000;
const TRANSCRIPT_LIMIT = 60;
// Replies are capped at ~35 words by the prompt; the budget is mostly for the
// model's hidden reasoning, which Claude counts against max_tokens.
export const ENGINEER_MAX_OUTPUT_TOKENS = 2000;

const RADIO_STYLE = `Radio style:
- Sound like a real race engineer on the radio, calm and British, for any series (GT3, single-seaters, touring cars). Use general racing lingo: "copy", "understood", "box this lap", "push", "gap", "stint", "deg", "tyres in the window", "nice and tidy". Don't use series-specific terms (like DRS or ERS) unless the data shows the car has them.
- Vary your wording; don't reuse the same opener. Say "mate" only occasionally, at most once in every four or five messages.
- No lists, no markdown, no emojis. Write lap times as 1:42.3 and deltas as "plus 0.4" or "minus 0.2". Round numbers for speech.`;

const SYSTEM_PROMPT = `You are the driver's race engineer on team radio during a sim racing session.
${RADIO_STYLE}
Answering:
- By default reply in one or two short sentences, under 35 words.
- For open questions (session summary, what went well or badly, the car, the track, strategy, setup) you may use up to five sentences. Be direct and practical.
- Use the live data, session summary, corner splits and driver dossier provided. For general questions about tracks, cars, technique or setup you may use your own racing knowledge; say when something is a general suggestion rather than from their data.
- Setup advice: give one to three concrete changes in simple terms, e.g. "front anti-roll bar down two clicks, brake bias one click rearward", tied to what the data shows (understeer, oversteer, lock-ups, bottoming). Small steps, one thing at a time.
- If something you need isn't in the data, say so briefly and still give your best general advice.
- Laps marked "excluded" (out laps, in laps, idle or stopped laps far slower than usual) are not representative. Never use them for pace, consistency or advice; don't criticise the driver for them.
- If the driver asks you to start or stop calling something out repeatedly, add a last line exactly "INSTRUCTION: on <kind>" or "INSTRUCTION: off <kind>". Kinds: brake-lockup (lock-ups), understeer, oversteer, bottoming, sector-delta (sector splits), lap-delta (lap times).
- If the driver asks you to talk more or less, add a last line exactly "MODE: quiet", "MODE: normal", "MODE: coach" or "MODE: co-driver".`;

const SESSION_END_PROMPT = `You are the driver's race engineer on team radio. The session has just ended. Give a short, warm end-of-session message in two to three sentences, under 45 words.
${RADIO_STYLE}
- Lead with the result when there is one: P1 deserves real celebration ("That's P1! Brilliant job."), a podium is "P3, that's a podium, well driven", a poor result is honest but supportive ("Tough one today, we'll regroup.").
- Then one thing that went well and one thing to work on next time, from the session summary.`;

const COACH_PROMPT = `You are the driver's race engineer on team radio, British and calm, for any racing series. After each lap you give a short debrief for the next lap.
Rules:
- Two or three short sentences, under 40 words. No lists, no markdown.
- Start with the lap time against their best in a few words (e.g. "1:42.3, two tenths off.", "Purple lap, mate."). Say "lap invalidated" if it was invalid.
- Then one or two incremental improvements: name the corner and what to change (braking point, entry speed, throttle timing, line, kerbs). Coach, don't list stats.
- Example: "1:42.3, two tenths off. Brake a touch earlier into Turn 2, you're running wide on exit."
${RADIO_STYLE}
- Use only the lap data given. If there are no mistakes, tell them to keep the rhythm and push in their weakest sector.`;

const CO_DRIVER_PROMPT = `You are a co-driver on team radio, British and calm, for any racing series. From the driver's last lap you write short tips that will be read out just before each corner group on the next lap.
Rules:
- Reply with ONLY a JSON array: [{"group":"G1","tip":"..."}]. No other text.
- Each tip is 6 to 12 words, radio style, one concrete change: braking point, entry speed, line, kerbs or throttle. Example: "Brake ten metres later, use the kerb on exit."
- Do not repeat the corner name; it is added for you.
- Only include groups with real time to gain (slower than the best lap through that group, or a mistake there). Skip the rest. At most 5 tips.
- "Earlier tips" lists tips already given and what they did to the time through that group. Build on tips that gained time. If a tip gained nothing or lost time, don't repeat it: suggest a different change or skip that group.
- Use only the data given. If no group has time to gain, reply [].`;

/** Tip generation runs in the background while the next lap starts. */
const CO_DRIVER_TIMEOUT_MS = 15_000;
/** Lap-saved arrives just before the first packet of the new lap; let the recorder close the lap first. */
const CO_DRIVER_SETTLE_MS = 300;

/** Coach debriefs are skipped if Claude takes longer than this. */
export const COACH_TIMEOUT_MS = 4000;

/** `stablePrefix` (the driver dossier) is identical for every call in a session, so it can be cached. */
export type EngineerGenerate = (system: string, prompt: string, stablePrefix?: string) => Promise<string>;

/** Local reasoning models can inline <think> blocks; drop them so they are never spoken. */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*<\/think>/i, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

const defaultGenerate: EngineerGenerate = async (system, prompt, stablePrefix = "") => {
  // Same provider/model resolution as the liveEngineer AI feature (falls back to AI Chat).
  const settings = loadSettings({ syncLaunchOnLogin: false });
  const provider = settings.engineerProvider || settings.chatProvider;
  const model = (settings.engineerModel || settings.chatModel).trim() || "claude-haiku-5-5";
  if (provider === "anthropic") {
    const apiKey = await getAiProviderApiKey("anthropic");
    if (apiKey) {
      try {
        const reply = await generateWithClaude({ apiKey, model, stablePrefix, instructions: system, prompt, maxTokens: ENGINEER_MAX_OUTPUT_TOKENS });
        // Native usage: input_tokens already excludes cache reads and writes.
        engineerUsage.add({ provider: "anthropic", model, ...reply.usage });
        return reply.text;
      } catch (error) {
        console.warn("[Engineer] Native Claude call failed; using the compatibility path:", error instanceof Error ? error.message : String(error));
      }
    }
  }
  const ai = await resolveAi("liveEngineer");
  const result = await ai.generateText({ system: stablePrefix ? `${stablePrefix}\n\n${system}` : system, prompt, temperature: 0.4, maxOutputTokens: ENGINEER_MAX_OUTPUT_TOKENS });
  // Chat-completions style usage counts cached tokens inside the prompt total.
  const cacheReadTokens = result.usage.cacheReadTokens ?? 0;
  engineerUsage.add({
    provider: ai.provider,
    model: result.usage.model || ai.model,
    inputTokens: Math.max(0, result.usage.inputTokens - cacheReadTokens),
    outputTokens: result.usage.outputTokens + (result.usage.reasoningTokens ?? 0),
    cacheReadTokens,
    cacheWriteTokens: 0,
  });
  return stripReasoning(String(result.analysis ?? ""));
};

export class EngineerService {
  readonly state: EngineerLiveState;
  readonly instructions = new Set<InstructionKind>();
  readonly transcript: TranscriptEntry[] = [];
  private settings: AppSettings = loadSettings({ syncLaunchOnLogin: false });
  private lastSaid = new Map<string, number>();
  private bestLap = 0;
  private sessionKey = "";
  sessionType: EngineerSessionType | null = null;
  private lapsSinceStatus = 0;
  private thinking = false;
  private untap: (() => void) | null = null;
  private settingsTimer: ReturnType<typeof setInterval> | null = null;
  private unwatchUsage: (() => void) | null = null;
  private readonly ptt: PushToTalkWatcher;

  private readonly generate: EngineerGenerate;
  readonly tips = new TipScheduler();
  private coGroups: CornerGroup[] = [];
  private coGroupsKey = "";
  private coRecorder: CornerLapRecorder | null = null;
  private coLapNumber = -1;
  private coLastTick = 0;
  lastLapCornerStats: CornerGroupStats[] = [];
  readonly sessionLaps: SessionLapRecord[] = [];
  /** The last saved lap was an anomaly; its corner data isn't representative. */
  private lastLapExcluded = false;
  private endedSessionKey = "";
  private readonly rng: Rng;
  private dossier = "";
  private dossierKey = "";
  bestLapCornerStats: CornerGroupStats[] = [];
  /** Tips spoken on the lap in progress and on the last finished lap, to judge whether they helped. */
  private tipsPlayedThisLap: CachedTip[] = [];
  private tipsPlayedLastLap: CachedTip[] = [];
  readonly tipHistory = new TipHistory();
  /** Fastest time through each corner group this session, from clean laps. */
  private groupBestS = new Map<string, number>();
  private lapsSinceTipFeedback = TIP_FEEDBACK_EVERY_LAPS;
  readonly fuel = new FuelTracker();
  private readonly strategy = new StrategyCaller();
  readonly gaps = new RaceGapCaller();
  private readonly punctures = new PunctureDetector();
  /** A tyre went down this lap; like a crash lap it says nothing about pace. */
  private punctureThisLap = false;
  private readonly impacts = new ImpactDetector();
  private damageHistory: { at: number; reading: DamageReading }[] = [];
  private pendingCrash: { impact: Impact; before: DamageReading | null; settleAt: number } | null = null;
  /** The current lap had a crash; it's left out of pace analysis like an idle lap. */
  private crashThisLap = false;
  /** Damage was reported without a pit call; the next clean lap decides if it's costing too much. */
  private crashPaceCheck: { usualLapS: number } | null = null;

  constructor(generate: EngineerGenerate = defaultGenerate, rng: Rng = Math.random) {
    this.generate = generate;
    this.rng = rng;
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
        this.fuel.update(packet);
        this.coDriverTick(packet);
        this.gapsTick(packet);
        this.crashTick(packet);
        this.punctureTick(packet);
      },
      onNotification: (event) => {
        if (!this.settings.engineerEnabled) return;
        if (event.type === "lap-saved") this.onLapSaved(event);
        else if (event.type === "recording-sealed") void this.endOfSession();
      },
    });
    this.refreshSettings();
    this.settingsTimer = setInterval(() => this.refreshSettings(), 2000);
    this.unwatchUsage = engineerUsage.onChange((usage) => wsManager.broadcastNotification({ type: "engineer-usage", usage }));
  }

  stop(): void {
    this.untap?.();
    this.untap = null;
    if (this.settingsTimer) clearInterval(this.settingsTimer);
    this.settingsTimer = null;
    this.unwatchUsage?.();
    this.unwatchUsage = null;
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

  /** Clears the radio and everything the engineer remembers, for a fresh practice, qualifying or race. */
  newSession(type: EngineerSessionType): void {
    this.sessionType = type;
    this.transcript.length = 0;
    this.instructions.clear();
    this.lastSaid.clear();
    this.bestLap = 0;
    this.lapsSinceStatus = 0;
    this.state.lapIssues = new Map();
    this.state.lastLapIssues = new Map();
    this.coRecorder = null;
    this.coLapNumber = -1;
    this.tips.setTips([]);
    this.lastLapCornerStats = [];
    this.resetTipFeedback();
    this.impacts.reset();
    this.damageHistory = [];
    this.pendingCrash = null;
    this.crashThisLap = false;
    this.crashPaceCheck = null;
    this.bestLapCornerStats = [];
    this.dossierKey = "";
    this.sessionLaps.length = 0;
    this.fuel.reset();
    this.strategy.reset();
    this.gaps.reset();
    this.punctures.reset();
    this.punctureThisLap = false;
    engineerUsage.reset();
    wsManager.broadcastNotification({ type: "engineer-reset", sessionType: type });
  }

  /** The driver dossier for the current game/car/track/session; rebuilt only when those change. */
  async driverDossier(): Promise<string> {
    const packet = this.state.packet;
    if (!packet) return this.dossier;
    const groups = this.coGroups.length > 0 ? this.coGroups : groupCorners(this.state.cornerSegments, this.state.trackLength);
    const key = `${packet.gameId}|${packet.carId}|${packet.trackId}|${this.sessionType ?? ""}|${groups.length}`;
    if (key === this.dossierKey) return this.dossier;
    try {
      this.dossier = await buildDriverDossier({ gameId: packet.gameId, carId: packet.carId || null, trackId: packet.trackId || null }, groups);
      this.dossierKey = key;
    } catch (error) {
      console.warn("[Engineer] Could not build the driver dossier:", error instanceof Error ? error.message : String(error));
    }
    return this.dossier;
  }

  /** Prompt line describing the session type, if one was chosen. */
  private sessionLine(): string {
    return this.sessionType ? `\n${SESSION_GUIDANCE[this.sessionType]}` : "";
  }

  status() {
    return {
      enabled: this.settings.engineerEnabled,
      mode: this.mode,
      sessionType: this.sessionType,
      live: this.state.live,
      thinking: this.thinking,
      instructions: [...this.instructions],
      transcript: this.transcript.slice(-20),
      usage: this.usage(),
    };
  }

  /** AI tokens and estimated cost for this session. */
  usage(): UsageSummary {
    return engineerUsage.summary();
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
        `Session so far (JSON): ${JSON.stringify(summarizeSession(this.sessionLaps))}`,
        `Corner splits, last lap vs best lap (JSON): ${JSON.stringify(this.cornerSplits())}`,
        `Strategy (JSON): ${JSON.stringify(this.strategyFacts())}`,
        `Race position and gaps (JSON): ${JSON.stringify(this.gaps.context())}`,
        `Engineer mode: ${this.mode}. Active callouts: ${[...this.instructions].join(", ") || "none"}.`,
        recent ? `Recent radio:\n${recent}` : "",
        `Driver: ${text}`,
      ].filter(Boolean).join("\n\n");
      const reply = this.applyDirectives(await this.generate(SYSTEM_PROMPT + this.sessionLine(), prompt, await this.driverDossier()));
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
      this.sessionLaps.length = 0;
      this.bestLap = 0;
      this.lapsSinceStatus = 0;
      this.strategy.reset();
      this.gaps.reset();
    }
    const isValid = event.isValid !== false;
    const previousBest = this.bestLap;
    const lapIssues = this.state.lastLapIssues.size > 0 ? this.state.lastLapIssues : this.state.lapIssues;
    const sectorTimes = Array.isArray(event.sectors) ? (event.sectors as number[]) : (this.state.sectors?.lastTimes ?? []);
    // Out laps, in laps and idle laps (far slower than usual) say nothing about pace: keep them out of analysis and calls.
    const classification = (event.classification ?? null) as LapClassification | null;
    const normalTimes = this.sessionLaps.filter((lap) => lap.valid && !lap.excluded).map((lap) => lap.timeS);
    const excluded = !isPaceLap(classification) ? `not a pace lap (${classification})` : this.crashThisLap ? "crash or heavy impact on this lap" : this.punctureThisLap ? "puncture on this lap" : anomalyReason(lapTime, normalTimes);
    this.crashThisLap = false;
    this.punctureThisLap = false;
    this.lastLapExcluded = excluded !== null;
    const lapsCompleted = Number(event.lapNumber) || this.sessionLaps.length + 1;
    this.sessionLaps.push(lapRecordFromTally(lapsCompleted, lapTime, isValid, sectorTimes, lapIssues, this.state.packet?.RacePosition || null, excluded));
    this.fuel.lapComplete(excluded !== null);
    if (excluded) {
      // Critical calls (fuel, tyres) still matter on any lap; everything else waits for a real lap.
      const critical = lapCompleteCallouts(this.mode, { lapNumber: Number(event.lapNumber) || 0, lapTime, isValid, previousBest, pit: this.state.pit, lastLapIssues: new Map(), lapsSinceStatus: 0 }, this.rng).filter((call) => call.priority === 2);
      for (const call of critical) this.say(call);
      this.raceCalls(lapsCompleted, critical);
      return;
    }
    if (this.crashPaceCheck) {
      const call = crashPaceCallout(lapTime, this.crashPaceCheck.usualLapS, this.rng);
      this.crashPaceCheck = null;
      if (call) this.say(call);
    }
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
    }, this.rng);
    if (calls.some((call) => call.key === "status")) this.lapsSinceStatus = 0;
    if (isValid && (this.bestLap <= 0 || lapTime < this.bestLap)) this.bestLap = lapTime;
    if (mode !== "coach" && mode !== "co-driver") {
      for (const call of calls) this.say(call);
      this.raceCalls(lapsCompleted, calls);
      return;
    }
    // Coach and Co-driver: critical calls stay instant; AI replaces every other after-lap call.
    for (const call of calls) if (call.priority === 2) this.say(call);
    this.raceCalls(lapsCompleted, calls);
    const lap = { lapNumber: Number(event.lapNumber) || 0, lapTime, isValid, previousBest };
    // Co-driver without a corner map (or before one loads) behaves like Coach.
    const coDriver = mode === "co-driver" && this.coGroups.length > 0;
    void this.coachLap(lap, coDriver);
    if (coDriver) setTimeout(() => void this.refreshCornerTips(lap), CO_DRIVER_SETTLE_MS);
  }

  /** Typical lap time from clean laps, for turning time left into laps left. */
  private paceS(): number | null {
    const times = this.sessionLaps.filter((lap) => lap.valid && !lap.excluded).map((lap) => lap.timeS);
    return times.length > 0 ? median(times) : null;
  }

  /** Fuel, tyre and pit-window picture after `lapsCompleted` laps. */
  strategyInput(lapsCompleted: number): StrategyInput & { plan: FuelPlan | null } {
    const packet = this.state.packet;
    const perLap = this.fuel.perLap;
    const fuelLeft = this.fuel.fuel;
    const unit = (packet && tryGetGame(packet.gameId)?.telemetry.fuel.packetUnit) || null;
    const length = packet ? raceLength(packet) : { lapsTotal: null, timeLeftS: null };
    const capacity = packet?.FuelCapacity && Number.isFinite(packet.FuelCapacity) && packet.FuelCapacity > 0 ? packet.FuelCapacity : null;
    const plan = perLap && fuelLeft !== null && unit ? fuelPlan(fuelLeft, perLap, lapsToGo(length, lapsCompleted, this.paceS()), unit, capacity) : null;
    const ideal = packet?.f1?.pitStopWindowIdealLap ?? 0;
    const pitWindow = ideal > 0 ? { idealLap: ideal, latestLap: packet?.f1?.pitStopWindowLatestLap ?? ideal } : null;
    return { lapsCompleted, plan, tyre: worstTyre(this.state.pit), pitWindow };
  }

  /**
   * Race only, after each lap: fuel, tyre and pit-window calls when the picture
   * changes, else the gap trend. Quiet keeps only must-act calls.
   */
  private raceCalls(lapsCompleted: number, alreadySaid: readonly Callout[]): void {
    const gapCall = this.gaps.lapEnd(this.state.packet ? readGaps(this.state.packet) : null);
    if (!isRaceSession(this.state.packet, this.sessionType)) return;
    let said = false;
    for (const call of this.strategy.afterLap(this.strategyInput(lapsCompleted), this.rng)) {
      // The critical fuel or tyre call already covers it this lap.
      if (call.key === "strategy-fuel" && alreadySaid.some((entry) => entry.key === "fuel-critical")) continue;
      if (call.key === "strategy-tyres" && alreadySaid.some((entry) => entry.key === "tyres-critical")) continue;
      if (call.priority < 2 && this.mode === "quiet") continue;
      this.say(call);
      said = true;
    }
    if (gapCall && !said && this.mode !== "quiet") this.say(gapCall);
  }

  /** Race only: position changes and defend/attack calls as they happen. */
  gapsTick(packet: TelemetryPacket, nowMs = Date.now()): void {
    const reading = readGaps(packet);
    if (!isRaceSession(packet, this.sessionType)) {
      this.gaps.latest = reading;
      return;
    }
    const call = this.gaps.tick(reading, nowMs, this.nextCorner(), this.sessionLaps.length === 0, this.rng);
    if (call && this.mode !== "quiet") this.say(call);
  }

  /** Name of the next corner group ahead of the car, if the track has a corner map. */
  private nextCorner(): string | null {
    const frac = this.state.lapFraction;
    if (frac === null || this.coGroups.length === 0) return null;
    return (this.coGroups.find((group) => group.startFrac > frac) ?? this.coGroups[0])!.label;
  }

  /** Per-corner-group time on the last lap against the best lap, for questions. */
  cornerSplits(): Array<Record<string, unknown>> {
    if (this.lastLapExcluded) return [];
    const best = new Map(this.bestLapCornerStats.map((entry) => [entry.id, entry]));
    const labels = new Map(this.coGroups.map((group) => [group.id, group.label]));
    return this.lastLapCornerStats.map((entry) => {
      const ref = best.get(entry.id);
      return {
        corner: labels.get(entry.id) ?? entry.id,
        timeS: entry.timeS,
        bestLapTimeS: ref?.timeS ?? null,
        deltaS: ref ? Number((entry.timeS - ref.timeS).toFixed(2)) : null,
        minKph: entry.minKph,
        bestLapMinKph: ref?.minKph ?? null,
      };
    });
  }

  /** Fuel, tyres, race length and pit window for driver questions. */
  strategyFacts(): Record<string, unknown> {
    const input = this.strategyInput(this.sessionLaps.at(-1)?.lap ?? 0);
    const packet = this.state.packet;
    return strategyContext(input.plan, packet ? raceLength(packet) : { lapsTotal: null, timeLeftS: null }, input.tyre, input.pitWindow, this.fuel.cleanLaps);
  }

  /** End-of-session debrief with the result; template fallback if the AI fails. */
  async endOfSession(): Promise<void> {
    if (this.sessionLaps.length === 0 || this.endedSessionKey === this.sessionKey) return;
    this.endedSessionKey = this.sessionKey;
    const position = this.state.packet?.RacePosition || this.sessionLaps.at(-1)?.position || null;
    const isRace = this.sessionType === "race" || (this.sessionType === null && position !== null && position > 0);
    let text = "";
    try {
      const context = { sessionType: this.sessionType ?? "unknown", finalPosition: position, summary: summarizeSession(this.sessionLaps) };
      text = (await this.generate(SESSION_END_PROMPT + this.sessionLine(), `Session result (JSON): ${JSON.stringify(context)}`, await this.driverDossier())).replace(/\s+/g, " ").trim();
    } catch {
      text = "";
    }
    this.say(text ? { key: "session-end", priority: 1, text } : sessionEndCallout(position, isRace, this.rng));
  }

  /** Co-driver: records each corner group and plays cached tips ahead of braking zones. */
  /** Watches for a crash and, once damage telemetry settles, says at most one useful thing about it. */
  crashTick(packet: TelemetryPacket, nowMs = Date.now()): void {
    const reading = readDamage(packet);
    if (reading) {
      this.damageHistory.push({ at: nowMs, reading });
      while (this.damageHistory.length > 1 && nowMs - this.damageHistory[0]!.at > DAMAGE_HISTORY_MS) this.damageHistory.shift();
    }
    const hit = this.impacts.update(packet, nowMs);
    if (!this.pendingCrash) {
      const before = this.damageHistory[0]?.reading ?? null;
      // Damage can rise without a detectable hit (e.g. a slow-speed tap that breaks the wing).
      const damageJump = reading !== null && before !== null && Object.entries(reading.parts).some(([part, value]) => value - (before.parts[part] ?? 0) >= reading.step);
      if (hit || damageJump) {
        this.pendingCrash = { impact: hit ?? { at: nowMs, speedLossMs: 0, peakG: 0, heavy: false }, before, settleAt: nowMs + CRASH_SETTLE_MS };
        this.crashThisLap = true;
      }
      return;
    }
    // Damage often shows a frame before the hit is measured; keep the real impact so its size counts.
    if (hit && this.pendingCrash.impact.speedLossMs === 0 && this.pendingCrash.impact.peakG === 0) this.pendingCrash.impact = hit;
    if (nowMs < this.pendingCrash.settleAt) return;
    const { impact, before } = this.pendingCrash;
    this.pendingCrash = null;
    this.damageHistory = reading ? [{ at: nowMs, reading }] : [];
    const call = assessCrash(impact, before, reading, this.rng);
    if (!call || (call.priority < 2 && this.mode === "quiet")) return;
    this.say(call);
    // Damage without a pit call: the next clean lap decides if it's costing too much.
    const normalTimes = this.sessionLaps.filter((lap) => lap.valid && !lap.excluded).map((lap) => lap.timeS);
    if (call.priority < 2 && /damage/i.test(call.text) && normalTimes.length >= 2) this.crashPaceCheck = { usualLapS: median(normalTimes) };
  }

  /** One tyre losing pressure the others don't: a must-act call in any session and mode. */
  punctureTick(packet: TelemetryPacket, nowMs = Date.now()): void {
    const wheel = this.punctures.update(readPressures(packet), nowMs);
    if (wheel === null) return;
    this.punctureThisLap = true;
    this.say(punctureCallout(wheel, this.rng));
  }

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
      this.resetTipFeedback();
    }
    if (this.coGroups.length === 0) return;
    if (packet.LapNumber !== this.coLapNumber || !this.coRecorder) {
      if (this.coRecorder && packet.LapNumber !== this.coLapNumber) {
        this.lastLapCornerStats = this.coRecorder.finish();
        this.tipsPlayedLastLap = this.tipsPlayedThisLap;
        this.tipsPlayedThisLap = [];
      }
      this.coRecorder = new CornerLapRecorder(this.coGroups, trackLength);
      this.coLapNumber = packet.LapNumber;
      this.tips.newLap();
    }
    const frac = this.state.lapFraction;
    if (frac === null) return;
    this.coRecorder.update(packet, frac);
    if (nowMs - this.coLastTick < 100) return;
    this.coLastTick = nowMs;
    // Corner timing is recorded in every mode (questions use it); tips only play in Co-driver.
    if (this.mode !== "co-driver") return;
    const tip = this.tips.update(frac, packet.Speed, trackLength, nowMs);
    if (tip) {
      this.tipsPlayedThisLap.push(tip);
      this.say({ key: `tip-${tip.groupId}`, priority: 0, text: tip.text });
    }
  }

  private resetTipFeedback(): void {
    this.tipsPlayedThisLap = [];
    this.tipsPlayedLastLap = [];
    this.tipHistory.clear();
    this.groupBestS.clear();
    this.lapsSinceTipFeedback = TIP_FEEDBACK_EVERY_LAPS;
  }

  /** Judges the tips played on the lap just finished; now and then confirms the biggest gain on the radio. */
  private tipFeedback(lap: { isValid: boolean }): void {
    const outcomes = tipOutcomes(this.tipsPlayedLastLap, this.lastLapCornerStats, this.groupBestS);
    this.tipsPlayedLastLap = [];
    this.tipHistory.record(outcomes);
    this.lapsSinceTipFeedback++;
    if (this.mode === "co-driver" && this.lapsSinceTipFeedback >= TIP_FEEDBACK_EVERY_LAPS) {
      const text = tipFeedbackCallout(outcomes, this.rng);
      if (text) {
        this.lapsSinceTipFeedback = 0;
        this.say({ key: "tip-feedback", priority: 0, text });
      }
    }
    // A cut through a group on an invalid lap isn't a time to beat.
    if (!lap.isValid) return;
    for (const entry of this.lastLapCornerStats) {
      const best = this.groupBestS.get(entry.id);
      if (entry.timeS > 0 && (best === undefined || entry.timeS < best)) this.groupBestS.set(entry.id, entry.timeS);
    }
  }

  /** One AI call per lap: a short tip per corner group with time to gain. Keeps the last good tips on failure. */
  async refreshCornerTips(lap: { lapTime: number; isValid: boolean; previousBest: number }): Promise<void> {
    const last = this.lastLapCornerStats;
    if (last.length === 0) return;
    this.tipFeedback(lap);
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
        this.generate(CO_DRIVER_PROMPT + this.sessionLine(), this.tipPrompt(lap, groups), await this.driverDossier()),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), CO_DRIVER_TIMEOUT_MS)),
      ]);
    } catch {
      raw = "";
    }
    const tips = parseTips(raw, this.coGroups, last).filter((tip) => !this.tipHistory.failedBefore(tip));
    if (tips.length > 0 || raw.trim().startsWith("[")) this.tips.setTips(tips);
    if (isBest || this.bestLapCornerStats.length === 0) this.bestLapCornerStats = last;
  }

  private tipPrompt(lap: { lapTime: number; previousBest: number }, groups: unknown[]): string {
    const earlier = this.tipHistory.forPrompt();
    return [
      `Last lap corner groups (JSON): ${JSON.stringify({ lapTimeS: Number(lap.lapTime.toFixed(3)), bestLapS: lap.previousBest > 0 ? Number(lap.previousBest.toFixed(3)) : null, groups })}`,
      earlier.length > 0 ? `Earlier tips (JSON): ${JSON.stringify(earlier)}` : "",
    ].filter(Boolean).join("\n\n");
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
        this.generate(brief ? `${COACH_PROMPT}${this.sessionLine()}\n- Co-driver tips cover individual corners, so keep this to ONE sentence under 15 words.` : COACH_PROMPT + this.sessionLine(), `Lap data (JSON): ${JSON.stringify(context)}`, await this.driverDossier()),
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
