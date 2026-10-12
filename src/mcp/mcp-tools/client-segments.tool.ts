import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { ClientSegmentsService } from "src/client-segments/client-segments.service";
import { ClientSegmentStatus, ClientSegmentType } from "entities/clients-segments.entity";
import { listPaging, parseSearchInput, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { TOOL } from "../utils/mcp-tool-names";

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

const segmentsStatsInput = z.object({});

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
    audienceFilter: row.audienceFilter ?? row.audiencefilter ?? null,
    createdAt: row.createdAt ?? null,
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
      "Search client segments or fetch one. Without `id`: paged summaries filtered by name, status, or type. With `id`: returns that segment with its audience filter and estimated count. Read-only.",
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
    description: "Client segment totals. Read-only.",
    parameters: segmentsStatsInput,
  })
  async getSegmentsStats(@McpUser() user: User) {
    return toolJson(await this.segments.stats(user));
  }
}
