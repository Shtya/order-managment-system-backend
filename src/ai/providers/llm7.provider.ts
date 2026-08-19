import { Injectable } from "@nestjs/common";
import {
  AiProviderAbstract,
  normalizeUsage,
  safeJsonParse,
  boolEnv,
  intEnv,
  floatEnv,
  strEnv,
} from "./ai-provider.abstract";
import { AiProviderRequest, AiProviderResult } from "../interfaces/ai-types";
import { AiProviderError } from "../errors/provider.errors";

interface OpenAiChatCompletionRequest {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: "auto" | "none";
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAiChatCompletionChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAiToolCall[];
  };
  finish_reason?: string;
}

interface OpenAiChatCompletionResponse {
  id: string;
  choices: OpenAiChatCompletionChoice[];
  usage?: OpenAiUsage;
  error?: { message?: string; type?: string; code?: string; status?: number };
}

@Injectable()
export class Llm7Provider extends AiProviderAbstract {
  readonly kind = "llm7";
  readonly displayName = "LLM7";

  constructor() {
    super();
    const prefix = "AI_LLM7";
    this.baseUrl = strEnv(
      process.env[`${prefix}_BASE_URL`],
      "https://api.llm7.io/v1",
    );
    this.apiKey = strEnv(process.env[`${prefix}_API_KEY`], "");
    this.model = strEnv(process.env[`${prefix}_MODEL`], "openai");
    this.maxTokens = intEnv(process.env[`${prefix}_MAX_TOKENS`], 2048);
    this.temperature = floatEnv(process.env[`${prefix}_TEMPERATURE`], 0.4);
    this.priority = intEnv(process.env[`${prefix}_PRIORITY`], 10);
    this.retries = intEnv(process.env[`${prefix}_RETRIES`], 2);
  }

  supports(): boolean {
    return true;
  }

  protected async chat(request: AiProviderRequest): Promise<AiProviderResult> {
    const endpoint = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body: OpenAiChatCompletionRequest = {
      model: this.model,
      messages: request.messages.map((m) => mapMessage(m)),
      tool_choice: request.toolChoice,
      max_tokens: request.maxTokens ?? this.maxTokens,
      temperature: request.temperature ?? this.temperature,
      stream: false,
    };

    if (request.tools.length > 0 && request.toolChoice !== "none") {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    } else {
      delete body.tools;
      delete body.tool_choice;
    }

    const controller = this.createAbortController();
    const timeoutMs = request.signal ? 0 : this.getTimeoutMs();

    const fetchPromise = fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const response = await this.withTimeout(
      fetchPromise,
      timeoutMs || this.getTimeoutMs(),
      this.kind,
    );

    const data = (await response
      .json()
      .catch(() => null)) as OpenAiChatCompletionResponse | null;

    if (!response.ok) {
      const message =
        data?.error?.message ?? `Provider returned HTTP ${response.status}`;
      throw new AiProviderError(message, {
        kind:
          response.status === 429
            ? "RATE_LIMITED"
            : response.status === 401 || response.status === 403
              ? "AUTH"
              : "HTTP",
        provider: this.kind,
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const normalized = this.normalizeOpenAi(data);
    if (normalized) return normalized;

    throw new AiProviderError(
      `Provider '${this.kind}' returned an unparseable response`,
      {
        kind: "INVALID_RESPONSE",
        provider: this.kind,
      },
    );
  }

  private normalizeOpenAi(
    data: OpenAiChatCompletionResponse | null,
  ): AiProviderResult | null {
    if (!data?.choices?.length) return null;

    const message = data.choices[0].message;
    const usage = normalizeUsage(data.usage);
    const toolCalls = message.tool_calls
      ?.filter((tc) => tc.type === "function")
      .map((tc) => {
        const parsed = safeJsonParse(tc.function.arguments);
        return {
          id: tc.id,
          name: tc.function.name,
          arguments:
            parsed && typeof parsed === "object"
              ? (parsed as Record<string, unknown>)
              : {},
        };
      });

    if (toolCalls?.length) {
      return {
        role: "assistant",
        toolCalls,
        usage,
        providerModel: this.model,
      };
    }

    if (typeof message.content === "string" && message.content.trim() !== "") {
      return {
        role: "assistant",
        content: message.content,
        usage,
        providerModel: this.model,
      };
    }

    return null;
  }
}

function mapMessage(message: {
  role: string;
  content: string | null;
  toolCallId?: string;
  name?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}) {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "assistant":
      if (message.toolCalls?.length) {
        return {
          role: "assistant",
          content: message.content,
          tool_calls: message.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        };
      }
      return { role: "assistant", content: message.content };
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content ?? "",
      };
    default:
      return { role: message.role, content: message.content };
  }
}
