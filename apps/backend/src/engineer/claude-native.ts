/**
 * Engineer calls to Claude through Anthropic's native Messages API.
 *
 * The OpenAI-compatible endpoint ignores prompt caching. Here the stable
 * prefix (driver dossier + role instructions) is a cached system block, so each
 * lap only pays full price for the per-lap data after it.
 */
import Anthropic from "@anthropic-ai/sdk";

export type ClaudeEngineerRequest = {
  apiKey: string;
  model: string;
  /** Same for every call in a session (driver dossier). */
  stablePrefix: string;
  /** Role instructions (question, Coach debrief, Co-driver tips). */
  instructions: string;
  prompt: string;
  maxTokens: number;
};

export type ClaudeEngineerUsage = { inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number };

const clients = new Map<string, Anthropic>();
function clientFor(apiKey: string): Anthropic {
  let client = clients.get(apiKey);
  if (!client) {
    client = new Anthropic({ apiKey, maxRetries: 1, timeout: 30_000 });
    clients.clear();
    clients.set(apiKey, client);
  }
  return client;
}

export async function generateWithClaude(request: ClaudeEngineerRequest): Promise<{ text: string; usage: ClaudeEngineerUsage }> {
  const system: Anthropic.TextBlockParam[] = [];
  if (request.stablePrefix) system.push({ type: "text", text: request.stablePrefix });
  system.push({ type: "text", text: request.instructions, cache_control: { type: "ephemeral" } });
  const response = await clientFor(request.apiKey).messages.create({
    model: request.model,
    max_tokens: request.maxTokens,
    // Radio replies are short; low effort keeps hidden reasoning (latency and cost) down.
    output_config: { effort: "low" },
    system,
    messages: [{ role: "user", content: request.prompt }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined to answer");
  const text = response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(" ").trim();
  const usage: ClaudeEngineerUsage = {
    inputTokens: response.usage.input_tokens,
    cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    outputTokens: response.usage.output_tokens,
  };
  console.info(`[Engineer] Claude usage: input=${usage.inputTokens} cache_write=${usage.cacheWriteTokens} cache_read=${usage.cacheReadTokens} output=${usage.outputTokens}`);
  if (!text) throw new Error(response.stop_reason === "max_tokens" ? "Model ran out of output tokens before answering" : "Model returned an empty response");
  return { text, usage };
}
