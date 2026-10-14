import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { CampaignsService } from "src/campaigns/campaigns.service";
import { WhatsappService } from "src/whatsapp/whatsapp.service";
import { tenantId } from "src/category/category.service";
import {
  CampaignAudienceType,
  CampaignCategory,
  CampaignChannel,
  CampaignExclusionType,
  CampaignRecipientDeliveryStatus,
  CampaignScheduleMode,
  CampaignStatus,
} from "entities/campaigns.entity";
import { TemplateStatus } from "entities/whatsapp.entity";
import { CreateCampaignDto, UpdateCampaignDto } from "dto/campaign.dto";
import { listPaging, parseDto, parseSaveInput, parseSearchInput, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, ref, TOOL } from "../utils/mcp-tool-names";
import { uuidField } from "../utils/mcp-date.util";
import { audienceFilterSchema, normalizeAudienceFilter } from "../utils/mcp-audience-filter";

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

const PLACEHOLDERS_DOC =
  "Values may use placeholders filled per recipient: {{customer.name}}, {{customer.number}}, {{campaign.orderUrl}} (purchase page link).";

const COUNTS_DOC =
  "Counts: estimatedRecipientsCount = audience size calculated when the campaign is saved, before excluded recipients and duplicate phone numbers are removed. " +
  "counters.recipientsCount and recipientCounts = the real recipient list, built in the background a few seconds after create / schedule, after exclusions and duplicates are removed (recipientCounts.byStatus splits it by delivery status). " +
  "Right after saving, recipientCounts.total is often 0 while the estimate is not; fetch again to see the real number. They can also differ for good when exclusions or duplicates removed people. " +
  "If exclusions remove everyone, save still succeeds (the estimate ignores them) but a few seconds later the campaign turns failed with failureReason=audience_empty; failed is final and cannot be cancelled or edited.";

const EXCLUSIONS_DOC =
  "Recipients to skip. type=client skips audience people linked to that clientId; type=phone_number skips anyone with that phone (normalized). " +
  "Applied only when the recipient list is built in the background, not in estimatedRecipientsCount. " +
  "Do not exclude the whole audience: the campaign would turn failed (failureReason=audience_empty) right after saving. " +
  "Replaces the whole list on update; [] clears it.";

const variableMap = (what: string) =>
  z.record(z.string(), z.string()).optional().describe(what);

const whatsappInput = z
  .object({
    accountId: uuidField(idDescription("WhatsApp account sending the campaign.", TOOL.whatsapp.accountsSearch)),
    templateId: uuidField(
      idDescription("Approved, active message template of that account.", TOOL.whatsapp.templatesSearch, "Its templateConfig shows the variables to fill."),
    ),
    bodyVariables: variableMap(
      `Body variables, keyed by the template variable name: positional templates use "1", "2"...; named templates use the name. Every variable in bodyText must have a value. ${PLACEHOLDERS_DOC}`,
    ),
    headerVariables: variableMap("Header variables (TEXT headers only), keyed like bodyVariables."),
    buttonVariables: variableMap(
      `Button values keyed by button index ("0", "1"...), only for dynamic URL buttons (the URL suffix) and COPY_CODE buttons (the code). ${PLACEHOLDERS_DOC}`,
    ),
    headerUrl: z.string().max(1000).optional().describe("Public media URL for IMAGE, VIDEO or DOCUMENT headers. Defaults to the template's own header media."),
    useOrderFirstItemImage: z.boolean().optional().describe("IMAGE headers: use the first campaign product's image instead of headerUrl."),
    locationData: z
      .object({
        latitude: z.union([z.number(), z.string()]),
        longitude: z.union([z.number(), z.string()]),
        name: z.string(),
        address: z.string(),
      })
      .optional()
      .describe("Required for LOCATION headers."),
  })
  .describe("WhatsApp message. The template config and variable format are built by the tool from the template.");

const AUDIENCE_TYPES = [CampaignAudienceType.CUSTOMERS, CampaignAudienceType.SEGMENT, CampaignAudienceType.MANUAL] as const;

const saveCampaignInput = z.object({
  mode: z.enum(["create", "update"]).describe('Required. "create" launches a new campaign. "update" edits a scheduled one. Never infer from id.'),
  id: uuidField(
    idDescription("Campaign ID.", TOOL.campaigns.search, "Required for mode=update (campaign must be status=scheduled). Forbidden for mode=create."),
  ).optional(),
  name: z.string().min(1).max(255).optional().describe("Campaign name, unique in the workspace. Required for create."),
  description: z.string().max(2000).optional(),
  category: z.enum(CampaignCategory).optional(),

  audienceType: z
    .enum(AUDIENCE_TYPES)
    .optional()
    .describe("Required for create. customers = all clients (optionally narrowed by audienceFilter). segment = a saved client segment (audienceSegmentId). manual = manualRecipients list. File audiences are not supported here."),
  audienceSegmentId: uuidField(idDescription("Client segment for audienceType=segment.", TOOL.clientSegments.search)).optional(),
  audienceFilter: audienceFilterSchema.optional(),
  manualRecipients: z
    .array(z.object({ phoneNumber: z.string().min(1).max(50), name: z.string().max(200).optional() }))
    .min(1)
    .optional()
    .describe("For audienceType=manual. Replaces the whole list on update."),
  excludedRecipients: z
    .array(
      z.object({
        type: z.enum(CampaignExclusionType),
        clientId: uuidField(idDescription("Client to exclude (type=client).", TOOL.clients.search)).optional(),
        phoneNumber: z.string().max(50).optional().describe("Phone to exclude (type=phone_number)."),
        reason: z.string().max(1000).optional(),
      }),
    )
    .optional()
    .describe(EXCLUSIONS_DOC),

  whatsapp: whatsappInput.optional(),

  products: z
    .array(
      z.object({
        productId: uuidField(idDescription("Product.", TOOL.products.search)).optional(),
        variantId: uuidField(idDescription("Variant: variants[].id of the product.", TOOL.products.search)).optional(),
        name: z.string().min(1).max(200).describe("Name shown on the purchase page."),
        sku: z.string().max(120).optional(),
        image: z.string().max(500).optional(),
        quantity: z.number().int().min(1).optional(),
        price: z.number().min(0).optional().describe("Offer price."),
      }),
    )
    .optional()
    .describe("Products offered on the purchase page. Replaces the whole list on update."),
  shippingPrice: z.number().min(0).optional(),
  enablePurchasePage: z.boolean().optional().describe("Lets recipients order the products from a purchase page link."),
  orderReplyFollowupEnabled: z.boolean().optional().describe("Send automatic replies when a recipient taps a quick-reply button."),
  orderReplyFollowups: z
    .array(z.object({ buttonIndex: z.number().int().min(0), text: z.string().min(1).max(2000) }))
    .optional()
    .describe("One automatic reply per template quick-reply button index."),

  scheduleMode: z.enum(CampaignScheduleMode).optional().describe("now = start sending immediately. scheduled = start at scheduledAt."),
  scheduledAt: z.string().datetime({ offset: true }).optional().describe("ISO datetime with timezone, in the future, for scheduleMode=scheduled."),
  workingHoursStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe("HH:MM. Messages are only sent inside working hours."),
  workingHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe("HH:MM."),
  workingHoursTimezone: z.string().max(64).optional().describe("IANA timezone, e.g. Africa/Cairo."),
  delayMinSeconds: z.number().int().min(4).optional().describe("Min seconds between messages (default 30)."),
  delayMaxSeconds: z.number().int().min(4).optional().describe("Max seconds between messages (default 90), not less than delayMinSeconds."),
  maxMessagesPerHour: z.number().int().min(1).optional(),

  confirmSendNow: z
    .boolean()
    .optional()
    .describe("Must be true when this call starts sending immediately (create without a future scheduledAt, or update with scheduleMode=now / a past scheduledAt). Ask the user first."),
});

const CAMPAIGN_ACTIONS = ["start_now", "pause", "resume", "cancel", "retry_failed"] as const;

const actCampaignInput = z.object({
  action: z.enum(CAMPAIGN_ACTIONS).describe(
    "start_now: scheduled -> running now (sends messages). pause: running -> paused. resume: paused -> running. cancel: scheduled, running or paused -> cancelled (final). retry_failed: failed or completed campaign -> resend to failed recipients (sends messages).",
  ),
  id: uuidField(idDescription("Campaign ID.", TOOL.campaigns.search)),
});

const ACTION_FROM: Record<(typeof CAMPAIGN_ACTIONS)[number], CampaignStatus[]> = {
  start_now: [CampaignStatus.SCHEDULED],
  pause: [CampaignStatus.RUNNING],
  resume: [CampaignStatus.PAUSED],
  cancel: [CampaignStatus.SCHEDULED, CampaignStatus.RUNNING, CampaignStatus.PAUSED],
  retry_failed: [CampaignStatus.FAILED, CampaignStatus.COMPLETED],
};

const FINAL_STATUSES: string[] = [CampaignStatus.COMPLETED, CampaignStatus.CANCELLED, CampaignStatus.FAILED];

const isSet = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

// ── WhatsApp config builder (mirrors frontend StepMessage buildInitialWhatsapp) ──

type WhatsappInput = z.infer<typeof whatsappInput>;

const VAR_RE = { positional: /\{\{(\d+)\}\}/g, named: /\{\{([a-z][a-z0-9_]*)\}\}/g };
const MEDIA_HEADERS = ["IMAGE", "VIDEO", "DOCUMENT"];

function templateVars(text: string | undefined, format: "positional" | "named") {
  return [...new Set([...(text ?? "").matchAll(VAR_RE[format])].map((m) => m[1]))];
}

function fillVars(
  kind: string,
  expected: string[],
  given: Record<string, string> | undefined,
  build: (key: string, value: string) => Record<string, any>,
) {
  const sent = given ?? {};
  const unknown = Object.keys(sent).filter((k) => !expected.includes(k));
  if (unknown.length) {
    throw new RpcException(
      `whatsapp.${kind}: unknown keys ${unknown.join(", ")}. Expected: ${expected.length ? expected.join(", ") : "none"}.`,
    );
  }
  const missing = expected.filter((k) => !String(sent[k] ?? "").trim());
  if (missing.length) {
    throw new RpcException(`whatsapp.${kind}: missing values for ${missing.join(", ")}. Expected keys: ${expected.join(", ")}.`);
  }
  return Object.fromEntries(expected.map((k) => [k, build(k, sent[k])]));
}

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

// Stored variables are {type, value, example...}; return just the values,
// keyed like the campaigns_save whatsapp input.
function variableValues(vars: Record<string, any> | null | undefined) {
  if (!vars || typeof vars !== "object") return {};
  return Object.fromEntries(
    Object.entries(vars).map(([key, v]) => [key, v && typeof v === "object" ? (v.value ?? null) : (v ?? null)]),
  );
}

function toCampaignResultDto(
  row: any,
  extra: { performance?: any; recipientCounts?: any; exclusions?: any[] | null } = {},
) {
  const wa = row.templateConfigSnapshot ?? null;
  return {
    id: row.id,
    name: row.name ?? null,
    description: row.description ?? null,
    status: row.status ?? null,
    failureReason: row.failureReason ?? null,
    channel: row.channel ?? null,
    category: row.category ?? null,
    audienceType: row.audienceType ?? null,
    audienceFilter: row.audienceFilter ?? null,
    manualRecipientsCount: Array.isArray(row.audienceManualSnapshot) ? row.audienceManualSnapshot.length : null,
    estimatedRecipientsCount: Number(row.estimatedRecipientsCount ?? 0),
    excludedRecipientsCount: Number(row.excludedRecipientsCount ?? 0),
    excludedRecipients: (extra.exclusions ?? []).map((e: any) => ({
      type: e.type,
      clientId: e.clientId ?? null,
      phoneNumber: e.phoneNumber ?? null,
      reason: e.reason ?? null,
    })),
    scheduleMode: row.scheduleMode ?? null,
    scheduledAt: row.scheduledAt ?? null,
    workingHoursStart: row.workingHoursStart ?? null,
    workingHoursEnd: row.workingHoursEnd ?? null,
    workingHoursTimezone: row.workingHoursTimezone ?? null,
    delayMinSeconds: row.delayMinSeconds ?? null,
    delayMaxSeconds: row.delayMaxSeconds ?? null,
    maxMessagesPerHour: row.maxMessagesPerHour ?? null,
    shippingPrice: Number(row.shippingPrice ?? 0),
    enablePurchasePage: row.enablePurchasePage ?? false,
    orderReplyFollowupEnabled: row.orderReplyFollowupEnabled ?? false,
    orderReplyFollowups: row.orderReplyFollowups ?? [],
    whatsapp: wa
      ? {
        accountId: wa.accountId ?? null,
        templateId: row.templateId ?? null,
        bodyVariables: variableValues(wa.bodyVariables),
        headerVariables: variableValues(wa.headerVariables),
        buttonVariables: variableValues(wa.buttonVariables),
        headerUrl: wa.headerUrl ?? null,
        useOrderFirstItemImage: wa.useOrderFirstItemImage ?? false,
        locationData: wa.locationData ?? null,
      }
      : null,
    dates: {
      createdAt: row.createdAt ?? null,
      startedAt: row.startedAt ?? null,
      pausedAt: row.pausedAt ?? null,
      completedAt: row.completedAt ?? null,
      cancelledAt: row.cancelledAt ?? null,
      failedAt: row.failedAt ?? null,
    },
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
    products: Array.isArray(row.products)
      ? [...row.products]
        .sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .map((p: any) => ({
          id: p.id ?? null,
          productId: p.productId ?? null,
          variantId: p.variantId ?? null,
          name: p.name ?? null,
          sku: p.sku ?? null,
          quantity: Number(p.quantity ?? 1),
          price: Number(p.price ?? 0),
        }))
      : [],
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
  constructor(
    private campaigns: CampaignsService,
    private whatsapp: WhatsappService,
  ) {}

  @McpReadTool({
    name: TOOL.campaigns.search,
    description:
      `Search campaigns or fetch one. Without \`id\`: paged summaries filtered by search text, exact name, status, channel, or category. With \`id\`: returns that campaign with every saved setting (products with prices, shipping, schedule, working hours, delays, max per hour, follow-ups, exclusions, whatsapp template variables in the same shape as ${ref(TOOL.campaigns.save)} input), status + failureReason, counters, order performance, and recipient status counts. Read-only. Create or edit with ${ref(TOOL.campaigns.save)}; start, pause, resume, cancel or retry with ${ref(TOOL.campaigns.act)}. ${COUNTS_DOC}`,
    parameters: searchCampaignsInput,
  })
  async searchCampaigns(
    @Payload() input: z.infer<typeof searchCampaignsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "campaign");
    if (req.mode === "get") {
      return toolJson(await this.campaignResult(user, req.id));
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

  @McpSaveTool({
    name: TOOL.campaigns.save,
    description:
      `Create or edit a WhatsApp campaign. IMPORTANT: create LAUNCHES the campaign — it starts sending right away, or at scheduledAt when scheduleMode=scheduled with a future time. There is no draft. Sending now requires confirmSendNow=true; confirm with the user first. ` +
      `Create requires: name, audienceType, whatsapp (accountId, templateId, and every template variable). ` +
      `Update: only campaigns with status=scheduled can be edited (others: use ${ref(TOOL.campaigns.act)}). Send \`id\` plus fields to change. On update, whatsapp, products, manualRecipients, excludedRecipients and audienceFilter each REPLACE the whole value (products get new row ids; match them by productId / variantId); scheduleMode=now on update starts sending (needs confirmSendNow). ` +
      `Audience: customers (all clients, optional audienceFilter), segment (audienceSegmentId from ${ref(TOOL.clientSegments.search)}; check its size with ${ref(TOOL.clientSegments.preview)}), manual (manualRecipients). ` +
      `WhatsApp: accountId from ${ref(TOOL.whatsapp.accountsSearch)}, templateId from ${ref(TOOL.whatsapp.templatesSearch)} (approved + active; its templateConfig lists header/body variables and buttons). ${PLACEHOLDERS_DOC} ` +
      `Products from ${ref(TOOL.products.search)}. Only the WhatsApp channel is supported. No delete. ${COUNTS_DOC}`,
    parameters: saveCampaignInput,
  })
  async saveCampaign(
    @Payload() input: z.infer<typeof saveCampaignInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "campaign", TOOL.campaigns.search);
    const { confirmSendNow, whatsapp, audienceFilter, ...rest } = req.fields;
    const fields: Record<string, unknown> = { ...rest };
    if (audienceFilter) fields.audienceFilter = normalizeAudienceFilter(audienceFilter);
    if (whatsapp) fields.whatsapp = await this.buildWhatsappConfig(user, whatsapp);

    const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
    const isFuture = (d: Date | null | undefined) => !!d && d.getTime() > Date.now();
    const needConfirm = (msg: string) => {
      if (confirmSendNow !== true) {
        throw new RpcException(`${msg} Messages would go out immediately. Ask the user, then retry with confirmSendNow=true, or set scheduleMode=scheduled with a future scheduledAt.`);
      }
    };

    if (req.mode === "create") {
      if (!whatsapp) throw new RpcException("create requires `whatsapp` (accountId, templateId, variables).");
      if (input.audienceType === CampaignAudienceType.SEGMENT && !input.audienceSegmentId) {
        throw new RpcException(`audienceType=segment requires audienceSegmentId (from ${TOOL.clientSegments.search}).`);
      }
      if (input.audienceType === CampaignAudienceType.MANUAL && !input.manualRecipients?.length) {
        throw new RpcException("audienceType=manual requires manualRecipients.");
      }
      const futureSchedule = input.scheduleMode === CampaignScheduleMode.SCHEDULED && isFuture(scheduledAt);
      if (input.scheduleMode === CampaignScheduleMode.SCHEDULED && !isFuture(scheduledAt)) {
        throw new RpcException("scheduleMode=scheduled needs a future scheduledAt (ISO datetime with timezone).");
      }
      if (!futureSchedule) needConfirm("This create starts the campaign now.");

      fields.channel = CampaignChannel.WHATSAPP;
      const parsed = await parseDto(CreateCampaignDto, fields);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      const created: any = await this.campaigns.create(user, parsed.dto);
      return toolJson(await this.campaignResult(user, created.id));
    }

    const current: any = await this.campaigns.get(user, req.id);
    if (current.status !== CampaignStatus.SCHEDULED) {
      throw new RpcException(
        `Only scheduled campaigns can be edited; this one is ${current.status}${current.failureReason ? ` (failureReason: ${current.failureReason})` : ""}. Use ${TOOL.campaigns.act} for pause / resume / cancel / retry_failed.`,
      );
    }
    if (input.scheduleMode === CampaignScheduleMode.NOW) {
      needConfirm("scheduleMode=now starts the campaign.");
    } else if (input.scheduleMode === CampaignScheduleMode.SCHEDULED) {
      const effective = scheduledAt ?? (current.scheduledAt ? new Date(current.scheduledAt) : null);
      if (!isFuture(effective)) needConfirm("scheduledAt is not in the future, so the campaign would start.");
    }

    const parsed = await parseDto(UpdateCampaignDto, fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    await this.campaigns.update(user, req.id, parsed.dto);
    return toolJson(await this.campaignResult(user, req.id));
  }

  @McpSaveTool({
    name: TOOL.campaigns.act,
    description:
      `Run a lifecycle action on a campaign. Required: action, id (from ${ref(TOOL.campaigns.search)}). ` +
      `start_now: only from scheduled; starts sending immediately (confirm with the user). pause: only from running. resume: only from paused. cancel: from scheduled, running or paused; final, cannot be undone. retry_failed: only from failed or completed with failed recipients; resends to them. Returns the refreshed campaign. ${COUNTS_DOC}`,
    parameters: actCampaignInput,
  })
  async actCampaign(
    @Payload() input: z.infer<typeof actCampaignInput>,
    @McpUser() user: User,
  ) {
    const current: any = await this.campaigns.get(user, input.id);
    const allowed = ACTION_FROM[input.action];
    if (!allowed.includes(current.status)) {
      const reason = current.failureReason ? ` (failureReason: ${current.failureReason})` : "";
      throw new RpcException(
        `${input.action} needs status ${allowed.join(" or ")}; this campaign is ${current.status}${reason}.` +
        (FINAL_STATUSES.includes(current.status) && input.action !== "retry_failed" ? " That status is final." : ""),
      );
    }
    switch (input.action) {
      case "start_now":
        await this.campaigns.start(user, input.id, { startNow: true });
        break;
      case "pause":
        await this.campaigns.pause(user, input.id);
        break;
      case "resume":
        await this.campaigns.resume(user, input.id);
        break;
      case "cancel":
        await this.campaigns.cancel(user, input.id);
        break;
      case "retry_failed": {
        const { retried } = await this.campaigns.retryFailed(user, input.id);
        return toolJson({
          retried,
          ...(retried === 0 ? { message: "No failed recipients to retry." } : {}),
          campaign: await this.campaignResult(user, input.id),
        });
      }
    }
    return toolJson(await this.campaignResult(user, input.id));
  }

  private async campaignResult(user: User, id: string) {
    const [campaign, performance, summary, exclusions] = await Promise.all([
      this.campaigns.get(user, id),
      this.campaigns.orderPerformance(user, id).catch(() => null),
      this.campaigns.getSummary(user, id).catch(() => null),
      this.campaigns.listExclusions(user, id).catch(() => null),
    ]);
    return toCampaignResultDto(campaign, { performance, recipientCounts: summary ?? null, exclusions });
  }

  private async buildWhatsappConfig(user: User, input: WhatsappInput) {
    const adminId = tenantId(user);
    const template: any = await this.whatsapp.findTemplateForAccount(adminId, input.accountId, { id: input.templateId });
    if (!template || !template.isActive || template.status !== TemplateStatus.APPROVED) {
      throw new RpcException(
        `Template not found for this account, or not approved and active. Pick one with ${TOOL.whatsapp.templatesSearch}.`,
      );
    }

    const cfg = template.templateConfig ?? {};
    const format: "positional" | "named" = cfg.parameterFormat === "named" ? "named" : "positional";
    const examples = cfg.examples ?? {};
    const direct = (key: string, value: string) => ({ type: "direct", value, example: examples[key] ?? "" });

    const headerKeys = cfg.headerType === "TEXT" ? templateVars(cfg.headerText, format) : [];
    const headerVariables = fillVars("headerVariables", headerKeys, input.headerVariables, direct);
    const bodyVariables = fillVars("bodyVariables", templateVars(cfg.bodyText, format), input.bodyVariables, direct);

    const buttons: any[] = cfg.buttons ?? [];
    const buttonKeys: string[] = [];
    buttons.forEach((btn, idx) => {
      if ((btn.type === "VISIT_WEBSITE" && btn.urlType === "Dynamic") || btn.type === "COPY_CODE") buttonKeys.push(String(idx));
    });
    const buttonVariables = fillVars("buttonVariables", buttonKeys, input.buttonVariables, (key, value) => {
      const btn = buttons[Number(key)];
      return btn.type === "COPY_CODE"
        ? { type: "COPY_CODE", buttonType: "copy_code", value, label: "Copy code", example: btn.example ?? "" }
        : { type: "Dynamic", buttonType: "url", value, label: btn.text ?? "", example: btn.url ?? "" };
    });

    const headerUrl = input.headerUrl ?? cfg.headerUrl ?? undefined;
    if (MEDIA_HEADERS.includes(cfg.headerType) && !headerUrl && !input.useOrderFirstItemImage) {
      throw new RpcException(`Template header is ${cfg.headerType}: send whatsapp.headerUrl (public media URL) or useOrderFirstItemImage=true.`);
    }
    if (cfg.headerType === "LOCATION" && !input.locationData) {
      throw new RpcException("Template header is LOCATION: send whatsapp.locationData { latitude, longitude, name, address }.");
    }

    return {
      templateId: template.id,
      accountId: input.accountId,
      templateData: cfg,
      ...(headerUrl ? { headerUrl } : {}),
      ...(input.useOrderFirstItemImage !== undefined ? { useOrderFirstItemImage: input.useOrderFirstItemImage } : {}),
      headerVariables,
      bodyVariables,
      buttonVariables,
      ...(cfg.headerType === "LOCATION" ? { locationData: input.locationData } : {}),
    };
  }
}
