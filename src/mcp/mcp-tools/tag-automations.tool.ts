import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { TagAutomationsService } from "src/tags/tag-automations.service";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import {
  TagAutomationEntity,
  TagConditionField,
  TagConditionLogic,
  TagConditionOperator,
  TagTarget,
} from "entities/tag.entity";
import { OrderConfirmationSource, PaymentMethod, PaymentStatus } from "entities/order.entity";
import { ShipmentStatus } from "entities/shipping.entity";
import { CreateTagAutomationDto, UpdateTagAutomationDto } from "dto/tag.dto";
import { listPaging, parseDto, parseSaveInput, parseSearchInput, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, ref, TOOL } from "../utils/mcp-tool-names";
import { uuidField } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Small, curated contract with descriptions. The real business
//    rules live in the DTO classes (class-validator), not here.
// ═══════════════════════════════════════════════════════════════

const F = TagConditionField;
const enumList = (e: Record<string, string>) => Object.values(e).join(", ");

const UUID_FIELDS: Record<string, string> = {
  [F.ORDER_STATUS_ID]: `order status id from ${ref(TOOL.orderStatuses.list)}`,
  [F.ORDER_STORE_ID]: `store id from ${ref(TOOL.stores.list)}`,
  [F.ORDER_CITY_ID]: `city id from ${ref(TOOL.cities.list)}`,
  [F.ORDER_SHIPPING_COMPANY_ID]: `shipping company id = row.providerId from ${ref(TOOL.shippingCompanies.list)} (never integrationId)`,
};

const ENUM_FIELDS: Record<string, string> = {
  [F.ORDER_PAYMENT_STATUS]: enumList(PaymentStatus),
  [F.ORDER_PAYMENT_METHOD]: enumList(PaymentMethod),
  [F.ORDER_CONFIRMATION_SOURCE]: enumList(OrderConfirmationSource),
  [F.SHIPMENT_STATUS]: `${enumList(ShipmentStatus)} (status of the order's latest shipment)`,
};

const BOOLEAN_FIELDS: Record<string, string> = {
  [F.ORDER_IS_CONFIRMED]: "order is confirmed",
  [F.ORDER_ALLOW_OPEN_PACKAGE]: "customer may open the package",
  [F.ASSIGNMENT_HAS_ACTIVE]: "order has an active employee assignment",
  [F.UPSELL_ACCEPTED]: "latest upsell offer on the order was accepted",
  [F.ORDER_PHONE_VALID]: "phone is a valid Egyptian mobile (2010/2011/2012/2015 + 8 digits)",
};

const NUMBER_FIELDS: Record<string, string> = {
  [F.ORDER_PRODUCTS_TOTAL]: "products subtotal",
  [F.ORDER_FINAL_TOTAL]: "final order total",
  [F.ORDER_DISCOUNT]: "discount amount",
  [F.ORDER_ITEMS_QUANTITY]: "sum of item quantities",
  [F.ORDER_PRODUCTS_COUNT]: "number of order lines",
  [F.ORDER_DUPLICATE_COUNT]: "number of duplicate orders detected",
  [F.ASSIGNMENT_CONTACT_TRIES]: "total contact tries across assignments",
};

const CLIENT_FIELDS_DOC =
  "client.totalOrders, client.confirmedCount, client.shippedCount, client.deliveredCount, client.returnedCount, client.cancelledCount, client.cancelledBeforeShippingCount, client.cancelledAfterShippingCount (counts); " +
  "client.confirmedPercent, client.confirmedRate, client.shippedPercent, client.deliveredPercent, client.returnedPercent, client.cancelRate, client.beforeShippingCancelRate, client.afterShippingCancelRate, client.afterShippingCancelRateOfShipped (percentages 0-100); " +
  "client.totalSales, client.deliveredRevenue (money).";

const docLines = (fields: Record<string, string>) =>
  Object.entries(fields).map(([k, v]) => `${k} (${v})`).join("; ");

const CONDITIONS_DOC =
  `Rules are evaluated against each order whenever it is created or changed. ` +
  `UUID fields — value must be a real id, never a name: ${docLines(UUID_FIELDS)}. ` +
  `Enum fields — value must be one of: ${docLines(ENUM_FIELDS)}. ` +
  `Boolean fields — value true or false with eq/neq: ${docLines(BOOLEAN_FIELDS)}. ` +
  `Number fields — use gte/lte/eq/neq with a number: ${docLines(NUMBER_FIELDS)}. ` +
  `Client fields (ONLY for tags with target=client; forbidden for order tags): ${CLIENT_FIELDS_DOC} ` +
  `Operators: eq / neq = one scalar value; in / not_in = non-empty array of values; gte / lte = a number (inclusive); is_null / is_not_null = omit value (also matches empty).`;

const ruleSchema = z.object({
  field: z.enum(TagConditionField).describe("What to check. See conditions description for the type of each field."),
  operator: z.enum(TagConditionOperator).describe(
    "eq, neq: single value. in, not_in: array. gte, lte: number. is_null, is_not_null: no value.",
  ),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])
    .optional()
    .describe("Compared value. Omit for is_null / is_not_null. Array for in / not_in. Number for gte / lte. UUID fields need ids from their lookup tool."),
});

const conditionsSchema = z
  .object({
    logic: z.enum(TagConditionLogic).describe("AND = every rule must match. OR = at least one rule matches."),
    rules: z.array(ruleSchema).min(1).max(5).describe("1 to 5 rules."),
  })
  .describe(CONDITIONS_DOC);

const searchTagAutomationsInput = searchInput("tag automation", {
  ...listPaging({
    items: "tag automations",
    sortBy: ["created_at"],
    search: "Matches automation name or tag name",
  }),
  tagId: uuidField(idDescription("Only automations of this tag.", TOOL.tags.list)).optional(),
  isEnabled: z.boolean().optional().describe("true = only enabled, false = only disabled. Omit for both."),
  target: z.enum(TagTarget).optional().describe("Tag target of the automations. Omit for order tags."),
}, TOOL.tagAutomations.search);

const saveTagAutomationInput = z.object({
  mode: z
    .enum(["create", "update"])
    .describe('Required. "create" to add a new automation. "update" to change an existing one. Never infer from id.'),
  id: uuidField(
    idDescription("Tag automation ID.", TOOL.tagAutomations.search, "Required for mode=update. Forbidden for mode=create."),
  ).optional(),
  tagId: uuidField(
    idDescription("Tag that gets auto-assigned when the conditions match.", TOOL.tags.list, "Its target decides whether client.* fields are allowed."),
  ).optional(),
  name: z.string().min(1).max(150).optional().describe("Automation name (1-150 chars)."),
  isEnabled: z.boolean().optional().describe("False pauses the automation. Default true on create. Replaces toggle."),
  conditions: conditionsSchema.optional(),
});

type RuleInput = z.infer<typeof ruleSchema>;

function normalizeRules(rules: RuleInput[]): RuleInput[] {
  return rules.map((rule, i) => {
    const at = `conditions.rules[${i}] (${rule.field} ${rule.operator})`;
    const { value } = rule;
    switch (rule.operator) {
      case TagConditionOperator.IS_NULL:
      case TagConditionOperator.IS_NOT_NULL:
        return { field: rule.field, operator: rule.operator };
      case TagConditionOperator.IN:
      case TagConditionOperator.NOT_IN:
        if (!Array.isArray(value) || value.length === 0) {
          throw new RpcException(`${at}: value must be a non-empty array.`);
        }
        return rule;
      case TagConditionOperator.GTE:
      case TagConditionOperator.LTE:
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new RpcException(`${at}: value must be a number.`);
        }
        return rule;
      default:
        if (value === undefined || value === null || Array.isArray(value)) {
          throw new RpcException(`${at}: value must be a single value (not an array).`);
        }
        return rule;
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: what the model RECEIVES from the tools
//    Entity -> small plain object. Never return raw entities, and
//    keep list views slim (summary) vs detail views (full).
// ═══════════════════════════════════════════════════════════════

function toTagRef(row: Partial<TagAutomationEntity>) {
  return row.tag
    ? { id: row.tag.id, name: row.tag.name ?? null, target: row.tag.target ?? null }
    : { id: row.tagId ?? null };
}

function toTagAutomationSummary(row: Partial<TagAutomationEntity>) {
  return {
    id: row.id,
    name: row.name ?? null,
    isEnabled: row.isEnabled ?? null,
    tag: toTagRef(row),
    logic: row.conditions?.logic ?? null,
    rulesCount: row.conditions?.rules?.length ?? 0,
  };
}

function toTagAutomationResultDto(row: Partial<TagAutomationEntity>) {
  return {
    id: row.id,
    name: row.name ?? null,
    isEnabled: row.isEnabled ?? null,
    tag: toTagRef(row),
    conditions: row.conditions ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS: the @McpController class
//    Guards, tool decorators, service calls and the toolJson /
//    toolPage return helpers. No mapping or schema code here.
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpTagAutomationsTools {
  constructor(private automations: TagAutomationsService) {}

  @McpReadTool({
    name: TOOL.tagAutomations.search,
    description:
      `List tag automations (auto-assign rules) or fetch one. Without \`id\`: paged list filtered by target (default order), tagId, isEnabled, search; each row has logic and rulesCount only. With \`id\`: full automation including conditions.rules. Read-only.`,
    parameters: searchTagAutomationsInput,
  })
  async searchTagAutomations(
    @Payload() input: z.infer<typeof searchTagAutomationsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "tag automation");
    if (req.mode === "get") {
      return toolJson(toTagAutomationResultDto(await this.automations.get(user, req.id)));
    }
    const result = await this.automations.list(user, req.query);
    return toolPage("tagAutomations", result, toTagAutomationSummary, req.query.limit);
  }

  @McpSaveTool({
    name: TOOL.tagAutomations.save,
    description:
      `Create or update a tag automation: when an order matches the conditions, the tag is assigned automatically (order tags to the order, client tags to the order's client); when it stops matching, the automatic tag may be removed. ` +
      `Required: mode. Create requires tagId, name, conditions; isEnabled defaults to true. Update: \`id\` plus any of tagId, name, isEnabled, conditions. On update, \`conditions\` REPLACES the whole object — send the full logic + rules (fetch current with ${ref(TOOL.tagAutomations.search)} id first). ` +
      `Get tagId from ${ref(TOOL.tags.list)} (target=client for client tags). Order-tag automations must never use client.* fields; client-tag automations may mix client.* and order fields. ` +
      `Before writing UUID values, look them up: order.statusId via ${ref(TOOL.orderStatuses.list)}, order.storeId via ${ref(TOOL.stores.list)}, order.cityId via ${ref(TOOL.cities.list)}, order.shippingCompanyId via ${ref(TOOL.shippingCompanies.list)} providerId. ` +
      `Example: {"logic":"AND","rules":[{"field":"order.finalTotal","operator":"gte","value":1000},{"field":"order.paymentMethod","operator":"in","value":["cod","cash"]},{"field":"order.isConfirmed","operator":"eq","value":true}]}. No delete.`,
    parameters: saveTagAutomationInput,
  })
  async saveTagAutomation(
    @Payload() input: z.infer<typeof saveTagAutomationInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "tag automation", TOOL.tagAutomations.search);
    const fields: Record<string, any> = { ...req.fields };
    if (fields.conditions) {
      fields.conditions = { ...fields.conditions, rules: normalizeRules(fields.conditions.rules) };
    }
    if (req.mode === "create") {
      const parsed = await parseDto(CreateTagAutomationDto, fields);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      const created = await this.automations.create(user, parsed.dto);
      return toolJson(toTagAutomationResultDto(await this.automations.get(user, created.id)));
    }
    const parsed = await parseDto(UpdateTagAutomationDto, fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    await this.automations.update(user, req.id, parsed.dto);
    return toolJson(toTagAutomationResultDto(await this.automations.get(user, req.id)));
  }
}
