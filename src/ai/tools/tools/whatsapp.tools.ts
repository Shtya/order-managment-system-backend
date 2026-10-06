import {
  BadRequestException,
  forwardRef,
  HttpException,
  Inject,
  Injectable,
  OnModuleInit,
} from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import { RedisService } from "common/redis/RedisService";
import { WhatsappService } from "../../../whatsapp/whatsapp.service";
import { WhatsappTemplateService } from "../../../whatsapp/services/WhatsappTemplate.service";
import { AiTool } from "../ai-tool.abstract";
import { AiToolContext } from "../ai-tool-context";
import {
  AiToolNamespace,
  AiToolRegistryService,
} from "../ai-tool-registry.service";
import { AiToolExecutionResult } from "../../interfaces/ai-types";
import { AgentToolScope } from "../../../agents/runtime/agent-runtime.constants";
import {
  appendPlaygroundBubble,
  playgroundBubbleFromSend,
} from "../../../agents/runtime/agent-playground.session";
import {
  AgentCustomerWindowClosedError,
  AgentSendBlockedError,
  AgentSenderService,
} from "../../../agents/runtime/agent-sender.service";
import {
  agentScopeOf,
  Args,
  fail,
  LIMITS,
  RESERVED_ID_PREFIXES,
  str,
} from "./customer-tools";
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
    private readonly redis: RedisService,
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
        audience: ["staff", "customer"],
        run: (ctx, args) => this.listTemplates(ctx, args),
      }),
      new AiTool({
        name: "send_whatsapp_template",
        description:
          "Send an approved WhatsApp template message to a customer phone number. Supply bodyVariables/headerVariables keyed by the template placeholders. Never auto-resend on a stale result: reconcile first.",
        inputSchema: dtoToJsonSchema(SendWhatsappTemplateToolArgsDto),
        argsDto: SendWhatsappTemplateToolArgsDto,
        permission: AI_PERMISSION_TOOLS_WHATSAPP_WRITE,
        isWrite: true,
        staleRecovery: "manual_review",
        audience: ["staff", "customer"],
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

  private resolveAccountId(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): string | undefined {
    if (args.accountId) return String(args.accountId);
    const fromSession = ctx.session.metadata?.whatsappAccountId;
    return fromSession ? String(fromSession) : undefined;
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

  private async sendTemplate(
    ctx: AiToolContext,
    args: Record<string, unknown>,
  ): Promise<AiExecutionResult> {
    return this.wrap("WHATSAPP_TEMPLATE_SENT", async () => {
      const scope = ctx.session.metadata?.agentScope as AgentToolScope | undefined;
      if (scope?.playgroundKey) {
        const wamid = `playground:${randomUUID()}`;
        await appendPlaygroundBubble(
          this.redis,
          scope.playgroundKey,
          playgroundBubbleFromSend(
            {
              type: "template",
              templateId: args.templateId,
              name: args.templateId,
            },
            wamid,
          ),
          scope.playgroundHashId,
        );
        return { messageId: wamid, status: "accepted" };
      }
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
        this.resolveAccountId(ctx, args),
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

/**
 * Agent-turn WhatsApp send tools (customer audience), delivered through
 * AgentSenderService. Kept separate from WhatsappAiTools above (staff
 * template API: different audience, deps and lifecycle) and from
 * CustomerTools (which keeps the read/write domain tools). Registered as
 * its own namespace so the tool set stays identical by name.
 */
@Injectable()
export class AgentWhatsappTools implements AiToolNamespace, OnModuleInit {
  constructor(
    @Inject(forwardRef(() => AiToolRegistryService))
    private readonly registry: AiToolRegistryService,
    private readonly sender: AgentSenderService,
  ) {}

  onModuleInit() {
    this.registry.registerNamespace(this);
  }

  getTools(): AiTool[] {
    return [
      this.sendText(),
      this.sendImage(),
      this.sendButtons(),
      this.sendList(),
      this.reactToMessage(),
      this.requestLocation(),
    ];
  }

  private sendText() {
    return new AiTool({
      name: "send_text",
      audience: "customer",
      description:
        "Send a text message to the customer. Can quote a customer message by its msg id.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", maxLength: LIMITS.text },
          replyToMessageId: { type: "string", description: "Msg id to quote." },
        },
        required: ["text"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const text = str(args.text);
        if (!text) return fail("INVALID_ARGS", "text is required");
        if (text.length > LIMITS.text) return fail("INVALID_ARGS", `text must be at most ${LIMITS.text} characters`);
        const context = await this.quoteContext(scope, args.replyToMessageId);
        return this.deliver(scope, { type: "text", text: { body: text, preview_url: false }, ...context });
      },
    });
  }

  private sendImage() {
    return new AiTool({
      name: "send_image",
      audience: "customer",
      description:
        "Send one catalog photo from get_product_details/get_bundle_details images (first url is the main one). One call per image; main image first.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Image url from get_product_details or get_bundle_details." },
          caption: { type: "string", maxLength: LIMITS.caption },
          replyToMessageId: { type: "string", description: "Msg id to quote." },
        },
        required: ["url"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const caption = str(args.caption);
        if (caption.length > LIMITS.caption) {
          return fail("INVALID_ARGS", `caption must be at most ${LIMITS.caption} characters`);
        }
        const url = str(args.url);
        if (!url) return fail("INVALID_ARGS", "url is required");
        try {
          const extra = await this.quoteContext(scope, args.replyToMessageId);
          await this.sender.sendImage(scope, { url, caption: caption || undefined, extra });
          return { ok: true, code: "SENT" };
        } catch (error) {
          if (error instanceof AgentCustomerWindowClosedError) throw error;
          if (error instanceof AgentSendBlockedError) {
            return fail("SEND_BLOCKED", `${error.message}. End the turn.`);
          }
          if (error instanceof BadRequestException || error instanceof HttpException) {
            return fail("UPLOAD_FAILED", "Could not send this image. Try another url from get_product_details.");
          }
          throw error;
        }
      },
    });
  }

  private sendButtons() {
    return new AiTool({
      name: "send_buttons",
      audience: "customer",
      description:
        "Send a message with up to 3 reply buttons. The choice arrives in the next message. End the turn after sending.",
      inputSchema: {
        type: "object",
        properties: {
          body: { type: "string", maxLength: LIMITS.body },
          buttons: {
            type: "array",
            minItems: 1,
            maxItems: LIMITS.buttons,
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Id returned when the customer picks it." },
                title: { type: "string", maxLength: LIMITS.buttonTitle },
              },
              required: ["title"],
              additionalProperties: false,
            },
          },
          header: { type: "string", maxLength: LIMITS.header },
          footer: { type: "string", maxLength: LIMITS.footer },
        },
        required: ["body", "buttons"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const body = str(args.body);
        if (!body || body.length > LIMITS.body) return fail("INVALID_ARGS", `body is required (max ${LIMITS.body} characters)`);
        const buttons = Array.isArray(args.buttons) ? args.buttons : [];
        if (!buttons.length || buttons.length > LIMITS.buttons) {
          return fail("INVALID_ARGS", `buttons must contain 1-${LIMITS.buttons} items; use send_list for more options`);
        }
        const replies = [];
        for (const [index, button] of buttons.entries()) {
          const title = str(button?.title);
          if (!title || title.length > LIMITS.buttonTitle) {
            return fail("INVALID_ARGS", `button titles are required and at most ${LIMITS.buttonTitle} characters ("${title}")`);
          }
          const id = this.optionId(button?.id, index);
          if (typeof id !== "string") return id;
          replies.push({ type: "reply", reply: { id, title } });
        }
        const header = str(args.header);
        const footer = str(args.footer);
        if (header.length > LIMITS.header || footer.length > LIMITS.footer) {
          return fail("INVALID_ARGS", `header and footer are at most ${LIMITS.header} characters`);
        }
        return this.deliver(scope, {
          type: "interactive",
          interactive: {
            type: "button",
            ...(header ? { header: { type: "text", text: header } } : {}),
            body: { text: body },
            ...(footer ? { footer: { text: footer } } : {}),
            action: { buttons: replies },
          },
        });
      },
    });
  }

  private sendList() {
    return new AiTool({
      name: "send_list",
      audience: "customer",
      description:
        "Send a 1-10 option list for the customer to choose from. End the turn after sending.",
      inputSchema: {
        type: "object",
        properties: {
          body: { type: "string", maxLength: LIMITS.body },
          buttonText: { type: "string", maxLength: LIMITS.listButton, description: "Button label that opens the list." },
          rows: {
            type: "array",
            minItems: 1,
            maxItems: LIMITS.rows,
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string", maxLength: LIMITS.rowTitle },
                description: { type: "string", maxLength: LIMITS.rowDescription },
              },
              required: ["title"],
              additionalProperties: false,
            },
          },
          sectionTitle: { type: "string", maxLength: LIMITS.rowTitle },
          header: { type: "string", maxLength: LIMITS.header },
          footer: { type: "string", maxLength: LIMITS.footer },
        },
        required: ["body", "buttonText", "rows"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const body = str(args.body);
        const buttonText = str(args.buttonText);
        if (!body || body.length > LIMITS.body) return fail("INVALID_ARGS", `body is required (max ${LIMITS.body} characters)`);
        if (!buttonText || buttonText.length > LIMITS.listButton) {
          return fail("INVALID_ARGS", `buttonText is required (max ${LIMITS.listButton} characters)`);
        }
        const rowsIn = Array.isArray(args.rows) ? args.rows : [];
        if (!rowsIn.length || rowsIn.length > LIMITS.rows) return fail("INVALID_ARGS", `rows must contain 1-${LIMITS.rows} items`);
        const rows = [];
        for (const [index, row] of rowsIn.entries()) {
          const title = str(row?.title);
          const description = str(row?.description);
          if (!title || title.length > LIMITS.rowTitle) {
            return fail("INVALID_ARGS", `row titles are required and at most ${LIMITS.rowTitle} characters ("${title}")`);
          }
          if (description.length > LIMITS.rowDescription) {
            return fail("INVALID_ARGS", `row descriptions are at most ${LIMITS.rowDescription} characters`);
          }
          const id = this.optionId(row?.id, index);
          if (typeof id !== "string") return id;
          rows.push({ id, title, ...(description ? { description } : {}) });
        }
        const sectionTitle = str(args.sectionTitle).slice(0, LIMITS.rowTitle);
        const header = str(args.header);
        const footer = str(args.footer);
        if (header.length > LIMITS.header || footer.length > LIMITS.footer) {
          return fail("INVALID_ARGS", `header and footer are at most ${LIMITS.header} characters`);
        }
        return this.deliver(scope, {
          type: "interactive",
          interactive: {
            type: "list",
            ...(header ? { header: { type: "text", text: header } } : {}),
            body: { text: body },
            ...(footer ? { footer: { text: footer } } : {}),
            action: {
              button: buttonText,
              sections: [{ ...(sectionTitle ? { title: sectionTitle } : {}), rows }],
            },
          },
        });
      },
    });
  }

  private reactToMessage() {
    return new AiTool({
      name: "react_to_message",
      audience: "customer",
      description: "React with one emoji to a customer message.",
      inputSchema: {
        type: "object",
        properties: {
          messageId: { type: "string" },
          emoji: { type: "string", maxLength: 16 },
        },
        required: ["messageId", "emoji"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const emoji = str(args.emoji);
        if (!emoji || emoji.length > 16) return fail("INVALID_ARGS", "emoji is required");
        const target = await this.sender.findConversationMessage(scope, str(args.messageId));
        if (!target?.messageId) return fail("NOT_FOUND", "Unknown message id in this conversation");
        return this.deliver(scope, {
          type: "reaction",
          reaction: { message_id: target.messageId, emoji },
        });
      },
    });
  }

  private requestLocation() {
    return new AiTool({
      name: "request_location",
      audience: "customer",
      description:
        "Ask the customer to share their location (when an address is needed and they are probably there).",
      inputSchema: {
        type: "object",
        properties: { body: { type: "string", maxLength: LIMITS.body } },
        required: ["body"],
        additionalProperties: false,
      },
      isWrite: true,
      staleRecovery: "auto_recover",
      run: async (ctx, args: Args) => {
        const scope = agentScopeOf(ctx);
        const body = str(args.body);
        if (!body || body.length > LIMITS.body) return fail("INVALID_ARGS", `body is required (max ${LIMITS.body} characters)`);
        return this.deliver(scope, {
          type: "interactive",
          interactive: {
            type: "location_request_message",
            body: { text: body },
            action: { name: "send_location" },
          },
        });
      },
    });
  }

  private async deliver(scope: AgentToolScope, data: Record<string, any>): Promise<AiToolExecutionResult> {
    try {
      await this.sender.send(scope, data);
      return { ok: true, code: "SENT" };
    } catch (error) {
      if (error instanceof AgentCustomerWindowClosedError) throw error;
      if (error instanceof AgentSendBlockedError) return fail("SEND_BLOCKED", `${error.message}. End the turn.`);
      throw error;
    }
  }

  private async quoteContext(scope: AgentToolScope, messageId: unknown) {
    const id = str(messageId);
    if (!id) return {};
    const target = await this.sender.findConversationMessage(scope, id);
    return target?.messageId ? { context: { message_id: target.messageId } } : {};
  }

  private optionId(raw: unknown, index: number): string | AiToolExecutionResult {
    const id = str(raw) || `option_${index + 1}`;
    if (id.length > LIMITS.optionId) return fail("INVALID_ARGS", "option ids are at most 200 characters");
    if (RESERVED_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) {
      return fail("INVALID_ARGS", "option ids can't start with agent_confirm/agent_edit/agent_cancel");
    }
    return id;
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
