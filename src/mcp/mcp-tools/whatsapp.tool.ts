import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import {
  MessageDirection,
  MessageSendSource,
  MessageStatus,
  TemplateCategory,
  TemplateStatus,
  WhatsappMessageType,
} from "entities/whatsapp.entity";
import { WhatsappService } from "src/whatsapp/whatsapp.service";
import { WhatsappAccountService } from "src/whatsapp/services/WhatsappAccount.service";
import { WhatsappTemplateService } from "src/whatsapp/services/WhatsappTemplate.service";
import { listPaging, parseSearchInput, resolveToolDates, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";
import {
  BUSINESS_TZ,
  businessDayRange,
  uuidField,
  isoDateField,
  TREND_RANGES,
} from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS
//    Read-only. No send, no tokens, no media. Accounts sort via
//    sortBy/sortDir at SQL; templates sort createdAt fixed.
// ═══════════════════════════════════════════════════════════════

const whatsappStatsInput = z.strictObject({
  report: z
    .enum(["summary", "accounts", "templates"])
    .optional()
    .describe("Which report to return. summary (default): dashboard stats, optional dates/accountId. accounts: account counts, no dates. templates: template counts, no dates."),
  startDate: isoDateField("Range start, ISO date (YYYY-MM-DD). Only valid with report=summary.").optional(),
  endDate: isoDateField("Range end, ISO date (YYYY-MM-DD). Only valid with report=summary.").optional(),
  range: z.enum(TREND_RANGES).optional().describe(`Quick range. Only valid with report=summary. One of: ${TREND_RANGES.join(", ")}.`),
  accountId: uuidField(idDescription("WhatsApp account id.", TOOL.whatsapp.accountsSearch, "Only valid with report=summary.")).optional(),
});

const searchAccountsInput = searchInput("whatsapp account", {
  ...listPaging({
    items: "whatsapp accounts",
    sortBy: ["createdAt", "name", "mobileNumber"],
    defaultSortBy: "createdAt",
    search: "Matches account name or number",
  }),
  isActive: z.boolean().optional().describe("True for active only, false for inactive only. Omit for all."),
}, TOOL.whatsapp.accountsSearch);

const searchTemplatesInput = searchInput("whatsapp template", {
  ...listPaging({
    items: "whatsapp templates",
    sortBy: ["createdAt"],
    search: "Matches template name",
  }),
  accountId: uuidField(idDescription("WhatsApp account id.", TOOL.whatsapp.accountsSearch)).optional(),
  category: z.enum(TemplateCategory).optional().describe("Keep templates of this category"),
  status: z.enum(TemplateStatus).optional().describe("Keep templates with this status"),
  language: z.string().optional().describe("Keep templates in this language"),
  library: z.boolean().optional().describe("True for the Meta library instead of workspace templates."),
}, TOOL.whatsapp.templatesSearch);

const messageDateField = (label: string) =>
  z
    .union([
      isoDateField(`${label}, ISO date (YYYY-MM-DD).`),
      z.string().datetime({ offset: true }),
    ])
    .describe(
      `${label}. Use YYYY-MM-DD for a Cairo calendar day, or an ISO date-time with timezone, such as 2026-10-24T14:30:00+03:00.`,
    );

const searchMessagesInput = searchInput("whatsapp message", {
  limit: z.number().int().min(1).max(50).default(25).describe("Maximum messages to return."),
  search: z
    .string()
    .optional()
    .describe("Matches contact number, WhatsApp message id, or text body."),
  sortBy: z.enum(["createdAt", "status"]).default("createdAt"),
  sortDir: z.enum(["ASC", "DESC"]).default("DESC"),
  cursor: z
    .strictObject({
      value: z.union([z.string(), z.number()]),
      id: uuidField("Message id from the previous page cursor."),
    })
    .optional()
    .describe("Use nextCursor from the previous result to fetch the next page."),
  startDate: messageDateField("Range start").optional(),
  endDate: messageDateField("Range end").optional(),
  range: z
    .enum(TREND_RANGES)
    .optional()
    .describe(`Quick range. One of: ${TREND_RANGES.join(", ")}.`),
  status: z
    .union([z.enum(MessageStatus), z.literal("replied")])
    .optional()
    .describe("Keep messages with this delivery status, or replied messages."),
  accountId: uuidField(idDescription("WhatsApp account id.", TOOL.whatsapp.accountsSearch)).optional(),
  conversationId: uuidField("Conversation id.").optional(),
  customerId: uuidField(
    idDescription(
      "Contact id (stored as a customer record).",
      TOOL.contacts.search,
    ),
  ).optional(),
  automationRunId: uuidField(idDescription("Automation run id.", TOOL.automation.runsSearch)).optional(),
  direction: z.enum(MessageDirection).optional(),
  messageType: z.enum(WhatsappMessageType).optional(),
  sendSource: z.enum(MessageSendSource).optional(),
  sentByUserId: uuidField("User id that sent the message.").optional(),
  sentByAgentId: uuidField(idDescription("Agent id that sent the message.", TOOL.agents.list)).optional(),
}, TOOL.whatsapp.messagesSearch);

const isSet = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

function resolveMessageDates(input: {
  range?: (typeof TREND_RANGES)[number];
  startDate?: string;
  endDate?: string;
}) {
  if (input.range) return resolveToolDates(input);

  const isDateOnly = (value?: string) =>
    Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
  const startDate = isDateOnly(input.startDate)
    ? businessDayRange(input.startDate).start
    : input.startDate
      ? new Date(input.startDate)
      : undefined;
  const endDate = isDateOnly(input.endDate)
    ? businessDayRange(undefined, input.endDate).end
    : input.endDate
      ? new Date(input.endDate)
      : undefined;

  if (startDate && endDate && startDate > endDate) {
    throw new RpcException("`startDate` is after `endDate`. Swap them.");
  }

  return { startDate, endDate };
}

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: no tokens, no secrets, no binary.
// ═══════════════════════════════════════════════════════════════

function toAccountSummary(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    mobileNumber: row.mobileNumber ?? row.phone ?? null,
    isActive: row.isActive ?? null,
    quality: row.quality ?? row.qualityRating ?? null,
    status: row.status ?? null,
  };
}

function toAccountDto(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    mobileNumber: row.mobileNumber ?? row.phone ?? null,
    isActive: row.isActive ?? null,
    quality: row.quality ?? row.qualityRating ?? null,
    status: row.status ?? null,
    aiEnabled: row.aiEnabled ?? null,
  };
}

function toTemplateAccount(row: any) {
  const account = row?.account;
  return {
    id: account?.id ?? row?.accountId ?? null,
    name: account?.name ?? null,
    mobileNumber: account?.mobileNumber ?? account?.phone ?? row?.mobileNumber ?? null,
  };
}

function toTemplateSummary(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    language: row.language ?? null,
    category: row.category ?? null,
    status: row.status ?? null,
    account: toTemplateAccount(row),
  };
}

function toTemplateDto(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    language: row.language ?? null,
    category: row.category ?? null,
    status: row.status ?? null,
    templateConfig: row.templateConfig ?? row.config ?? null,
    account: toTemplateAccount(row),
  };
}

function toMessageDto(row: any) {
  return {
    id: row.id,
    messageId: row.messageId,
    contactNumber: row.contactNumber,
    direction: row.direction,
    status: row.status,
    messageType: row.messageType,
    content: row.content ?? null,
    error: row.error ?? null,
    account: row.account
      ? {
          id: row.account.id,
          name: row.account.name ?? null,
          mobileNumber: row.account.mobileNumber ?? row.account.phone ?? null,
        }
      : null,
    conversationId: row.conversationId ?? null,
    automationRunId: row.automationRunId ?? null,
    campaignId: row.campaignId ?? null,
    sendSource: row.sendSource,
    sentByUser: row.sentByUser
      ? {
          id: row.sentByUser.id,
          name: row.sentByUser.name ?? null,
          avatarUrl: row.sentByUser.avatarUrl ?? null,
        }
      : null,
    sentByAgent: row.sentByAgent
      ? { id: row.sentByAgent.id, name: row.sentByAgent.name ?? null }
      : null,
    sentAt: row.sentAt ?? null,
    deliveredAt: row.deliveredAt ?? null,
    readAt: row.readAt ?? null,
    failedAt: row.failedAt ?? null,
    createdAt: row.createdAt,
  };
}

function toOneMessageDto(row: any) {
  return {
    id: row.id,
    adminId: row.adminId ?? null,
    messageId: row.messageId,
    contactNumber: row.contactNumber,
    direction: row.direction,
    status: row.status,
    messageType: row.messageType,
    content: row.content ?? null,
    metadata: row.metadata ?? null,
    account: row.account
      ? {
          id: row.account.id,
          name: row.account.name ?? null,
          mobileNumber: row.account.mobileNumber ?? row.account.phone ?? null,
          status: row.account.status ?? null,
          isActive: row.account.isActive ?? null,
        }
      : null,
    accountId: row.accountId ?? null,
    automationRunId: row.automationRunId ?? null,
    campaignId: row.campaignId ?? null,
    conversationId: row.conversationId ?? null,
    customerId: row.customerId ?? null,
    orderId: row.orderId ?? null,
    replyToId: row.replyToId ?? null,
    replyTo: row.replyTo ? toMessageDto(row.replyTo) : null,
    reactionToId: row.reactionToId ?? null,
    reactions: Array.isArray(row.reactions)
      ? row.reactions.map(toMessageDto)
      : [],
    sendSource: row.sendSource,
    sentByUserId: row.sentByUserId ?? null,
    sentByUser: row.sentByUser
      ? {
          id: row.sentByUser.id,
          name: row.sentByUser.name ?? null,
          avatarUrl: row.sentByUser.avatarUrl ?? null,
        }
      : null,
    sentByAgentId: row.sentByAgentId ?? null,
    sentByAgent: row.sentByAgent
      ? { id: row.sentByAgent.id, name: row.sentByAgent.name ?? null }
      : null,
    actionIntent: row.actionIntent ?? null,
    actionStatus: row.actionStatus ?? null,
    actionCompletedAt: row.actionCompletedAt ?? null,
    costAmount: row.costAmount ?? null,
    costCurrency: row.costCurrency ?? null,
    costChargedAt: row.costChargedAt ?? null,
    pricingCategory: row.pricingCategory ?? null,
    pricingType: row.pricingType ?? null,
    error: row.error ?? null,
    errorCode: row.errorCode ?? null,
    retryCount: row.retryCount ?? 0,
    metaTimestamp: row.metaTimestamp ?? null,
    sentAt: row.sentAt ?? null,
    deliveredAt: row.deliveredAt ?? null,
    readAt: row.readAt ?? null,
    failedAt: row.failedAt ?? null,
    playedAt: row.playedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpWhatsappTools {
  constructor(
    private whatsapp: WhatsappService,
    private accounts: WhatsappAccountService,
    private templates: WhatsappTemplateService,
  ) {}

  @McpReadTool({
    name: TOOL.whatsapp.stats,
    description:
      "WhatsApp stats. Pass `report`: summary (default — dashboard stats, optional dates/accountId), accounts (account counts, no dates), templates (template counts, no dates). Every result echoes the applied period and filters; null period dates mean all time. Read-only.",
    parameters: whatsappStatsInput,
  })
  async getStats(
    @Payload() input: z.infer<typeof whatsappStatsInput>,
    @McpUser() user: User,
  ) {
    const report = (input as any)?.report ?? "summary";
    if (report !== "summary" && (isSet((input as any).startDate) || isSet((input as any).endDate) || isSet((input as any).range) || isSet((input as any).accountId))) {
      throw new RpcException("report=accounts and report=templates take no dates, range, or accountId. Remove them or set report=summary.");
    }
    const allTimePeriod = {
      startDate: null,
      endDate: null,
      timezone: BUSINESS_TZ,
      source: "all_time",
    };
    if (report === "accounts") {
      return toolJson({
        report,
        period: allTimePeriod,
        filters: {},
        ...(await this.accounts.getCounts(user)),
      });
    }
    if (report === "templates") {
      return toolJson({
        report,
        period: allTimePeriod,
        filters: {},
        ...(await this.templates.getStats(user)),
      });
    }
    const dates = resolveToolDates(input);
    const period = dates.startDate || dates.endDate
      ? {
          startDate: dates.startDate?.toISOString() ?? null,
          endDate: dates.endDate?.toISOString() ?? null,
          timezone: BUSINESS_TZ,
          source: input.range ? "range" : "custom",
          ...(input.range ? { range: input.range } : {}),
        }
      : allTimePeriod;
    return toolJson({
      report,
      period,
      filters: {
        accountId: input.accountId ?? null,
      },
      ...(await this.whatsapp.getDashboardStats(user, {
        accountId: (input as any).accountId,
        startDate: dates.startDate,
        endDate: dates.endDate,
        skipDefaultRange: !dates.startDate && !dates.endDate,
      })),
    });
  }

  @McpReadTool({
    name: TOOL.whatsapp.accountsSearch,
    description:
      "Search WhatsApp accounts or fetch one. Without `id`: paged summaries. With `id`: returns that account with AI flags. No tokens. Read-only.",
    parameters: searchAccountsInput,
  })
  async searchAccounts(
    @Payload() input: z.infer<typeof searchAccountsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "whatsapp account");
    if (req.mode === "get") {
      return toolJson(toAccountDto(await this.accounts.findOne(user, req.id)));
    }
    const { isActive, ...rest } = req.query as typeof req.query & { isActive?: boolean };
    const result = await this.accounts.list(user, {
      ...rest,
      ...(isActive === undefined ? {} : { isActive: isActive ? "true" : "false" }),
    });
    return toolPage("accounts", result, toAccountSummary, (rest as any).limit);
  }

  @McpReadTool({
    name: TOOL.whatsapp.templatesSearch,
    description:
      "Search WhatsApp templates or fetch one. Without `id`: paged summaries filtered by account, category, status, or language. Pass library:true for the Meta library. With `id`: returns that template with its config, no binary. Read-only.",
    parameters: searchTemplatesInput,
  })
  async searchTemplates(
    @Payload() input: z.infer<typeof searchTemplatesInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "whatsapp template");
    if (req.mode === "get") {
      return toolJson(toTemplateDto(await this.templates.findOne(user, req.id)));
    }
    const { library, ...rest } = req.query as typeof req.query & { library?: boolean };
    if (library === true) {
      const rows = await this.templates.metaLibrary(user, rest as any);
      const records = Array.isArray(rows) ? rows : [];
      return toolPage(
        "templates",
        { records, total_records: records.length, current_page: 1, per_page: records.length || 1 },
        toTemplateSummary,
        records.length || 1,
      );
    }
    const result = await this.templates.list(user, rest);
    return toolPage("templates", result, toTemplateSummary, (rest as any).limit);
  }

  @McpReadTool({
    name: TOOL.whatsapp.messagesSearch,
    description:
      "Search WhatsApp messages or fetch one. Without `id`: cursor-paged message summaries filtered by text, dates, status, account, conversation, contact/customer, automation run, direction, message type, send source, sending user, or sending agent. `customerId` is the contact id from contacts_search because contacts are stored as customers. With `id`: returns that message's full details. Read-only.",
    parameters: searchMessagesInput,
  })
  async searchMessages(
    @Payload() input: z.infer<typeof searchMessagesInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "whatsapp message");
    if (req.mode === "get") {
      return toolJson(
        toOneMessageDto(
          await this.whatsapp.findOneMessage(user, req.id, {
            includeSenderRelations: true,
          }),
        ),
      );
    }

    const dates = resolveMessageDates(req.query);
    const result = await this.whatsapp.findAllMessages(user, {
      ...req.query,
      startDate: dates.startDate,
      endDate: dates.endDate,
      range: undefined,
    }, {
      includeSenderRelations: true,
    });

    return toolJson({
      messages: result.records.map(toMessageDto),
      hasMore: result.hasMore,
      limit: result.limit,
      nextCursor: result.nextCursor,
      sortBy: result.sortBy,
      sortDir: result.sortDir,
    });
  }
}
