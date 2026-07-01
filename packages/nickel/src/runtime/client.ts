// OpenAI-compatible client for the local llama-server (Gemma 4 E4B). One engine
// for text grounding (JSON-schema constrained) and vision (image parts).

import { FailureError, FAILURE_CODES } from "@argent/registry";

export interface ChatImage {
  base64: string;
  mime?: string;
}

export interface ChatResult {
  text: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  latency_ms: number;
}

export interface ChatOpts {
  system?: string;
  user: string;
  image?: ChatImage;
  schema?: object;
  maxTokens?: number;
  temperature?: number;
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class LlamaClient {
  constructor(public baseUrl: string) {}

  async ping(timeoutMs = 2000): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      return r.ok;
    } catch {
      return false;
    }
  }

  async modelId(): Promise<string> {
    try {
      const r = await fetch(`${this.baseUrl}/v1/models`);
      const j = (await r.json()) as { data?: { id?: string }[] };
      return j.data?.[0]?.id ?? "unknown";
    } catch {
      return "unreachable";
    }
  }

  /** One constrained chat turn. Gemma has no system role, so `system` folds into the
   *  single user turn. `image` attaches a screenshot for vision. */
  async chat(opts: ChatOpts): Promise<ChatResult> {
    const userText = opts.system ? `${opts.system}\n\n${opts.user}` : opts.user;
    const content: ContentPart[] = [{ type: "text", text: userText }];
    if (opts.image) {
      content.unshift({
        type: "image_url",
        image_url: { url: `data:${opts.image.mime ?? "image/png"};base64,${opts.image.base64}` },
      });
    }
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: opts.image ? content : userText }],
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens ?? 220,
      cache_prompt: true,
    };
    if (opts.schema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "toolcall", schema: opts.schema },
      };
    }
    const t = Date.now();
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new FailureError(`llama-server ${res.status}: ${(await res.text()).slice(0, 200)}`, {
        error_code: FAILURE_CODES.NICKEL_LLAMA_HTTP_ERROR,
        failure_stage: "nickel_llama_chat",
        failure_area: "tool_server",
        error_kind: "network",
      });
    }
    const j = (await res.json()) as ChatCompletionResponse;
    return {
      text: j.choices?.[0]?.message?.content ?? "",
      usage: j.usage,
      latency_ms: Date.now() - t,
    };
  }
}
