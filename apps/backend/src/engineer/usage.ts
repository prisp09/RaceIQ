/**
 * AI token use and an estimated cost for the race engineer's current session.
 *
 * Prices are list prices in USD per million tokens, kept as a small table and
 * shown as an estimate. Models not in the table (local models, new releases)
 * report tokens only.
 */

export type UsageEntry = {
  provider: string;
  model: string;
  /** Input tokens billed at the full rate (not served from cache). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Prefix -> price. Longest matching prefix wins, so "gpt-5-mini" is not priced as "gpt-5". */
const PRICES: Record<string, Price> = {
  // Anthropic list prices; cache writes are the 5-minute rate (1.25x input).
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // OpenAI; cached input at the listed cached rate.
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.05 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
  "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
  "o4-mini": { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 1.1 },
  // Google Gemini (prompts up to 200K tokens).
  "gemini-2.5-pro": { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 1.25 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0.3 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
};
const PREFIXES = Object.keys(PRICES).sort((a, b) => b.length - a.length);

/** List price for a model id, or null when it isn't in the table. Local servers are never priced. */
export function priceFor(provider: string, model: string): Price | null {
  if (provider === "openai-compatible") return null;
  const id = model.toLowerCase().replace(/^(models\/|anthropic\/|openai\/|google\/)/, "");
  const prefix = PREFIXES.find((candidate) => id === candidate || id.startsWith(`${candidate}-`) || id.startsWith(`${candidate}@`));
  return prefix ? PRICES[prefix]! : null;
}

export function entryCostUsd(entry: UsageEntry): number | null {
  const price = priceFor(entry.provider, entry.model);
  if (!price) return null;
  return (entry.inputTokens * price.input + entry.outputTokens * price.output + entry.cacheReadTokens * price.cacheRead + entry.cacheWriteTokens * price.cacheWrite) / 1_000_000;
}

export type UsageSummary = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimated USD for the calls whose model is priced; null when none are. */
  costUsd: number | null;
  /** Calls with a model missing from the price table (counted in tokens only). */
  unpricedCalls: number;
  models: string[];
};

/** Running totals for one engineer session. */
export class EngineerUsage {
  private entries: UsageEntry[] = [];
  private listeners = new Set<(summary: UsageSummary) => void>();

  add(entry: UsageEntry): void {
    this.entries.push(entry);
    this.emit();
  }

  reset(): void {
    this.entries = [];
    this.emit();
  }

  onChange(listener: (summary: UsageSummary) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  summary(): UsageSummary {
    let costUsd: number | null = null;
    let unpricedCalls = 0;
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const entry of this.entries) {
      totals.inputTokens += entry.inputTokens;
      totals.outputTokens += entry.outputTokens;
      totals.cacheReadTokens += entry.cacheReadTokens;
      totals.cacheWriteTokens += entry.cacheWriteTokens;
      const cost = entryCostUsd(entry);
      if (cost === null) unpricedCalls++;
      else costUsd = (costUsd ?? 0) + cost;
    }
    return { calls: this.entries.length, ...totals, costUsd, unpricedCalls, models: [...new Set(this.entries.map((entry) => entry.model))] };
  }

  private emit(): void {
    const summary = this.summary();
    for (const listener of this.listeners) listener(summary);
  }
}

/** The engineer's session usage; the service resets it on a new session. */
export const engineerUsage = new EngineerUsage();
