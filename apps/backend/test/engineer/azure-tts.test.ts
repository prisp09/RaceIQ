import { describe, expect, test } from "bun:test";
import { setSecret } from "@raceiq/backend-core/runtime/platform/keystore";
import { buildSsml, synthesizeEngineerSpeech } from "../../src/engineer/azure-tts";

describe("Azure engineer speech", () => {
  test("builds SSML for the Thomas (UK) voice with prosody and escaped text", () => {
    expect(buildSsml("Box <now> & push", 0.95, 0.85)).toBe(
      '<speak version="1.0" xml:lang="en-GB"><voice name="en-GB-ThomasNeural"><prosody rate="-5%" pitch="-8%">Box &lt;now&gt; &amp; push</prosody></voice></speak>',
    );
  });

  test("calls the regional endpoint with the stored key and returns the audio", async () => {
    await setSecret("azure-speech-api-key", "azure-test-key");
    let url = "";
    let headers = new Headers();
    const audio = await synthesizeEngineerSpeech("westeurope", "Radio check.", 1, 1, (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      headers = new Headers(init?.headers);
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch);
    expect(url).toBe("https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1");
    expect(headers.get("ocp-apim-subscription-key")).toBe("azure-test-key");
    expect(headers.get("x-microsoft-outputformat")).toBe("audio-24khz-48kbitrate-mono-mp3");
    expect(new Uint8Array(audio)).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("fails clearly when no key is stored", async () => {
    await setSecret("azure-speech-api-key", "");
    await expect(synthesizeEngineerSpeech("westeurope", "Radio check.", 1, 1)).rejects.toThrow("Azure Speech is not configured");
  });
});
