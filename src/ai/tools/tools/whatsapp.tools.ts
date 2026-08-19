import { Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { WhatsappService } from "../../../whatsapp/whatsapp.service";
import { WhatsappTemplateService } from "../../../whatsapp/services/WhatsappTemplate.service";
import { AiTool } from "../ai-tool.abstract";
import { AiToolContext } from "../ai-tool-context";
import {
  ListWhatsappTemplatesToolArgsDto,
  SendWhatsappTemplateToolArgsDto,
  SendWhatsappTextToolArgsDto,
} from "../dto/whatsapp.tool.dto";
import { dtoToJsonSchema } from "../dto-to-json-schema";
import {
  AI_PERMISSION_TOOLS_WHATSAPP_READ,
  AI_PERMISSION_TOOLS_WHATSAPP_WRITE,
} from "../../ai.constants";
import { AiExecutionResult } from "../../interfaces/ai-types";

@Injectable()
export class WhatsappAiTools {
  constructor(
    private readonly whatsappService: WhatsappService,
    private readonly whatsappTemplateService: WhatsappTemplateService,
  ) {}

  getTools(): AiTool[] {
    return [
      new AiTool({
        name: "list_whatsapp_templates",
        description:
          "List the approved WhatsApp message templates available to the tenant. Returns template id, name, category, status, language, and variable placeholder names.",
        inputSchema: dtoToJsonSchema(ListWhatsappTemplatesToolArgsDto),
        argsDto: ListWhatsappTemplatesToolArgsDto,
        permission: AI_PERMISSION_TOOLS_WHATSAPP_READ,
        isWrite: false,
        staleRecovery: "manual_review",
        run: (ctx, args) => this.listTemplates(ctx, args),
      }),
      // new AiTool({
      // 	name: 'send_whatsapp_text',
      // 	description:
      // 		'Send a plain-text WhatsApp message to a customer phone number using the tenant default account. Use after summarizing the order. Never auto-resend on a stale result: reconcile first.',
      // 	inputSchema: dtoToJsonSchema(SendWhatsappTextToolArgsDto),
      // 	argsDto: SendWhatsappTextToolArgsDto,
      // 	permission: AI_PERMISSION_TOOLS_WHATSAPP_WRITE,
      // 	isWrite: true,
      // 	staleRecovery: 'manual_review',
      // 	dedup: {
      // 		key: (args) => whatsappTextDedupKey(args),
      // 		phone: (args) => (args.phoneNumber ? String(args.phoneNumber) : null),
      // 		orderId: (args) => (args.orderId ? String(args.orderId) : null),
      // 	},
      // 	run: (ctx, args) => this.sendText(ctx, args),
      // }),
      new AiTool({
        name: "send_whatsapp_template",
        description:
          "Send an approved WhatsApp template message to a customer phone number. Supply bodyVariables/headerVariables keyed by the template placeholders. Never auto-resend on a stale result: reconcile first.",
        inputSchema: dtoToJsonSchema(SendWhatsappTemplateToolArgsDto),
        argsDto: SendWhatsappTemplateToolArgsDto,
        permission: AI_PERMISSION_TOOLS_WHATSAPP_WRITE,
        isWrite: true,
        staleRecovery: "manual_review",
        dedup: {
          key: (args) => whatsappTemplateDedupKey(args),
          phone: (args) => (args.phoneNumber ? String(args.phoneNumber) : null),
          orderId: (args) => (args.orderId ? String(args.orderId) : null),
        },
        run: (ctx, args) => this.sendTemplate(ctx, args),
      }),
    ];
  }

  private buildMe(ctx: AiToolContext): any {
    return {
      id: ctx.session.userId,
      adminId: ctx.session.tenantId ?? ctx.session.userId,
      role: { name: ctx.session.userRoleName },
    };
  }

  private wrap<T>(
    code: string,
    fn: () => Promise<T>,
  ): Promise<AiExecutionResult> {
    return fn().then(
      (data) => ({ ok: true, code, data }),
      (error) => ({
        ok: false,
        code: `${code}_ERROR`,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  private async listTemplates(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("WHATSAPP_TEMPLATES", async () => {
      const result: any = await this.whatsappTemplateService.list(
        this.buildMe(ctx),
        {
          search: args.search,
          category: args.category,
          status: args.status,
          page: args.page,
          limit: args.limit,
        },
      );
      const records = result?.records ?? [];
      return {
        total_records: result?.total_records,
        current_page: result?.current_page,
        per_page: result?.per_page,
        records: records.map((t: any) => ({
          id: t.id,
          name: t.name,
          category: t.category,
          subCategory: t.subCategory,
          status: t.status,
          quality: t.quality,
          language: t.language,
          headerType: t.templateConfig?.headerType ?? null,
          bodyVariables: t.templateConfig?.bodyVariables ?? [],
        })),
      };
    });
  }

  private async sendText(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("WHATSAPP_MESSAGE_SENT", async () => {
      const orderId = args.orderId ? String(args.orderId) : undefined;
      const response = await this.whatsappService.sendMessage(
        this.buildMe(ctx),
        {
          to: String(args.phoneNumber),
          type: "text",
          text: { body: String(args.text) },
          metadata: { source: "ai", orderId },
        } as any,
        args.accountId ? String(args.accountId) : undefined,
        undefined,
        undefined,
        orderId,
      );
      return {
        messageId:
          (response as any)?.messageId ?? (response as any)?.id ?? null,
        status: (response as any)?.status ?? "accepted",
      };
    });
  }

  private async sendTemplate(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("WHATSAPP_TEMPLATE_SENT", async () => {
      const orderId = args.orderId ? String(args.orderId) : undefined;
      const response = await this.whatsappService.sendTemplate(
        this.buildMe(ctx),
        {
          to: String(args.phoneNumber),
          templateId: String(args.templateId),
          headerVariables:
            (args.headerVariables as Record<string, any>) ?? undefined,
          bodyVariables:
            (args.bodyVariables as Record<string, any>) ?? undefined,
          buttonVariables:
            (args.buttonVariables as Record<string, any>) ?? undefined,
          locationData: {
            latitude: "0",
            longitude: "0",
            address: "",
            name: "",
          },
        },
        args.accountId ? String(args.accountId) : undefined,
        undefined,
        { source: "ai", orderId },
      );
      return {
        messageId:
          (response as any)?.messageId ?? (response as any)?.id ?? null,
        status: (response as any)?.status ?? "accepted",
      };
    });
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(sortObject(value ?? {}));
  } catch {
    return "";
  }
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortObject((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export function whatsappTextDedupKey(
  args: Record<string, unknown>,
): string | null {
  const phone = args.phoneNumber ? String(args.phoneNumber) : null;
  const text = args.text ? String(args.text) : null;
  if (!phone || !text) return null;
  const parts = ["whatsapp_text", phone, sha256(text)];
  if (args.orderId) parts.push(String(args.orderId));
  return parts.join("|");
}

export function whatsappTemplateDedupKey(
  args: Record<string, unknown>,
): string | null {
  const phone = args.phoneNumber ? String(args.phoneNumber) : null;
  const templateId = args.templateId ? String(args.templateId) : null;
  if (!phone || !templateId) return null;
  const variablesHash = sha256(stableJson(args.bodyVariables));
  const parts = ["whatsapp_template", phone, templateId, variablesHash];
  if (args.orderId) parts.push(String(args.orderId));
  return parts.join("|");
}
