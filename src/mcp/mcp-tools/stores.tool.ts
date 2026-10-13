import { UseGuards } from "@nestjs/common";
import { Payload } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { StoresService } from "src/stores/stores.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import {
  OrderFailStatus,
  StoreEntity,
  StoreProvider,
  SyncStatus,
} from "entities/stores.entity";
import { listPaging, parseSearchInput, resolveToolDates, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, ref, TOOL } from "../utils/mcp-tool-names";
import { isoDateField, uuidField } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

const listStoresInput = z.strictObject({
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
});

const searchFailedOrdersInput = searchInput("failed store order", {
  ...listPaging({
    items: "failed store orders",
    sortBy: ["createdAt"],
    search: "Matches customer name, phone, or the external store order id",
  }),
  storeId: uuidField(idDescription("Keep only failures from this Madar store.", TOOL.stores.list)).optional(),
  provider: z
    .enum(StoreProvider)
    .optional()
    .describe("Store platform of the source order: easyorder, shopify, or woocommerce"),
  status: z
    .enum(OrderFailStatus)
    .optional()
    .describe("Failure queue status: pending (waiting for a fix), retrying, success, or failed"),
  startDate: isoDateField("Created-at range start, ISO date (YYYY-MM-DD)").optional(),
  endDate: isoDateField("Created-at range end, ISO date (YYYY-MM-DD)").optional(),
}, TOOL.stores.failedOrdersSearch);

const failedOrdersStatsInput = z.strictObject({});

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

function toFailedCartItem(item: any) {
  const variant = item?.variant;
  return {
    name: item?.name ?? null,
    productSlug: item?.productSlug ?? null,
    quantity: item?.quantity ?? null,
    remoteProductId: item?.remoteProductId ?? null,
    price: item?.price ?? null,
    sku: variant?.sku ?? null,
    variantKey: variant?.key ?? null,
    localProductId: variant?.localProductId ?? null,
    matchedBySku: variant?.matchedBySku ?? null,
  };
}

function toFailedOrderSummary(row: any) {
  const cartItems = Array.isArray(row?.cartItems)
    ? row.cartItems
    : Array.isArray(row?.payload?.cartItems)
      ? row.payload.cartItems
      : [];
  return {
    id: row?.id ?? null,
    status: row?.status ?? null,
    externalOrderId: row?.externalOrderId ?? null,
    customerName: row?.customerName ?? null,
    phoneNumber: row?.phoneNumber ?? null,
    storeId: row?.storeId ?? row?.store?.id ?? null,
    storeName: row?.store?.name ?? null,
    provider: row?.store?.provider ?? null,
    reason: row?.reason ?? null,
    attempts: row?.attempts ?? 0,
    createdAt: row?.created_at ?? row?.createdAt ?? null,
    cartItems: cartItems.map(toFailedCartItem),
  };
}

function toFailedOrderDto(detail: any) {
  const fail = detail?.failureLog ?? detail;
  const payload = fail?.payload ?? {};
  const problems = Array.isArray(detail?.problems) ? detail.problems : [];
  const cartItems = Array.isArray(detail?.cartItems)
    ? detail.cartItems
    : Array.isArray(payload.cartItems)
      ? payload.cartItems
      : [];
  return {
    ...toFailedOrderSummary(fail),
    lastRetryFailedReason: fail?.lastRetryFailedReason ?? null,
    customer: {
      name: fail?.customerName ?? payload.fullName ?? null,
      phoneNumber: fail?.phoneNumber ?? payload.phone ?? null,
      email: payload.email ?? null,
      address: payload.address ?? null,
      government: payload.government ?? null,
    },
    payment: {
      method: payload.paymentMethod ?? null,
      status: payload.paymentStatus ?? null,
      shippingCost: payload.shippingCost ?? null,
      totalCost: payload.totalCost ?? null,
    },
    problems: problems.map((p: any) => ({
      code: p?.code ?? null,
      problem: p?.problem ?? null,
      details: p?.details ?? null,
      name: p?.name ?? null,
      sku: p?.sku ?? null,
      productId: p?.productId ?? null,
      remoteId: p?.remoteId ?? null,
      key: p?.key ?? null,
      slug: p?.slug ?? null,
    })),
    cartItems: cartItems.map(toFailedCartItem),
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

  @McpReadTool({
    name: TOOL.stores.failedOrdersSearch,
    description:
      `Search pending/failed inbound store orders (الطلبات المعلقة) or fetch one. These are EasyOrder, Shopify, or WooCommerce orders that did not become Madar orders because of missing product, missing variant/SKU, inactive SKU, or insufficient stock — they stay pending until the catalog/stock is fixed. Not ${ref(TOOL.orders.search)}. Without \`id\`: paged summaries (search text, store, provider, status, dates). With \`id\`: diagnostics (problems + cart lines). Read-only. No retry or payload edit.`,
    parameters: searchFailedOrdersInput,
  })
  async searchFailedOrders(
    @Payload() input: z.infer<typeof searchFailedOrdersInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "failed store order");
    if (req.mode === "get") {
      return toolJson(toFailedOrderDto(await this.stores.getFailedOrderDetail(user, req.id)));
    }
    const dates = resolveToolDates(req.query);
    const result = await this.stores.listFailedOrders(user, {
      ...req.query,
      startDate: dates.startDate,
      endDate: dates.endDate,
      sortDir: (req.query as any).sortOrder,
    });
    return toolPage("failedOrders", result, toFailedOrderSummary, req.query.limit);
  }

  @McpReadTool({
    name: TOOL.stores.failedOrdersStats,
    description:
      `Counts of inbound store orders that failed to import (pending queue / الطلبات المعلقة): pending, retrying, success, failed, total. Same domain as ${ref(TOOL.stores.failedOrdersSearch)}. Read-only.`,
    parameters: failedOrdersStatsInput,
  })
  async getFailedOrdersStats(@McpUser() user: User) {
    return toolJson(await this.stores.getFailedOrdersStatistics(user));
  }
}
