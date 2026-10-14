import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpUpdateTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { UpsellsService } from "src/upsells/upsells.service";
import { UpdateUpsellDto, UpsellHeaderType } from "dto/upsells.dto";
import { isSet, listPaging, parseDto, parseSearchInput, resolveToolDates, searchInput } from "../utils/mcp-dto.util";
import { toolJson, toolPage } from "../utils/mcp-result.util";
import { idDescription, ref, TOOL } from "../utils/mcp-tool-names";
import { isoDateField, TREND_RANGES, uuidField } from "../utils/mcp-date.util";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS
//    Service sorts createdAt only: advertise that single column.
//    No raw files on get.
// ═══════════════════════════════════════════════════════════════

const searchUpsellsInput = searchInput("upsell", {
  ...listPaging({
    items: "upsells",
    sortBy: ["createdAt"],
    search: "Matches trigger or upsell product name or SKU",
  }),
  status: z.enum(["active", "inactive"]).optional().describe("Keep active or inactive offers. Omit for all."),
  productId: uuidField(idDescription("Keep offers for this product (trigger or upsell).", TOOL.products.search)).optional(),
  startDate: isoDateField("Created-at range start, ISO date (YYYY-MM-DD)").optional(),
  endDate: isoDateField("Created-at range end, ISO date (YYYY-MM-DD)").optional(),
}, TOOL.upsells.search);

const upsellsStatsInput = z.strictObject({
  startDate: isoDateField("Range start, ISO date (YYYY-MM-DD)").optional(),
  endDate: isoDateField("Range end, ISO date (YYYY-MM-DD)").optional(),
  range: z.enum(TREND_RANGES).optional().describe(`Quick range. One of: ${TREND_RANGES.join(", ")}. Do not pass together with startDate/endDate.`),
});

const updateUpsellInput = z.object({
  id: uuidField(idDescription("Upsell offer ID.", TOOL.upsells.search)),
  triggerProductId: uuidField(
    idDescription("Product whose orders trigger the offer.", TOOL.products.search),
  ).optional(),
  upsellProductId: uuidField(
    idDescription("Product offered to the customer.", TOOL.products.search, "When it changes, also send upsellSkuId of one of its variants."),
  ).optional(),
  upsellSkuId: uuidField(
    idDescription("Variant of the upsell product: variants[].id of that product.", TOOL.products.search, "Must belong to the upsell product."),
  ).optional(),
  upsellPrice: z.number().min(0).optional().describe("Offer price for the upsell variant."),
  expireEnabled: z
    .boolean()
    .optional()
    .describe("false = the offer never expires (clears expireTimeM). true = the offer expires after expireTimeM minutes."),
  expireTimeM: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Minutes the customer has to accept after the offer is sent. Sending it alone also enables expiry."),
  bodyText: z.string().min(1).optional().describe("WhatsApp message body text."),
  footerText: z.string().optional().describe('WhatsApp message footer text. Send "" to remove the footer.'),
  buttons: z
    .array(z.string().min(1))
    .min(1)
    .max(3)
    .optional()
    .describe("Button texts, 1 to 3. Replaces all buttons, in this order."),
});

const MESSAGE_KEYS = ["bodyText", "footerText", "buttons"] as const;

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: offer, products, message config. No files.
// ═══════════════════════════════════════════════════════════════

function toUpsellSummary(row: any) {
  return {
    id: row.id,
    isActive: row.isActive ?? null,
    triggerProduct: row.triggerProduct ? { id: row.triggerProduct.id ?? null, name: row.triggerProduct.name ?? null } : null,
    upsellProduct: row.upsellProduct ? { id: row.upsellProduct.id ?? null, name: row.upsellProduct.name ?? null } : null,
    upsellSku: row.upsellSku ? { id: row.upsellSku.id ?? null, sku: row.upsellSku.sku ?? null } : null,
    upsellPrice: row.upsellPrice != null ? Number(row.upsellPrice) : null,
    expireTimeM: row.expireTimeM ?? null,
    createdAt: row.createdAt ?? null,
  };
}

function toUpsellResultDto(row: any) {
  return {
    id: row.id,
    isActive: row.isActive ?? null,
    triggerProduct: row.triggerProduct ? { id: row.triggerProduct.id ?? null, name: row.triggerProduct.name ?? null } : null,
    upsellProduct: row.upsellProduct ? { id: row.upsellProduct.id ?? null, name: row.upsellProduct.name ?? null } : null,
    upsellSku: row.upsellSku ? { id: row.upsellSku.id ?? null, sku: row.upsellSku.sku ?? null } : null,
    upsellPrice: row.upsellPrice != null ? Number(row.upsellPrice) : null,
    expireEnabled: row.expireTimeM != null,
    expireTimeM: row.expireTimeM ?? null,
    message: row.message ?? row.messageConfig ?? null,
    createdAt: row.createdAt ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpUpsellsTools {
  constructor(private upsells: UpsellsService) {}

  @McpReadTool({
    name: TOOL.upsells.search,
    description:
      "Search upsell offers or fetch one. Without `id`: paged summaries filtered by search text, status, product, or dates. With `id`: returns that offer with products and message config. Read-only.",
    parameters: searchUpsellsInput,
  })
  async searchUpsells(
    @Payload() input: z.infer<typeof searchUpsellsInput>,
    @McpUser() user: User,
  ) {
    const req = parseSearchInput(input, "upsell");
    if (req.mode === "get") {
      return toolJson(toUpsellResultDto(await this.upsells.findOne(user, req.id)));
    }
    const dates = resolveToolDates(req.query);
    const result = await this.upsells.list(user, {
      ...req.query,
      startDate: dates.startDate,
      endDate: dates.endDate,
    });
    return toolPage("upsells", result, toUpsellSummary, req.query.limit);
  }

  @McpReadTool({
    name: TOOL.upsells.stats,
    description:
      "Upsell outcome counts: sent, accepted, rejected, noAnswer, expired, acceptedNonEligible, failedToAdd, delivered, pending. Optional startDate/endDate/range. Read-only.",
    parameters: upsellsStatsInput,
  })
  async getUpsellsStats(
    @Payload() input: z.infer<typeof upsellsStatsInput>,
    @McpUser() user: User,
  ) {
    const dates = resolveToolDates(input);
    return toolJson(await this.upsells.stats(user, {
      startDate: dates.startDate,
      endDate: dates.endDate,
    }));
  }

  @McpUpdateTool({
    name: TOOL.upsells.update,
    description:
      `Update an existing upsell offer's data. Required: id. Optional: triggerProductId, upsellProductId, upsellSkuId (variant), upsellPrice, expireEnabled, expireTimeM, bodyText, footerText, buttons (1-3 texts). Only the fields you send change. ` +
      `Expiry: expireEnabled=false removes it; expireTimeM (minutes) sets it and enables it; expireEnabled=true alone keeps the current minutes. ` +
      `The message header (type, text, media) is never changed by this tool and is kept as is. ` +
      `When changing upsellProductId also send upsellSkuId of one of its variants (from ${ref(TOOL.products.search)} variants[].id). ` +
      `The same trigger + upsell product + variant + price combination cannot exist twice. No create, no delete.`,
    parameters: updateUpsellInput,
  })
  async updateUpsell(
    @Payload() input: z.infer<typeof updateUpsellInput>,
    @McpUser() user: User,
  ) {
    const { id, bodyText, footerText, buttons, expireEnabled, expireTimeM, ...offer } = input;
    const changed = Object.entries(input).filter(([k, v]) => k !== "id" && v !== undefined);
    if (changed.length === 0) {
      throw new RpcException("Nothing to update. Send at least one field besides id.");
    }
    if (isSet(offer.upsellProductId) && !isSet(offer.upsellSkuId)) {
      throw new RpcException(
        `upsellProductId changed: also send upsellSkuId (a variant of the new product, from ${TOOL.products.search} variants[].id).`,
      );
    }

    const current = await this.upsells.findOne(user, id);
    const fields: Record<string, unknown> = { ...offer };

    if (expireEnabled === false) {
      if (expireTimeM !== undefined) {
        throw new RpcException("expireEnabled=false clears the expiry: do not send expireTimeM with it.");
      }
      fields.expireTimeM = null;
    } else if (expireTimeM !== undefined) {
      fields.expireTimeM = expireTimeM;
    } else if (expireEnabled === true && current.expireTimeM == null) {
      throw new RpcException("expireEnabled=true needs expireTimeM (minutes) because the offer has no expiry time yet.");
    }

    if (MESSAGE_KEYS.some((k) => input[k] !== undefined)) {
      const old: any = current.messageConfig ?? {};
      fields.messageConfig = {
        headerType: old.headerType ?? UpsellHeaderType.NONE,
        ...(old.headerText != null && { headerText: old.headerText }),
        ...(old.headerUrl != null && { headerUrl: old.headerUrl }),
        ...(old.headerHandle != null && { headerHandle: old.headerHandle }),
        bodyText: bodyText ?? old.bodyText,
        ...((footerText ?? old.footerText) != null && { footerText: footerText ?? old.footerText }),
        buttons: buttons
          ? buttons.map((text) => ({ text }))
          : (old.buttons ?? []).map((b: any) => ({ text: b?.text })),
      };
    }

    const parsed = await parseDto(UpdateUpsellDto, fields);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    await this.upsells.update(user, id, parsed.dto);
    return toolJson(toUpsellResultDto(await this.upsells.findOne(user, id)));
  }
}
