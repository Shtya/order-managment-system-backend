import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { SafesService } from "src/safes/safes.service";
import { AccountType } from "entities/safe.entity";
import { listPaging } from "../utils/mcp-dto.util";
import { toolPage } from "../utils/mcp-result.util";
import { TOOL } from "../utils/mcp-tool-names";

const listSafesInput = z.strictObject({
  ...listPaging({
    items: "safes",
    sortBy: ["createdAt"],
    search: "Matches safe, bank, or account number",
  }),
  type: z.enum(AccountType).optional().describe("Keep safes of this type. Omit for all."),
});

@McpController()
@UseGuards(McpScopeGuard)
export class McpSafesTools {
  constructor(private safes: SafesService) {}

  @McpReadTool({
    name: TOOL.safes.list,
    description:
      "List cash safes. Use the returned id as safeId on purchases_save and purchase_returns_save. Read-only.",
    parameters: listSafesInput,
  })
  async listSafes(
    @Payload() query: z.infer<typeof listSafesInput>,
    @McpUser() user: User,
  ) {
    const result = await this.safes.listAccounts(user, query);
    return toolPage("safes", result, (row: any) => ({
      id: row.id,
      name: row.name ?? null,
      balance: Number(row.currentBalance ?? row.balance ?? 0),
      isActive: (row.status ?? "ACTIVE") === "ACTIVE",
    }), query.limit);
  }
}
