import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, Maximize2, Mic, Radio, RotateCcw, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authenticatedFetch } from "@/lib/rpc";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";
import { EngineerModePicker } from "./EngineerModePicker";
import { maximizeWindow } from "./EngineerDrawer";
import { EngineerSpeaker } from "./engineer-voice";
import { WebSpeechToText, type SpeechToText } from "./speech-to-text";

type Line = { id: string; from: "driver" | "engineer"; text: string };
type EngineerEvent = { type: string } & Record<string, unknown>;
type Mode = "quiet" | "normal" | "coach" | "co-driver";
type SessionType = "practice" | "qualifying" | "race";

const MAX_LINES = 8;
const WINDOW_MAX_LINES = 200;

export const ENGINEER_EVENT = "raceiq-engineer";

export type EngineerRadioProps = {
  /** "drawer": small panel at the bottom left. "window": fills the pop-out window. */
  variant?: "drawer" | "window";
  onPopOut?: () => void;
};

export function EngineerRadio({ variant = "drawer", onPopOut }: EngineerRadioProps = {}) {
  const inWindow = variant === "window";
  const maxLines = inWindow ? WINDOW_MAX_LINES : MAX_LINES;
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const mode: Mode = displaySettings.engineerMode ?? "normal";
  const micMode = displaySettings.engineerMicMode ?? "push-to-talk";
  const [lines, setLines] = useState<Line[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [started, setStarted] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [thinking, setThinking] = useState(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmingNewSession, setConfirmingNewSession] = useState(false);
  const [sessionType, setSessionType] = useState<SessionType | null>(null);
  const [micPermission, setMicPermission] = useState<"granted" | "prompt" | "denied" | "unknown">("unknown");

  useEffect(() => {
    let status: PermissionStatus | null = null;
    const update = () => { if (status) setMicPermission(status.state as "granted" | "prompt" | "denied"); };
    navigator.permissions?.query({ name: "microphone" as PermissionName }).then((result) => { status = result; update(); result.addEventListener("change", update); }).catch(() => {});
    return () => status?.removeEventListener("change", update);
  }, []);

  /** Asks the browser for the microphone; speech recognition needs it. */
  const requestMic = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      setMicPermission("granted");
      setError(null);
      return true;
    } catch {
      setMicPermission("denied");
      setError(m.engineer_mic_permission_denied());
      return false;
    }
  }, []);
  const speakerRef = useRef<EngineerSpeaker | null>(null);
  const sttRef = useRef<SpeechToText | null>(null);
  const startedRef = useRef(false);
  const micModeRef = useRef(micMode);
  micModeRef.current = micMode;

  const addLine = useCallback((line: Line) => {
    setLines((current) => current.some((existing) => existing.id === line.id) ? current : [...current, line].slice(-maxLines));
  }, [maxLines]);

  const ask = useCallback(async (text: string) => {
    const question = text.trim();
    if (!question) return;
    setError(null);
    try {
      const res = await authenticatedFetch("/api/engineer/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: question }) });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        setError(body?.error ?? m.engineer_error_generic());
      }
    } catch {
      setError(m.engineer_error_generic());
    }
  }, []);

  if (!speakerRef.current) {
    speakerRef.current = new EngineerSpeaker((speaking) => {
      sttRef.current?.setPaused(speaking);
    });
  }
  if (!sttRef.current) {
    sttRef.current = new WebSpeechToText({
      onFinal: (text) => { setInterim(""); void ask(text); },
      onInterim: setInterim,
      onError: (message) => setError(message),
      onListeningChange: setListening,
    });
  }

  useEffect(() => {
    speakerRef.current?.configure({
      voiceURI: displaySettings.engineerVoiceURI ?? null,
      rate: displaySettings.engineerVoiceRate ?? 0.95,
      pitch: displaySettings.engineerVoicePitch ?? 0.85,
      radioFilter: displaySettings.engineerRadioFilter ?? true,
      radioLevel: displaySettings.engineerRadioFilterLevel ?? 0.5,
      azure: Boolean(displaySettings.azureSpeechKeySet && displaySettings.engineerAzureRegion),
    });
  }, [displaySettings.engineerVoiceURI, displaySettings.engineerVoiceRate, displaySettings.engineerVoicePitch, displaySettings.engineerRadioFilter, displaySettings.engineerRadioFilterLevel, displaySettings.azureSpeechKeySet, displaySettings.engineerAzureRegion]);

  useEffect(() => {
    let cancelled = false;
    void authenticatedFetch("/api/engineer/state").then(async (res) => {
      if (!res.ok || cancelled) return;
      const state = await res.json() as { live: boolean; thinking: boolean; transcript: Line[]; sessionType: SessionType | null };
      setSessionType(state.sessionType);
      setLive(state.live);
      setThinking(state.thinking);
      setLines(state.transcript.slice(-maxLines));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const data = (event as CustomEvent<EngineerEvent>).detail;
      if (data.type === "engineer-say") {
        const text = String(data.text ?? "");
        addLine({ id: String(data.id), from: "engineer", text });
        if (startedRef.current) speakerRef.current?.say(String(data.id), text, Number(data.priority) || 0);
      } else if (data.type === "engineer-heard") {
        addLine({ id: String(data.id), from: "driver", text: String(data.text ?? "") });
      } else if (data.type === "engineer-reset") {
        speakerRef.current?.stop();
        setLines([]);
        setInterim("");
        setError(null);
        setSessionType((data.sessionType as SessionType | undefined) ?? null);
      } else if (data.type === "engineer-state") {
        setThinking(Boolean(data.thinking));
        setLive(Boolean(data.live));
      } else if (data.type === "engineer-error") {
        setError(String(data.message ?? m.engineer_error_generic()));
      } else if (data.type === "engineer-ptt") {
        if (!startedRef.current || micModeRef.current !== "push-to-talk") return;
        if (data.pressed) { speakerRef.current?.stop(); sttRef.current?.startUtterance(); } else sttRef.current?.stop();
      }
    };
    window.addEventListener(ENGINEER_EVENT, handler);
    return () => window.removeEventListener(ENGINEER_EVENT, handler);
  }, [addLine]);

  useEffect(() => {
    // Only open mic is driven by state; push to talk starts and stops on press/release.
    const stt = sttRef.current;
    if (!started || !stt || micMode !== "open-mic") return;
    stt.startContinuous();
    return () => stt.stop();
  }, [started, micMode]);

  useEffect(() => () => { speakerRef.current?.stop(); sttRef.current?.dispose(); }, []);

  const start = () => {
    if (micModeRef.current !== "off" && micPermission !== "granted") void requestMic();
    speakerRef.current?.unlock();
    startedRef.current = true;
    setStarted(true);
    setError(null);
  };

  const holdStart = () => {
    if (!startedRef.current) start();
    speakerRef.current?.stop();
    sttRef.current?.startUtterance();
  };
  const holdEnd = () => sttRef.current?.stop();

  const setMode = (next: Mode) => saveSettings.mutate({ engineerMode: next });

  const startNewSession = async (type: SessionType) => {
    setConfirmingNewSession(false);
    try {
      const res = await authenticatedFetch("/api/engineer/new-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type }) });
      if (!res.ok) setError(m.engineer_error_generic());
    } catch {
      setError(m.engineer_error_generic());
    }
  };
  const sessionLabel = (type: SessionType) => type === "practice" ? m.engineer_session_practice() : type === "qualifying" ? m.engineer_session_qualifying() : m.engineer_session_race();

  const status = thinking ? m.engineer_status_thinking() : listening ? m.engineer_status_listening() : live ? m.engineer_status_live() : m.engineer_status_waiting();
  const binding = displaySettings.engineerPushToTalk?.name;

  return (
    <div className={inWindow ? "flex h-full flex-col" : "pointer-events-none absolute bottom-[max(1rem,env(safe-area-inset-bottom,0px))] left-[max(1rem,env(safe-area-inset-left,0px))] z-40 flex w-[min(22rem,calc(100%-2rem))] flex-col items-start"}>
      <div className={inWindow ? "flex min-h-0 flex-1 flex-col bg-app-surface-alt text-app-text" : "pointer-events-auto w-full rounded border border-app-border-input bg-app-surface-alt text-app-text shadow-lg"}>
        <div className="flex items-center gap-2 border-b border-app-border-input px-3 py-2">
          <Radio className={`size-4 ${live ? "text-status-success" : "text-app-text-muted"}`} aria-hidden="true" />
          <span className="text-sm font-semibold">{m.engineer_title()}</span>
          <span className="truncate text-xs text-app-text-muted" aria-live="polite">{status}</span>
          <div className="ml-auto flex items-center gap-1">
            <EngineerModePicker id="engineer-radio-mode" value={mode} onChange={setMode} className="w-28" />
            <Button variant="app-ghost" size="icon-sm" onClick={() => setConfirmingNewSession((value) => !value)} aria-label={m.engineer_new_session()} title={m.engineer_new_session()}>
              <RotateCcw className="size-4" />
            </Button>
            {!inWindow && onPopOut && (
              <Button variant="app-ghost" size="icon-sm" onClick={onPopOut} aria-label={m.engineer_pop_out()} title={m.engineer_pop_out()}>
                <ExternalLink className="size-4" />
              </Button>
            )}
            {inWindow ? (
              <>
                <Button variant="app-ghost" size="icon-sm" onClick={maximizeWindow} aria-label={m.engineer_maximize()} title={m.engineer_maximize()}>
                  <Maximize2 className="size-4" />
                </Button>
                <Button variant="app-ghost" size="icon-sm" onClick={() => window.close()} aria-label={m.engineer_close_window()} title={m.engineer_close_window()}>
                  <X className="size-4" />
                </Button>
              </>
            ) : (
              <Button variant="app-ghost" size="icon-sm" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? m.engineer_expand() : m.engineer_collapse()}>
                {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              </Button>
            )}
          </div>
        </div>
        {(!collapsed || inWindow) && (
          <div className={inWindow ? "flex min-h-0 flex-1 flex-col gap-2 p-3" : "flex flex-col gap-2 p-3"}>
            {micMode !== "off" && micPermission !== "granted" && micPermission !== "unknown" && (
              <div role="alert" className="flex items-center justify-between gap-2 rounded border border-status-warning/40 px-2 py-1.5 text-xs text-app-text">
                <span>{micPermission === "denied" ? m.engineer_mic_permission_denied() : m.engineer_mic_permission_needed()}</span>
                {micPermission === "prompt" && <Button variant="app-outline" size="app-sm" onClick={() => void requestMic()}>{m.engineer_mic_permission_allow()}</Button>}
              </div>
            )}
            {confirmingNewSession && (
              <div role="group" aria-label={m.engineer_new_session()} className="flex flex-col gap-2 rounded border border-app-border-input p-2 text-xs">
                <p className="text-app-text">{m.engineer_new_session_confirm()}</p>
                <div className="flex flex-wrap gap-1.5">
                  {(["practice", "qualifying", "race"] as const).map((type) => (
                    <Button key={type} variant="app-outline" size="app-sm" onClick={() => void startNewSession(type)}>{sessionLabel(type)}</Button>
                  ))}
                  <Button variant="app-ghost" size="app-sm" onClick={() => setConfirmingNewSession(false)}>{m.engineer_new_session_cancel()}</Button>
                </div>
              </div>
            )}
            {sessionType && !confirmingNewSession && <p className="text-app-caption uppercase tracking-wider text-app-text-muted">{sessionLabel(sessionType)}</p>}
            {!started && (
              <Button variant="app-primary" size="app-sm" onClick={start} className="w-full">
                {m.engineer_start_radio()}
              </Button>
            )}
            <ol className={inWindow ? "flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto text-sm leading-snug" : "flex max-h-48 flex-col gap-1 overflow-y-auto text-xs leading-snug"} aria-label={m.engineer_transcript_label()}>
              {lines.length === 0 && <li className="text-app-text-muted">{m.engineer_transcript_empty()}</li>}
              {lines.map((line) => (
                <li key={line.id} className={line.from === "engineer" ? "text-app-text" : "text-app-text-secondary"}>
                  <span className="mr-1 font-semibold uppercase tracking-wider text-app-caption text-app-text-muted">{line.from === "engineer" ? m.engineer_label_engineer() : m.engineer_label_driver()}</span>
                  {line.text}
                </li>
              ))}
              {interim && <li className="italic text-app-text-muted">{interim}</li>}
            </ol>
            {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
            <form
              className="flex items-center gap-1.5"
              onSubmit={(event) => { event.preventDefault(); if (!startedRef.current) start(); void ask(draft); setDraft(""); }}
            >
              {micMode !== "off" && (
                <Button
                  type="button"
                  variant={listening ? "destructive-outline" : "app-ghost"}
                  size="icon-sm"
                  aria-label={m.engineer_hold_to_talk()}
                  title={binding ? m.engineer_hold_to_talk_with_binding({ binding }) : m.engineer_hold_to_talk()}
                  onPointerDown={holdStart}
                  onPointerUp={holdEnd}
                  onPointerLeave={() => { if (listening && micMode === "push-to-talk") holdEnd(); }}
                >
                  <Mic className="size-4" />
                </Button>
              )}
              <Input
                id="engineer-question"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={m.engineer_ask_placeholder()}
                autoComplete="off"
                className="h-8 text-xs"
              />
              <Button type="submit" variant="app-ghost" size="icon-sm" aria-label={m.engineer_send()} disabled={!draft.trim()}>
                <Send className="size-4" />
              </Button>
            </form>
            {micMode === "push-to-talk" && (
              <p className="text-app-caption text-app-text-muted">{binding ? m.engineer_ptt_hint_binding({ binding }) : m.engineer_ptt_hint_unbound()}</p>
            )}
            {micMode === "open-mic" && started && <p className="text-app-caption text-app-text-muted">{m.engineer_open_mic_hint()}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
