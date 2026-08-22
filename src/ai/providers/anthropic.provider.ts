import { BadRequestException, Injectable } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import {
  AiProviderAbstract,
  AiProviderModelInfo,
  normalizeUsage,
  boolEnv,
  intEnv,
  floatEnv,
  strEnv,
  isTextGenerateModel,
} from "./ai-provider.abstract";
import { AiProviderRequest, AiProviderResult } from "../interfaces/ai-types";
import { toAiProviderError } from "../errors/provider.errors";
import { AiModelType } from "../../../entities/ai.entity";

@Injectable()
export class AnthropicProvider extends AiProviderAbstract {
  readonly kind = "anthropic";
  readonly displayName = "Anthropic";

  protected buildClient(): Anthropic {
    if (!this.apiKey) {
      throw new BadRequestException(`Missing API key for provider '${this.kind}'`);
    }
    return new Anthropic({
      apiKey: this.apiKey,
      // baseURL: this.baseUrl || undefined,
    });
  }

  constructor() {
    super();
    const prefix = "AI_ANTHROPIC";
    this.baseUrl = strEnv(
      process.env[`${prefix}_BASE_URL`],
      "https://api.anthropic.com/v1",
    );
    this.apiKey = strEnv(process.env[`${prefix}_API_KEY`], "");
    this.model = strEnv(process.env[`${prefix}_MODEL`], "claude-3-opus-latest");
    this.maxTokens = intEnv(process.env[`${prefix}_MAX_TOKENS`], 2048);
    this.temperature = floatEnv(process.env[`${prefix}_TEMPERATURE`], 0.4);
    this.priority = intEnv(process.env[`${prefix}_PRIORITY`], 50);
    this.retries = intEnv(process.env[`${prefix}_RETRIES`], 2);
  }

  supports(): boolean {
    return !!this.apiKey;
  }

  async getModels(): Promise<AiProviderModelInfo[]> {
    const client = this.buildClient();
    try {
      const models: AiProviderModelInfo[] = [];
      for await (const model of client.models.list({ limit: 100 })) {
        const modelCode = model.id;
        if (!modelCode) continue;
        if (!isTextGenerateModel({ modelCode, modelType: AiModelType.TEXT })) {
          continue;
        }
        const capabilities = model.capabilities;
        models.push({
          modelCode,
          name: model.display_name || model.id,
          modelType: AiModelType.TEXT,
          reasoning: capabilities?.thinking?.supported === true,
          jsonMode: capabilities?.structured_outputs?.supported === true,
          toolsCalling: true,
          stream: true,
          contextWindow: {
            maxInputTokens: model.max_input_tokens ?? undefined,
            maxOutputTokens: model.max_tokens ?? undefined,
          },
          metadata: {
            type: model.type,
            created_at: model.created_at,
            capabilities,
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
    const systemMessage = request.messages.find((m) => m.role === "system");

    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role:
          m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: typeof m.content === "string" ? m.content : m.content,
      }));

    const response = await this.withTimeout(
      client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens ?? this.maxTokens ?? 1024,
        temperature: request.temperature ?? this.temperature,

        ...(systemMessage
          ? {
              system:
                typeof systemMessage.content === "string"
                  ? systemMessage.content
                  : "",
            }
          : {}),

        messages,

        ...(request.tools.length > 0 && request.toolChoice !== "none"
          ? {
              tools: request.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: {
                  type: "object" as const,
                  ...(typeof t.parameters === "object" && t.parameters !== null
                    ? t.parameters
                    : {}),
                },
              })),
            }
          : {}),
      }),
      this.getTimeoutMs(),
      this.kind,
    );

    return this.normalizeResponse(response);
  }

  private normalizeResponse(response: Anthropic.Message): AiProviderResult {
    const toolCalls = response.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments:
          block.input && typeof block.input === "object"
            ? (block.input as Record<string, unknown>)
            : {},
      }));

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    const usage = normalizeUsage({
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    });

    if (toolCalls.length) {
      return {
        role: "assistant",
        toolCalls,
        usage,
        providerModel: this.model,
      };
    }

    return {
      role: "assistant",
      content: text,
      usage,
      providerModel: this.model,
    };
  }
}
