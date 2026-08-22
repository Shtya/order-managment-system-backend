import { Injectable } from "@nestjs/common";
import {
  AiProviderAbstract,
  AiProviderModelInfo,
  normalizeUsage,
  safeJsonParse,
  boolEnv,
  intEnv,
  floatEnv,
  strEnv,
  mapModelTypeFromModalities,
  isTextGenerateModel,
} from "./ai-provider.abstract";
import { AiProviderRequest, AiProviderResult } from "../interfaces/ai-types";
import { AiProviderError } from "../errors/provider.errors";
import { AiModelType, AiModelTier } from "../../../entities/ai.entity";

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

  async getModels(): Promise<AiProviderModelInfo[]> {
    const endpoint = `${this.baseUrl.replace(/\/$/, "")}/models`;
    const controller = this.createAbortController();

    const response = await this.withTimeout(
      fetch(endpoint, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        signal: controller.signal,
      }),
      this.getTimeoutMs(),
      this.kind,
    );

    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as any;
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

    const data = (await response.json().catch(() => null)) as any;
    const models = Array.isArray(data?.data) ? data.data : [];
    return models.flatMap((model: any) => {
      const modelCode = typeof model?.id === "string" ? model.id : "";
      if (!modelCode) return [];

      const outputModalities = model.modalities?.output;
      let modelType = mapModelTypeFromModalities(outputModalities);
      if (model.model_type === "video") modelType = AiModelType.VIDEO;
      else if (model.model_type === "image") modelType = AiModelType.IMAGE;
      else if (model.model_type === "audio") modelType = AiModelType.AUDIO;

      if (
        !isTextGenerateModel({
          modelCode,
          modelType,
          outputModalities,
          modelFamily: model.model_type,
        })
      ) {
        return [];
      }

      const tier =
        model.tier === "pro"
          ? AiModelTier.PRO
          : model.tier === "turbo" || model.tier === "free"
            ? AiModelTier.FREE
            : undefined;

      return [
        {
          modelCode,
          name: model.id,
          modelType: AiModelType.TEXT,
          tier,
          stream: typeof model.stream === "boolean" ? model.stream : undefined,
          jsonMode:
            typeof model.json_mode === "boolean" ? model.json_mode : undefined,
          reasoning:
            typeof model.reasoning === "boolean" ? model.reasoning : undefined,
          toolsCalling:
            typeof model.tools_calling === "boolean"
              ? model.tools_calling
              : undefined,
          contextWindow: {
            maxInputTokens: model.context_window?.tokens ?? undefined,
          },
          metadata: {
            object: model.object,
            owned_by: model.owned_by,
            created: model.created,
            model_type: model.model_type,
            tier: model.tier,
            pricing: model.pricing,
            pricing_mode: model.pricing_mode,
            modalities: model.modalities,
            usage_based_only: model.usage_based_only,
            capabilities: model.capabilities,
          },
        },
      ];
    });
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
