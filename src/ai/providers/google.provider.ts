import { Injectable } from "@nestjs/common";
import { GoogleGenAI } from "@google/genai";
import {
  AiProviderAbstract,
  boolEnv,
  intEnv,
  floatEnv,
  strEnv,
} from "./ai-provider.abstract";
import { AiProviderRequest, AiProviderResult } from "../interfaces/ai-types";

@Injectable()
export class GoogleProvider extends AiProviderAbstract {
  readonly kind = "google";
  readonly displayName = "Google Gemini";

  protected buildClient(): GoogleGenAI {
    if (!this.apiKey) {
      throw new Error(
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
