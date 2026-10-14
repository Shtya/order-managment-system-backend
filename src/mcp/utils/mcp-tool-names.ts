import { Injectable, OnApplicationBootstrap } from "@nestjs/common";

/**
 * 1) ONE place for every tool name. `as const` gives string-literal types, so a
 *    typo like TOOL.serachClients is a compile error, and renaming a tool here
 *    renames it everywhere it is used.
 *
 *    Use it in the tool decorator:   @McpReadTool({ name: TOOL.clients.search, ... })
 *    and in descriptions:            idDescription("...", TOOL.clients.search)
 */
export const TOOL = {
  clients: {
    search: "clients_search",
    stats: "clients_stats",
    save: "clients_save",
    addressSave: "clients_address_save",
  },
  cities: {
    list: "list_cities",
    areas: "list_areas",
  },
  shippingCompanies: {
    list: "list_shipping_companies",
    geo: "shipping_geo",
  },
  stores: {
    list: "list_stores",
    failedOrdersSearch: "store_failed_orders_search",
    failedOrdersStats: "store_failed_orders_stats",
  },
  products: {
    search: "products_search",
    save: "products_save",
    stats: "products_stats",
  },
  bundles: {
    search: "bundles_search",
    save: "bundles_save",
  },
  categories: {
    list: "list_categories",
    save: "categories_save",
  },
  orderStatuses: {
    list: "list_order_statuses",
  },
  tags: {
    list: "list_tags",
    save: "tags_save",
  },
  tagAutomations: {
    search: "tag_automations_search",
    save: "tag_automations_save",
  },
  employees: {
    list: "list_employees",
  },
  users: {
    me: "get_me",
  },
  cancelCauses: {
    list: "list_cancel_causes",
    save: "cancel_causes_save",
    accept: "cancel_causes_accept",
    stats: "cancel_causes_stats",
  },
  orders: {
    search: "orders_search",
    save: "orders_save",
    act: "orders_act",
    stats: "orders_stats",
    internalNotesSearch: "order_internal_notes_search",
    internalNotesSave: "order_internal_notes_save",
    tagsSave: "order_tags_save",
    replacementsSearch: "order_replacements_search",
    replacementsSave: "order_replacements_save",
    returnsSave: "order_returns_save",
  },
  dashboard: {
    stats: "dashboard_orders_stats",
    aiStats: "dashboard_ai_stats",
  },
  accounting: {
    stats: "accounting_stats",
    expensesSearch: "accounting_expenses_search",
    expenseCategoriesList: "accounting_expense_categories_list",
    monthlyClosingsSearch: "accounting_monthly_closings_search",
    supplierClosingsSearch: "accounting_supplier_closings_search",
    supplierPaymentsSearch: "accounting_supplier_payments_search",
  },
  purchases: {
    search: "purchases_search",
    save: "purchases_save",
    stats: "purchases_stats",
    act: "purchases_act",
  },
  purchaseReturns: {
    search: "purchase_returns_search",
    save: "purchase_returns_save",
  },
  clientSegments: {
    search: "client_segments_search",
    stats: "client_segments_stats",
    save: "client_segments_save",
    preview: "client_segments_preview",
    act: "client_segments_act",
  },
  clientSettings: {
    get: "client_settings_get",
    save: "client_settings_save",
  },
  campaigns: {
    search: "campaigns_search",
    stats: "campaigns_stats",
  },
  upsells: {
    search: "upsells_search",
    stats: "upsells_stats",
    update: "upsells_update",
  },
  issues: {
    search: "issues_search",
    save: "issues_save",
    stats: "issues_stats",
    act: "issues_act",
    lookupsList: "issues_lookups_list",
  },
  orderCollections: {
    list: "order_collections_list",
    stats: "order_collections_stats",
  },
  gettingStarted: {
    stats: "getting_started_stats",
  },
  shippingAssigning: {
    search: "shipping_assigning_rules_search",
    stats: "shipping_assigning_stats",
  },
  roles: {
    list: "roles_list",
  },
  safes: {
    list: "safes_list",
  },
  supplierCategories: {
    search: "supplier_categories_search",
    save: "supplier_categories_save",
  },
  suppliers: {
    search: "suppliers_search",
    save: "suppliers_save",
  },
  warehouses: {
    search: "warehouses_search",
    save: "warehouses_save",
    locationsSearch: "warehouse_locations_search",
    locationsSave: "warehouse_locations_save",
  },
  automation: {
    stats: "automation_stats",
    search: "automations_search",
    runsSearch: "automation_runs_search",
    runsRetry: "automation_runs_retry",
    stepsList: "automation_steps_list",
  },
  whatsapp: {
    stats: "whatsapp_stats",
    accountsSearch: "whatsapp_accounts_search",
    templatesSearch: "whatsapp_templates_search",
  },
  warehouseOps: {
    stats: "warehouse_ops_stats",
    act: "warehouse_ops_act",
    manifestsSearch: "warehouse_manifests_search",
  },
} as const;

type LeafStrings<T> = T extends string ? T : { [K in keyof T]: LeafStrings<T[K]> }[keyof T];

export type ToolName = LeafStrings<typeof TOOL>;

const referenced = new Set<string>(); // names mentioned inside descriptions
const registered = new Set<string>(); // names of tools that really exist

/**
 * 2) Call this inside YOUR tool decorators (McpReadTool, McpCreateTool, ...)
 *    with the `name` they receive, before passing it on to the library's @Tool.
 *    This is what "the tool really exists" is checked against.
 */
export function registerToolName(name: string): void {
  registered.add(name);
}

/** Use for a tool name inside free text: `Get the id from ${ref(TOOL.orders.search)}.` */
export function ref(tool: ToolName): ToolName {
  referenced.add(tool);
  return tool;
}

/** Standard description for an id field that must come from a lookup tool. */
export function idDescription(what: string, lookup: ToolName, extra = ""): string {
  return `${what} Find it with ${ref(lookup)}.${extra ? ` ${extra}` : ""} Never guess an id.`;
}

/**
 * `list_shipping_companies` rows are integrations: `providerId` is the shipping
 * company id (`shippingCompanyId` on orders/manifests/filters). `id` /
 * `integrationId` is the workspace connection. Never pass the integration id
 * as shippingCompanyId.
 */
export function shippingCompanyIdDescription(what = "Shipping company id.", extra = ""): string {
  const fromProvider =
    "Use `providerId` from the row, never `id` or `integrationId` (`id` is the workspace integration).";
  return idDescription(what, TOOL.shippingCompanies.list, extra ? `${fromProvider} ${extra}` : fromProvider);
}

/**
 * 3) Startup check: every tool named in a description must be registered.
 *    Fails the boot with a clear message instead of letting the model call a
 *    tool that does not exist.
 */
export function assertReferencedToolsExist(): void {
  const missing = [...referenced].filter((name) => !registered.has(name));
  if (missing.length > 0) {
    throw new Error(
      `MCP descriptions mention tools that are not registered: ${missing.join(", ")}. ` +
        `Create them or remove the reference.`,
    );
  }
}

/** Add to MadarMcpModule `providers`. */
@Injectable()
export class McpToolRefsCheck implements OnApplicationBootstrap {
  onApplicationBootstrap() {
    assertReferencedToolsExist();
  }
}
