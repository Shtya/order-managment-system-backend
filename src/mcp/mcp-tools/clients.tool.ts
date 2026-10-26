import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { ClientService } from "src/clients/clients.service";
import { TagsService } from "src/tags/tags.service";
import { TagsAssignmentService } from "src/tags/tags-assignment.service";
import { TagTarget } from "entities/tag.entity";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { ClientEntity } from "entities/clients.entity";
import { CreateClientAddressDto, CreateClientDto, UpdateClientAddressDto, UpdateClientDto } from "dto/client.dto";
import { listPaging, parseDto, parseSaveInput, parseSearchInput, searchInput, toolInputFor } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, ref, TOOL } from "../utils/mcp-tool-names";
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
    // addresses: ${TOOL.clients.addressSave}
  }),
);

const saveClientAddressFields = toolInputFor<UpdateClientAddressDto>()(
  z.object({
    label: z.string().optional().describe("Short label, e.g. Home or Work"),
    address: z.string().optional().describe("Street / full address text. Required for create"),
    cityId: uuidField(idDescription("Madar city id.", TOOL.cities.list)).optional(),
    areaId: uuidField(idDescription("Madar area id for system addresses.", TOOL.cities.areas)).optional(),
    city: z.string().optional().describe("City display name. Optional when cityId is sent."),
    area: z.string().optional().describe("Area / zone display text. For Bosta this is zone, district."),
    landmark: z.string().optional().describe("Nearby landmark"),
    shippingProvider: z
      .enum(["none", "bosta", "turbo"])
      .optional()
      .describe(
        `none = Madar city/area. bosta/turbo = carrier geo. Provider code from ${ref(TOOL.shippingCompanies.list)} row.provider. Bosta needs shippingMetadata.cityId (provider city id) and districtId from ${ref(TOOL.shippingCompanies.geo)}. Turbo needs shippingMetadata.cityId and zoneId.`,
      ),
    shippingMetadata: z
      .object({
        cityId: z.string().optional().describe(`Provider city id from ${ref(TOOL.cities.list)} with provider=, not the Madar city UUID.`),
        zoneId: z.string().optional().describe(`Turbo zone id from ${ref(TOOL.shippingCompanies.geo)} kind=zones.`),
        districtId: z.string().optional().describe(`Bosta district id from ${ref(TOOL.shippingCompanies.geo)} kind=districts.`),
        locationId: z.string().optional().describe("Optional provider location id"),
      })
      .optional()
      .describe("Carrier geo ids. Required for bosta/turbo. Omit for none."),
    isDefault: z
      .boolean()
      .optional()
      .describe(
        "Update (or create): true makes this the client's only default address. Other addresses are unset. False clears default on this row only.",
      ),
  }),
);

const saveClientAddressInput = z.object({
  mode: z
    .enum(["create", "update"])
    .describe(
      'Required. "create" to add an address on a client. "update" to change an existing address. Never infer from id.',
    ),
  clientId: uuidField(idDescription("Client ID that owns the address.", TOOL.clients.search)),
  id: uuidField(
    idDescription(
      "Address ID.",
      TOOL.clients.search,
      "Required for mode=update. Forbidden for mode=create. Use an address id from that client's dto.",
    ),
  ).optional(),
  ...saveClientAddressFields.shape,
});

const saveClientInput = z.object({
  mode: z
    .enum(["create", "update"])
    .describe(
      'Required. "create" to add a new client. "update" to change an existing one. Never infer from id.',
    ),
  id: uuidField(idDescription("Client ID.", TOOL.clients.search, "Required for mode=update. Forbidden for mode=create.")).optional(),
  ...saveClientFields.shape,
  tags: z
    .array(z.string())
    .optional()
    .describe(
      `Client tag names (not ids), exact names from ${ref(TOOL.tags.list)} with target=client. On create/update, the client's tags become this list (empty array removes all). Omit to leave tags unchanged. Do not combine with addTagIds/removeTagIds.`,
    ),
  addTagIds: z
    .array(uuidField(idDescription("Tag id to add.", TOOL.tags.list, "The tag target must be client.")))
    .optional()
    .describe(`Client tag ids to add (create or update). Find ids with ${ref(TOOL.tags.list)} target=client. Never guess an id.`),
  removeTagIds: z
    .array(uuidField(idDescription("Tag id to remove.", TOOL.tags.list, "The tag target must be client.")))
    .optional()
    .describe(`Client tag ids to remove (update only; rejected on create). Find ids with ${ref(TOOL.tags.list)} target=client or the client's tags in clients_search. Never guess an id.`),
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
// ═══════════════════════════════════════════════════════════════

function toAddressDto(a: any) {
  return {
    id: a.id ?? null,
    label: a.label ?? null,
    address: a.address ?? null,
    landmark: a.landmark ?? null,
    cityId: a.cityId ?? null,
    city: a.city ?? null,
    cityName: a.cityDetails?.nameEn ?? a.cityDetails?.nameAr ?? null,
    areaId: a.areaId ?? null,
    area: a.area ?? null,
    areaName: a.areaDetails?.nameEn ?? a.areaDetails?.nameAr ?? null,
    shippingProvider: a.shippingProvider ?? null,
    shippingMetadata: a.shippingMetadata ?? null,
    isDefault: Boolean(a.isDefault),
  };
}

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
    addresses: addresses.map(toAddressDto),
    tags: Array.isArray((row as any).clientTags)
      ? (row as any).clientTags.map((ct: any) => ({
          id: ct.tag?.id ?? ct.tagId ?? null,
          name: ct.tag?.name ?? null,
          color: ct.tag?.color ?? null,
        }))
      : [],
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
  constructor(
    private clients: ClientService,
    private tags: TagsService,
    private tagsAssignment: TagsAssignmentService,
  ) {}

  @McpReadTool({
    name: TOOL.clients.search,
    description:
      "Search clients or fetch one. Without `id`: lists active clients with page/limit, search (name, email, phone), optional hasPhone, and sortBy (createdAt, name, ordersCount, email, updatedAt). With `id`: returns that single client with contacts, addresses, client tags, and order stats. Read-only.",
    parameters: searchClientsInput,
  })
  async searchClients(
    @Payload() input: z.infer<typeof searchClientsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "client");
    if (req.mode === "get") {
      return toolJson(await this.clientSaveResult(user, req.id));
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
      `Create or update a client. Required: mode ("create" or "update"). Optional on create: name, email, notes, contacts (phoneNumber, isPrimary), tags (client tag names from list_tags target=client). addTagIds / removeTagIds: client-target tag ids from ${ref(TOOL.tags.list)} (removeTagIds update only); applied after the client is saved. For update: \`id\` plus any of those; a tags-only update is allowed. Sending \`tags\` replaces the client's tags. \`contacts\` on update REPLACES the full phone list: a phone left out is deleted, so send every phone to keep. customerId is the phone (contact) row id from clients_search; include it to edit an existing phone, omit it to add one. Never profilePicture. Addresses use ${ref(TOOL.clients.addressSave)}.`,
    parameters: saveClientInput,
  })
  async saveClient(
    @Payload() input: z.infer<typeof saveClientInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "client", TOOL.clients.search);
    const { tags: tagNames, addTagIds, removeTagIds, ...fields } = req.fields as Record<string, unknown> & {
      tags?: string[];
      addTagIds?: string[];
      removeTagIds?: string[];
    };
    const hasIdTags = (addTagIds?.length ?? 0) > 0 || (removeTagIds?.length ?? 0) > 0;
    if (hasIdTags && tagNames !== undefined) {
      throw new RpcException("Use either `tags` (names, replaces all) or addTagIds/removeTagIds, not both.");
    }
    if (req.mode === "create" && (removeTagIds?.length ?? 0) > 0) {
      throw new RpcException("removeTagIds is not allowed on mode=create (a new client has no tags). Use addTagIds.");
    }
    if (req.mode === "create") {
      const parsed = await parseDto(CreateClientDto, fields);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      const created = await this.clients.create(user, parsed.dto);
      await this.applyClientTagNames(user, (created as any).id, tagNames, "create");
      if (addTagIds?.length) {
        await this.tagsAssignment.syncClientManual(user, (created as any).id, addTagIds, []);
      }
      return toolJson(await this.clientSaveResult(user, (created as any).id));
    }
    // Tags-only update: skip the client update when no client fields were sent.
    const hasClientFields = Object.values(fields).some((v) => v !== undefined);
    if (hasClientFields) {
      const parsed = await parseDto(UpdateClientDto, fields);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      await this.clients.update(user, req.id, parsed.dto);
    }
    await this.applyClientTagNames(user, req.id, tagNames, "update");
    if (hasIdTags) {
      await this.tagsAssignment.syncClientManual(user, req.id, addTagIds, removeTagIds);
    }
    return toolJson(await this.clientSaveResult(user, req.id));
  }

  @McpSaveTool({
    name: TOOL.clients.addressSave,
    description:
      'Create or update a client address. Required: mode ("create" or "update") and clientId. Required for create: address. Optional: label, cityId (Madar UUID), areaId (system addresses), city, area, landmark, shippingProvider (none|bosta|turbo), shippingMetadata (provider cityId/zoneId/districtId), isDefault. Bosta needs shippingMetadata.cityId + districtId from shipping_geo; Turbo needs cityId + zoneId. For update: `id` (address id from clients_search) plus any fields. isDefault=true unsets default on the client\'s other addresses.',
    parameters: saveClientAddressInput,
  })
  async saveClientAddress(
    @Payload() input: z.infer<typeof saveClientAddressInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "client address", TOOL.clients.search);
    const clientId = (input as any).clientId as string;
    if (!clientId) {
      throw new RpcException("`clientId` is required. Find the client with clients_search.");
    }
    const { clientId: _omit, ...fields } = req.fields as Record<string, unknown> & { clientId?: string };
    if (req.mode === "create") {
      const parsed = await parseDto(CreateClientAddressDto, fields);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      return toolJson(toAddressDto(await this.clients.createAddress(user, clientId, parsed.dto)));
    }
    const parsed = await parseDto(UpdateClientAddressDto, fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(toAddressDto(await this.clients.updateAddress(user, clientId, req.id, parsed.dto)));
  }

  private async clientSaveResult(user: User, clientId: string) {
    const [client, stats, clientTags] = await Promise.all([
      this.clients.findOne(user, clientId),
      this.clients.getOrderStats(user, clientId).catch(() => null),
      this.tagsAssignment.listClientTags(user, clientId).catch(() => []),
    ]);
    return toClientResultDto({ ...(client as any), clientTags }, stats);
  }

  private async applyClientTagNames(
    user: User,
    clientId: string,
    tagNames: string[] | undefined,
    mode: "create" | "update",
  ) {
    if (tagNames === undefined) return;
    const wanted = await this.resolveClientTagIds(user, tagNames);
    if (mode === "create") {
      if (wanted.length === 0) return;
      await this.tagsAssignment.syncClientManual(user, clientId, wanted, []);
      return;
    }
    const current = await this.tagsAssignment.listClientTags(user, clientId);
    const currentIds = current
      .map((row: any) => row.tagId ?? row.tag?.id)
      .filter(Boolean) as string[];
    const wantedSet = new Set(wanted);
    const currentSet = new Set(currentIds);
    const addTagIds = wanted.filter((id) => !currentSet.has(id));
    const removeTagIds = currentIds.filter((id) => !wantedSet.has(id));
    if (addTagIds.length === 0 && removeTagIds.length === 0) return;
    await this.tagsAssignment.syncClientManual(user, clientId, addTagIds, removeTagIds);
  }

  private async resolveClientTagIds(user: User, names: string[]) {
    const unique = [...new Set(names.map((n) => String(n ?? "").trim()).filter(Boolean))];
    if (unique.length === 0) return [];
    const found = await this.tags.findActiveByNames(user, unique, TagTarget.CLIENT);
    const foundNames = new Set(found.map((t) => t.name.toLowerCase()));
    const missing = unique.filter((n) => !foundNames.has(n.toLowerCase()));
    if (missing.length > 0) {
      throw new RpcException(
        `Unknown client tag name(s): ${missing.join(", ")}. Find names with list_tags { "target": "client" }.`,
      );
    }
    return found.map((t) => t.id);
  }
}
