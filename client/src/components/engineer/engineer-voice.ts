/**
 * Engineer speech output: a priority queue over the browser's speechSynthesis,
 * with a short synthesized radio squelch around each transmission.
 */

export type EngineerVoiceSettings = { voiceURI: string | null; rate: number; pitch: number; radioFilter: boolean };
type Utterance = { id: string; text: string; priority: number };

const PREFERRED_VOICES = [/thomas.*united kingdom/i, /ryan.*united kingdom/i, /google uk english male/i, /george/i, /oliver/i, /alfie/i, /elliot/i];

export function englishVoices(): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === "undefined") return [];
  return speechSynthesis.getVoices().filter((voice) => voice.lang.toLowerCase().startsWith("en"));
}

/** The saved voice, else the closest mature British male voice available. */
export function pickVoice(voiceURI: string | null): SpeechSynthesisVoice | null {
  if (typeof speechSynthesis === "undefined") return null;
  const voices = speechSynthesis.getVoices();
  if (voiceURI) {
    const saved = voices.find((voice) => voice.voiceURI === voiceURI);
    if (saved) return saved;
  }
  for (const pattern of PREFERRED_VOICES) {
    const match = voices.find((voice) => pattern.test(voice.name) && voice.lang.toLowerCase().startsWith("en"));
    if (match) return match;
  }
  return voices.find((voice) => voice.lang.toLowerCase() === "en-gb") ?? voices.find((voice) => voice.lang.toLowerCase().startsWith("en")) ?? null;
}

let audioCtx: AudioContext | null = null;
function ctx(): AudioContext | null {
  try {
    if (!audioCtx || audioCtx.state === "closed") audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

/** Short band-passed noise burst plus a click, like a team radio key-up. */
function squelch(kind: "open" | "close"): Promise<void> {
  const ac = ctx();
  if (!ac) return Promise.resolve();
  const duration = kind === "open" ? 0.09 : 0.14;
  const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * duration), ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const noise = ac.createBufferSource();
  noise.buffer = buffer;
  const band = ac.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 1800;
  band.Q.value = 0.8;
  const gain = ac.createGain();
  gain.gain.value = 0.12;
  noise.connect(band).connect(gain).connect(ac.destination);
  const tone = ac.createOscillator();
  tone.frequency.value = kind === "open" ? 1450 : 1100;
  const toneGain = ac.createGain();
  toneGain.gain.setValueAtTime(0.05, ac.currentTime);
  toneGain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.06);
  tone.connect(toneGain).connect(ac.destination);
  noise.start();
  tone.start();
  tone.stop(ac.currentTime + 0.06);
  return new Promise((resolve) => setTimeout(resolve, duration * 1000));
}

export class EngineerSpeaker {
  private queue: Utterance[] = [];
  private current: Utterance | null = null;
  private settings: EngineerVoiceSettings = { voiceURI: null, rate: 0.95, pitch: 0.85, radioFilter: true };

  private readonly onSpeakingChange: (speaking: boolean) => void;

  constructor(onSpeakingChange: (speaking: boolean) => void) {
    this.onSpeakingChange = onSpeakingChange;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.getVoices();
  }

  configure(settings: EngineerVoiceSettings): void {
    this.settings = settings;
  }

  get speaking(): boolean {
    return this.current !== null;
  }

  /** Must be called from a click so browsers allow audio and speech. */
  unlock(): void {
    ctx();
    if (typeof speechSynthesis !== "undefined") {
      const silent = new SpeechSynthesisUtterance(" ");
      silent.volume = 0;
      speechSynthesis.speak(silent);
    }
  }

  say(id: string, text: string, priority: number): void {
    if (typeof speechSynthesis === "undefined") return;
    if (priority >= 2 && this.current && this.current.priority < 2) {
      this.queue.unshift({ id, text, priority });
      speechSynthesis.cancel();
      return;
    }
    this.queue.push({ id, text, priority });
    this.queue.sort((a, b) => b.priority - a.priority);
    if (!this.current) void this.next();
  }

  stop(): void {
    this.queue = [];
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }

  private async next(): Promise<void> {
    const item = this.queue.shift();
    if (!item) {
      if (this.current) { this.current = null; this.onSpeakingChange(false); }
      return;
    }
    const wasIdle = this.current === null;
    this.current = item;
    if (wasIdle) this.onSpeakingChange(true);
    if (this.settings.radioFilter) await squelch("open");
    const utterance = new SpeechSynthesisUtterance(item.text);
    const voice = pickVoice(this.settings.voiceURI);
    if (voice) { utterance.voice = voice; utterance.lang = voice.lang; } else utterance.lang = "en-GB";
    utterance.rate = this.settings.rate;
    utterance.pitch = this.settings.pitch;
    const done = async () => {
      if (this.current !== item) return;
      if (this.settings.radioFilter) await squelch("close");
      if (this.queue.length === 0) { this.current = null; this.onSpeakingChange(false); } else void this.next();
    };
    utterance.onend = () => void done();
    utterance.onerror = () => void done();
    speechSynthesis.speak(utterance);
  }
}
