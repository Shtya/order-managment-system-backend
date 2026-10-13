import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { ClientService } from "src/clients/clients.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { ClientEntity } from "entities/clients.entity";
import { CreateClientDto, UpdateClientDto } from "dto/client.dto";
import { listPaging, parseDto, parseSaveInput, parseSearchInput, searchInput, toolInputFor } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";
import { uuidField } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

const searchClientsInput = searchInput("client", {
  ...listPaging({
    items: "clients",
    sortBy: ["createdAt", "name", "ordersCount", "email", "updatedAt"],
    defaultSortBy: "createdAt",
    search: "Matches client name, email, contact name, or phone number",
  }),
  hasPhone: z
    .boolean()
    .optional()
    .describe("When true, keep only clients that have a phone number"),
}, TOOL.clients.search);

const clientsStatsInput = z.strictObject({});

const saveClientFields = toolInputFor<UpdateClientDto>()(
  z.object({
    name: z.string().optional().describe("Client name"),
    email: z.string().optional().describe("Client email"),
    notes: z.string().optional().describe("Internal notes"),
    contacts: z
      .array(
        z.object({
          phoneNumber: z.string().describe("Contact phone number"),
          isPrimary: z.boolean().optional().describe("True to mark as the primary contact"),
          customerId: uuidField(idDescription("Existing contact/phone row id when editing a phone.", TOOL.clients.search, "Use a contact id from that client's dto. Omit to add a new phone.")).optional(),
        }),
      )
      .optional()
      .describe("Contact phones. Enough for add/edit phones on save."),
    // profilePicture never offered: avatar upload
    // addresses stay on get detail; address CRUD later
  }),
);

const saveClientInput = z.object({
  mode: z
    .enum(["create", "update"])
    .describe(
      'Required. "create" to add a new client. "update" to change an existing one. Never infer from id.',
    ),
  id: uuidField(idDescription("Client ID.", TOOL.clients.search, "Required for mode=update. Forbidden for mode=create.")).optional(),
  ...saveClientFields.shape,
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
    ordersCount: Number((row as any).ordersCount ?? 0),
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
      "Search clients or fetch one. Without `id`: lists active clients with page/limit, search (name, email, phone), optional hasPhone, and sortBy (createdAt, name, ordersCount, email, updatedAt). With `id`: returns that single client with contacts, addresses, and order stats. Read-only.",
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
    const result = await this.clients.listPaginated(user, req.query);
    return toolPage("clients", result, toClientSummary, req.query.limit);
  }

  @McpReadTool({
    name: TOOL.clients.stats,
    description:
      "Client totals: total clients, with orders, with delivered orders, with orders in the last 30 days. No date filters. Extra fields (e.g. startDate) are rejected. Read-only.",
    parameters: clientsStatsInput,
  })
  async getClientsStats(@McpUser() user: User) {
    return toolJson(await this.clients.getStats(user));
  }

  @McpSaveTool({
    name: TOOL.clients.save,
    description:
      'Create or update a client. Required: mode ("create" or "update"). Optional on create: name, email, notes, contacts (phoneNumber, isPrimary). For update: `id` plus any of those. Never profilePicture. Contact link/unlink and addresses are separate later slices.',
    parameters: saveClientInput,
  })
  async saveClient(
    @Payload() input: z.infer<typeof saveClientInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "client", TOOL.clients.search);
    if (req.mode === "create") {
      const parsed = await parseDto(CreateClientDto, req.fields);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      const created = await this.clients.create(user, parsed.dto);
      const [client, stats] = await Promise.all([
        this.clients.findOne(user, (created as any).id),
        this.clients.getOrderStats(user, (created as any).id).catch(() => null),
      ]);
      return toolJson(toClientResultDto(client, stats));
    }
    const parsed = await parseDto(UpdateClientDto, req.fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    await this.clients.update(user, req.id, parsed.dto);
    const [client, stats] = await Promise.all([
      this.clients.findOne(user, req.id),
      this.clients.getOrderStats(user, req.id).catch(() => null),
    ]);
    return toolJson(toClientResultDto(client, stats));
  }
}
