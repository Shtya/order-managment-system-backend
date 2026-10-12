import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { CancelCausesService } from "src/cancel-causes/cancel-causes.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { CancelCauseReviewStatus, CancelCauseSource } from "entities/cancel-cause.entity";
import { CreateCancelCauseDto, ReviewCancelCauseDto, UpdateCancelCauseDto } from "dto/cancel-cause.dto";
import { listPaging, parseDto, parseSaveInput, parseSearchInput, searchInput, toolInputFor } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS
//    Default (no admin filter): listSelectable (approved + active,
//    for order cancel). Any admin filter set: list().
//    sortBy whitelist: sortOrder (default), name, created_at, updated_at.
// ═══════════════════════════════════════════════════════════════

const listCancelCausesInput = searchInput("cancel cause", {
  ...listPaging({
    items: "cancel causes",
    sortBy: ["sortOrder", "name", "created_at", "updated_at"],
    defaultSortBy: "sortOrder",
    search: "Matches cancel-cause name or code",
  }),
  reviewStatus: z.enum(CancelCauseReviewStatus).optional().describe("Keep causes with this review status. Pass pending for the review queue."),
  isActive: z.boolean().optional().describe("True for active only, false for inactive only. Omit for the selectable default."),
  source: z.enum(CancelCauseSource).optional().describe("Keep causes from this source"),
  submittedByEmployeeId: z
    .string()
    .optional()
    .describe(idDescription("Keep causes submitted by this employee.", TOOL.employees.list)),
}, TOOL.cancelCauses.list);

const saveCancelCauseFields = toolInputFor<UpdateCancelCauseDto>()(
  z.object({
    name: z.string().optional().describe("Cause name, at least 3 characters. Required for create"),
    description: z.string().optional().describe("What this cause means"),
    sortOrder: z.number().int().min(0).optional().describe("Lower shows first"),
    isActive: z.boolean().optional().describe("False to deactivate"),
  }),
);

const saveCancelCauseInput = z.object({
  mode: z
    .enum(["create", "update"])
    .describe(
      'Required. "create" to add a new cause. "update" to change an existing one. Never infer from id.',
    ),
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      idDescription("Cause ID.", TOOL.cancelCauses.list, "Required for mode=update. Forbidden for mode=create."),
    ),
  ...saveCancelCauseFields.shape,
});

const acceptCancelCauseInput = z.object({
  id: z.string().min(1).describe(idDescription("Pending cause ID.", TOOL.cancelCauses.list, "Call the lookup with reviewStatus: pending.")),
  reviewNote: z.string().optional().describe("Reviewer note"),
  name: z.string().optional().describe("Rename on accept (at least 3 characters)"),
  description: z.string().optional().describe("New description on accept"),
});

const cancelCausesStatsInput = z.object({
  report: z
    .enum([
      "overview",
      "by_cause",
      "top",
      "top_this_month",
      "top_products",
      "trend",
      "by_employee",
      "sla",
      "custom_vs_predefined",
      "pending_review",
    ])
    .optional()
    .describe("Which report to return. overview (default): totals. top_this_month: no custom dates. pending_review: no dates."),
  startDate: z.string().optional().describe("Range start, ISO date (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("Range end, ISO date (YYYY-MM-DD)"),
});

const isSet = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS
// ═══════════════════════════════════════════════════════════════

function toCancelCauseSummary(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    code: row.code ?? null,
    reviewStatus: row.reviewStatus ?? null,
    isActive: row.isActive ?? null,
    sortOrder: row.sortOrder ?? null,
    usageCount: Number(row.usageCount ?? 0),
  };
}

function toCancelCauseResultDto(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    code: row.code ?? null,
    description: row.description ?? null,
    reviewStatus: row.reviewStatus ?? null,
    source: row.source ?? null,
    isActive: row.isActive ?? null,
    sortOrder: row.sortOrder ?? null,
    usageCount: Number(row.usageCount ?? 0),
    submittedBy: row.submittedByEmployee ? { id: row.submittedByEmployee.id ?? null, name: row.submittedByEmployee.name ?? null } : null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpCancelCausesTools {
  constructor(private cancelCauses: CancelCausesService) {}

  @McpReadTool({
    name: TOOL.cancelCauses.list,
    description:
      "List cancel causes or fetch one. Without `id`: default returns selectable causes (approved + active) for order cancel; set any admin filter (reviewStatus, isActive, source, submittedByEmployeeId) for the full admin list. With `id`: returns that cause with usage count. Read-only.",
    parameters: listCancelCausesInput,
  })
  async listCancelCauses(
    @Payload() input: z.infer<typeof listCancelCausesInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "cancel cause");
    if (req.mode === "get") {
      return toolJson(toCancelCauseResultDto(await this.cancelCauses.get(user, req.id)));
    }
    const q = req.query as typeof req.query & {
      reviewStatus?: string;
      isActive?: boolean;
      source?: string;
      submittedByEmployeeId?: string;
    };
    const isAdmin =
      isSet(q.reviewStatus) || isSet(q.isActive) || isSet(q.source) || isSet(q.submittedByEmployeeId);
    // Both list() and listSelectable() filter at SQL; default keeps order-cancel behavior.
    const result = isAdmin
      ? await this.cancelCauses.list(user, q)
      : await this.cancelCauses.listSelectable(user, q);
    return toolPage("cancel_causes", result, toCancelCauseSummary, req.query.limit);
  }

  @McpSaveTool({
    name: TOOL.cancelCauses.save,
    description:
      'Create or update a cancel cause. Required: mode ("create" or "update"). Required for create: name (min 3). Optional: description, sortOrder, isActive. For update: `id` plus any of those. Review (accept) is a separate tool.',
    parameters: saveCancelCauseInput,
  })
  async saveCancelCause(
    @Payload() input: z.infer<typeof saveCancelCauseInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "cancel cause", TOOL.cancelCauses.list);
    if (req.mode === "create") {
      const parsed = await parseDto(CreateCancelCauseDto, req.fields);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      return toolJson(toCancelCauseResultDto(await this.cancelCauses.create(user, parsed.dto)));
    }
    const parsed = await parseDto(UpdateCancelCauseDto, req.fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(toCancelCauseResultDto(await this.cancelCauses.update(user, req.id, parsed.dto)));
  }

  @McpSaveTool({
    name: TOOL.cancelCauses.accept,
    description:
      "Accept a pending cancel cause (review action, not save). Required: id of a pending cause. Optional: reviewNote, rename via name/description. Rejects and deletes are out of scope.",
    parameters: acceptCancelCauseInput,
  })
  async acceptCancelCause(
    @Payload() input: z.infer<typeof acceptCancelCauseInput>,
    @McpUser() user: User,
  ) {
    const parsed = await parseDto(ReviewCancelCauseDto, {
      reviewNote: (input as any).reviewNote,
      name: (input as any).name,
      description: (input as any).description,
    });
    if (parsed.ok === false) throw new RpcException(parsed.message);
    const accepted = await this.cancelCauses.accept(user, (input as any).id, parsed.dto);
    return toolJson({
      id: (accepted as any).id ?? null,
      name: (accepted as any).name ?? null,
      reviewStatus: (accepted as any).reviewStatus ?? null,
    });
  }

  @McpReadTool({
    name: TOOL.cancelCauses.stats,
    description:
      "Cancel-cause statistics. Pass `report`: overview (default), by_cause, top, top_this_month (no custom dates), top_products, trend, by_employee, sla, custom_vs_predefined, pending_review (no dates). Shared optional startDate/endDate where the service uses them. Read-only.",
    parameters: cancelCausesStatsInput,
  })
  async getCancelCausesStats(
    @Payload() input: z.infer<typeof cancelCausesStatsInput>,
    @McpUser() user: User,
  ) {
    const report = (input as any)?.report ?? "overview";
    const filters = { startDate: (input as any)?.startDate, endDate: (input as any)?.endDate };
    if (report === "top_this_month" && (isSet(filters.startDate) || isSet(filters.endDate))) {
      throw new RpcException("report=top_this_month takes no custom dates. Remove startDate/endDate.");
    }
    if (report === "pending_review" && (isSet(filters.startDate) || isSet(filters.endDate))) {
      throw new RpcException("report=pending_review takes no dates. Remove startDate/endDate.");
    }
    if (report === "by_cause") return toolJson({ report, ...(await this.cancelCauses.getByCauseStatistics(user, filters)) });
    if (report === "top") return toolJson({ report, ...(await this.cancelCauses.getTopStatistics(user, filters)) });
    if (report === "top_this_month") return toolJson({ report, ...(await this.cancelCauses.getTopThisMonth(user, filters)) });
    if (report === "top_products") return toolJson({ report, ...(await this.cancelCauses.getTopCancelledProducts(user, filters)) });
    if (report === "trend") return toolJson({ report, ...(await this.cancelCauses.getTrend(user, filters)) });
    if (report === "by_employee") return toolJson({ report, ...(await this.cancelCauses.getByEmployee(user, filters)) });
    if (report === "sla") return toolJson({ report, ...(await this.cancelCauses.getSlaStatistics(user, filters)) });
    if (report === "custom_vs_predefined") return toolJson({ report, ...(await this.cancelCauses.getCustomVsPredefined(user, filters)) });
    if (report === "pending_review") return toolJson({ report, ...(await this.cancelCauses.getPendingReviewStats(user)) });
    return toolJson({ report, ...(await this.cancelCauses.getOverviewStatistics(user, filters)) });
  }
}
