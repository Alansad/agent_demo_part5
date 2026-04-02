import { withTimeout } from "../utils/time.js";

export type AnthropicConfig = {
  apiKey: string;
  baseUrl: string; // e.g. https://api.anthropic.com
  model: string;
  anthropicVersion: string; // e.g. 2023-06-01
  maxTokens: number;
  timeoutMs: number;
};

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string;
};

export class AnthropicClient {
  constructor(private readonly cfg: AnthropicConfig) {}

  async completeText(params: {
    system?: string;
    messages: AnthropicMessage[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ text: string; raw: unknown }> {
    const url = new URL("/v1/messages", this.cfg.baseUrl).toString();

    const body = {
      model: this.cfg.model,
      max_tokens: params.maxTokens ?? this.cfg.maxTokens,
      temperature: params.temperature,
      system: params.system,
      messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    const res = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.cfg.apiKey,
          "anthropic-version": this.cfg.anthropicVersion,
        },
        body: JSON.stringify(body),
      }),
      this.cfg.timeoutMs,
      `Anthropic request timed out after ${this.cfg.timeoutMs}ms`,
    );

    const rawText = await res.text();
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(rawText);
    } catch {
      rawJson = { _nonJson: true, text: rawText };
    }

    if (!res.ok) {
      const msg = typeof rawText === "string" ? rawText.slice(0, 800) : String(rawText);
      throw new Error(`Anthropic error (${res.status}): ${msg}`);
    }

    // Expected shape:
    // { content: [ { type: "text", text: "..." }, ... ] }
    const content = (rawJson as any)?.content;
    if (!Array.isArray(content)) {
      throw new Error("Anthropic response missing content[]");
    }

    const text = content
      .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("");

    if (!text) {
      throw new Error("Anthropic response contained no text content");
    }

    return { text, raw: rawJson };
  }
}

