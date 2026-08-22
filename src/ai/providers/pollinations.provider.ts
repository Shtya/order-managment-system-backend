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
import { AiModelType } from "../../../entities/ai.entity";

interface PollinationsChatCompletionRequest {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: "auto" | "none";
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  jsonMode?: boolean;
  referrer?: string;
}

interface PollinationsChatCompletionResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: Record<string, unknown>;
}

@Injectable()
export class PollinationsProvider extends AiProviderAbstract {
  readonly kind = "pollinations";
  readonly displayName = "Pollinations";

  constructor() {
    super();
    const prefix = "AI_POLLINATIONS";
    this.baseUrl = strEnv(
      process.env[`${prefix}_BASE_URL`],
      "https://text.pollinations.ai",
    );
    this.apiKey = strEnv(process.env[`${prefix}_API_KEY`], "");
    this.model = strEnv(process.env[`${prefix}_MODEL`], "openai");
    this.maxTokens = intEnv(process.env[`${prefix}_MAX_TOKENS`], 2048);
    this.temperature = floatEnv(process.env[`${prefix}_TEMPERATURE`], 0.4);
    this.priority = intEnv(process.env[`${prefix}_PRIORITY`], 20);
    this.retries = intEnv(process.env[`${prefix}_RETRIES`], 1);
    // Pollinations doesn't support function calling
    this.capabilities = { functionCalling: false };
  }

  supports(): boolean {
    return true;
  }

  async getModels(): Promise<AiProviderModelInfo[]> {
    const endpoint = `${this.baseUrl.replace(/\/$/, "")}/v1/models`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const controller = this.createAbortController();
    const response = await this.withTimeout(
      fetch(endpoint, {
        method: "GET",
        headers,
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

      const modelType = mapModelTypeFromModalities(model.output_modalities);
      if (
        !isTextGenerateModel({
          modelCode,
          modelType,
          outputModalities: model.output_modalities,
        })
      ) {
        return [];
      }

      return [
        {
          modelCode,
          name: model.id,
          modelType: AiModelType.TEXT,
          toolsCalling:
            typeof model.tools === "boolean" ? model.tools : undefined,
          reasoning:
            typeof model.reasoning === "boolean" ? model.reasoning : undefined,
          stream: Array.isArray(model.supported_endpoints)
            ? model.supported_endpoints.some((ep: string) =>
                String(ep).includes("chat/completions"),
              )
            : true,
          contextWindow: {
            maxInputTokens: model.context_length ?? undefined,
          },
          metadata: {
            object: model.object,
            created: model.created,
            input_modalities: model.input_modalities,
            output_modalities: model.output_modalities,
            supported_endpoints: model.supported_endpoints,
            agent: model.agent,
            base_model: model.base_model,
            pricing: model.pricing,
            capabilities: model.capabilities,
          },
        },
      ];
    });
  }

  protected async chat(request: AiProviderRequest): Promise<AiProviderResult> {
    const endpoint = `${this.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
    const body: PollinationsChatCompletionRequest = {
      model: this.model || "openai",
      messages: request.messages.map((m) => mapMessage(m)),
      max_tokens: request.maxTokens ?? this.maxTokens,
      temperature: request.temperature ?? this.temperature,
      stream: false,
    };

    if (request.toolChoice !== "none") {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = "auto";
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const controller = this.createAbortController();
    const fetchPromise = fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const response = await this.withTimeout(
      fetchPromise,
      this.getTimeoutMs(),
      this.kind,
    );
    const data = (await response
      .json()
      .catch(() => null)) as PollinationsChatCompletionResponse | null;

    if (!response.ok) {
      const message =
        (data as any)?.error?.message ??
        `Provider returned HTTP ${response.status}`;
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

    const normalized = this.normalizePollinations(data);
    if (normalized) return normalized;

    throw new AiProviderError(
      `Provider '${this.kind}' returned an unparseable response`,
      {
        kind: "INVALID_RESPONSE",
        provider: this.kind,
      },
    );
  }

  private normalizePollinations(
    data: PollinationsChatCompletionResponse | null,
  ): AiProviderResult | null {
    const message = data?.choices?.[0]?.message;
    if (!message) return null;

    const usage = normalizeUsage(data.usage);
    const toolCalls = message.tool_calls
      ?.map((tc) => {
        const parsed = safeJsonParse(tc.function?.arguments);
        return {
          id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
          name: tc.function?.name ?? "",
          arguments:
            parsed && typeof parsed === "object"
              ? (parsed as Record<string, unknown>)
              : {},
        };
      })
      .filter((tc) => tc.name);

    if (toolCalls?.length) {
      return { role: "assistant", toolCalls, usage, providerModel: this.model };
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
