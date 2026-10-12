import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { CampaignsService } from "src/campaigns/campaigns.service";
import { CampaignCategory, CampaignChannel, CampaignRecipientDeliveryStatus, CampaignStatus } from "entities/campaigns.entity";
import { listPaging, parseSearchInput, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";
import { uuidField } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS
//    Service sorts createdAt only (sortOrder ASC/DESC). Advertise that column.
//    Exact name replaces check-name (0 rows = free).
// ═══════════════════════════════════════════════════════════════

const searchCampaignsInput = searchInput("campaign", {
  ...listPaging({
    items: "campaigns",
    sortBy: ["createdAt"],
    search: "Matches campaign name",
  }),
  name: z.string().optional().describe("Exact campaign name. 0 rows means the name is free. Do not pass with `id`."),
  status: z.enum(CampaignStatus).optional().describe("Keep campaigns with this status"),
  channel: z.enum(CampaignChannel).optional().describe("Keep campaigns on this channel"),
  category: z.enum(CampaignCategory).optional().describe("Keep campaigns in this category"),
}, TOOL.campaigns.search);

const campaignsStatsInput = z.object({
  report: z
    .enum(["summary", "recipients"])
    .optional()
    .describe("Which report to return. summary (default): workspace totals. recipients: recipient rows for one campaign (requires campaignId)."),
  campaignId: uuidField(idDescription("Campaign id. Required for report=recipients, forbidden on summary.", TOOL.campaigns.search)).optional(),
  status: z
    .enum(CampaignRecipientDeliveryStatus)
    .optional()
    .describe(
      "Recipient delivery status. Only valid with report=recipients. Omit: processed only (excludes pending and sending). Pass pending or sending to see those rows.",
    ),
  search: z.string().optional().describe("Matches recipient name or phone. Only valid with report=recipients."),
  page: z.number().int().min(1).optional().describe("Page number, starting at 1. Only valid with report=recipients. Default 1."),
  limit: z.number().int().min(1).max(50).optional().describe("Rows per page. Only valid with report=recipients. Default 20 (service cap 100; this tool max 50)."),
});

const isSet = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS
//    Get merges details-page payload: counters + performance +
//    recipient byStatus. Recipient table stays on stats.
// ═══════════════════════════════════════════════════════════════

function toCampaignSummary(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    status: row.status ?? null,
    channel: row.channel ?? null,
    category: row.category ?? null,
    recipientsCount: Number(row.recipientsCount ?? 0),
    sentCount: Number(row.sentCount ?? 0),
    createdAt: row.createdAt ?? null,
  };
}

function toCampaignResultDto(row: any, extra: { performance?: any; recipientCounts?: any }) {
  return {
    id: row.id,
    name: row.name ?? null,
    status: row.status ?? null,
    channel: row.channel ?? null,
    category: row.category ?? null,
    counters: {
      recipientsCount: Number(row.recipientsCount ?? 0),
      sentCount: Number(row.sentCount ?? 0),
      deliveredCount: Number(row.deliveredCount ?? 0),
      readCount: Number(row.readCount ?? 0),
      repliedCount: Number(row.repliedCount ?? 0),
      ordersCount: Number(row.ordersCount ?? 0),
      salesAmount: Number(row.salesAmount ?? 0),
      costAmount: Number(row.costAmount ?? 0),
    },
    products: Array.isArray(row.products) ? row.products.map((p: any) => ({ id: p.id ?? null, name: p.name ?? null })) : [],
    template: row.template ? { id: row.template.id ?? null, name: row.template.name ?? null } : null,
    segment: row.audienceSegment ? { id: row.audienceSegment.id ?? null, name: row.audienceSegment.name ?? null } : null,
    performance: extra.performance ?? null,
    recipientCounts: extra.recipientCounts ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpCampaignsTools {
  constructor(private campaigns: CampaignsService) {}

  @McpReadTool({
    name: TOOL.campaigns.search,
    description:
      "Search campaigns or fetch one. Without `id`: paged summaries filtered by search text, exact name, status, channel, or category. With `id`: returns that campaign with counters, order performance, and recipient status counts. Read-only.",
    parameters: searchCampaignsInput,
  })
  async searchCampaigns(
    @Payload() input: z.infer<typeof searchCampaignsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "campaign");
    if (req.mode === "get") {
      const [campaign, performance, summary] = await Promise.all([
        this.campaigns.get(user, req.id),
        this.campaigns.orderPerformance(user, req.id).catch(() => null),
        this.campaigns.getSummary(user, req.id),
      ]);
      return toolJson(
        toCampaignResultDto(campaign, {
          performance,
          recipientCounts: summary ?? null,
        }),
      );
    }
    const { name, ...rest } = req.query as typeof req.query & { name?: string };
    const result = await this.campaigns.list(user, {
      ...rest,
      ...(name ? { name } : {}),
    });
    return toolPage("campaigns", result, toCampaignSummary, (rest as any).limit);
  }

  @McpReadTool({
    name: TOOL.campaigns.stats,
    description:
      "Campaign stats. Pass `report`: summary (default — workspace totals, no dates) or recipients (rows for one campaign; requires campaignId). Recipients omit status: processed only (pending/sending hidden); default page 1, limit 20. Optional status/search/page/limit. One campaign's KPIs live on campaigns_search with `id`, not here. Read-only.",
    parameters: campaignsStatsInput,
  })
  async getCampaignsStats(
    @Payload() input: z.infer<typeof campaignsStatsInput>,
    @McpUser() user: User,
  ) {
    const report = (input as any)?.report ?? "summary";
    if (report === "recipients") {
      if (!isSet((input as any).campaignId)) {
        throw new RpcException("report=recipients requires `campaignId`. Use campaigns_search to find it.");
      }
      const { report: _r, campaignId, ...q } = input as any;
      const result = await this.campaigns.listRecipients(user, campaignId, q);
      const rows = Array.isArray((result as any)?.records) ? (result as any).records : [];
      return toolJson({
        report,
        total_records: (result as any)?.total_records ?? rows.length,
        current_page: (result as any)?.current_page ?? 1,
        per_page: (result as any)?.per_page ?? (q as any)?.limit ?? 20,
        recipients: rows.map((r: any) => ({
          id: r.id ?? null,
          name: r.name ?? null,
          phoneNumber: r.phoneNumber ?? null,
          deliveryStatus: r.deliveryStatus ?? null,
          orderId: r.orderId ?? r.order?.id ?? null,
          orderNumber: r.order?.orderNumber ?? null,
        })),
      });
    }
    if (isSet((input as any).campaignId) || isSet((input as any).limit) || isSet((input as any).status) || isSet((input as any).search) || isSet((input as any).page)) {
      throw new RpcException("report=summary takes no filters. Remove campaignId/limit/status/search/page, or set report=recipients.");
    }
    return toolJson({ report, ...(await this.campaigns.stats(user)) });
  }
}
