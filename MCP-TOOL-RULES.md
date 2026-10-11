# MCP tool playbook

This file is the **single source of truth** for creating a new MCP tool.

Canonical example: `src/mcp/mcp-tools/orders.tool.ts`.

Copy its structure, not REST controller style. Tools talk to **existing services**. They do not duplicate business logic, TypeORM queries, or HTTP ValidationPipe.

---

## 1. Folder layout

```
src/mcp/
  mcp.module.ts                 # register every @McpController here (controllers, not providers)
  mcp-tools/
    mcp-tool-names.ts           # TOOL object, idDescription, ref, registerToolName, boot check
    orders.tool.ts              # one file per domain (clients.tool.ts, products.tool.ts, ...)
  decorators/
    mcp-tool.decorators.ts      # McpReadTool / McpCreateTool / McpUpdateTool / McpDeleteTool
    require-mcp-scope.decorator.ts
  utils/
    mcp-dto.util.ts             # toolInputFor, McpDto, parseDto
    mcp-result.util.ts          # toolJson, toolPage, toolError, toolText
  mcp-guards/
    mcp-scope-guard.ts
    mcp-user.decorator.ts       # @McpUser()
```

Rules:

- One `*.tool.ts` per domain, named after the domain (`orders.tool.ts`).
- Class name: `Mcp{Domain}Tools` (example: `McpOrdersTools`).
- Put **schemas + mappers + tools in the same file**, in that order. Do not split a domain across files unless the file becomes unmaintainable.
- Shared helpers stay in `utils/` and `mcp-tool-names.ts`. Do not copy them into a tool file.
- New tool class **must** be added to `McpModule.controllers`. Classes in `providers` are **not** discovered; `tools/list` would stay empty.
- The domain Nest module that owns the service must be imported in `McpModule` (example: `OrdersModule` so `OrdersService` injects).
- Keep `McpToolRefsCheck` in `McpModule.providers`. It fails boot if a description names a tool that was never registered.

---

## 2. Anatomy of a tool file

Every `*.tool.ts` has **three numbered sections**, in this order, with the same banner comments as `orders.tool.ts`:

1. **INPUT SCHEMAS (Zod)** — what the model sends.
2. **OUTPUT MAPPERS** — what the model receives.
3. **TOOLS** — the `@McpController` class only: guards, decorators, service calls, return helpers.

The class itself must not contain mapping functions or Zod schemas. Those live above it.

---

## 3. Tool names (`TOOL` object)

All names live in `src/mcp/mcp-tools/mcp-tool-names.ts`.

```ts
export const TOOL = {
  clients: { search: "search_clients" },
  orders:  { list: "list_orders", get: "get_order", create: "create_order" },
} as const;
```

Rules:

- Group by **domain**, then action. Never a flat `TOOL.listOrders`.
- The **string value** is the public MCP name (`snake_case`).
- Decorator `name` is always `TOOL.orders.list`, never `"list_orders"`.
- Mentioning a tool in a description is always `TOOL.clients.search` / `ref(TOOL.products.list)`, never a hardcoded `"list_products"`.
- Add the name to `TOOL` **before** you write a tool or a description that uses it.
- `McpReadTool` / `McpCreateTool` / … call `registerToolName(opts.name)` automatically. Do not call it by hand.
- At boot, every name passed through `idDescription` / `ref` must exist on a real decorated tool. If the lookup tool is not built yet, do not reference it.

Wire a new tool:

```ts
@McpReadTool({
  name: TOOL.orders.list,          // object, not a string literal
  description: "List the orders by the given filters.",
  parameters: listOrdersInput,
})
```

---

## 4. Input schemas (Zod)

Schemas are a **small, curated contract for the model**. Real validation lives on DTO classes (`class-validator`), not in Zod.

### 4.1 When to use which schema style

| Kind | Schema | Payload decorator |
| --- | --- | --- |
| **Create / update** that maps to a REST DTO | `toolInputFor<TheDto>()(z.object({ ... }))` | `@McpDto(TheDto) dto: TheDto` |
| **List / search / get** (query, not a write DTO) | Plain `z.object({ ... })` | `@Payload() query: z.infer<typeof schema>` |

### 4.2 `toolInputFor<Dto>()` (create from DTO)

Wrap the Zod object with `toolInputFor<CreateOrderDto>()(...)`.

It fails to compile when the schema:

- is missing a field that is **required** on the DTO,
- uses a **different type** for a field,
- still uses a field **renamed** on the DTO.

Optional DTO fields may be **left out on purpose**. A Zod-only field that is not on the DTO is a bug: `parseDto` / `@McpDto` uses `forbidNonWhitelisted: true` and fails at runtime.

Omit fields the agent must never send (costs, internal flags, update-only fields). Leave a short comment in the schema explaining why.

```ts
const createOrderInput = toolInputFor<CreateOrderDto>()(
  z.object({
    customerName: z.string().describe("Customer full name"),
    // unitCost not offered: internal cost/margin data
  }),
);
```

### 4.3 Field descriptions

Every Zod field has `.describe(...)`. That text is what the model sees.

- Plain fields: one short sentence (`"Customer full name"`).
- Enums: `z.enum(PaymentMethod)` / `z.enum(ShipmentStatus)` — reuse domain enums, do not re-type string unions.
- List filters should match the **service query** (`OrdersService.list(me, q)`), including pagination, sort, search, and the same filter names the service already understands.
- Spread `listPaging({ items, sortBy, defaultSortBy?, search? })` from `mcp-dto.util.ts` for every list. It adds `page`, `limit` (max 50), `sortBy` (enum of the options you pass; description lists them), `sortOrder` (`ASC` | `DESC`), and `search` (included by default). Pass `search: "Matches …"` to set the description, or `search: false` to omit it. Example: `...listPaging({ items: "stores", sortBy: ["created_at", "name"], search: "Matches store name or store URL" })`.
- `sortBy` values must be keys of the service whitelist (`sortColumns` / `SORT_WHITELIST`). Never advertise a column the query ignores, and never interpolate `alias.${q.sortBy}`. Default `sortBy` must match the service default (tags `priority`, cancel causes `sortOrder`, cities `nameEn`).
- If the service uses `sortDir` instead of `sortOrder`, map it in the handler (`sortDir: query.sortOrder`).
- Date strings: say the format, `ISO date (YYYY-MM-DD)`.
- Defaults belong on the schema (`page` default 1, `limit` default 10).

### 4.4 IDs — `idDescription`, never handwritten lookup text

Any field whose value is an **id the model must look up** uses `idDescription`, not a manual `"Find it with list_cities. Never guess an id."`.

```ts
idDescription(what: string, lookup: ToolName, extra?: string)
// -> `${what} Find it with ${lookup}. ${extra} Never guess an id.`
```

```ts
clientId: z.string().optional().describe(
  idDescription(
    "Id of an existing client record. Omit if the customer is not registered.",
    TOOL.clients.search,
  ),
),

storeId: z.string().optional().describe(
  idDescription(
    "Store id.",
    TOOL.stores.list,
    'Pass "none" for orders with no store, "all" to skip.',
  ),
),
```

Rules:

- First argument: what the id is (and omit/skip rules that belong with the field).
- Second argument: `TOOL.{domain}.{action}` — this also **registers the reference** for the boot check.
- Third argument: extra filter conventions (`Pass "all" to skip`, `Omit when \`status\` is set.`).
- Never write a tool name as a string inside `.describe()`.
- If a **non-id** field mentions a tool in prose (prices, “use the result of …”), wrap the name with `ref(...)`:

```ts
.describe(
  `Unit price, up to 2 decimals. Use the price returned by ${ref(TOOL.products.list)} unless the user explicitly gives a different one.`,
)
```

- Never guess an id. The helper always appends that sentence.
- A get-by-id field that is **this domain’s own id** (already known from `list_*`) does not need `idDescription` unless you want the model to call list first. `get_order` uses a plain `"ID of the order to retrieve."` because list already returned ids.

---

## 5. Output mappers

Never return a raw TypeORM entity, nested admin objects, passwords, costs, profits, unread-count maps, or other internals.

Two mapper styles, both in section 2 of the file:

| Use | Function | Used by |
| --- | --- | --- |
| **Summary** | slim: ids, status name, a few display fields, counts | **list** via `toolPage` |
| **Detail** | nested, ids + related names, items, tags, shipping, replacements | **get** and **create** via `toolJson` |

Example from orders:

- `toOrderSummary` — list rows (`id`, `orderNumber`, status name, customer, totals, `itemsCount`, dates).
- `toOrderResultDto` — one order after get/create (customer, address, payment, shipping, assignment, tags, items, replacements, notes). Shared helpers such as `toOrderItem` / `toReplacement` are fine.

Rules:

- List payload must stay small. Lists go through `toolPage`, which JSON-serializes every row into the model context (`DEFAULT_MAX_CHARS` = 60_000). If it is too large, the helper returns an **error** telling the model to add filters or lower `limit` — it does **not** truncate JSON.
- Detail mapper includes ids the model will need for the next call (`variantId`, `clientId`, `status.id`, tag ids).
- Exclude internal money fields (`unitCost`, `profit`, `lineProfit`) unless a later product decision says otherwise.
- Missing relations → `null` or `[]`, not thrown errors.
- Service list rows are often **plain objects** (`{ ...order, automationRunCount }`), not class instances. Type mappers as `Partial<Entity> & { extraCounts?: number }`, not as the entity class (entity methods like `setNormalizedPhone` will not exist).

### Return helpers (`mcp-result.util.ts`)

```ts
return toolPage("orders", result, toOrderSummary, query.limit);
// { total_records, current_page, per_page, orders: [...] }

return toolJson(toOrderResultDto(created));
// one object

return toolError("..."); // only if you handle errors yourself; prefer @McpDto / RpcException
```

- `toolPage` first argument is the **JSON key** for the array (`"orders"`, `"clients"`, …).
- `toolJson` / `toolPage` always produce `{ content: [{ type: "text", text: "<json>" }] }`. Do not return a raw object from the handler.

---

## 6. The tool class (decorators and payload)

```ts
@McpController()
@UseGuards(McpScopeGuard)
export class McpOrdersTools {
  constructor(private orders: OrdersService) {}

  @McpReadTool({ name: TOOL.orders.list, description: "...", parameters: listOrdersInput })
  async listOrders(
    @Payload() query: z.infer<typeof listOrdersInput>,
    @McpUser() user: User,
  ) {
    const result = await this.orders.list(user, query);
    return toolPage("orders", result, toOrderSummary, query.limit);
  }

  @McpCreateTool({ name: TOOL.orders.create, description: "...", parameters: createOrderInput })
  async createOrder(
    @McpDto(CreateOrderDto) dto: CreateOrderDto,
    @McpUser() user: User,
  ) {
    const created = await this.orders.create(user, dto);
    return toolJson(toOrderResultDto(created));
  }

  @McpReadTool({ name: TOOL.orders.get, description: "...", parameters: getOrderInput })
  async getOrder(
    @Payload() input: z.infer<typeof getOrderInput>,
    @McpUser() user: User,
  ) {
    const result = await this.orders.get(user, input.id);
    return toolJson(toOrderResultDto(result));
  }
}
```

### Decorators (kind + OAuth scope are bound)

| Decorator | When | OAuth scope | Annotations |
| --- | --- | --- | --- |
| `@McpReadTool` | list, get, search | `read` | `readOnlyHint: true` |
| `@McpCreateTool` | create | `write` | not read-only, not destructive |
| `@McpUpdateTool` | update | `write` | destructive + idempotent |
| `@McpDeleteTool` | delete | `write` | destructive + idempotent |

Do not use `@Tool` from `@rekog/mcp-nest` directly. Always use these wrappers so scope, annotations, and `registerToolName` stay in sync.

Always:

- Class: `@McpController()` + `@UseGuards(McpScopeGuard)`.
- Inject the **existing domain service**. Do not new-up repositories in the tool.
- Every handler takes `@McpUser() user: User` (or `@McpUser("id")`) and passes `user` into the service as `me`. Auth is already on the request; the decorator throws if the guard was skipped.
- **Read/list/get:** `@Payload()` + `z.infer<typeof schema>`.
- **Create/update with a DTO:** `@McpDto(TheDto) dto: TheDto` — **not** `@Payload()` plus a manual `parseDto` in the handler. The parameter type is written by hand; it must match the class passed to `@McpDto`.
- `@McpDto` runs the same `class-validator` rules as REST (`whitelist`, `forbidNonWhitelisted`). Failures surface as `Invalid input. items.0.quantity: min` (constraint **names**, not i18n keys).
- If you ever parse by hand, use `parsed.ok === false` (not `!parsed.ok`) because `strictNullChecks` is off and the union will not narrow.
- Handler body: call service → map → `toolJson` / `toolPage`. No extra branching unless the service cannot express it.

### List vs get vs create (orders pattern)

- **list** — pass the Zod query object straight into `service.list(user, query)`. Map with **summary**. Return `toolPage`.
- **get** — take `id` from payload, `service.get(user, id)`, map with **detail**, `toolJson`.
- **create** — `@McpDto`, `service.create(user, dto)`, map with **detail**, `toolJson`.

---

## 7. Checklist for a new tool

1. Add names under the right group in `TOOL` (`mcp-tool-names.ts`).
2. Create or extend `src/mcp/mcp-tools/{domain}.tool.ts` with the three sections.
3. Zod input:
   - Write DTO → `toolInputFor<Dto>()(z.object(...))`.
   - List/get → plain `z.object`.
   - Every field `.describe(...)`.
   - Every foreign id → `idDescription(..., TOOL.x.y, extra?)`.
   - Tool names in other prose → `ref(TOOL.x.y)`.
4. Mappers: summary for list, detail for get/create. No raw entities. No costs/secrets.
5. Class: `@McpController` + `McpScopeGuard`; `McpReadTool` / `McpCreateTool` / … with `name: TOOL....`.
6. Payload: `@Payload()` for queries; `@McpDto(Dto)` for writes; always `@McpUser()`.
7. Return `toolPage` (list) or `toolJson` (one record).
8. Register the class on `McpModule.controllers` and import the domain module.
9. Confirm lookup tools referenced by `idDescription` / `ref` are real decorated tools (or boot will fail).

---

## 8. Do not

- Hardcode tool names in `name:` or in `.describe()`.
- Return `JSON.stringify` yourself or `{ content: [...] }` by hand.
- Put `parseDto` in the handler when `@McpDto` exists.
- Dump the full list entity into `toolPage`.
- Offer internal fields on create schemas (`unitCost`, `profit`, update-only flags).
- Reimplement service filters; expose the same query the service already applies.
- Register the tool class only as a provider.
- Use `if (!parsed.ok)` for `ParseResult` under this tsconfig.
