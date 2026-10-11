import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { ClientService } from "src/clients/clients.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { ClientEntity } from "entities/clients.entity";
import { parseSearchInput, searchInput } from "../utils/mcp-dto.util";
import { toolJson } from "../utils/mcp-result.util";
import { TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

const searchClientsInput = searchInput("client", {
  search: z
    .string()
    .optional()
    .describe("Matches client name, email, contact name, or phone number"),
  limit: z.number().int().min(1).max(50).default(10).describe("The number of clients to return"),
  cursor: z
    .string()
    .optional()
    .describe("Pagination cursor from a previous response (nextCursor). Omit for the first page."),
  hasPhone: z
    .boolean()
    .optional()
    .describe("When true, keep only clients that have a phone number"),
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
// ═══════════════════════════════════════════════════════════════

function toClientSummary(row: Partial<ClientEntity>) {
  return {
    id: row.id,
    name: row.name ?? null,
    email: (row as any).email ?? null,
    phoneNumber: row.primaryContact?.phoneNumber ?? null,
    createdAt: (row as any).createdAt ?? null,
  };
}

function toClientResultDto(row: Partial<ClientEntity>, stats: unknown) {
  const contacts = Array.isArray((row as any).contacts) ? (row as any).contacts : [];
  const addresses = Array.isArray((row as any).addresses) ? (row as any).addresses : [];
  const primary = row.primaryContact as any;
  return {
    id: row.id,
    name: row.name ?? null,
    email: (row as any).email ?? null,
    profilePicture: (row as any).profilePicture ?? null,
    status: (row as any).status ?? null,
    notes: (row as any).notes ?? null,
    primaryContact: primary
      ? {
          id: primary.id ?? null,
          name: primary.name ?? null,
          phoneNumber: primary.phoneNumber ?? null,
        }
      : null,
    contacts: contacts.map((c: any) => ({
      id: c.id ?? null,
      name: c.name ?? null,
      phoneNumber: c.phoneNumber ?? null,
    })),
    addresses: addresses.map((a: any) => ({
      id: a.id ?? null,
      label: a.label ?? null,
      address: a.address ?? null,
      city: a.city ?? null,
      cityName: a.cityDetails?.nameEn ?? a.cityDetails?.nameAr ?? null,
      areaName: a.areaDetails?.nameEn ?? a.areaDetails?.nameAr ?? null,
    })),
    counts: {
      orders: Number((row as any).ordersCount ?? 0),
      contacts: Number((row as any).contactsCount ?? 0),
    },
    stats: stats ?? null,
    createdAt: (row as any).createdAt ?? null,
    updatedAt: (row as any).updatedAt ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS: the @McpController class
//    Guards, tool decorators, service calls and the toolJson /
//    toolPage return helpers. No mapping or schema code here.
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpClientsTools {
  constructor(private clients: ClientService) {}

  @McpReadTool({
    name: TOOL.clients.search,
    description:
      "Search clients or fetch one. Without `id`: lists the signed-in Madar user's clients by name, email, or phone. Cursor-paginated: pass nextCursor back as cursor for the next page. With `id`: returns that single client with contacts, addresses, and order stats. Read-only.",
    parameters: searchClientsInput,
  })
  async searchClients(
    @Payload() input: z.infer<typeof searchClientsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "client");
    if (req.mode === "get") {
      const [client, stats] = await Promise.all([
        this.clients.findOne(user, req.id),
        this.clients.getOrderStats(user, req.id),
      ]);
      return toolJson(toClientResultDto(client, stats));
    }
    const result = await this.clients.list(user, req.query);
    const rows = Array.isArray(result?.data) ? result.data : [];
    return toolJson({
      clients: rows.map(toClientSummary),
      nextCursor: result?.nextCursor ?? null,
      hasMore: result?.hasMore ?? false,
    });
  }
}
