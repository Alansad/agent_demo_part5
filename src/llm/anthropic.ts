import { withTimeout } from "../utils/time.js";
import Anthropic from "@anthropic-ai/sdk";

export type AnthropicConfig = {
  apiKey: string;
  baseUrl: string; // e.g. https://api.anthropic.com
  model: string;
  maxTokens: number;
  timeoutMs: number;
};

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string;
};

export class AnthropicClient {
  private readonly client: Anthropic;

  constructor(private readonly cfg: AnthropicConfig) {
    this.client = new Anthropic({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl,
    });
  }

  async completeText(params: {
    system?: string;
    messages: AnthropicMessage[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ text: string; raw: unknown }> {
    const raw = await withTimeout(
      this.client.messages.create({
        model: this.cfg.model,
        max_tokens: params.maxTokens ?? this.cfg.maxTokens,
        temperature: params.temperature,
        system: params.system,
        messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
      }),
      this.cfg.timeoutMs,
      `Anthropic request timed out after ${this.cfg.timeoutMs}ms`,
    );

    const text = raw.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    if (!text) throw new Error("Anthropic response contained no text content");
    return { text, raw };
  }
}
