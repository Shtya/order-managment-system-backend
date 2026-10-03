import { Injectable, Logger } from "@nestjs/common";
import { toFile } from "openai";
import {
  MediaConfigService,
  MediaUnderstandingError,
  type MediaUsage,
} from "../media-config.service";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    relevant: { type: "boolean" },
    confidence: { type: "number" },
    documentType: { type: "string" },
    summary: { type: "string" },
    information: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          value: { type: "string" },
        },
        required: ["name", "value"],
      },
    },
  },
  required: [
    "relevant",
    "confidence",
    "documentType",
    "summary",
    "information",
  ],
};

@Injectable()
export class DocumentMediaProcessor {
  private readonly logger = new Logger (DocumentMediaProcessor.name);
  constructor(private readonly mediaConfig: MediaConfigService) {}

  estimate(buffer: Buffer): MediaUsage {
    return this.fallbackUsage(buffer);
  }

  fallbackUsage(buffer: Buffer): MediaUsage {
    const extra = Math.min(20_000, Math.ceil(buffer.length / 50));

    return {
      inputTokens: 4000 + extra,
      outputTokens: 1500,
      audioSeconds: 0,
    };
  }

  compactInfo(information: unknown): string {
    if (!information || typeof information !== "object") {
      return "";
    }
  
    const payload = Array.isArray(information)
      ? Object.fromEntries(
          information
            .map((item) => {
              if (!item || typeof item !== "object") return null;
              const name = String((item as { name?: unknown }).name ?? "").trim();
              const value = String((item as { value?: unknown }).value ?? "").trim();
              if (!name || !value) return null;
              return [name, value] as const;
            })
            .filter((entry): entry is readonly [string, string] => Boolean(entry)),
        )
      : information;
  
    if (
      typeof payload === "object" &&
      payload !== null &&
      !Array.isArray(payload) &&
      Object.keys(payload).length === 0
    ) {
      return "";
    }
  
    try {
      const json = JSON.stringify(payload);
  
      return json.length > 1500
        ? `${json.slice(0, 1500)}…`
        : json;
    } catch(error) {
      this.logger.error(`Error compacting information`, error);
      return "";
    }
  }

  async process(
    buffer: Buffer,
    mimeType?: string,
    filename?: string,
    caption?: string,
  ): Promise<{ text: string; usage: MediaUsage; model: string }> {
    const models = this.mediaConfig.models();
    const client = this.mediaConfig.createOpenAi();

    const name = filename || "document.pdf";
    const mime =
      mimeType?.split(";")[0]?.trim() || "application/pdf";

    const file = await client.files.create({
      file: await toFile(buffer, name, { type: mime }),
      purpose: "user_data",
    });

    try {
      const prompt = documentPrompt(caption);

      const response = await client.responses.create({
        model: models.documentModel,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_file",
                file_id: file.id,
                detail: "high",
              },
              {
                type: "input_text",
                text: prompt,
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "document_understanding",
            strict: true,
            schema,
          },
        },
        max_output_tokens: 3000,
      });

      let understanding: any;

      try {
        understanding = JSON.parse(response.output_text || "{}");
      } catch {
        throw new MediaUnderstandingError(
          "Document model returned invalid JSON",
          "INVALID_JSON",
        );
      }

      const usage = {
        inputTokens:
          response.usage?.input_tokens ??
          this.fallbackUsage(buffer).inputTokens,
        outputTokens: response.usage?.output_tokens ?? 0,
        audioSeconds: 0,
      };
      this.logger.log(`Understanding: `, JSON.stringify(understanding, null, 2));
      const info = this.compactInfo(understanding?.information);
      this.logger.log(`Info: ${info}`);
      const summary = String(
        understanding?.summary ?? "",
      ).trim();
      this.logger.log(`Summary: `, JSON.stringify(summary, null, 2));
      const type = String(
        understanding?.documentType ?? "document",
      );

      return {
        text: `[Shared document ${name}] (${type}) ${summary}${
          info ? `\n${info}` : ""
        }`.trim(),
        usage,
        model: models.documentModel,
      };
    } catch(error) {
      this.logger.error(`Error processing document ${name}`, error);
      throw error;
    }
    finally {
      try {
        await client.files.delete(file.id);
      } catch(error) {
        this.logger.error(`Error deleting file ${file.id}`, error);
        /* ignore */
      }
    }
  }
}

function documentPrompt(caption?: string): string {
  const context =
    caption?.trim() || "No additional customer message was provided.";

  return `You are the document-understanding layer of a WhatsApp customer-support agent for an ERP/business system.

Read the document and return:
- relevant
- confidence
- documentType
- summary
- information: a list of {name, value} fields (empty list if none)

Do NOT answer the customer.

Extract only information relevant to the document and the customer's request.

Rules:
- Do not invent or guess information.
- Preserve names, phone numbers, IDs, SKUs, tracking numbers, dates, and amounts exactly as shown.
- Do not normalize, correct, reformat, or modify numbers or identifiers.
- If text is unclear, mark it as unclear instead of guessing.
- Extract important structured information from tables, invoices, receipts, labels, forms, and documents.
- Use the customer's message only as context for deciding what information is relevant.

Customer message:
${context}`;
}

