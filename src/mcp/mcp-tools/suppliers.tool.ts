import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { SuppliersService } from "src/supplier/supplier.service";
import { CreateSupplierDto, UpdateSupplierDto, UpdateSupplierFinancialsDto } from "dto/supplier.dto";
import { listPaging, parseDto, parseSaveInput, parseSearchInput, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, TOOL } from "../utils/mcp-tool-names";
import { uuidField } from "../utils/mcp-date.util";

// Update DTO keeps categoryIds required: flat save stays plain z.object,
// Create/Update (+Financials) DTOs enforce at runtime.
const searchSuppliersInput = searchInput("supplier", {
  ...listPaging({
    items: "suppliers",
    sortBy: ["created_at"],
    search: "Matches name, phone, email, or address",
  }),
  categoryId: uuidField(idDescription("Keep suppliers of this category.", TOOL.supplierCategories.search)).optional(),
}, TOOL.suppliers.search);

const saveSupplierFields = z.object({
  name: z.string().optional().describe("Supplier name. Required for create"),
  phone: z.string().optional().describe("Supplier phone. Required for create"),
  categoryIds: z.array(uuidField(idDescription("Category ids. Required for create.", TOOL.supplierCategories.search))).optional(),
  address: z.string().optional().describe("Supplier address"),
  email: z.string().optional().describe("Supplier email"),
  secondPhone: z.string().optional().describe("Second phone"),
  description: z.string().optional().describe("Internal notes"),
  dueBalance: z.number().optional().describe("Update only. Financial due balance."),
  purchaseValue: z.number().optional().describe("Update only. Financial purchase value."),
});

const saveSupplierInput = z.object({
  mode: z.enum(["create", "update"]).describe('Required. "create" or "update". Never infer from id.'),
  id: uuidField(idDescription("Supplier ID.", TOOL.suppliers.search, "Required for mode=update. Forbidden for mode=create.")).optional(),
  ...saveSupplierFields.shape,
});

function toSummary(row: any) {
  const cats = Array.isArray(row?.categories) ? row.categories : [];
  return {
    id: row.id,
    name: row.name ?? null,
    phone: row.phone ?? null,
    categories: cats.map((c: any) => ({ id: c.id ?? null, name: c.name ?? null })),
  };
}

function toResultDto(row: any) {
  const cats = Array.isArray(row?.categories) ? row.categories : [];
  return {
    id: row.id,
    name: row.name ?? null,
    phone: row.phone ?? null,
    secondPhone: row.secondPhone ?? null,
    email: row.email ?? null,
    address: row.address ?? null,
    description: row.description ?? null,
    dueBalance: Number(row.dueBalance ?? 0),
    categories: cats.map((c: any) => ({ id: c.id ?? null, name: c.name ?? null })),
  };
}

@McpController()
@UseGuards(McpScopeGuard)
export class McpSuppliersTools {
  constructor(private suppliers: SuppliersService) {}

  @McpReadTool({
    name: TOOL.suppliers.search,
    description:
      "Search suppliers or fetch one. Without `id`: paged summaries by search text or category. With `id`: returns that supplier with categories and balances. Read-only.",
    parameters: searchSuppliersInput,
  })
  async search(
    @Payload() input: z.infer<typeof searchSuppliersInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "supplier");
    if (req.mode === "get") {
      return toolJson(toResultDto(await this.suppliers.get(user, req.id)));
    }
    const result = await this.suppliers.list(user, req.query);
    return toolPage("suppliers", result, toSummary, req.query.limit);
  }

  @McpSaveTool({
    name: TOOL.suppliers.save,
    description:
      'Create or update a supplier. Required: mode ("create" or "update"). Required for create: name, phone, categoryIds. Optional: address, email, second phone, description. For update: `id` plus any of those; dueBalance/purchaseValue are update-only financials. No delete, pay, or export.',
    parameters: saveSupplierInput,
  })
  async save(
    @Payload() input: z.infer<typeof saveSupplierInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "supplier", TOOL.suppliers.search);
    const { dueBalance, purchaseValue, ...rest } = req.fields as any;
    const hasFinancials = dueBalance !== undefined || purchaseValue !== undefined;
    if (req.mode === "create") {
      if (hasFinancials) {
        throw new RpcException("dueBalance/purchaseValue are update-only. Remove them or set mode=update with `id`.");
      }
      const parsed = await parseDto(CreateSupplierDto, rest);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      return toolJson(toResultDto(await this.suppliers.create(user, parsed.dto)));
    }
    const parsed = await parseDto(UpdateSupplierDto, rest);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    const updated = await this.suppliers.update(user, req.id, parsed.dto);
    if (hasFinancials) {
      const fin = await parseDto(UpdateSupplierFinancialsDto, { ...(dueBalance !== undefined ? { dueBalance } : {}), ...(purchaseValue !== undefined ? { purchaseValue } : {}) });
      if (fin.ok === false) throw new RpcException(fin.message);
      await (this.suppliers as any).updateFinancials(user, req.id, fin.dto);
      return toolJson(toResultDto(await this.suppliers.get(user, req.id)));
    }
    return toolJson(toResultDto(updated));
  }
}
