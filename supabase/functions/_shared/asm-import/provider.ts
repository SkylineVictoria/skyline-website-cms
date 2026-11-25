/**
 * ASM-AI-IMPORT: the AI behind a small interface, so the provider or model can change without touching the import code.
 * Configured by the Edge Function from its secrets: EF_ASM_IMPORT_PROVIDER ("openai" by default, "mock" in the lab) and
 * EF_ASM_IMPORT_MODEL (default OPENAI_DOCUMENT_MODEL); the key is OPENAI_API_KEY, read server side only and never logged.
 * Only workbooks and answer guides are ever sent; never student data. The AI does not mark.
 */
export interface AiUsage { inputTokens: number; outputTokens: number }
export type AiInput = { kind: "text"; text: string } | { kind: "image"; dataUrl: string };
export interface StructuredRequest {
  /** Schema name (a-z, 0-9, _). */
  name: string;
  schema: Record<string, unknown>;
  instructions: string;
  input: AiInput[];
  maxOutputTokens: number;
  timeoutMs: number;
}
export interface StructuredResult { data: unknown; usage: AiUsage; responseId: string | null }
export interface StructuredProvider {
  id: string;
  model: string;
  /** Can read page images (scanned pages). */
  vision: boolean;
  generate(request: StructuredRequest): Promise<StructuredResult>;
}

export type AiErrorCode = "config" | "network" | "timeout" | "rate_limit" | "provider" | "incomplete" | "schema";
export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly retry: boolean;
  constructor(message: string, code: AiErrorCode, retry: boolean) {
    super(message);
    this.code = code;
    this.retry = retry;
  }
}

export interface ProviderConfig {
  provider: string;
  model: string;
  apiKey?: string;
  /** OpenAI-compatible base URL (lab mocks only). */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** The mock's answer, for the lab and tests. */
  mock?: (request: StructuredRequest) => unknown;
}

export function createProvider(config: ProviderConfig): StructuredProvider {
  const id = (config.provider || "openai").toLowerCase();
  if (id === "mock") {
    if (!config.mock) throw new AiError("The mock AI provider has no answers configured.", "config", false);
    const answer = config.mock;
    return {
      id: "mock", model: config.model || "mock", vision: true,
      generate: (request) => Promise.resolve({ data: answer(request), usage: { inputTokens: 0, outputTokens: 0 }, responseId: null }),
    };
  }
  if (id === "openai") return openAi(config);
  throw new AiError(`Unknown AI provider "${config.provider}".`, "config", false);
}

function responseText(response: Record<string, unknown>): string | null {
  if (typeof response.output_text === "string") return response.output_text;
  const output = (response.output as Record<string, unknown>[] | undefined) ?? [];
  for (const item of output) {
    for (const c of (item.content as Record<string, unknown>[] | undefined) ?? []) {
      if (c.type === "output_text" && typeof c.text === "string") return c.text;
      if (c.type === "refusal") throw new AiError("The AI declined to read this document.", "provider", false);
    }
  }
  return null;
}

function openAi(config: ProviderConfig): StructuredProvider {
  if (!config.apiKey) throw new AiError("The AI reader is not configured (no API key).", "config", false);
  if (!config.model) throw new AiError("The AI reader is not configured (no model).", "config", false);
  const url = `${(config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/responses`;
  const call = config.fetch ?? fetch;
  return {
    id: "openai", model: config.model, vision: true,
    async generate(request) {
      const content = request.input.map((p) => (p.kind === "text" ? { type: "input_text", text: p.text } : { type: "input_image", image_url: p.dataUrl, detail: "high" }));
      let res: Response;
      try {
        res = await call(url, {
          method: "POST", signal: AbortSignal.timeout(request.timeoutMs),
          headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: config.model, store: false, max_output_tokens: request.maxOutputTokens,
            instructions: request.instructions,
            input: [{ role: "user", content }],
            text: { format: { type: "json_schema", name: request.name, strict: true, schema: request.schema } },
          }),
        });
      } catch (e) {
        const timeout = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
        throw new AiError(timeout ? "The AI reader took too long." : "The AI reader could not be reached.", timeout ? "timeout" : "network", true);
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new AiError(`The AI reader answered ${res.status}.`, res.status === 429 ? "rate_limit" : "provider", res.status === 429 || res.status >= 500);
      }
      let body: Record<string, unknown>;
      try { body = await res.json(); } catch { throw new AiError("The AI reader sent an unreadable answer.", "schema", true); }
      const usageRaw = (body.usage ?? {}) as Record<string, number>;
      const usage = { inputTokens: Number(usageRaw.input_tokens) || 0, outputTokens: Number(usageRaw.output_tokens) || 0 };
      if (body.status === "incomplete") throw Object.assign(new AiError("The AI reader stopped before the end (the part is too long).", "incomplete", false), { usage });
      const text = responseText(body);
      let data: unknown;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!data || typeof data !== "object") throw Object.assign(new AiError("The AI reader's answer did not match the expected structure.", "schema", true), { usage });
      return { data, usage, responseId: typeof body.id === "string" ? body.id : null };
    },
  };
}

/** USD for the usage, when prices per million tokens are configured (EF_ASM_IMPORT_INPUT_USD_PER_MILLION / _OUTPUT_). */
export function costUsd(usage: AiUsage, inputPerMillion?: number, outputPerMillion?: number): number | null {
  if (inputPerMillion === undefined || outputPerMillion === undefined) return null;
  return Math.round(((usage.inputTokens * inputPerMillion + usage.outputTokens * outputPerMillion) / 1e6) * 1e6) / 1e6;
}
