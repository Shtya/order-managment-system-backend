import OpenAI from "openai";
import {
  AiProviderAbstract,
  AiProviderModelInfo,
  isTextGenerateModel,
} from "./ai-provider.abstract";
import { AiProviderRequest, AiProviderResult } from "../interfaces/ai-types";
import { AiProviderError, toAiProviderError } from "../errors/provider.errors";
import { AiModelType } from "../../../entities/ai.entity";

export abstract class OpenAiCompatibleProvider extends AiProviderAbstract {
  protected buildClient(): OpenAI {
    if (!this.apiKey) {
      throw new AiProviderError(
        `Missing API key for provider '${this.kind}'(env or integration)`,
        { kind: "AUTH", provider: this.kind, retryable: false },
      );
    }
    return new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseUrl || undefined,
    });
  }

  async getModels(): Promise<AiProviderModelInfo[]> {
    const client = this.buildClient();

    try {
      const models: AiProviderModelInfo[] = [];
      for await (const model of client.models.list()) {
        const modelCode = model.id;
        if (!modelCode) continue;
        if (!isTextGenerateModel({ modelCode, modelType: AiModelType.TEXT })) {
          continue;
        }
        models.push({
          modelCode,
          name: model.id,
          modelType: AiModelType.TEXT,
          toolsCalling: undefined,
          stream: undefined,
          jsonMode: undefined,
          reasoning: undefined,
          metadata: {
            object: model.object,
            ownedBy: model.owned_by,
            created: model.created,
          },
        });
      }
      return models;
    } catch (error) {
      throw toAiProviderError(error, this.kind);
    }
  }

  protected abstract getFunctionCallModelName(
    request: AiProviderRequest,
  ): string;

  protected async chat(request: AiProviderRequest): Promise<AiProviderResult> {
    const client = this.buildClient();
    const model = request.tools.length
      ? this.getFunctionCallModelName(request)
      : this.model;

    const response = await this.withTimeout(
      client.chat.completions.create({
        model,
        messages: request.messages.map((m) => mapMessage(m)) as any,
        max_tokens: request.maxTokens ?? this.maxTokens,
        temperature: request.temperature ?? this.temperature,
        stream: false,

        ...(request.tools.length > 0 && request.toolChoice !== "none"
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
      }),
      this.getTimeoutMs(),
      this.kind,
    );

    const choice = response.choices?.[0];
    const msg = choice?.message;

    if (!msg) {
      return this.validateResult({}, this.kind);
    }

    const out: Record<string, unknown> = {};
    if (typeof msg.content === "string") out.content = msg.content;
    if (msg.tool_calls?.length) {
      out.toolCalls = msg.tool_calls
        .filter((tc) => tc.type === "function")
        .map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }));
    }
    if (response.usage) {
      out.usage = {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      };
    }
    out.providerModel = response.model;

    return this.validateResult(out, this.kind);
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
