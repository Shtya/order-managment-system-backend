import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { StoresService } from "src/stores/stores.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { StoreEntity, StoreProvider, SyncStatus } from "entities/stores.entity";
import { listPaging } from "../utils/mcp-dto.util";
import { toolPage } from "../utils/mcp-result.util";
import { TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

const listStoresInput = z.object({
  ...listPaging({
    items: "stores",
    sortBy: [
      "created_at",
      "name",
      "provider",
      "syncStatus",
      "isActive",
      "isIntegrated",
      "lastSyncAttemptAt",
      "updated_at",
    ],
    search: "Matches store name or store URL",
  }),
  provider: z.enum(StoreProvider).optional().describe("Store platform"),
  syncStatus: z.enum(SyncStatus).optional().describe("Sync status to filter by"),
  isActive: z.enum(["true", "false"]).optional().describe("Only active (true) or inactive (false) stores"),
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
// ═══════════════════════════════════════════════════════════════

function toStoreSummary(row: Partial<StoreEntity>) {
  return {
    id: row.id,
    name: (row as any).name ?? null,
    storeUrl: (row as any).storeUrl ?? null,
    provider: (row as any).provider ?? null,
    isActive: (row as any).isActive ?? null,
    isIntegrated: (row as any).isIntegrated ?? null,
    syncStatus: (row as any).syncStatus ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS: the @McpController class
//    Guards, tool decorators, service calls and the toolJson /
//    toolPage return helpers. No mapping or schema code here.
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpStoresTools {
  constructor(private stores: StoresService) {}

  @McpReadTool({
    name: TOOL.stores.list,
    description:
      "List the stores of the signed-in Madar user's workspace. Read-only.",
    parameters: listStoresInput,
  })
  async listStores(
    @Payload() query: z.infer<typeof listStoresInput>,
    @McpUser() user: User,
  ) {
    const result = await this.stores.list(user, query);
    return toolPage("stores", result, toStoreSummary, query.limit);
  }
}
