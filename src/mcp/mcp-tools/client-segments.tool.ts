import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { ClientSegmentsService } from "src/client-segments/client-segments.service";
import { ClientSegmentStatus, ClientSegmentType } from "entities/clients-segments.entity";
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
import { CreateClientSegmentDto, UpdateClientSegmentDto } from "dto/client-segment.dto";
import { listPaging, parseDto, parseSaveInput, parseSearchInput, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, ref, TOOL } from "../utils/mcp-tool-names";
import { uuidField } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS (Zod): what the model SENDS to the tools
//    Service sorts createdAt only: advertise that single column.
// ═══════════════════════════════════════════════════════════════

const searchSegmentsInput = searchInput("client segment", {
  ...listPaging({
    items: "client segments",
    sortBy: ["createdAt"],
    search: "Matches segment name",
  }),
  status: z.enum(ClientSegmentStatus).optional().describe("Keep segments with this status"),
  type: z.enum(ClientSegmentType).optional().describe("Keep segments of this type"),
}, TOOL.clientSegments.search);

const segmentsStatsInput = z.strictObject({});

// ── Audience filter ────────────────────────────────────────────
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

const FILTER_DOC =
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

const audienceFilterSchema = z
  .object({
    logic: logicField,
    rules: z.array(z.union([ruleFor(C, "client"), orderGroup])).min(1),
  })
  .describe(FILTER_DOC);

type AudienceFilterInput = z.infer<typeof audienceFilterSchema>;
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

function normalizeAudienceFilter(filter: AudienceFilterInput) {
  return {
    rootEntity: ClientAudienceEntity.CLIENT,
    entity: ClientAudienceEntity.CLIENT,
    logic: filter.logic,
    rules: normalizeNodes(filter.rules as AudienceNode[], "audienceFilter.rules"),
  };
}

const saveSegmentInput = z.object({
  mode: z
    .enum(["create", "update"])
    .describe('Required. "create" to add a new segment. "update" to change an existing one. Never infer from id.'),
  id: uuidField(
    idDescription("Client segment ID.", TOOL.clientSegments.search, "Required for mode=update. Forbidden for mode=create."),
  ).optional(),
  name: z.string().min(1).max(160).optional().describe("Segment name, unique in the workspace (1-160 chars). Required for create."),
  description: z.string().max(1000).optional().describe("What this segment is for"),
  type: z
    .enum([ClientSegmentType.DYNAMIC, ClientSegmentType.FROZEN])
    .optional()
    .describe("Create only. dynamic (default) = membership recalculated on every use. frozen = snapshot of the matching clients taken now in the background."),
  status: z.enum(ClientSegmentStatus).optional().describe("Update only. inactive hides it from campaigns."),
  audienceFilter: audienceFilterSchema.optional(),
});

const previewSegmentInput = z.object({
  id: uuidField(
    idDescription("Saved segment to preview.", TOOL.clientSegments.search, "Pass either id or audienceFilter, not both."),
  ).optional(),
  audienceFilter: audienceFilterSchema.optional(),
  limit: z.number().int().min(1).max(50).optional().describe("Sample size, default 10, max 50."),
  cursor: z
    .object({ value: z.string(), id: z.string() })
    .optional()
    .describe("nextCursor from the previous preview call, to get the next page of clients."),
});

const SEGMENT_ACTIONS = ["freeze", "unfreeze", "refresh_estimate"] as const;

const actSegmentInput = z.object({
  action: z.enum(SEGMENT_ACTIONS).describe(
    "freeze: snapshot current matching clients (only from dynamic or freeze_failed). unfreeze: back to dynamic, drops the snapshot (from frozen or freeze_failed). refresh_estimate: recount estimatedRecipientsCount.",
  ),
  id: uuidField(idDescription("Client segment ID.", TOOL.clientSegments.search)),
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS
//    No recipient tables, no templates, no freeze internals.
// ═══════════════════════════════════════════════════════════════

function toSegmentSummary(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    status: row.status ?? null,
    type: row.type ?? null,
    estimatedRecipientsCount: Number(row.estimatedRecipientsCount ?? 0),
  };
}

function toSegmentResultDto(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    description: row.description ?? null,
    status: row.status ?? null,
    type: row.type ?? null,
    estimatedRecipientsCount: Number(row.estimatedRecipientsCount ?? 0),
    frozenRecipientsCount: Number(row.frozenRecipientsCount ?? 0),
    frozenAt: row.frozenAt ?? null,
    audienceFilter: row.audienceFilter ?? row.audiencefilter ?? null,
    createdAt: row.createdAt ?? null,
  };
}

function toRecipient(row: any) {
  return {
    clientId: row.clientId ?? null,
    name: row.name ?? null,
    phoneNumber: row.phoneNumber ?? null,
  };
}

function toPreviewResult(count: number, page: any) {
  return {
    count,
    recipients: (page?.records ?? []).map(toRecipient),
    hasMore: !!page?.hasMore,
    nextCursor: page?.nextCursor ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpClientSegmentsTools {
  constructor(private segments: ClientSegmentsService) {}

  @McpReadTool({
    name: TOOL.clientSegments.search,
    description:
      `Search client segments or fetch one. Without \`id\`: paged summaries filtered by name, status, or type. No date filters; extra fields (e.g. startDate) are rejected. With \`id\`: returns that segment with its audience filter, estimated count and frozen snapshot info. Read-only. Write with ${ref(TOOL.clientSegments.save)}, see matching clients with ${ref(TOOL.clientSegments.preview)}, freeze / unfreeze with ${ref(TOOL.clientSegments.act)}.`,
    parameters: searchSegmentsInput,
  })
  async searchSegments(
    @Payload() input: z.infer<typeof searchSegmentsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "client segment");
    if (req.mode === "get") {
      return toolJson(toSegmentResultDto(await this.segments.get(user, req.id)));
    }
    const result = await this.segments.list(user, req.query);
    return toolPage("client_segments", result, toSegmentSummary, req.query.limit);
  }

  @McpReadTool({
    name: TOOL.clientSegments.stats,
    description:
      "Client segment totals. No date filters. Extra fields (e.g. startDate) are rejected. Read-only.",
    parameters: segmentsStatsInput,
  })
  async getSegmentsStats(@McpUser() user: User) {
    return toolJson(await this.segments.stats(user));
  }

  @McpReadTool({
    name: TOOL.clientSegments.preview,
    description:
      `Count and sample the clients matching an audience filter, before or after saving. Pass exactly one of: \`audienceFilter\` (unsaved draft, same shape as ${ref(TOOL.clientSegments.save)}) or \`id\` (saved segment; frozen segments return their snapshot and must be active). Returns count, up to \`limit\` recipients (clientId, name, phoneNumber), hasMore and nextCursor for the next page. Read-only.`,
    parameters: previewSegmentInput,
  })
  async previewSegment(
    @Payload() input: z.infer<typeof previewSegmentInput>,
    @McpUser() user: User,
  ) {
    if (!!input.id === !!input.audienceFilter) {
      throw new RpcException("Pass exactly one of `id` or `audienceFilter`.");
    }
    const q = { limit: input.limit ?? 10, cursor: input.cursor };

    if (input.audienceFilter) {
      const filter = normalizeAudienceFilter(input.audienceFilter) as any;
      const [{ count }, page] = await Promise.all([
        this.segments.preview(user, filter),
        this.segments.previewRecipients(user, filter, q),
      ]);
      return toolJson(toPreviewResult(count, page));
    }

    const seg = await this.segments.get(user, input.id!);
    const page = await this.segments.listRecipients(user, seg.id, q);
    const count =
      seg.type === ClientSegmentType.FROZEN
        ? Number(seg.frozenRecipientsCount ?? 0)
        : (await this.segments.preview(user, seg.audienceFilter)).count;
    return toolJson(toPreviewResult(count, page));
  }

  @McpSaveTool({
    name: TOOL.clientSegments.save,
    description:
      `Create or update a client segment (a saved audience of clients, used by campaigns). Required: mode. Create requires name and audienceFilter; type optional (dynamic default, or frozen). Update: \`id\` plus any of name, description, status, audienceFilter. ` +
      `On update, audienceFilter REPLACES the whole filter: fetch the current one with ${ref(TOOL.clientSegments.search)} id first. ` +
      `A frozen or freezing segment's audienceFilter cannot be changed: unfreeze it with ${ref(TOOL.clientSegments.act)} first. ` +
      `Check the audience with ${ref(TOOL.clientSegments.preview)} before saving. Returns the segment with estimatedRecipientsCount. No delete.`,
    parameters: saveSegmentInput,
  })
  async saveSegment(
    @Payload() input: z.infer<typeof saveSegmentInput>,
    @McpUser() user: User,
  ) {
    const req = parseSaveInput(input, "client segment", TOOL.clientSegments.search, { updateOnlyKeys: ["status"] });
    const { audienceFilter, ...rest } = req.fields;
    const fields: Record<string, unknown> = { ...rest };
    if (audienceFilter) fields.audienceFilter = normalizeAudienceFilter(audienceFilter);

    if (req.mode === "create") {
      const parsed = await parseDto(CreateClientSegmentDto, fields);
      if (parsed.ok === false) throw new RpcException(parsed.message);
      return toolJson(toSegmentResultDto(await this.segments.create(user, parsed.dto)));
    }

    if (fields.type !== undefined) {
      throw new RpcException(
        `type is create-only. To freeze or unfreeze an existing segment use ${TOOL.clientSegments.act}.`,
      );
    }
    const parsed = await parseDto(UpdateClientSegmentDto, fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(toSegmentResultDto(await this.segments.update(user, req.id, parsed.dto)));
  }

  @McpSaveTool({
    name: TOOL.clientSegments.act,
    description:
      `Act on a saved client segment. Required: action, id. freeze: takes a snapshot of the matching clients in the background (allowed from dynamic or freeze_failed); the result shows type=freezing, re-check with ${ref(TOOL.clientSegments.search)} to see frozen or freeze_failed. unfreeze: back to dynamic and drops the snapshot (from frozen or freeze_failed). refresh_estimate: recounts estimatedRecipientsCount. Returns the segment.`,
    parameters: actSegmentInput,
  })
  async actSegment(
    @Payload() input: z.infer<typeof actSegmentInput>,
    @McpUser() user: User,
  ) {
    switch (input.action) {
      case "freeze":
        await this.segments.freeze(user, input.id);
        break;
      case "unfreeze":
        await this.segments.unfreeze(user, input.id);
        break;
      case "refresh_estimate":
        await this.segments.refreshEstimate(user, input.id);
        break;
    }
    return toolJson(toSegmentResultDto(await this.segments.get(user, input.id)));
  }
}
