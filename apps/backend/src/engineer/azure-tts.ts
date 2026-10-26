/**
 * Optional Azure Speech text-to-speech for the race engineer.
 *
 * Edge's "Thomas (UK)" voice is Azure's en-GB-ThomasNeural. Browser speech
 * can't be routed through Web Audio, so a real radio filter needs the audio
 * itself: this calls Azure's official REST API with the user's own key (kept
 * on the server) and returns MP3 for the client's radio chain.
 */
import { getSecret } from "@raceiq/backend-core/runtime/platform/keystore";

export const AZURE_ENGINEER_VOICE = "en-GB-ThomasNeural";

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[char]!);
}

/** Maps browser-style rate (0.7-1.3) and pitch (0.5-1.5) to SSML prosody. */
export function buildSsml(text: string, rate: number, pitch: number): string {
  const ratePct = Math.round((rate - 1) * 100);
  const pitchPct = Math.round((pitch - 1) * 50);
  const sign = (value: number) => (value >= 0 ? `+${value}%` : `${value}%`);
  return `<speak version="1.0" xml:lang="en-GB"><voice name="${AZURE_ENGINEER_VOICE}"><prosody rate="${sign(ratePct)}" pitch="${sign(pitchPct)}">${escapeXml(text)}</prosody></voice></speak>`;
}

export async function synthesizeEngineerSpeech(region: string, text: string, rate: number, pitch: number, fetchImpl: typeof fetch = fetch): Promise<ArrayBuffer> {
  const key = await getSecret("azure-speech-api-key");
  if (!key || !region) throw new Error("Azure Speech is not configured");
  const response = await fetchImpl(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "RaceIQ",
    },
    body: buildSsml(text, rate, pitch),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Azure Speech failed (${response.status})`);
  return response.arrayBuffer();
}
