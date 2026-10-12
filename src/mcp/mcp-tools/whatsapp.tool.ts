import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { TemplateCategory, TemplateStatus } from "entities/whatsapp.entity";
import { WhatsappService } from "src/whatsapp/whatsapp.service";
import { WhatsappAccountService } from "src/whatsapp/services/WhatsappAccount.service";
import { WhatsappTemplateService } from "src/whatsapp/services/WhatsappTemplate.service";
import { assertDateOrder, listPaging, parseSearchInput, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";
import { uuidField, isoDateField } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS
//    Read-only. No send, no tokens, no media. Accounts sort via
//    sortBy/sortDir at SQL; templates sort createdAt fixed.
// ═══════════════════════════════════════════════════════════════

const whatsappStatsInput = z.object({
  report: z
    .enum(["summary", "accounts", "templates"])
    .optional()
    .describe("Which report to return. summary (default): dashboard stats, optional dates/accountId. accounts: account counts, no dates. templates: template counts, no dates."),
  startDate: isoDateField("Range start, ISO date (YYYY-MM-DD). Only valid with report=summary.").optional(),
  endDate: isoDateField("Range end, ISO date (YYYY-MM-DD). Only valid with report=summary.").optional(),
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

const isSet = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

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

function toTemplateSummary(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    language: row.language ?? null,
    category: row.category ?? null,
    status: row.status ?? null,
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
      "WhatsApp stats. Pass `report`: summary (default — dashboard stats, optional dates/accountId), accounts (account counts, no dates), templates (template counts, no dates). Read-only.",
    parameters: whatsappStatsInput,
  })
  async getStats(
    @Payload() input: z.infer<typeof whatsappStatsInput>,
    @McpUser() user: User,
  ) {
    const report = (input as any)?.report ?? "summary";
    assertDateOrder(input as Record<string, unknown>);
    if (report !== "summary" && (isSet((input as any).startDate) || isSet((input as any).endDate) || isSet((input as any).accountId))) {
      throw new RpcException("report=accounts and report=templates take no dates or accountId. Remove them or set report=summary.");
    }
    if (report === "accounts") return toolJson({ report, ...(await this.accounts.getStats(user)) });
    if (report === "templates") return toolJson({ report, ...(await this.templates.getStats(user)) });
    const { report: _r, ...filters } = input as any;
    return toolJson({ report, ...(await this.whatsapp.getDashboardStats(user, filters)) });
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
    const result = await this.templates.list(user, rest, library === true ? true : undefined);
    return toolPage("templates", result, toTemplateSummary, (rest as any).limit);
  }
}
