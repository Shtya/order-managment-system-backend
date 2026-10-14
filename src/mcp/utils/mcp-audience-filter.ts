import { RpcException } from "@nestjs/microservices";
import { z } from "zod";
import { OrderConfirmationSource, PaymentMethod } from "entities/order.entity";
import { ConditionLogic, ConditionOperator } from "common/condition.types";
import {
  CLIENT_AUDIENCE_FIELD_VALUE_TYPES,
  ClientAudienceClientField,
  ClientAudienceEntity,
  ClientAudienceOrderField,
  ClientAudienceOrderItemField,
  ClientAudienceValueType,
} from "common/client-audience-filter.types";
import { ref, TOOL } from "./mcp-tool-names";

// Client audience filter shared by client segments and campaigns.
// Fixed 3-level tree (client -> order -> order_item), so each level
// only offers its own fields and the nesting is enforced by the schema.

const C = ClientAudienceClientField;
const O = ClientAudienceOrderField;
const I = ClientAudienceOrderItemField;

const FIELD_LOOKUPS: Record<string, string> = {
  [C.CLIENT_TAG_ID]: `client tag id from ${ref(TOOL.tags.list)} with target=client`,
  [O.ORDER_STATUS_ID]: `from ${ref(TOOL.orderStatuses.list)}`,
  [O.ORDER_STORE_ID]: `from ${ref(TOOL.stores.list)}`,
  [O.ORDER_CITY_ID]: `from ${ref(TOOL.cities.list)}`,
  [O.ORDER_SHIPPING_COMPANY_ID]: `row.providerId from ${ref(TOOL.shippingCompanies.list)} (never integrationId)`,
  [O.ORDER_TAG_ID]: `order tag id from ${ref(TOOL.tags.list)}`,
  [O.ORDER_CANCEL_CAUSE_ID]: `from ${ref(TOOL.cancelCauses.list)}`,
  [O.ORDER_PAYMENT_METHOD]: `one of: ${Object.values(PaymentMethod).join(", ")}`,
  [O.ORDER_CONFIRMATION_SOURCE]: `one of: ${Object.values(OrderConfirmationSource).join(", ")}`,
  [I.PRODUCT_ID]: `product id from ${ref(TOOL.products.search)}`,
  [I.VARIANT_ID]: `variant id from ${ref(TOOL.products.search)}`,
  [I.CATEGORY_ID]: `from ${ref(TOOL.categories.list)}`,
};

const RATE_FIELDS = new Set<string>([
  C.CLIENT_DELIVERED_RATE,
  C.CLIENT_CONFIRMED_RATE,
  C.CLIENT_RETURNED_RATE,
  C.CLIENT_CANCEL_RATE,
]);

const RELATION_FIELDS = new Set<string>([C.CLIENT_TAG_ID, O.ORDER_TAG_ID, O.ORDER_CANCEL_CAUSE_ID]);

function fieldType(field: string): ClientAudienceValueType {
  return (CLIENT_AUDIENCE_FIELD_VALUE_TYPES as Record<string, ClientAudienceValueType>)[field];
}

function fieldDocs(fields: Record<string, string>) {
  return Object.values(fields)
    .map((field) => {
      const type = fieldType(field);
      const extra = FIELD_LOOKUPS[field] ?? (RATE_FIELDS.has(field) ? "percentage 0-100" : "");
      return `${field} (${type}${extra ? `, ${extra}` : ""})`;
    })
    .join("; ");
}

export const AUDIENCE_FILTER_DOC =
  `Audience filter tree. Root = clients: {"logic":"AND"|"OR","rules":[...]}. ` +
  `Root rules: client rules OR order groups {"entity":"order","logic","rules"} meaning "client has at least one order matching ALL/ANY of these rules". ` +
  `Order group rules: order rules OR order_item groups {"entity":"order_item","logic","rules"} meaning "that order has an item matching these rules". No other nesting. ` +
  `CLIENT fields: ${fieldDocs(C)}. ` +
  `ORDER fields (only inside an order group): ${fieldDocs(O)}. ` +
  `ORDER_ITEM fields (only inside an order_item group): ${fieldDocs(I)}. ` +
  `Operators: eq / neq = one value; in / not_in = non-empty array; gte / lte = number for number fields, "YYYY-MM-DD" for date fields (compared by day, inclusive); is_null / is_not_null = omit value. ` +
  `For client.tagId, order.tagId, order.cancelCauseId: is_null = has none, is_not_null = has any, neq / not_in = has none of them. ` +
  `UUID values must be real ids from the lookup tool, never names. ` +
  `Example (clients with 3+ orders who bought a product in Cairo since 2026-01-01): ` +
  `{"logic":"AND","rules":[{"field":"client.totalOrders","operator":"gte","value":3},{"entity":"order","logic":"AND","rules":[{"field":"order.cityId","operator":"eq","value":"<cityId>"},{"field":"order.createdAt","operator":"gte","value":"2026-01-01"},{"entity":"order_item","logic":"AND","rules":[{"field":"product.id","operator":"in","value":["<productId>"]}]}]}]}.`;

const ruleValue = z
  .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])
  .optional()
  .describe("Omit for is_null / is_not_null. Array for in / not_in. Number or YYYY-MM-DD for gte / lte.");

const ruleFor = <E extends Record<string, string>>(fields: E, level: string) =>
  z.object({
    field: z.enum(fields).describe(`${level} field`),
    operator: z.enum(ConditionOperator),
    value: ruleValue,
  });

const logicField = z.enum(ConditionLogic).describe("AND = every rule matches. OR = any rule matches.");

const orderItemGroup = z.object({
  entity: z.literal(ClientAudienceEntity.ORDER_ITEM),
  logic: logicField,
  rules: z.array(ruleFor(I, "order_item")).min(1),
});

const orderGroup = z.object({
  entity: z.literal(ClientAudienceEntity.ORDER),
  logic: logicField,
  rules: z.array(z.union([ruleFor(O, "order"), orderItemGroup])).min(1),
});

export const audienceFilterSchema = z
  .object({
    logic: logicField,
    rules: z.array(z.union([ruleFor(C, "client"), orderGroup])).min(1),
  })
  .describe(AUDIENCE_FILTER_DOC);

export type AudienceFilterInput = z.infer<typeof audienceFilterSchema>;
type AudienceNode = { field?: string; operator?: string; value?: unknown; entity?: string; logic?: string; rules?: AudienceNode[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function normalizeRule(node: AudienceNode, path: string): AudienceNode {
  const at = `${path} (${node.field} ${node.operator})`;
  const type = fieldType(String(node.field));
  const { value } = node;
  const isDate = type === ClientAudienceValueType.DATE;
  const checkScalar = (v: unknown) => {
    if (isDate && (typeof v !== "string" || !DATE_RE.test(v))) {
      throw new RpcException(`${at}: date values must be "YYYY-MM-DD".`);
    }
  };

  switch (node.operator) {
    case ConditionOperator.IS_NULL:
    case ConditionOperator.IS_NOT_NULL:
      return { field: node.field, operator: node.operator };
    case ConditionOperator.IN:
    case ConditionOperator.NOT_IN:
      if (!Array.isArray(value) || value.length === 0) {
        throw new RpcException(`${at}: value must be a non-empty array.`);
      }
      value.forEach(checkScalar);
      return node;
    case ConditionOperator.GTE:
    case ConditionOperator.LTE:
      if (isDate) {
        checkScalar(value);
        return node;
      }
      if (type !== ClientAudienceValueType.NUMBER || RELATION_FIELDS.has(String(node.field))) {
        throw new RpcException(`${at}: gte / lte only work on number or date fields.`);
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new RpcException(`${at}: value must be a number.`);
      }
      return node;
    default:
      if (value === undefined || value === null || Array.isArray(value)) {
        throw new RpcException(`${at}: value must be a single value (not an array).`);
      }
      checkScalar(value);
      return node;
  }
}

function normalizeNodes(nodes: AudienceNode[], path: string): AudienceNode[] {
  return nodes.map((node, i) => {
    const at = `${path}[${i}]`;
    if (node.entity) {
      return { entity: node.entity, logic: node.logic, rules: normalizeNodes(node.rules ?? [], `${at}.rules`) };
    }
    return normalizeRule(node, at);
  });
}

export function normalizeAudienceFilter(filter: AudienceFilterInput) {
  return {
    rootEntity: ClientAudienceEntity.CLIENT,
    entity: ClientAudienceEntity.CLIENT,
    logic: filter.logic,
    rules: normalizeNodes(filter.rules as AudienceNode[], "audienceFilter.rules"),
  };
}
