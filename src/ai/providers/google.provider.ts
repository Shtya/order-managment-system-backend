import { BadRequestException, Injectable } from "@nestjs/common";
import { GoogleGenAI, type Model } from "@google/genai";
import {
  AiProviderAbstract,
  AiProviderModelInfo,
  intEnv,
  floatEnv,
  strEnv,
  stripGeminiModelName,
  isTextGenerateModel,
} from "./ai-provider.abstract";
import { AiProviderRequest, AiProviderResult } from "../interfaces/ai-types";
import { toAiProviderError } from "../errors/provider.errors";
import { AiModelType } from "../../../entities/ai.entity";

@Injectable()
export class GoogleProvider extends AiProviderAbstract {
  readonly kind = "google";
  readonly displayName = "Google Gemini";

  protected buildClient(): GoogleGenAI {
    if (!this.apiKey) {
      throw new BadRequestException(
        `Missing API key for provider '${this.kind}'(env or integration)`,
      );
    }
    return new GoogleGenAI({ apiKey: this.apiKey });
  }

  constructor() {
    super();
    const prefix = "AI_GOOGLE";
    this.baseUrl = strEnv(process.env[`${prefix}_BASE_URL`], "");
    this.apiKey = strEnv(
      process.env[`${prefix}_API_KEY`],
      process.env.GOOGLE_API_KEY ?? "",
    );
    this.model = strEnv(process.env[`${prefix}_MODEL`], "gemini-2.5-flash");
    this.maxTokens = intEnv(process.env[`${prefix}_MAX_TOKENS`], 2048);
    this.temperature = floatEnv(process.env[`${prefix}_TEMPERATURE`], 0.4);
    this.priority = intEnv(process.env[`${prefix}_PRIORITY`], 70);
    this.retries = intEnv(process.env[`${prefix}_RETRIES`], 2);
  }

  supports(): boolean {
    return !!this.apiKey;
  }

  async getModels(): Promise<AiProviderModelInfo[]> {
    const client = this.buildClient();

    try {
      const pager = await client.models.list();
      const models: Model[] = [];

      for await (const model of pager) {
        models.push(model);
      }

      return models.flatMap((model) => {
        const actions = model.supportedActions ?? [];
        const modelCode =
          (model as Model & { baseModelId?: string }).baseModelId ||
          stripGeminiModelName(model.name);

        if (!modelCode) return [];

        const canGenerate = actions.includes("generateContent");
        const canStream =
          actions.includes("streamGenerateContent") || canGenerate;
        const modelType = inferGeminiModelType(modelCode);

        if (
          !isTextGenerateModel({
            modelCode,
            modelType,
            supportedActions: actions,
          })
        ) {
          return [];
        }

        return [
          {
            modelCode,
            name: model.displayName ?? modelCode,
            description: model.description,
            modelType: AiModelType.TEXT,
            reasoning: model.thinking === true,
            // ListModels does not expose function-calling; generateContent ≠ tools.
            toolsCalling: canGenerate ? undefined : false,
            stream: canStream,
            contextWindow: {
              maxInputTokens: model.inputTokenLimit,
              maxOutputTokens: model.outputTokenLimit,
            },
            metadata: {
              version: model.version,
              supportedActions: actions,
              temperature: model.temperature,
              maxTemperature: model.maxTemperature,
              topP: model.topP,
              topK: model.topK,
              thinking: model.thinking,
              tunedModelInfo: model.tunedModelInfo,
            },
          },
        ];
      });
    } catch (error) {
      throw toAiProviderError(error, this.kind);
    }
  }

  protected async chat(request: AiProviderRequest): Promise<AiProviderResult> {
    const client = this.buildClient();
    const contents = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [
          {
            text: typeof m.content === "string" ? m.content : String(m.content),
          },
        ],
      }));

    const systemMessage = request.messages.find((m) => m.role === "system");

    const response = await this.withTimeout(
      client.models.generateContent({
        model: this.model,

        contents,

        config: {
          ...(systemMessage
            ? {
              systemInstruction:
                typeof systemMessage.content === "string"
                  ? systemMessage.content
                  : String(systemMessage.content),
            }
            : {}),

          temperature: request.temperature ?? this.temperature,

          maxOutputTokens: request.maxTokens ?? this.maxTokens,

          ...(request.tools.length > 0 && request.toolChoice !== "none"
            ? {
              tools: [
                {
                  functionDeclarations: request.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                  })),
                },
              ],
            }
            : {}),
        },
      }),
      this.getTimeoutMs(),
      this.kind,
    );

    return this.normalizeResponse(response);
  }

  private normalizeResponse(response: any): AiProviderResult {
    const text = response.text ?? "";

    const functionCalls =
      typeof response.functionCalls === "function"
        ? response.functionCalls()
        : [];

    if (functionCalls?.length) {
      return {
        role: "assistant",
        toolCalls: functionCalls.map((call: any, index: number) => ({
          id: `google-tool-${index}`,
          name: call.name,
          arguments: call.args ?? {},
        })),
        providerModel: this.model,
      };
    }

    return {
      role: "assistant",
      content: text,
      providerModel: this.model,
    };
  }
}

function inferGeminiModelType(modelCode: string): AiModelType {
  const id = modelCode.toLowerCase();
  if (id.includes("image") || id.includes("imagen") || id.includes("banana")) {
    return AiModelType.IMAGE;
  }
  if (id.includes("lyria") || id.includes("tts") || id.includes("audio")) {
    return AiModelType.AUDIO;
  }
  if (id.includes("veo") || id.includes("video")) {
    return AiModelType.VIDEO;
  }
  return AiModelType.TEXT;
}
