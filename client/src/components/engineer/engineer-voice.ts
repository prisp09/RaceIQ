/**
 * Engineer speech output: a priority queue that speaks with either
 * - the browser's speechSynthesis (Edge's "Thomas (UK)"). Its audio can't be
 *   processed, so the radio effect is static, crackle and squelch around it; or
 * - Azure en-GB-ThomasNeural audio from the server (optional key), played
 *   through a Web Audio radio chain: band-pass, distortion, compression.
 * Any Azure failure falls back to speechSynthesis.
 */

import { authenticatedFetch } from "@/lib/rpc";

export type EngineerVoiceSettings = {
  voiceURI: string | null;
  rate: number;
  pitch: number;
  radioFilter: boolean;
  /** 0-1 strength of the radio effect. */
  radioLevel: number;
  /** Server has an Azure Speech key and region. */
  azure: boolean;
};
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

/** Short band-passed noise burst plus a click, like a team radio key-up. Louder with `level`. */
function squelch(kind: "open" | "close", level: number): Promise<void> {
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
  gain.gain.value = 0.04 + 0.16 * level;
  noise.connect(band).connect(gain).connect(ac.destination);
  const tone = ac.createOscillator();
  tone.frequency.value = kind === "open" ? 1450 : 1100;
  const toneGain = ac.createGain();
  toneGain.gain.setValueAtTime(0.02 + 0.06 * level, ac.currentTime);
  toneGain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.06);
  tone.connect(toneGain).connect(ac.destination);
  noise.start();
  tone.start();
  tone.stop(ac.currentTime + 0.06);
  return new Promise((resolve) => setTimeout(resolve, duration * 1000));
}

/** Radio hiss plus sparse crackle that plays under a transmission. Returns a stop function. */
function startStaticBed(level: number): () => void {
  const ac = ctx();
  if (!ac || level <= 0) return () => {};
  const seconds = 2;
  const buffer = ac.createBuffer(1, ac.sampleRate * seconds, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const hiss = (Math.random() * 2 - 1) * 0.35;
    const crackle = Math.random() < 0.0015 ? (Math.random() * 2 - 1) * 3 : 0;
    data[i] = hiss + crackle;
  }
  const source = ac.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const band = ac.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 2000;
  band.Q.value = 0.6;
  const gain = ac.createGain();
  gain.gain.value = 0.06 * level;
  source.connect(band).connect(gain).connect(ac.destination);
  source.start();
  return () => {
    try {
      gain.gain.setTargetAtTime(0, ac.currentTime, 0.03);
      source.stop(ac.currentTime + 0.15);
    } catch { /* already stopped */ }
  };
}

function distortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const samples = 1024;
  const curve = new Float32Array(samples);
  const k = amount * 50;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

/** Plays decoded audio through a radio chain scaled by `level` (0 = clean). Resolves when it ends. */
function playThroughRadio(audio: AudioBuffer, level: number, onSource: (source: AudioBufferSourceNode) => void): Promise<void> {
  const ac = ctx();
  if (!ac) return Promise.resolve();
  const source = ac.createBufferSource();
  source.buffer = audio;
  let node: AudioNode = source;
  if (level > 0) {
    const highpass = ac.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 150 + 150 * level;
    const lowpass = ac.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 6000 - 2600 * level;
    const shaper = ac.createWaveShaper();
    shaper.curve = distortionCurve(level * 0.6);
    const compressor = ac.createDynamicsCompressor();
    compressor.threshold.value = -24 - 10 * level;
    compressor.ratio.value = 4 + 8 * level;
    node.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(shaper);
    shaper.connect(compressor);
    node = compressor;
  }
  const output = ac.createGain();
  output.gain.value = 0.9;
  node.connect(output).connect(ac.destination);
  onSource(source);
  return new Promise((resolve) => {
    source.onended = () => resolve();
    source.start();
  });
}

async function fetchAzureAudio(text: string): Promise<AudioBuffer | null> {
  const ac = ctx();
  if (!ac) return null;
  const res = await authenticatedFetch("/api/engineer/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  if (!res.ok) return null;
  return ac.decodeAudioData(await res.arrayBuffer());
}

export class EngineerSpeaker {
  private queue: Utterance[] = [];
  private current: Utterance | null = null;
  private settings: EngineerVoiceSettings = { voiceURI: null, rate: 0.95, pitch: 0.85, radioFilter: true, radioLevel: 0.5, azure: false };
  private activeSource: AudioBufferSourceNode | null = null;
  private stopBed: () => void = () => {};

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
    if (typeof speechSynthesis === "undefined" && !this.settings.azure) return;
    if (priority >= 2 && this.current && this.current.priority < 2) {
      this.queue.unshift({ id, text, priority });
      this.interrupt();
      return;
    }
    this.queue.push({ id, text, priority });
    this.queue.sort((a, b) => b.priority - a.priority);
    if (!this.current) void this.next();
  }

  stop(): void {
    this.queue = [];
    this.interrupt();
  }

  private interrupt(): void {
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    try { this.activeSource?.stop(); } catch { /* not started */ }
  }

  private level(): number {
    return this.settings.radioFilter ? Math.min(1, Math.max(0, this.settings.radioLevel)) : 0;
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
    const level = this.level();
    const finish = async () => {
      this.stopBed();
      this.stopBed = () => {};
      this.activeSource = null;
      if (this.current !== item) return;
      if (level > 0) await squelch("close", level);
      if (this.queue.length === 0) { this.current = null; this.onSpeakingChange(false); } else void this.next();
    };

    // Fetch Azure audio before keying the radio so the squelch lines up with the voice.
    let audio: AudioBuffer | null = null;
    if (this.settings.azure) {
      try { audio = await fetchAzureAudio(item.text); } catch { audio = null; }
      if (this.current !== item) return;
    }
    if (level > 0) await squelch("open", level);
    this.stopBed = startStaticBed(level);

    if (audio) {
      await playThroughRadio(audio, level, (source) => { this.activeSource = source; });
      await finish();
      return;
    }
    if (typeof speechSynthesis === "undefined") { await finish(); return; }
    const utterance = new SpeechSynthesisUtterance(item.text);
    const voice = pickVoice(this.settings.voiceURI);
    if (voice) { utterance.voice = voice; utterance.lang = voice.lang; } else utterance.lang = "en-GB";
    utterance.rate = this.settings.rate;
    utterance.pitch = this.settings.pitch;
    utterance.onend = () => void finish();
    utterance.onerror = () => void finish();
    speechSynthesis.speak(utterance);
  }
}
