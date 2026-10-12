import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { ApprovalStatus, PurchaseReturnType } from "common/enums";
import { PurchasesService } from "src/purchases/purchases.service";
import { PurchaseReturnsService } from "src/purchases-return/purchases-return.service";
import { CreatePurchaseDto, UpdatePurchaseDto } from "dto/purchase.dto";
import { CreatePurchaseReturnDto, UpdatePurchaseReturnDto } from "dto/purchase_return.dto";
import { listPaging, parseDto, parseSaveInput, parseSearchInput, resolveToolDates, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, ref, TOOL } from "../utils/mcp-tool-names";
import { uuidField, isoDateField } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
//    Flat objects + runtime checks (no discriminated unions).
//    Services sort purchases by created_at only: advertise that
//    single column, never a column the query ignores.
// ═══════════════════════════════════════════════════════════════

const searchPurchasesInput = searchInput("purchase invoice", {
  ...listPaging({
    items: "purchase invoices",
    sortBy: ["created_at"],
    search: "Matches receipt number, supplier name, variant SKU, or product name",
  }),
  supplierId: uuidField(idDescription("Supplier id.", TOOL.suppliers.search, 'Pass "all" to skip, "none" for invoices with no supplier.'), ["all", "none"]).optional(),
  status: z.enum(ApprovalStatus).optional().describe("Invoice status. Omit for all."),
  closingId: uuidField(idDescription("Supplier closing id.", TOOL.accounting.supplierClosingsSearch)).optional(),
  startDate: isoDateField("Created-at range start, ISO date (YYYY-MM-DD)").optional(),
  endDate: isoDateField("Created-at range end, ISO date (YYYY-MM-DD)").optional(),
}, TOOL.purchases.search);

// Update DTOs keep required fields (safeId / items), so the flat save
// contract stays plain z.object here; Create/Update DTOs enforce at runtime.
const savePurchaseFields = z.object({
    receiptNumber: z.string().optional().describe("Receipt number. Required for create"),
    supplierId: uuidField(idDescription("Supplier id. Omit for invoices with no supplier.", TOOL.suppliers.search)).optional(),
    safeId: uuidField(idDescription("Safe id holding the payment. Required for create and update.", TOOL.safes.list)).optional(),
    paidAmount: z.number().optional().describe("Amount already paid"),
    notes: z.string().optional().describe("Internal notes"),
    saveAsDraft: z.boolean().optional().describe("True to save as draft"),
    items: z
      .array(
        z.object({
          variantId: uuidField(idDescription("Variant id of the product.", TOOL.products.search)),
          quantity: z.number().int().min(1).describe("Quantity: a whole number, at least 1"),
          purchaseCost: z.number().min(0).describe("Purchase cost per unit, up to 2 decimals"),
        }),
      )
      .optional()
      .describe("Invoice lines. Required for create."),
    // receiptAsset never offered: file upload
  });

const savePurchaseInput = z.object({
  mode: z
    .enum(["create", "update"])
    .describe(
      'Required. "create" to add a new invoice. "update" to change an existing one. Never infer from id.',
    ),
  id: uuidField(idDescription("Invoice ID.", TOOL.purchases.search, "Required for mode=update. Forbidden for mode=create.")).optional(),
  ...savePurchaseFields.shape,
});

const searchPurchaseReturnsInput = searchInput("purchase return", {
  ...listPaging({
    items: "purchase returns",
    sortBy: ["created_at"],
    search: "Matches return number, invoice number, supplier name, variant SKU, or product name",
  }),
  supplierId: uuidField(idDescription("Supplier id.", TOOL.suppliers.search, 'Pass "all" to skip, "none" for returns with no supplier.'), ["all", "none"]).optional(),
  status: z.enum(ApprovalStatus).optional().describe("Return status. Omit for all."),
  closingId: uuidField(idDescription("Supplier closing id.", TOOL.accounting.supplierClosingsSearch)).optional(),
  startDate: isoDateField("Created-at range start, ISO date (YYYY-MM-DD)").optional(),
  endDate: isoDateField("Created-at range end, ISO date (YYYY-MM-DD)").optional(),
}, TOOL.purchaseReturns.search);

const savePurchaseReturnFields = z.object({
    returnNumber: z.string().optional().describe("Return number. Required for create"),
    supplierId: uuidField(idDescription("Supplier id. Omit for returns with no supplier.", TOOL.suppliers.search)).optional(),
    invoiceNumber: z.string().optional().describe("Original invoice number"),
    returnReason: z.string().optional().describe("Why the goods are returned"),
    safeId: uuidField(idDescription("Safe id for the refund. Required for create.", TOOL.safes.list)).optional(),
    returnType: z.enum(PurchaseReturnType).optional().describe("How the refund is settled"),
    paidAmount: z.number().optional().describe("Amount already refunded"),
    notes: z.string().optional().describe("Internal notes"),
    items: z
      .array(
        z.object({
          variantId: uuidField(idDescription("Variant id of the product.", TOOL.products.search)),
          returnedQuantity: z.number().int().min(1).describe("Quantity to return, at least 1"),
          unitCost: z.number().min(0).describe("Unit cost, up to 2 decimals"),
        }),
      )
      .optional()
      .describe("Return lines. Required for create."),
    // receiptAsset never offered: file upload
  });

const savePurchaseReturnInput = z.object({
  mode: z
    .enum(["create", "update"])
    .describe(
      'Required. "create" to add a new return. "update" to change an existing one. Never infer from id.',
    ),
  id: uuidField(idDescription("Return ID.", TOOL.purchaseReturns.search, "Required for mode=update. Forbidden for mode=create.")).optional(),
  ...savePurchaseReturnFields.shape,
});

const purchasesStatsInput = z.strictObject({
  report: z
    .enum(["invoices", "returns"])
    .optional()
    .describe("Which stats to return. invoices (default): purchase invoice counts. returns: purchase return counts and total return value."),
});

const purchasesActInput = z.object({
  kind: z.enum(["invoice", "return"]).describe('Required. "invoice" for a purchase invoice, "return" for a purchase return.'),
  id: uuidField(idDescription(
        "Invoice or return ID.",
        TOOL.purchases.search,
        `For a return, find it with ${ref(TOOL.purchaseReturns.search)}.`,
      )),
  action: z.enum(["set_status", "set_paid"]).describe('Required. "set_status" to change approval status. "set_paid" to set the paid/refunded amount. Status is never changed through save.'),
  status: z.enum(ApprovalStatus).optional().describe("New status. Required for action=set_status."),
  paidAmount: z.number().min(0).optional().describe("New paid (invoice) or refunded (return) amount. Required for action=set_paid."),
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities.
//    purchaseCost / unitCost ARE allowed here (invoice lines,
//    not product margin dumps). No file bytes.
// ═══════════════════════════════════════════════════════════════

const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v));

function toPurchaseSummary(row: any) {
  const items = Array.isArray(row?.items) ? row.items : [];
  return {
    id: row.id,
    receiptNumber: row.receiptNumber ?? null,
    supplierName: row.supplier?.name ?? null,
    status: row.status ?? null,
    total: num(row.total),
    paidAmount: num(row.paidAmount),
    itemsCount: items.length,
    createdAt: row.created_at ?? row.createdAt ?? null,
  };
}

function toPurchaseResultDto(row: any, extra?: { preview?: any; audit?: unknown[] }) {
  const items = Array.isArray(row?.items) ? row.items : [];
  return {
    id: row.id,
    receiptNumber: row.receiptNumber ?? null,
    status: row.status ?? null,
    supplier: row.supplier ? { id: row.supplier.id ?? row.supplierId ?? null, name: row.supplier.name ?? null } : null,
    safe: row.safe ? { id: row.safe.id ?? row.safeId ?? null, name: row.safe.name ?? null } : null,
    total: num(row.total),
    paidAmount: num(row.paidAmount),
    remainingAmount: num(row.remainingAmount),
    notes: row.notes ?? null,
    closingId: row.closingId ?? null,
    items: items.map((i: any) => ({
      id: i.id ?? null,
      variantId: i.variantId ?? i.variant?.id ?? null,
      sku: i.variant?.sku ?? null,
      productName: i.variant?.product?.name ?? null,
      quantity: i.quantity ?? null,
      purchaseCost: num(i.purchaseCost),
      lineTotal: num(i.lineTotal),
    })),
    acceptPreview: extra?.preview
      ? {
          invoiceId: extra.preview.invoiceId ?? extra.preview.id ?? null,
          receiptNumber: extra.preview.receiptNumber ?? null,
          currentStatus: extra.preview.currentStatus ?? extra.preview.status ?? null,
          canApply: extra.preview.canApply ?? false,
          rows: extra.preview.rows ?? extra.preview,
        }
      : null,
    audit: (extra?.audit ?? []).map((a: any) => ({
      id: a.id ?? null,
      action: a.action ?? null,
      description: a.description ?? null,
      createdAt: a.created_at ?? a.createdAt ?? null,
    })),
    createdAt: row.created_at ?? row.createdAt ?? null,
  };
}

function toReturnSummary(row: any) {
  const items = Array.isArray(row?.items) ? row.items : [];
  return {
    id: row.id,
    returnNumber: row.returnNumber ?? null,
    supplierName: row.supplier?.name ?? null,
    status: row.status ?? null,
    totalReturn: num(row.totalReturn),
    paidAmount: num(row.paidAmount),
    itemsCount: items.length,
    createdAt: row.created_at ?? row.createdAt ?? null,
  };
}

function toReturnResultDto(row: any, extra?: { preview?: any; audit?: unknown[] }) {
  const items = Array.isArray(row?.items) ? row.items : [];
  return {
    id: row.id,
    returnNumber: row.returnNumber ?? null,
    invoiceNumber: row.invoiceNumber ?? null,
    status: row.status ?? null,
    returnType: row.returnType ?? null,
    supplier: row.supplier ? { id: row.supplier.id ?? row.supplierId ?? null, name: row.supplier.name ?? null } : null,
    safe: row.safe ? { id: row.safe.id ?? row.safeId ?? null, name: row.safe.name ?? null } : null,
    totalReturn: num(row.totalReturn),
    paidAmount: num(row.paidAmount),
    returnReason: row.returnReason ?? null,
    notes: row.notes ?? null,
    closingId: row.closingId ?? null,
    items: items.map((i: any) => ({
      id: i.id ?? null,
      variantId: i.variantId ?? i.variant?.id ?? null,
      sku: i.variant?.sku ?? null,
      productName: i.variant?.product?.name ?? null,
      returnedQuantity: i.returnedQuantity ?? null,
      unitCost: num(i.unitCost),
      lineTotal: num(i.lineTotal),
    })),
    acceptPreview: extra?.preview
      ? {
          invoiceId: extra.preview.invoiceId ?? extra.preview.id ?? null,
          receiptNumber: extra.preview.receiptNumber ?? null,
          currentStatus: extra.preview.currentStatus ?? extra.preview.status ?? null,
          canApply: extra.preview.canApply ?? false,
          rows: extra.preview.rows ?? extra.preview,
        }
      : null,
    audit: (extra?.audit ?? []).map((a: any) => ({
      id: a.id ?? null,
      action: a.action ?? null,
      description: a.description ?? null,
      createdAt: a.created_at ?? a.createdAt ?? null,
    })),
    createdAt: row.created_at ?? row.createdAt ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS: @McpController classes
//    Guards, tool decorators, service calls and the toolJson /
//    toolPage return helpers. No mapping or schema code here.
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpPurchasesTools {
  constructor(
    private purchases: PurchasesService,
    private returns: PurchaseReturnsService,
  ) {}

  @McpReadTool({
    name: TOOL.purchases.search,
    description:
      "Search purchase invoices or fetch one. Without `id`: paged summaries filtered by supplier, status, dates, closing, or search text. With `id`: returns that invoice with lines, supplier, safe, status, accept preview, and short audit. Read-only.",
    parameters: searchPurchasesInput,
  })
  async searchPurchases(
    @Payload() input: z.infer<typeof searchPurchasesInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "purchase invoice");
    if (req.mode === "get") {
      const [inv, preview, audit] = await Promise.all([
        this.purchases.get(user, req.id),
        this.purchases.acceptPreview(user, req.id).catch(() => null),
        this.purchases.getAuditLogs(user, req.id).catch(() => []),
      ]);
      const rows = Array.isArray(audit) ? audit.slice(0, 5) : [];
      return toolJson(toPurchaseResultDto(inv, { preview, audit: rows }));
    }
    const dates = resolveToolDates(req.query);
    const result = await this.purchases.list(user, {
      ...req.query,
      startDate: dates.startDate,
      endDate: dates.endDate,
    });
    return toolPage("purchases", result, toPurchaseSummary, req.query.limit);
  }

  @McpSaveTool({
    name: TOOL.purchases.save,
    description:
      'Create or update a purchase invoice. Required: mode ("create" or "update"). Required for create: receiptNumber, safeId, items (variantId, quantity, purchaseCost). Optional: supplierId, paidAmount, notes, saveAsDraft. For update: `id` plus any fields to change (safeId required by the service). Status is never changed through save — use purchases_act. No receipt files.',
    parameters: savePurchaseInput,
  })
  async savePurchase(
    @Payload() input: z.infer<typeof savePurchaseInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "purchase invoice", TOOL.purchases.search);
    if (req.mode === "create") {
      const parsed = await parseDto(CreatePurchaseDto, req.fields);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      return toolJson(toPurchaseResultDto(await this.purchases.create(user, parsed.dto)));
    }
    const parsed = await parseDto(UpdatePurchaseDto, req.fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(toPurchaseResultDto(await this.purchases.update(user, req.id, parsed.dto)));
  }

  @McpReadTool({
    name: TOOL.purchases.stats,
    description:
      "Purchase stats. Pass `report`: invoices (default — accepted/pending/rejected invoice counts) or returns (return counts + total return value). Read-only.",
    parameters: purchasesStatsInput,
  })
  async getPurchasesStats(
    @Payload() input: z.infer<typeof purchasesStatsInput>,
    @McpUser() user: User,
  ) {
    const report = (input as any)?.report ?? "invoices";
    if (report === "returns") {
      return toolJson({ report, ...(await this.returns.stats(user)) });
    }
    return toolJson({ report, ...(await this.purchases.stats(user)) });
  }

  @McpSaveTool({
    name: TOOL.purchases.act,
    description:
      "Change status or paid amount on a purchase invoice or return. Required: kind (invoice or return), id, action. action=set_status needs status. action=set_paid needs paidAmount. Never use save for status. Closed documents are rejected by the service.",
    parameters: purchasesActInput,
  })
  async actOnPurchase(
    @Payload() input: z.infer<typeof purchasesActInput>,
    @McpUser() user: User,
  ) {
    const svc = input.kind === "return" ? this.returns : this.purchases;
    if (input.action === "set_status") {
      if (!isSet(input.status)) {
        throw new RpcException("action=set_status requires `status`.");
      }
      const updated = await (svc as any).updateStatus(user, input.id, input.status);
      return toolJson(toPurchaseResultDto(updated));
    }
    if (!isSetNum(input.paidAmount)) {
      throw new RpcException("action=set_paid requires `paidAmount`.");
    }
    const updated = await (svc as any).updatePaidAmount(user, input.id, { paidAmount: Number(input.paidAmount) });
    return toolJson(toPurchaseResultDto(updated));
  }
}

@McpController()
@UseGuards(McpScopeGuard)
export class McpPurchaseReturnsTools {
  constructor(private returns: PurchaseReturnsService) {}

  @McpReadTool({
    name: TOOL.purchaseReturns.search,
    description:
      "Search purchase returns or fetch one. Without `id`: paged summaries filtered by supplier, status, dates, closing, or search text. With `id`: returns that return with lines, supplier, safe, status, accept preview, and short audit. Read-only.",
    parameters: searchPurchaseReturnsInput,
  })
  async searchPurchaseReturns(
    @Payload() input: z.infer<typeof searchPurchaseReturnsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "purchase return");
    if (req.mode === "get") {
      const [inv, preview, audit] = await Promise.all([
        this.returns.get(user, req.id),
        this.returns.acceptPreview(user, req.id).catch(() => null),
        this.returns.getAuditLogs(user, req.id).catch(() => []),
      ]);
      const rows = Array.isArray(audit) ? audit.slice(0, 5) : [];
      return toolJson(toReturnResultDto(inv, { preview, audit: rows }));
    }
    const dates = resolveToolDates(req.query);
    const result = await this.returns.list(user, {
      ...req.query,
      startDate: dates.startDate,
      endDate: dates.endDate,
    });
    return toolPage("purchase_returns", result, toReturnSummary, req.query.limit);
  }

  @McpSaveTool({
    name: TOOL.purchaseReturns.save,
    description:
      'Create or update a purchase return. Required: mode ("create" or "update"). Required for create: returnNumber, safeId, items (variantId, returnedQuantity, unitCost). Optional: supplierId, invoiceNumber, returnReason, returnType, paidAmount, notes. For update: `id` plus fields. Status is never changed through save — use purchases_act. No receipt files.',
    parameters: savePurchaseReturnInput,
  })
  async savePurchaseReturn(
    @Payload() input: z.infer<typeof savePurchaseReturnInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "purchase return", TOOL.purchaseReturns.search);
    if (req.mode === "create") {
      const parsed = await parseDto(CreatePurchaseReturnDto, req.fields);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      return toolJson(toReturnResultDto(await this.returns.create(user, parsed.dto)));
    }
    const parsed = await parseDto(UpdatePurchaseReturnDto, req.fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(toReturnResultDto(await this.returns.update(user, req.id, parsed.dto)));
  }
}

function isSet(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

function isSetNum(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}
