import { Injectable } from "@nestjs/common";
import {
  MediaConfigService,
  type MediaUsage,
} from "../media-config.service";

const VISION_PROMPT = `Analyze the image in the context of the customer's message.

Extract only information relevant to the customer's request, such as:
- Orders, products, SKUs, quantities, prices
- Customer, phone, address, and shipping information
- Payment/status information
- Dates and text from documents, invoices, receipts, labels, or screens
- Damage or condition when relevant

Rules:
- Do not answer the customer.
- Do not describe irrelevant visual details.
- Do not invent or guess information.
- Preserve names, numbers, IDs, SKUs, and phone numbers exactly as shown.
- If something is unclear, say it is unclear.

Return a concise factual description for the main AI agent.`;

@Injectable()
export class ImageMediaProcessor {
  constructor(private readonly mediaConfig: MediaConfigService) {}

  estimate(): MediaUsage {
    return {
      inputTokens: 10000,
      outputTokens: 400,
      audioSeconds: 0,
    };
  }

  async process(
    buffer: Buffer,
    mimeType?: string,
    caption?: string,
  ): Promise<{ text: string; usage: MediaUsage; model: string }> {
    const models = this.mediaConfig.models();
    const client = await this.mediaConfig.createOpenAi();

    const mime =
      mimeType?.split(";")[0]?.trim() || "image/jpeg";

    const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;

    const customerMessage = caption?.trim()
      ? caption.trim()
      : "No customer message or caption was provided.";

    const response = await client.chat.completions.create({
      model: models.visionModel,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${VISION_PROMPT}

Customer message:
${customerMessage}`,
            },
            {
              type: "image_url",
              image_url: {
                url: dataUrl,
              },
            },
          ],
        },
      ],
    });

    const description =
      response.choices[0]?.message?.content?.trim() || "";

    const usage: MediaUsage = {
      inputTokens:
        response.usage?.prompt_tokens ??
        this.estimate().inputTokens,
      outputTokens:
        response.usage?.completion_tokens ?? 0,
      audioSeconds: 0,
    };

    const captionPrefix = caption?.trim()
      ? `${caption.trim()}\n`
      : "";

    return {
      text: `[Shared image] ${captionPrefix}${description}`.trim(),
      usage,
      model: models.visionModel,
    };
  }
}