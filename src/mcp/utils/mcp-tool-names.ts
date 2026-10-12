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
  },
  cities: {
    list: "list_cities",
    areas: "list_areas",
  },
  shippingCompanies: {
    list: "list_shipping_companies",
  },
  stores: {
    list: "list_stores",
  },
  products: {
    search: "products_search",
    save: "products_save",
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
  employees: {
    list: "list_employees",
  },
  users: {
    me: "get_me",
  },
  cancelCauses: {
    list: "list_cancel_causes",
  },
  orders: {
    search: "orders_search",
    save: "orders_save",
  },
  dashboard: {
    stats: "dashboard_orders_stats",
  },
  accounting: {
    stats: "accounting_stats",
    expensesSearch: "accounting_expenses_search",
    expenseCategoriesList: "accounting_expense_categories_list",
    monthlyClosingsSearch: "accounting_monthly_closings_search",
    supplierClosingsSearch: "accounting_supplier_closings_search",
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
