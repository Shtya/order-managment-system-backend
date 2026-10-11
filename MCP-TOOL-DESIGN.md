# MCP Tool Design Rules (Madar)

These rules decide **how many tools we expose and what each one does**.
Read this file before adding, renaming, or merging any MCP tool.

## Why

- The customer connects one AI (ChatGPT / Claude) and expects it to do everything. We do **not** ask them to pick modules or scopes.
- Models pick the wrong tool as the tool count grows. Community measurements put the trouble zone at roughly 30–50 tools. **Hard budget: 50 tools total. maximam Target: about 50.**
- Fewer tools means a shorter tool list in context and less confusion between near-identical tools.

## The three rules

1. **`search` replaces `list` + `get`.** One read tool per entity, with an optional `id`.
2. **`save` replaces `create` + `update`.** One write tool per entity, with an explicit `mode`.
3. **One tool for statistics.** One `dashboard_orders_stats` tool with a `report` parameter replaces the four stats tools.

**Count rule:** a change may reduce the tool count or keep it equal. Never add a new tool when a parameter on an existing tool would do. Update the registry table at the bottom of this file in the same PR.

---

## Rule 1: `search` replaces `list` + `get`

### Contract

| Call | Behaviour |
|---|---|
| `id` omitted | Paged list of summary rows. All existing filters keep working (`search`, `categoryId`, `storeId`, paging, sorting). |
| `id` provided | Returns that single record with full details. |

- If `id` is sent together with filters (`search`, `categoryId`, `storeId`, ...), return an **actionable error**: "Pass either `id` or filters, not both. Remove `id` to search, or remove the filters to fetch one."
- Do **not** count paging fields (`limit`, `page`, `sortBy`, `sortOrder`) as conflicts. `listPaging` fills defaults, so they are always present.
- Keep the input a **plain `z.object`**. No `.refine()`, no discriminated unions. Some SDK versions and clients drop or reject non-object root schemas.
- Read-only annotation (`readOnlyHint: true`) so clients never ask for confirmation.
- The description must explain both modes in one paragraph.

### Example: bundles

Before (2 tools): `list_bundles`, `get_bundle`. After (1 tool): `bundles_search`.

```ts
// constants
bundles: { search: "bundles_search", save: "bundles_save" },
```

```ts
export const searchBundlesInput = z.object({
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Bundle ID. Pass it to get ONE bundle with full details. Omit it to search and list bundles.",
    ),
  ...listPaging({
    items: "bundles",
    sortBy: ["created_at", "name", "sku", "price", "isActive"],
    search: "Matches bundle name or SKU",
  }),
  categoryId: z
    .string()
    .optional()
    .describe(idDescription("Keep only bundles of this category.", TOOL.categories.list)),
  storeId: z
    .string()
    .optional()
    .describe(idDescription("Keep only bundles of this store.", TOOL.stores.list)),
});
```

```ts
@McpController()
@UseGuards(McpScopeGuard)
export class McpBundlesTools {
  constructor(private bundles: BundlesService) {}

  @McpReadTool({
    name: TOOL.bundles.search,
    description:
      `Search bundles or fetch one. Without \`id\`: lists bundles with paging, 
      filtered by search text, category, or store. With \`id\`: returns that single 
      bundle with full details.`,
    parameters: searchBundlesInput,
  })
  async searchBundles(@Payload() input: z.infer<typeof searchBundlesInput>, @McpUser() user: User) {
    const req = parseSearchInput(input, "bundle");
  
    if (req.mode === "get") {
      return toolJson(toBundleResultDto(await this.bundles.get(user, req.id)));
    }
    const result = await this.bundles.list(user, req.query);
    return toolPage("bundles", result, toBundleSummary, req.query.limit);
  }
}
```

**Search mode**: `{ "limit": 2 }`

```json
{
  "total_records": 11, "current_page": 1, "per_page": 2,
  "bundles": [
    { "id": "6c0ea82a-…", "name": "Howard Rivera", "sku": "SKU-NEW-BUNDLE2", "price": "685.00",
      "items": [{ "variantId": "a6109b41-…", "quantity": 2 }] },
    { "id": "33cee04d-…", "name": "Ferris Velez13", "sku": "SKU-456SFFS", "price": "350.00",
      "items": [{ "variantId": "a6109b41-…", "quantity": 3 }] }
  ]
}
```

**Detail mode**: `{ "id": "33cee04d-6bb1-489b-881a-634a2a651413" }`

```json
{
  "id": "33cee04d-…", "name": "Ferris Velez13", "sku": "SKU-456SFFS",
  "slug": "ferris-velez13", "price": "350.00", "isActive": true,
  "category": { "id": "ffb86d6a-…", "name": "…" },
  "store": null,
  "items": [
    { "variantId": "a6109b41-…", "sku": "SKU-9KE79PHW-T6ECV", "productName": null, "quantity": 3 }
  ]
}
```

### Apply the same rule to

`clients`, `products`, `bundles`, `orders` (each currently has `list`/`search` + `get`).
Entities with **no** `get` (cities, tags, categories, order statuses, cancel causes, employees, stores, shipping companies) keep a single `*_list` tool. Do not rename them.

---

## Rule 2: `save` replaces `create` + `update`

### Contract

- One write tool per entity: `<entity>_save`.
- `mode` is **required**: `"create"` or `"update"`. Never infer it from the presence of `id`. A forgotten `id` must not silently create a duplicate.
- `mode: "create"`: `id` is forbidden; the fields the old create tool required are enforced at **runtime**.
- `mode: "update"`: `id` is required; only the fields that are sent change (partial update).
- Flat object schema. Every field is optional in the schema. The description lists "Required for create: ..." and "For update: `id` plus any fields to change."
- Validate with the existing class-validator DTOs: `CreateXDto` for create, `UpdateXDto` (`PartialType` of create) for update. Do not duplicate validation in Zod.
- Errors must say what to do next: "mode=update requires `id`. Use `bundles_search` to find it."
- Annotations: write, not destructive, `idempotentHint: false` (create is not idempotent). Deletes are **not** part of `save`.
- if props is update or create only mention that 

### Example: orders

Before (2 tools): `create_order`, `update_order`. After (1 tool): `orders_save`.

```jsonc
// create
{
  "mode": "create",
  "customerName": "…", "phoneNumber": "…", "address": "…",
  "paymentMethod": "cod",
  "items": [{ "variantId": "…", "quantity": 2, "unitPrice": 120 }]
}

// update (only what changes)
{ "mode": "update", "id": "<order id>", "trackingNumber": "…", "shippingCompanyId": "…" }
```

- Required for create: `customerName`, `phoneNumber`, `address`, `paymentMethod`, `items`.
- Update-only fields stay optional: `trackingNumber`, `removedItems`, `items[].addQuantity`.
- Orders are billed per order on some plans, so the explicit `mode` is mandatory here.
- Changing an order's status is **not** done through `save`. Use a dedicated `orders_set_status` tool.

### Example: bundles

```jsonc
// create (fields illustrative; match the real DTO)
{ "mode": "create", "name": "Summer pack", "sku": "SKU-SUMMER-1", "price": 350,
  "items": [{ "variantId": "a6109b41-…", "quantity": 3 }] }

// update
{ "mode": "update", "id": "33cee04d-…", "price": 320, "isActive": false }
```

---

## Rule 3: one tool for statistics

Replace `get_advanced_stats`, `get_weekly_trend`, `get_top_cities_stats`, `get_top_products_stats` with **one** read-only tool: `dashboard_orders_stats`.

```ts
// constants
dashboard: { stats: "dashboard_orders_stats" },
```

### Contract

| `report` | Replaces | Notes |
|---|---|---|
| `summary` | `get_advanced_stats` | KPIs, status breakdown, comparison with the previous range. Default if `report` is omitted. |
| `weekly_trend` | `get_weekly_trend` | Created vs delivered per day, **always the last 7 days**. Reject `range`, `startDate`, `endDate` with an actionable error. |
| `top_cities` | `get_top_cities_stats` | Top cities by delivered orders. Accepts `limit`. |
| `top_products` | `get_top_products_stats` | Top products by delivered orders. Accepts `limit`. |

Shared filters (all optional): `storeId`, `cityId`, `shippingCompanyId`, `productIds`, `assignedUserId`.
Date filters (not for `weekly_trend`): `range` (`today`, `yesterday`, `this_week`, `last_week`, `this_month`, `last_month`, `this_year`) **or** `startDate` + `endDate`.
`limit` is only valid for `top_cities` and `top_products`.

Flat `z.object`, a plain `report` enum, and runtime checks for the combinations above. No discriminated union.

### Examples

```jsonc
{ "report": "summary", "range": "this_month" }
{ "report": "weekly_trend", "storeId": "…" }
{ "report": "top_cities", "range": "this_year", "limit": 5 }
{ "report": "top_products", "startDate": "2026-01-01", "endDate": "2026-09-30", "limit": 10 }
```

Real `summary` result for `this_month` (shape reference):

```json
{
  "stats": { "totalOrders": 9, "correctedOrders": 7, "confirmedCount": 6, "totalSales": 103860,
             "deliveredSales": 0, "collectedAmount": 0 },
  "statusBreakdown": [ { "code": "confirmed", "name": "Confirmed", "count": 6 } ],
  "comparison": { "totalOrders": 184, "totalSales": 1338241.29 }
}
```

---

## Naming

- Format: `<module>_<verb>`, noun first, snake_case. Examples: `bundles_search`, `orders_save`, `dashboard_orders_stats`.
- Prefixes help the model choose when many tools exist.
- Exceptions kept as-is: `get_me`.
- Descriptions that mention other tools must use the `TOOL` constants (as `idDescription` does), never hard-coded names. Search the repo for hard-coded old names, for example "Use the price returned by list_products".

## Registry (keep this table current)

| Area | Before | After |
|---|---|---|
| Clients | `search_clients`, `get_client` | `clients_search` |
| Products | `list_products`, `get_product` | `products_search` |
| Bundles | `list_bundles`, `get_bundle` | `bundles_search` |
| Orders | `list_orders`, `get_order`, `create_order`, `update_order` | `orders_search`, `orders_save` |
| Dashboard | 4 stats tools | `dashboard_orders_stats` |
| Cities | `list_cities`, `list_areas` | unchanged, or optionally one `cities_list` (pass `cityId` to get its areas) |
| Reference lists | `list_shipping_companies`, `list_stores`, `list_categories`, `list_order_statuses`, `list_tags`, `list_employees`, `list_cancel_causes` | unchanged (a rename to `*_list` is optional) |
| Account | `get_me` | unchanged |

Current tools: 16 (cities still two tools), before adding new modules. Hard budget: 50.

## Checklist for any new tool

1. Does a parameter on an existing tool cover it? If yes, add the parameter.
2. Read or write? Set the matching annotations.
3. Is the schema a flat `z.object`?
4. Does the description say when to use it and when not to?
5. Are error messages actionable (what to call or change next)?
6. Is the registry table above updated, and the total still at or under budget?
