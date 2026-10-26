import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Mic, Radio, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authenticatedFetch } from "@/lib/rpc";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";
import { EngineerModePicker } from "./EngineerModePicker";
import { EngineerSpeaker } from "./engineer-voice";
import { WebSpeechToText, type SpeechToText } from "./speech-to-text";

type Line = { id: string; from: "driver" | "engineer"; text: string };
type EngineerEvent = { type: string } & Record<string, unknown>;
type Mode = "quiet" | "normal" | "coach";

const MAX_LINES = 8;

export const ENGINEER_EVENT = "raceiq-engineer";

export function EngineerRadio() {
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
    setLines((current) => current.some((existing) => existing.id === line.id) ? current : [...current, line].slice(-MAX_LINES));
  }, []);

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
    });
  }, [displaySettings.engineerVoiceURI, displaySettings.engineerVoiceRate, displaySettings.engineerVoicePitch, displaySettings.engineerRadioFilter]);

  useEffect(() => {
    let cancelled = false;
    void authenticatedFetch("/api/engineer/state").then(async (res) => {
      if (!res.ok || cancelled) return;
      const state = await res.json() as { live: boolean; thinking: boolean; transcript: Line[] };
      setLive(state.live);
      setThinking(state.thinking);
      setLines(state.transcript.slice(-MAX_LINES));
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

  const status = thinking ? m.engineer_status_thinking() : listening ? m.engineer_status_listening() : live ? m.engineer_status_live() : m.engineer_status_waiting();
  const binding = displaySettings.engineerPushToTalk?.name;

  return (
    <div className="pointer-events-none absolute bottom-[max(1rem,env(safe-area-inset-bottom,0px))] left-[max(1rem,env(safe-area-inset-left,0px))] z-40 flex w-[min(22rem,calc(100%-2rem))] flex-col items-start">
      <div className="pointer-events-auto w-full rounded border border-app-border-input bg-app-surface-alt text-app-text shadow-lg">
        <div className="flex items-center gap-2 border-b border-app-border-input px-3 py-2">
          <Radio className={`size-4 ${live ? "text-status-success" : "text-app-text-muted"}`} aria-hidden="true" />
          <span className="text-sm font-semibold">{m.engineer_title()}</span>
          <span className="truncate text-xs text-app-text-muted" aria-live="polite">{status}</span>
          <div className="ml-auto flex items-center gap-1">
            <EngineerModePicker id="engineer-radio-mode" value={mode} onChange={setMode} className="w-28" />
            <Button variant="app-ghost" size="icon-sm" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? m.engineer_expand() : m.engineer_collapse()}>
              {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </Button>
          </div>
        </div>
        {!collapsed && (
          <div className="flex flex-col gap-2 p-3">
            {micMode !== "off" && micPermission !== "granted" && micPermission !== "unknown" && (
              <div role="alert" className="flex items-center justify-between gap-2 rounded border border-status-warning/40 px-2 py-1.5 text-xs text-app-text">
                <span>{micPermission === "denied" ? m.engineer_mic_permission_denied() : m.engineer_mic_permission_needed()}</span>
                {micPermission === "prompt" && <Button variant="app-outline" size="app-sm" onClick={() => void requestMic()}>{m.engineer_mic_permission_allow()}</Button>}
              </div>
            )}
            {!started && (
              <Button variant="app-primary" size="app-sm" onClick={start} className="w-full">
                {m.engineer_start_radio()}
              </Button>
            )}
            <ol className="flex max-h-48 flex-col gap-1 overflow-y-auto text-xs leading-snug" aria-label={m.engineer_transcript_label()}>
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
