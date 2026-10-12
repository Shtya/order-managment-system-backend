import { UseGuards } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { McpController } from "@rekog/mcp-nest";
import { z } from "zod";
import { McpScopeGuard } from "../mcp-guards/mcp-scope-guard";
import { McpReadTool, McpSaveTool } from "../decorators/mcp-tool.decorators";
import { McpUser } from "../mcp-guards/mcp-user.decorator";
import { User } from "entities/user.entity";
import { ClientSettingsService } from "src/client-settings/client-settings.service";
import { UpsertClientSettingsDto } from "dto/client-settings.dto";
import { parseDto } from "../utils/mcp-dto.util";
import { toolJson } from "../utils/mcp-result.util";
import { TOOL } from "../utils/mcp-tool-names";

// ═══════════════════════════════════════════════════════════════
// 1) INPUT SCHEMAS
//    Singleton: no id. Save is always upsert, never create/update mode.
//    File/logo binary (orphanFileIds) never offered.
// ═══════════════════════════════════════════════════════════════

const getSettingsInput = z.object({
  includePreview: z
    .boolean()
    .optional()
    .describe("When true, also returns the campaign order page preview."),
});

const saveSettingsInput = z.object({
  assignmentMode: z.string().optional().describe("How orders are assigned to employees"),
  assignmentDelay: z.number().int().min(1).optional().describe("Delay before auto-assignment"),
  stockDeductionStrategy: z.string().optional().describe("When stock is deducted"),
  orderFlowPath: z.string().optional().describe("Order flow path"),
  defaultLang: z.string().optional().describe("Default language"),
  notifyEmployee: z.boolean().optional().describe("Notify the assignee on new orders"),
  notifyAdmin: z.boolean().optional().describe("Notify the admin on new orders"),
  notifyLowStock: z.boolean().optional().describe("Notify on low stock"),
  whatsappAiEnabled: z.boolean().optional().describe("Enable the WhatsApp AI agent"),
  reservedEnabled: z.boolean().optional().describe("Enable reserved stock"),
  orderTagMode: z.string().optional().describe("Order tag mode"),
  clientTagMode: z.string().optional().describe("Client tag mode"),
  campaignOrderPage: z
    .object({
      pageTitle: z.string().optional().describe("Campaign page title text"),
      collectCityArea: z.boolean().optional().describe("Collect city and area on the page"),
    })
    .optional()
    .describe("Campaign page text. No logo or icon uploads."),
  // orphanFileIds / logoUrl / favicon icon never offered: file upload
});

// ═══════════════════════════════════════════════════════════════
// 2) OUTPUT MAPPERS: curated text settings, no file binaries.
// ═══════════════════════════════════════════════════════════════

function toSettingsDto(row: any) {
  return {
    assignmentMode: row.assignmentMode ?? null,
    assignmentDelay: row.assignmentDelay ?? null,
    stockDeductionStrategy: row.stockDeductionStrategy ?? null,
    orderFlowPath: row.orderFlowPath ?? null,
    defaultLang: row.defaultLang ?? null,
    notifyEmployee: row.notifyEmployee ?? null,
    notifyAdmin: row.notifyAdmin ?? null,
    notifyLowStock: row.notifyLowStock ?? null,
    notificationSettings: row.notificationSettings ?? null,
    shipping: row.shipping ?? null,
    whatsappAiEnabled: row.whatsappAiEnabled ?? null,
    reservedEnabled: row.reservedEnabled ?? null,
    orderTagMode: row.orderTagMode ?? null,
    clientTagMode: row.clientTagMode ?? null,
    tagAutomationsEnabled: row.tagAutomationsEnabled ?? null,
    campaignOrderPage: row.campaignOrderPage
      ? {
          pageTitle: row.campaignOrderPage.pageTitle ?? null,
          collectCityArea: row.campaignOrderPage.collectCityArea ?? null,
        }
      : null,
  };
}

// ═══════════════════════════════════════════════════════════════
// 3) TOOLS
// ═══════════════════════════════════════════════════════════════

@McpController()
@UseGuards(McpScopeGuard)
export class McpClientSettingsTools {
  constructor(private settings: ClientSettingsService) {}

  @McpReadTool({
    name: TOOL.clientSettings.get,
    description:
      "Get the tenant order/ops settings. Pass includePreview=true to also return the campaign order page preview. Singleton, no id. Read-only.",
    parameters: getSettingsInput,
  })
  async getSettings(
    @Payload() input: z.infer<typeof getSettingsInput>,
    @McpUser() user: User,
  ) {
    const settings = await this.settings.getSettings(user);
    if (!input?.includePreview) return toolJson(toSettingsDto(settings));
    const preview = await this.settings.getCampaignOrderPreview(user).catch(() => null);
    return toolJson({ ...toSettingsDto(settings), preview: preview ?? null });
  }

  @McpSaveTool({
    name: TOOL.clientSettings.save,
    description:
      "Upsert the tenant order/ops settings. No mode, no id: only sent keys change. Curated text fields only, no file or logo uploads.",
    parameters: saveSettingsInput,
  })
  async saveSettings(
    @Payload() input: z.infer<typeof saveSettingsInput>,
    @McpUser() user: User,
  ) {
    const parsed = await parseDto(UpsertClientSettingsDto, input);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return toolJson(toSettingsDto(await this.settings.upsertSettings(user, parsed.dto)));
  }
}
