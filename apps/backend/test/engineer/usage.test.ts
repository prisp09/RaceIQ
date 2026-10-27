import { describe, expect, test } from "bun:test";
import { entryCostUsd, EngineerUsage, priceFor } from "../../src/engineer/usage";

describe("engineer price table", () => {
  test("matches the longest model prefix and dated or aliased ids", () => {
    expect(priceFor("openai", "gpt-5-mini")?.input).toBe(0.25);
    expect(priceFor("openai", "gpt-5-2025-08-07")?.input).toBe(1.25);
    expect(priceFor("openai", "gpt-4o-mini-2024-07-18")?.input).toBe(0.15);
    expect(priceFor("gemini", "models/gemini-2.5-flash-lite")?.input).toBe(0.1);
    expect(priceFor("anthropic", "claude-haiku-5-5")?.output).toBe(0.5);
    expect(priceFor("anthropic", "claude-opus-5-5")?.cacheRead).toBe(0.2);
  });

  test("unknown models and local servers are not priced", () => {
    expect(priceFor("openai", "gpt-9-turbo")).toBeNull();
    expect(priceFor("gemini", "gemini-flash-latest")).toBeNull();
    expect(priceFor("openai-compatible", "gpt-4o-mini")).toBeNull();
  });

  test("prices cache reads and writes at their own rates", () => {
    // Haiku 5.5: 0.10 in, 0.50 out, 0.01 cache read, 0.125 cache write per million.
    const cost = entryCostUsd({ provider: "anthropic", model: "claude-haiku-5-5", inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 });
    expect(cost).toBeCloseTo(0.735, 6);
  });
});

describe("engineer session usage", () => {
  test("adds up tokens, prices known models and counts the rest as tokens only", () => {
    const usage = new EngineerUsage();
    const seen: number[] = [];
    const unwatch = usage.onChange((summary) => seen.push(summary.calls));
    usage.add({ provider: "openai", model: "gpt-4o-mini", inputTokens: 2000, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 0 });
    usage.add({ provider: "openai-compatible", model: "qwen3:8b", inputTokens: 3000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const summary = usage.summary();
    expect(summary).toMatchObject({ calls: 2, inputTokens: 5000, outputTokens: 300, cacheReadTokens: 1000, cacheWriteTokens: 0, unpricedCalls: 1, models: ["gpt-4o-mini", "qwen3:8b"] });
    expect(summary.costUsd).toBeCloseTo((2000 * 0.15 + 100 * 0.6 + 1000 * 0.075) / 1_000_000, 10);
    usage.reset();
    expect(usage.summary()).toMatchObject({ calls: 0, costUsd: null });
    expect(seen).toEqual([1, 2, 0]);
    unwatch();
  });

  test("no priced call means no cost, only tokens", () => {
    const usage = new EngineerUsage();
    usage.add({ provider: "openai-compatible", model: "llama3", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(usage.summary().costUsd).toBeNull();
  });
});
