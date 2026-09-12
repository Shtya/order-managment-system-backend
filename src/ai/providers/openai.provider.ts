import { Injectable } from "@nestjs/common";
import OpenAI from "openai";
import {
  AiProviderAbstract,
  AiProviderModelInfo,
  normalizeUsage,
  safeJsonParse,
  boolEnv,
  intEnv,
  floatEnv,
  strEnv,
  isTextGenerateModel,
} from "./ai-provider.abstract";
import { AiProviderRequest, AiProviderResult } from "../interfaces/ai-types";
import { AiProviderError, toAiProviderError } from "../errors/provider.errors";
import { AiModelType } from "../../../entities/ai.entity";
import { isChatCompletionsReasoningModel } from "../orchestrator/model-rank";

@Injectable()
export class OpenAiProvider extends AiProviderAbstract {
  readonly kind = "openai";
  readonly displayName = "OpenAI";

  protected buildClient(): OpenAI {
    if (!this.apiKey) {
      throw new AiProviderError(
        `Missing API key for provider '${this.kind}'(env or integration)`,
        { kind: "AUTH", provider: this.kind, retryable: false },
      );
    }
    return new OpenAI({
      apiKey: this.apiKey,
      baseURL: "https://api.openai.com/v1",
    });
  }

  constructor() {
    super();
    const prefix = "AI_OPENAI";
    this.baseUrl = "https://api.openai.com/v1",
    this.apiKey = strEnv(process.env[`${prefix}_API_KEY`], "");
    this.model = strEnv(process.env[`${prefix}_MODEL`], "gpt-4o-mini");
    this.maxTokens = intEnv(process.env[`${prefix}_MAX_TOKENS`], 2048);
    this.temperature = floatEnv(process.env[`${prefix}_TEMPERATURE`], 0.4);
    this.priority = intEnv(process.env[`${prefix}_PRIORITY`], 30);
    this.retries = intEnv(process.env[`${prefix}_RETRIES`], 2);
  }

  supports(): boolean {
    return !!this.apiKey;
  }

  async getModels(): Promise<AiProviderModelInfo[]> {
    const client = this.buildClient();
    try {
      const models: AiProviderModelInfo[] = [];
      const rawModels = await client.models.list();
      for (const model of rawModels.data) {
        const modelCode = model.id;
        if (!modelCode) continue;
        const modelType = inferOpenAiCatalogType(model.id);
        if (!isTextGenerateModel({ modelCode, modelType })) continue;
        models.push({
          modelCode,
          name: model.id,
          modelType: AiModelType.TEXT,
          toolsCalling: undefined,
          stream: undefined,
          metadata: {
            object: model.object,
            owned_by: model.owned_by,
            created: model.created,
          },
        });
      }
      return models;
    } catch (error) {
      throw toAiProviderError(error, this.kind);
    }
  }

  protected async chat(request: AiProviderRequest): Promise<AiProviderResult> {
    const client = this.buildClient();
    const useTools =
      request.tools.length > 0 && request.toolChoice !== "none";

      const buildBody = (
        includeTemperature: boolean,
        reasoningEffort: "medium" | "none" = "medium",
      ) => ({
        model: this.model,
        messages: request.messages.map((m) => mapMessage(m)) as any,
        stream: false as const,
      
        ...(includeTemperature
          ? { temperature: request.temperature ?? this.temperature }
          : {}),
      
        ...(useTools && isChatCompletionsReasoningModel(this.model)
          ? { reasoning_effort: reasoningEffort }
          : {}),
      
        ...(useTools
          ? {
              tools: request.tools.map((t) => ({
                type: "function" as const,
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                },
              })),
              tool_choice: request.toolChoice,
            }
          : {}),
      });

    const create = (includeTemperature: boolean, effort: "medium" | "none" = "medium") =>
      this.withTimeout(
        client.chat.completions.create(buildBody(includeTemperature, effort)),
        this.getTimeoutMs(),
        this.kind,
      );

    let response;

    try {
      response = await create(true);
    } catch (error) {
      if (isUnsupportedTemperatureError(error)) {
        response = await create(false, "medium");
      } else if (isReasoningToolsNotSupportedError(error)) {
        response = await create(true, "none");
      } else {
        throw error;
      }
    }

    return this.normalizeResponse(response);
  }

  private normalizeResponse(
    data: OpenAI.Chat.Completions.ChatCompletion,
  ): AiProviderResult {
    const message = data.choices[0]?.message;

    if (!message) {
      throw new AiProviderError(
        `Provider '${this.kind}' returned an empty response`,
        {
          kind: "INVALID_RESPONSE",
          provider: this.kind,
        },
      );
    }

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

    return {
      role: "assistant",
      content: message.content ?? "",
      usage,
      providerModel: this.model,
    };
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
          content: message.content ?? "",
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

function isReasoningToolsNotSupportedError(error: unknown): boolean {
  const text = String(
    (error as { message?: string })?.message ?? error ?? "",
  ).toLowerCase();

  return (
    text.includes("function tools") &&
    text.includes("reasoning_effort") &&
    text.includes("not supported") &&
    text.includes("chat/completions")
  );
}

function isUnsupportedTemperatureError(error: unknown): boolean {
  const text = String(
    (error as { message?: string })?.message ?? error ?? "",
  ).toLowerCase();
  if (text.includes("temperature") && text.includes("unsupported")) {
    return true;
  }
  if (!error || typeof error !== "object") return false;
  const body = error as {
    status?: number;
    error?: { param?: string; code?: string; message?: string };
  };
  if (body.status !== 400) return false;
  if (body.error?.param === "temperature") return true;
  const message = String(body.error?.message ?? "").toLowerCase();
  return message.includes("temperature") && message.includes("unsupported");
}

function inferOpenAiCatalogType(id: string): AiModelType {
  const lower = id.toLowerCase();
  if (
    lower.includes("dall-e") ||
    lower.includes("gpt-image") ||
    lower.includes("imagen")
  ) {
    return AiModelType.IMAGE;
  }
  if (
    lower.includes("whisper") ||
    lower.includes("tts") ||
    lower.includes("audio")
  ) {
    return AiModelType.AUDIO;
  }
  if (lower.includes("sora") || lower.includes("video")) {
    return AiModelType.VIDEO;
  }
  return AiModelType.TEXT;
}
