import { withTimeout } from "../utils/time.js";
import Anthropic from "@anthropic-ai/sdk";

export type AnthropicConfig = {
  apiKey?: string;
  authToken?: string;
  baseUrl: string; // e.g. https://api.anthropic.com
  model: string;
  maxTokens: number;
  timeoutMs: number;
  debug?: boolean;
};

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string;
};

export class AnthropicClient {
  private readonly client: Anthropic;

  constructor(private readonly cfg: AnthropicConfig) {
    this.client = new Anthropic({
      apiKey: cfg.apiKey || null,
      authToken: cfg.authToken || null,
      baseURL: cfg.baseUrl,
      timeout: cfg.timeoutMs,
    });
  }

  async completeText(params: {
    system?: string;
    messages: AnthropicMessage[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ text: string; raw: unknown }> {
    // Many "Anthropic-compatible" gateways deviate subtly from the official API surface.
    // The official SDK may throw while parsing responses (e.g. content.map on undefined).
    // For non-official base URLs, use a fetch fallback that is more tolerant and produces
    // actionable error messages.
    const isOfficial = isOfficialAnthropicHostname(this.cfg.baseUrl);

    const raw = isOfficial ? await this.sdkMessagesCreate(params) : await this.fetchMessages(params);

    const text = extractText(raw);

    if (!text) {
      const preview = safeJsonPreview(raw);
      throw new Error(
        [
          "LLM response contained no text content.",
          "If you are using a non-Anthropic gateway/proxy, make sure it is Anthropic Messages API compatible.",
          `baseUrl=${this.cfg.baseUrl}`,
          `model=${this.cfg.model}`,
          `raw=${preview}`,
        ].join("\n"),
      );
    }
    return { text, raw };
  }

  private async sdkMessagesCreate(params: {
    system?: string;
    messages: AnthropicMessage[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<unknown> {
    try {
      if (this.cfg.debug) {
        // eslint-disable-next-line no-console
        console.error(
          [
            "[llm:sdk] messages.create",
            `baseUrl=${this.cfg.baseUrl}`,
            `model=${this.cfg.model}`,
            `timeoutMs=${this.cfg.timeoutMs}`,
          ].join(" "),
        );
      }

      return await withTimeout(
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
    } catch (err) {
      // eslint-disable-next-line no-console
      if (this.cfg.debug) console.error("[llm:sdk] error:", err);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        [
          "LLM SDK call failed.",
          `baseUrl=${this.cfg.baseUrl}`,
          `model=${this.cfg.model}`,
          `message=${msg}`,
          "If you are using a third-party gateway, set ANTHROPIC_BASE_URL to that gateway and it will use the fetch fallback.",
        ].join("\n"),
      );
    }
  }

  private async fetchMessages(params: {
    system?: string;
    messages: AnthropicMessage[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<unknown> {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/v1/messages`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Keep pinned for compatibility; many gateways also accept it.
      "anthropic-version": "2023-06-01",
    };

    if (this.cfg.authToken) headers.authorization = `Bearer ${this.cfg.authToken}`;
    if (this.cfg.apiKey) headers["x-api-key"] = this.cfg.apiKey;

    const body = {
      model: this.cfg.model,
      max_tokens: params.maxTokens ?? this.cfg.maxTokens,
      temperature: params.temperature,
      system: params.system,
      messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    if (this.cfg.debug) {
      // eslint-disable-next-line no-console
      console.error(
        [
          "[llm:fetch] POST",
          url,
          `model=${this.cfg.model}`,
          `timeoutMs=${this.cfg.timeoutMs}`,
          `auth=${this.cfg.authToken ? "bearer" : this.cfg.apiKey ? "x-api-key" : "none"}`,
        ].join(" "),
      );
    }

    const res = await withTimeout(
      fetch(url, { method: "POST", headers, body: JSON.stringify(body) }),
      this.cfg.timeoutMs,
      `LLM request timed out after ${this.cfg.timeoutMs}ms`,
    );

    const rawText = await res.text();
    if (this.cfg.debug) {
      // eslint-disable-next-line no-console
      console.error(
        [
          "[llm:fetch] status",
          String(res.status),
          res.ok ? "ok" : "failed",
          "respPreview=" + (rawText.length > 400 ? `${rawText.slice(0, 400)}…` : rawText),
        ].join(" "),
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      json = { _nonJson: true, text: rawText };
    }

    if (!res.ok) {
      throw new Error(
        [
          `LLM gateway error (${res.status}).`,
          `baseUrl=${this.cfg.baseUrl}`,
          `model=${this.cfg.model}`,
          `body=${typeof rawText === "string" ? rawText.slice(0, 800) : String(rawText)}`,
        ].join("\\n"),
      );
    }

    return json;
  }
}

function isOfficialAnthropicHostname(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return /(^|\.)anthropic\.com$/i.test(host);
  } catch {
    return false;
  }
}

function extractText(raw: unknown): string {
  const r: any = raw as any;
  const content = r?.content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("")
      .trim();
  }

  if (typeof content === "string") return content.trim();

  // Best-effort fallback for OpenAI-like gateways
  const choiceText =
    r?.choices?.[0]?.message?.content ??
    r?.choices?.[0]?.delta?.content ??
    r?.output_text ??
    r?.text;
  if (typeof choiceText === "string") return choiceText.trim();

  return "";
}

function safeJsonPreview(raw: unknown): string {
  try {
    const text = JSON.stringify(raw);
    return text.length > 800 ? `${text.slice(0, 800)}…` : text;
  } catch {
    return String(raw);
  }
}
