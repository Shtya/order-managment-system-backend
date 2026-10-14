import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { ClientSegmentsService } from "src/client-segments/client-segments.service";
import { ClientSegmentStatus, ClientSegmentType } from "entities/clients-segments.entity";
import { CreateClientSegmentDto, UpdateClientSegmentDto } from "dto/client-segment.dto";
import { listPaging, parseDto, parseSaveInput, parseSearchInput, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, ref, TOOL } from "../utils/mcp-tool-names";
import { uuidField } from "../utils/mcp-date.util";
import { audienceFilterSchema, normalizeAudienceFilter } from "../utils/mcp-audience-filter";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Service sorts createdAt only: advertise that single column.
// ═══════════════════════════════════════════════════════════════

const searchSegmentsInput = searchInput("client segment", {
  ...listPaging({
    items: "client segments",
    sortBy: ["createdAt"],
    search: "Matches segment name",
  }),
  status: z.enum(ClientSegmentStatus).optional().describe("Keep segments with this status"),
  type: z.enum(ClientSegmentType).optional().describe("Keep segments of this type"),
}, TOOL.clientSegments.search);

const segmentsStatsInput = z.strictObject({});

const saveSegmentInput = z.object({
  mode: z
    .enum(["create", "update"])
    .describe('Required. "create" to add a new segment. "update" to change an existing one. Never infer from id.'),
  id: uuidField(
    idDescription("Client segment ID.", TOOL.clientSegments.search, "Required for mode=update. Forbidden for mode=create."),
  ).optional(),
  name: z.string().min(1).max(160).optional().describe("Segment name, unique in the workspace (1-160 chars). Required for create."),
  description: z.string().max(1000).optional().describe("What this segment is for"),
  type: z
    .enum([ClientSegmentType.DYNAMIC, ClientSegmentType.FROZEN])
    .optional()
    .describe("Create only. dynamic (default) = membership recalculated on every use. frozen = snapshot of the matching clients taken now in the background."),
  status: z.enum(ClientSegmentStatus).optional().describe("Update only. inactive hides it from campaigns."),
  audienceFilter: audienceFilterSchema.optional(),
});

const previewSegmentInput = z.object({
  id: uuidField(
    idDescription("Saved segment to preview.", TOOL.clientSegments.search, "Pass either id or audienceFilter, not both."),
  ).optional(),
  audienceFilter: audienceFilterSchema.optional(),
  limit: z.number().int().min(1).max(50).optional().describe("Sample size, default 10, max 50."),
  cursor: z
    .object({ value: z.string(), id: z.string() })
    .optional()
    .describe("nextCursor from the previous preview call, to get the next page of clients."),
});

const SEGMENT_ACTIONS = ["freeze", "unfreeze", "refresh_estimate"] as const;

const actSegmentInput = z.object({
  action: z.enum(SEGMENT_ACTIONS).describe(
    "freeze: snapshot current matching clients (only from dynamic or freeze_failed). unfreeze: back to dynamic, drops the snapshot (from frozen or freeze_failed). refresh_estimate: recount estimatedRecipientsCount.",
  ),
  id: uuidField(idDescription("Client segment ID.", TOOL.clientSegments.search)),
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS
//    No recipient tables, no templates, no freeze internals.
// ═══════════════════════════════════════════════════════════════

function toSegmentSummary(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    status: row.status ?? null,
    type: row.type ?? null,
    estimatedRecipientsCount: Number(row.estimatedRecipientsCount ?? 0),
  };
}

function toSegmentResultDto(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    description: row.description ?? null,
    status: row.status ?? null,
    type: row.type ?? null,
    estimatedRecipientsCount: Number(row.estimatedRecipientsCount ?? 0),
    frozenRecipientsCount: Number(row.frozenRecipientsCount ?? 0),
    frozenAt: row.frozenAt ?? null,
    audienceFilter: row.audienceFilter ?? row.audiencefilter ?? null,
    createdAt: row.createdAt ?? null,
  };
}

function toRecipient(row: any) {
  return {
    clientId: row.clientId ?? null,
    name: row.name ?? null,
    phoneNumber: row.phoneNumber ?? null,
  };
}

function toPreviewResult(count: number, page: any) {
  return {
    count,
    recipients: (page?.records ?? []).map(toRecipient),
    hasMore: !!page?.hasMore,
    nextCursor: page?.nextCursor ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpClientSegmentsTools {
  constructor(private segments: ClientSegmentsService) {}

  @McpReadTool({
    name: TOOL.clientSegments.search,
    description:
      `Search client segments or fetch one. Without \`id\`: paged summaries filtered by name, status, or type. No date filters; extra fields (e.g. startDate) are rejected. With \`id\`: returns that segment with its audience filter, estimated count and frozen snapshot info. Read-only. Write with ${ref(TOOL.clientSegments.save)}, see matching clients with ${ref(TOOL.clientSegments.preview)}, freeze / unfreeze with ${ref(TOOL.clientSegments.act)}.`,
    parameters: searchSegmentsInput,
  })
  async searchSegments(
    @Payload() input: z.infer<typeof searchSegmentsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "client segment");
    if (req.mode === "get") {
      return toolJson(toSegmentResultDto(await this.segments.get(user, req.id)));
    }
    const result = await this.segments.list(user, req.query);
    return toolPage("client_segments", result, toSegmentSummary, req.query.limit);
  }

  @McpReadTool({
    name: TOOL.clientSegments.stats,
    description:
      "Client segment totals. No date filters. Extra fields (e.g. startDate) are rejected. Read-only.",
    parameters: segmentsStatsInput,
  })
  async getSegmentsStats(@McpUser() user: User) {
    return toolJson(await this.segments.stats(user));
  }

  @McpReadTool({
    name: TOOL.clientSegments.preview,
    description:
      `Count and sample the clients matching an audience filter, before or after saving. Pass exactly one of: \`audienceFilter\` (unsaved draft, same shape as ${ref(TOOL.clientSegments.save)}) or \`id\` (saved segment; frozen segments return their snapshot and must be active). Returns count, up to \`limit\` recipients (clientId, name, phoneNumber), hasMore and nextCursor for the next page. Read-only.`,
    parameters: previewSegmentInput,
  })
  async previewSegment(
    @Payload() input: z.infer<typeof previewSegmentInput>,
    @McpUser() user: User,
  ) {
    if (!!input.id === !!input.audienceFilter) {
      throw new RpcException("Pass exactly one of `id` or `audienceFilter`.");
    }
    const q = { limit: input.limit ?? 10, cursor: input.cursor };

    if (input.audienceFilter) {
      const filter = normalizeAudienceFilter(input.audienceFilter) as any;
      const [{ count }, page] = await Promise.all([
        this.segments.preview(user, filter),
        this.segments.previewRecipients(user, filter, q),
      ]);
      return toolJson(toPreviewResult(count, page));
    }

    const seg = await this.segments.get(user, input.id!);
    const page = await this.segments.listRecipients(user, seg.id, q);
    const count =
      seg.type === ClientSegmentType.FROZEN
        ? Number(seg.frozenRecipientsCount ?? 0)
        : (await this.segments.preview(user, seg.audienceFilter)).count;
    return toolJson(toPreviewResult(count, page));
  }

  @McpSaveTool({
    name: TOOL.clientSegments.save,
    description:
      `Create or update a client segment (a saved audience of clients, used by campaigns). Required: mode. Create requires name and audienceFilter; type optional (dynamic default, or frozen). Update: \`id\` plus any of name, description, status, audienceFilter. ` +
      `On update, audienceFilter REPLACES the whole filter: fetch the current one with ${ref(TOOL.clientSegments.search)} id first. ` +
      `A frozen or freezing segment's audienceFilter cannot be changed: unfreeze it with ${ref(TOOL.clientSegments.act)} first. ` +
      `Check the audience with ${ref(TOOL.clientSegments.preview)} before saving. Returns the segment with estimatedRecipientsCount. No delete.`,
    parameters: saveSegmentInput,
  })
  async saveSegment(
    @Payload() input: z.infer<typeof saveSegmentInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "client segment", TOOL.clientSegments.search, { updateOnlyKeys: ["status"] });
    const { audienceFilter, ...rest } = req.fields;
    const fields: Record<string, unknown> = { ...rest };
    if (audienceFilter) fields.audienceFilter = normalizeAudienceFilter(audienceFilter);

    if (req.mode === "create") {
      const parsed = await parseDto(CreateClientSegmentDto, fields);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      return toolJson(toSegmentResultDto(await this.segments.create(user, parsed.dto)));
    }

    if (fields.type !== undefined) {
      throw new RpcException(
        `type is create-only. To freeze or unfreeze an existing segment use ${TOOL.clientSegments.act}.`,
      );
    }
    const parsed = await parseDto(UpdateClientSegmentDto, fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(toSegmentResultDto(await this.segments.update(user, req.id, parsed.dto)));
  }

  @McpSaveTool({
    name: TOOL.clientSegments.act,
    description:
      `Act on a saved client segment. Required: action, id. freeze: takes a snapshot of the matching clients in the background (allowed from dynamic or freeze_failed); the result shows type=freezing, re-check with ${ref(TOOL.clientSegments.search)} to see frozen or freeze_failed. unfreeze: back to dynamic and drops the snapshot (from frozen or freeze_failed). refresh_estimate: recounts estimatedRecipientsCount. Returns the segment.`,
    parameters: actSegmentInput,
  })
  async actSegment(
    @Payload() input: z.infer<typeof actSegmentInput>,
    @McpUser() user: User,
  ) {
    switch (input.action) {
      case "freeze":
        await this.segments.freeze(user, input.id);
        break;
      case "unfreeze":
        await this.segments.unfreeze(user, input.id);
        break;
      case "refresh_estimate":
        await this.segments.refreshEstimate(user, input.id);
        break;
    }
    return toolJson(toSegmentResultDto(await this.segments.get(user, input.id)));
  }
}
