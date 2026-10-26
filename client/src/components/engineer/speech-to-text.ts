/**
 * Swappable speech-to-text for the race engineer. Phase 1 uses the browser's
 * Web Speech API; a local Whisper adapter can implement the same interface.
 */

export type SpeechToTextEvents = {
  onFinal: (text: string) => void;
  onInterim?: (text: string) => void;
  onError?: (message: string) => void;
  onListeningChange?: (listening: boolean) => void;
};

export interface SpeechToText {
  readonly available: boolean;
  /** Push to talk: listen until `stop()`, then deliver one final transcript. */
  startUtterance(): void;
  stop(): void;
  /** Open mic: keep listening and deliver each utterance as it ends. */
  startContinuous(): void;
  /** Temporarily ignore audio (e.g. while the engineer is speaking). */
  setPaused(paused: boolean): void;
  dispose(): void;
}

type RecognitionResultEvent = { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> };
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  start(): void; stop(): void; abort(): void;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};

function recognitionConstructor(): (new () => Recognition) | null {
  const w = globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export class WebSpeechToText implements SpeechToText {
  private recognition: Recognition | null = null;
  private mode: "idle" | "utterance" | "continuous" = "idle";
  private paused = false;
  private pending = "";
  private stopping = false;

  private readonly events: SpeechToTextEvents;
  private readonly lang: string;

  constructor(events: SpeechToTextEvents, lang = "en-GB") {
    this.events = events;
    this.lang = lang;
  }

  get available(): boolean {
    return recognitionConstructor() !== null;
  }

  startUtterance(): void {
    this.pending = "";
    this.begin("utterance");
  }

  startContinuous(): void {
    this.begin("continuous");
  }

  stop(): void {
    if (this.mode === "utterance") {
      this.stopping = true;
      try { this.recognition?.stop(); } catch {}
      return;
    }
    this.mode = "idle";
    try { this.recognition?.abort(); } catch {}
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (this.mode !== "continuous") return;
    if (paused) { try { this.recognition?.abort(); } catch {} } else this.begin("continuous");
  }

  dispose(): void {
    this.mode = "idle";
    try { this.recognition?.abort(); } catch {}
    this.recognition = null;
  }

  private begin(mode: "utterance" | "continuous"): void {
    const Ctor = recognitionConstructor();
    if (!Ctor) { this.events.onError?.("Speech recognition is not available in this browser. Use Edge or Chrome."); return; }
    try { this.recognition?.abort(); } catch {}
    this.mode = mode;
    this.stopping = false;
    const recognition = new Ctor();
    recognition.lang = this.lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => this.events.onListeningChange?.(true);
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]!;
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          if (this.mode === "continuous") { if (!this.paused && text.trim()) this.events.onFinal(text.trim()); }
          else this.pending = `${this.pending} ${text}`.trim();
        } else interim += text;
      }
      if (interim) this.events.onInterim?.(interim.trim());
    };
    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      this.events.onError?.(event.error === "not-allowed" ? "Microphone access was blocked. Allow the mic for this page." : `Speech recognition error: ${event.error}`);
    };
    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      this.events.onListeningChange?.(false);
      if (this.mode === "utterance") {
        this.mode = "idle";
        const text = this.pending.trim();
        this.pending = "";
        if (text) this.events.onFinal(text);
        else if (!this.stopping) this.events.onError?.("Didn't catch that.");
      } else if (this.mode === "continuous" && !this.paused) {
        // Browsers end continuous recognition after silence; keep the open mic open.
        setTimeout(() => { if (this.mode === "continuous" && !this.paused && this.recognition === recognition) this.begin("continuous"); }, 250);
      }
    };
    this.recognition = recognition;
    try { recognition.start(); } catch (error) { this.events.onError?.(error instanceof Error ? error.message : String(error)); }
  }
}
