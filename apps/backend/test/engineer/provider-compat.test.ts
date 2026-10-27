import { describe, expect, test } from "bun:test";
import {
  AnthropicProviderAdapter,
  GeminiProviderAdapter,
  OpenAiCompatibleProviderAdapter,
  OpenAiProviderAdapter,
} from "../../src/ai/provider-adapters";
import { ENGINEER_MAX_OUTPUT_TOKENS, stripReasoning } from "../../src/engineer/service";

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

const openAiCompletion = {
  choices: [{ index: 0, message: { role: "assistant", content: "Box this lap." }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};
const geminiCompletion = {
  candidates: [{ content: { parts: [{ text: "Box this lap." }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
};

// The engineer's fallback request (see defaultGenerate in engineer/service.ts).
const engineerRequest = { system: "You are the race engineer.", prompt: "Gap to car ahead?", temperature: 0.4, maxOutputTokens: ENGINEER_MAX_OUTPUT_TOKENS };

async function capture(run: () => Promise<unknown>, response: unknown): Promise<Captured> {
  const requests: Captured[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    requests.push({ url: String(input), headers, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

function expectNoClaudeOnlyFields(req: Captured) {
  expect(req.headers["x-api-key"]).toBeUndefined();
  expect(req.headers["anthropic-version"]).toBeUndefined();
  const raw = JSON.stringify(req.body);
  expect(raw).not.toContain("cache_control");
  expect(raw).not.toContain("output_config");
}

describe("race engineer provider compatibility", () => {
  test("OpenAI chat models keep temperature and use max_completion_tokens", async () => {
    const adapter = new OpenAiProviderAdapter({ feature: "liveEngineer", model: "gpt-4o-mini", apiKey: "sk-test" });
    const req = await capture(() => adapter.generateText(engineerRequest), openAiCompletion);
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.body.temperature).toBe(0.4);
    expect(req.body.max_completion_tokens).toBe(ENGINEER_MAX_OUTPUT_TOKENS);
    expect(req.body.max_tokens).toBeUndefined();
    expect(req.body.reasoning_effort).toBeUndefined();
    expect(req.headers.authorization).toBe("Bearer sk-test");
    expectNoClaudeOnlyFields(req);
  });

  for (const model of ["gpt-5-mini", "o4-mini"]) {
    test(`OpenAI reasoning model ${model} drops temperature and uses low reasoning effort`, async () => {
      const adapter = new OpenAiProviderAdapter({ feature: "liveEngineer", model, apiKey: "sk-test" });
      const req = await capture(() => adapter.generateText(engineerRequest), openAiCompletion);
      expect(req.body.temperature).toBeUndefined();
      expect(req.body.max_completion_tokens).toBe(ENGINEER_MAX_OUTPUT_TOKENS);
      expect(req.body.max_tokens).toBeUndefined();
      expect(req.body.reasoning_effort).toBe("low");
      expectNoClaudeOnlyFields(req);
    });
  }

  test("Gemini gets temperature and maxOutputTokens in generationConfig", async () => {
    const adapter = new GeminiProviderAdapter({ feature: "liveEngineer", model: "gemini-flash-latest", apiKey: "g-test" });
    const req = await capture(() => adapter.generateText(engineerRequest), geminiCompletion);
    expect(req.url).toContain("generativelanguage.googleapis.com");
    const config = req.body.generationConfig as Record<string, unknown>;
    expect(config.temperature).toBe(0.4);
    expect(config.maxOutputTokens).toBe(ENGINEER_MAX_OUTPUT_TOKENS);
    expectNoClaudeOnlyFields(req);
  });

  test("local OpenAI-compatible servers get max_tokens and reasoning_effort none", async () => {
    const adapter = new OpenAiCompatibleProviderAdapter({ feature: "liveEngineer", model: "qwen3:8b", endpoint: "http://localhost:11434/v1", apiKey: "local-key" });
    const req = await capture(() => adapter.generateText(engineerRequest), openAiCompletion);
    expect(req.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(req.body.temperature).toBe(0.4);
    expect(req.body.max_tokens).toBe(ENGINEER_MAX_OUTPUT_TOKENS);
    expect(req.body.max_completion_tokens).toBeUndefined();
    expect(req.body.reasoning_effort).toBe("none");
    expect(req.headers.authorization).toBe("Bearer local-key");
    expectNoClaudeOnlyFields(req);
  });

  test("Anthropic compatibility path sends x-api-key and no temperature", async () => {
    const adapter = new AnthropicProviderAdapter({ feature: "liveEngineer", model: "claude-haiku-5-5", apiKey: "sk-ant-test" });
    const req = await capture(() => adapter.generateText(engineerRequest), openAiCompletion);
    expect(req.headers["x-api-key"]).toBe("sk-ant-test");
    expect(req.body.temperature).toBeUndefined();
    expect(req.body.reasoning_effort).toBeUndefined();
  });
});

describe("usage reported for the engineer's cost readout", () => {
  test("OpenAI reports cached prompt tokens", async () => {
    const adapter = new OpenAiProviderAdapter({ feature: "liveEngineer", model: "gpt-4o-mini", apiKey: "sk-test" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ ...openAiCompletion, usage: { prompt_tokens: 1200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1024 } } }))) as unknown as typeof fetch;
    try {
      const result = await adapter.generateText(engineerRequest);
      expect(result.usage).toMatchObject({ inputTokens: 1200, outputTokens: 30, cacheReadTokens: 1024 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Gemini reports cached and thinking tokens", async () => {
    const adapter = new GeminiProviderAdapter({ feature: "liveEngineer", model: "gemini-2.5-flash", apiKey: "g-test" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ ...geminiCompletion, usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 20, cachedContentTokenCount: 512, thoughtsTokenCount: 300 } }))) as unknown as typeof fetch;
    try {
      const result = await adapter.generateText(engineerRequest);
      expect(result.usage).toMatchObject({ inputTokens: 900, outputTokens: 20, cacheReadTokens: 512, reasoningTokens: 300 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("stripReasoning", () => {
  test("removes complete think blocks", () => {
    expect(stripReasoning("<think>gap is 1.2s</think>Gap is 1.2 seconds.")).toBe("Gap is 1.2 seconds.");
    expect(stripReasoning("<THINK>a</THINK>Push.<think>b</think> Now.")).toBe("Push. Now.");
  });

  test("drops anything before a stray closing tag", () => {
    expect(stripReasoning("reasoning leaked\n</think>\nBox this lap.")).toBe("Box this lap.");
  });

  test("drops an unterminated trailing think block", () => {
    expect(stripReasoning("Copy. <think>still reasoning")).toBe("Copy.");
  });

  test("leaves plain replies alone", () => {
    expect(stripReasoning("  Tyres look fine.  ")).toBe("Tyres look fine.");
  });
});
