import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { WarehousesService } from "src/warehouse/warehouse.service";
import { CreateWarehouseDto, UpdateWarehouseDto } from "dto/warehouse.dto";
import { CreateStorageLocationDto, UpdateStorageLocationDto } from "dto/storage-location.dto";
import { StorageLocationType } from "entities/warehouses.entity";
import { listPaging, parseDto, parseSaveInput, parseSearchInput, searchInput, toolInputFor } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";
import { uuidField } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS
//    Warehouses: service sorts created_at fixed + optional isActive.
//    Locations: filter warehouseId + search; no get-by-id.
// ═══════════════════════════════════════════════════════════════

const searchWarehousesInput = searchInput("warehouse", {
  ...listPaging({
    items: "warehouses",
    sortBy: ["createdAt"],
    search: "Matches warehouse name or address",
  }),
  isActive: z.boolean().optional().describe("True for active only, false for inactive only. Omit for all."),
}, TOOL.warehouses.search);

const saveWarehouseFields = toolInputFor<UpdateWarehouseDto>()(
  z.object({
    name: z.string().optional().describe("Warehouse name. Required for create"),
    address: z.string().optional().describe("Warehouse address"),
    description: z.string().optional().describe("What this warehouse stores"),
    isActive: z.boolean().optional().describe("False to deactivate. Replaces toggle-status."),
  }),
);

const saveWarehouseInput = z.object({
  mode: z.enum(["create", "update"]).describe('Required. "create" or "update". Never infer from id.'),
  id: uuidField(idDescription("Warehouse ID.", TOOL.warehouses.search, "Required for mode=update. Forbidden for mode=create.")).optional(),
  ...saveWarehouseFields.shape,
});

const searchLocationsInput = z.object({
  page: z.number().int().min(1).default(1).describe("Page number, starting at 1"),
  limit: z.number().int().min(1).max(50).default(10).describe("The number of locations to return"),
  warehouseId: uuidField(idDescription("Keep locations of this warehouse.", TOOL.warehouses.search)).optional(),
  search: z.string().optional().describe("Matches location name"),
  type: z.enum(StorageLocationType).optional().describe("Keep locations of this type"),
  isActive: z.boolean().optional().describe("True for active only, false for inactive only. Omit for all."),
});

const saveLocationFields = toolInputFor<UpdateStorageLocationDto>()(
  z.object({
    name: z.string().optional().describe("Location name. Required for create"),
    description: z.string().optional().describe("What this location holds"),
    // type/parentId are create-only on the DTOs: added on the save input.
  }),
);

const saveLocationInput = z.object({
  mode: z.enum(["create", "update"]).describe('Required. "create" or "update". Never infer from id.'),
  warehouseId: uuidField(idDescription("Warehouse id holding the location.", TOOL.warehouses.search)),
  id: uuidField(idDescription("Location ID.", TOOL.warehouses.locationsSearch, "Required for mode=update. Forbidden for mode=create.")).optional(),
  type: z.enum(StorageLocationType).optional().describe("Location type. Required for create, never on update."),
  parentId: uuidField(idDescription("Parent location id.", TOOL.warehouses.locationsSearch, "Create only, never on update.")).optional(),
  isActive: z.boolean().optional().describe("Update only. Toggles location status at runtime."),
  ...saveLocationFields.shape,
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS
// ═══════════════════════════════════════════════════════════════

function toWarehouseSummary(row: any) {
  return { id: row.id, name: row.name ?? null, address: row.address ?? null, isActive: row.isActive ?? null };
}

function toWarehouseDto(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    address: row.address ?? null,
    description: row.description ?? null,
    isActive: row.isActive ?? null,
  };
}

function toLocationSummary(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    type: row.type ?? null,
    description: row.description ?? null,
    parentId: row.parentId ?? row.parent?.id ?? null,
    warehouseId: row.warehouseId ?? row.warehouse?.id ?? null,
    isActive: row.isActive ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpWarehousesTools {
  constructor(private warehouses: WarehousesService) {}

  @McpReadTool({
    name: TOOL.warehouses.search,
    description:
      "Search warehouses or fetch one. Without `id`: paged summaries by search text or active flag. With `id`: returns that warehouse. Read-only.",
    parameters: searchWarehousesInput,
  })
  async search(
    @Payload() input: z.infer<typeof searchWarehousesInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "warehouse");
    if (req.mode === "get") {
      return toolJson(toWarehouseDto(await this.warehouses.get(user, req.id)));
    }
    const result = await this.warehouses.list(user, req.query);
    return toolPage("warehouses", result, toWarehouseSummary, req.query.limit);
  }

  @McpSaveTool({
    name: TOOL.warehouses.save,
    description:
      'Create or update a warehouse. Required: mode ("create" or "update"). Required for create: name. Optional: address, description, isActive. For update: `id` plus any of those (`isActive` replaces toggle). No delete tool.',
    parameters: saveWarehouseInput,
  })
  async save(
    @Payload() input: z.infer<typeof saveWarehouseInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "warehouse", TOOL.warehouses.search);
    if (req.mode === "create") {
      const parsed = await parseDto(CreateWarehouseDto, req.fields);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      return toolJson(toWarehouseDto(await this.warehouses.create(user, parsed.dto)));
    }
    const parsed = await parseDto(UpdateWarehouseDto, req.fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(toWarehouseDto(await this.warehouses.update(user, req.id, parsed.dto)));
  }
}

@McpController()
@UseGuards(McpScopeGuard)
export class McpWarehouseLocationsTools {
  constructor(private warehouses: WarehousesService) {}

  @McpReadTool({
    name: TOOL.warehouses.locationsSearch,
    description:
      "List storage locations. Filter by warehouse, search text, type, or active flag. No get-by-id. Read-only.",
    parameters: searchLocationsInput,
  })
  async search(
    @Payload() query: z.infer<typeof searchLocationsInput>,
    @McpUser() user: User,
  ) {
    const result = await this.warehouses.listLocations(user, query);
    return toolPage("locations", result, toLocationSummary, query.limit);
  }

  @McpSaveTool({
    name: TOOL.warehouses.locationsSave,
    description:
      'Create or update a storage location. Required: mode ("create" or "update") plus warehouseId. Required for create: name, type. Optional: parentId, description. The warehouse must be active to add locations. For update: `id` plus name/description; optional isActive toggles status at runtime; warehouseId must be the location\'s own warehouse. Type, parent and warehouse never change on update (moving between warehouses is not supported). No delete tool.',
    parameters: saveLocationInput,
  })
  async save(
    @Payload() input: z.infer<typeof saveLocationInput>,
    @McpUser() user: User,
  ) {
    const { mode, warehouseId, id, type, parentId, isActive, ...rest } = input as any;
    if (mode !== "create" && mode !== "update") {
      throw new RpcException('`mode` is required: "create" or "update". Do not infer it from `id`.');
    }
    if (mode === "create") {
      if (isSet(id)) throw new RpcException("mode=create forbids `id`. Omit `id` to create.");
      if (isSet(isActive)) throw new RpcException("`isActive` is update-only. Remove it or set mode=update.");
      const parsed = await parseDto(CreateStorageLocationDto, { ...rest, type, parentId });
      if (parsed.ok === false) throw new RpcException(parsed.message);
      return toolJson(toLocationSummary(await this.warehouses.createLocation(user, warehouseId, parsed.dto)));
    }
    if (!isSet(id)) throw new RpcException(`mode=update requires \`id\`. Use ${TOOL.warehouses.locationsSearch} to find it.`);
    if (isSet(type) || isSet(parentId)) {
      throw new RpcException("type/parent are create-only and never change on update. Remove them.");
    }
    const existing = await this.warehouses.findLocationById(user, id);
    if (!existing) {
      throw new RpcException(`Location not found. Use ${TOOL.warehouses.locationsSearch} to find it.`);
    }
    if ((existing as any).warehouseId !== warehouseId) {
      throw new RpcException(
        `This location belongs to another warehouse (warehouseId ${(existing as any).warehouseId}). Moving locations between warehouses is not supported. To edit it, pass its own warehouseId.`,
      );
    }
    const parsed = await parseDto(UpdateStorageLocationDto, rest);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    let updated: any = await this.warehouses.updateLocation(user, warehouseId, id, parsed.dto);
    if (isActive !== undefined && updated?.isActive !== isActive) {
      updated = await this.warehouses.toggleLocationStatus(user, warehouseId, id);
    }
    return toolJson(toLocationSummary(updated));
  }
}

function isSet(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}
