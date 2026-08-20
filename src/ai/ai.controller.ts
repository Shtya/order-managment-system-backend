import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import { Permissions } from "../../common/permissions.decorator";
import { PermissionsGuard } from "../../common/permissions.guard";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import {
  CreateIntegrationDto,
  CreateModelDto,
  CreateProviderDto,
  ExportIntegrationsQueryDto,
  ExportModelsQueryDto,
  ExportProvidersQueryDto,
  ExportRequestSummariesQueryDto,
  ExportWriteToolCallsQueryDto,
  ListIntegrationsQueryDto,
  ListModelsQueryDto,
  ListProvidersQueryDto,
  ListRequestSummariesQueryDto,
  ListWriteToolCallsQueryDto,
  SetCredentialsDto,
  UpdateModelDto,
  UpdateProviderDto,
} from "../../dto/ai.dto";
import { AiAccessGuard } from "./security/ai-access.guard";
import { AiService } from "./ai.service";
import { AiExportService } from "./ai-export.service";
import { AiOrchestratorService } from "./orchestrator/ai-orchestrator.service";
import { AI_PERMISSION_CHAT, AI_CONFIG_TOKEN } from "./ai.constants";
import {
  AiChatRequestDto,
  AiStatusProviderDto,
  AiStatusResponseDto,
} from "./ai.dto";
import { AiToolRegistryService } from "./tools/ai-tool-registry.service";
import { AiToolContext } from "./tools/ai-tool-context";
import { Inject } from "@nestjs/common";
import { AiConfig } from "./interfaces/provider-config.interface";
import { SetDefaultModelDto } from "../../dto/ai.dto";
import { AiProviderSelectorService } from "./orchestrator/provider-selector.service";

const AI_MANAGE = "ai.manage";

@ApiTags("AI")
@ApiBearerAuth()
@UseGuards(AiAccessGuard, JwtAuthGuard, PermissionsGuard)
@Controller("ai")
export class AiController {
  constructor(
    private readonly svc: AiService,
    private readonly exportSvc: AiExportService,
    private readonly orchestrator: AiOrchestratorService,
    private readonly toolRegistry: AiToolRegistryService,
    private readonly selector: AiProviderSelectorService,
    @Inject(AI_CONFIG_TOKEN) private readonly config: AiConfig,
  ) {}

  // ──────────────────────────── 1. PROVIDERS — System Catalog ────────────────────────────

  @ApiOperation({
    summary:
      "List all providers visible to the current tenant with lightweight models",
  })
  @Permissions(AI_PERMISSION_CHAT)
  @Get("providers")
  async listProviders(@Req() req: any, @Query() query: ListProvidersQueryDto) {
    return this.svc.listProviders(req.user, query);
  }

  @ApiOperation({ summary: "Export providers as Excel (super_admin only)" })
  @Permissions(AI_MANAGE)
  @Get("providers/export")
  async exportProviders(
    @Req() req: any,
    @Query() query: ExportProvidersQueryDto,
    @Res() res: Response,
  ) {
    const data = await this.svc.exportProviders(req.user, query);
    const buffer = await this.exportSvc.providers(data);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=ai_providers_export_${Date.now()}.xlsx`,
    );
    return res.send(buffer);
  }

  @ApiOperation({ summary: "Get provider by ID with full models" })
  @Permissions(AI_PERMISSION_CHAT)
  @Get("providers/:id")
  async getProvider(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.getProvider(req.user, id);
  }

  // ──────────────────────────── 2. PROVIDERS — Custom CRUD ────────────────────────────

  @ApiOperation({ summary: "Create a custom provider" })
  @Permissions(AI_MANAGE)
  @Post("providers")
  async createProvider(@Req() req: any, @Body() dto: CreateProviderDto) {
    return this.svc.createProvider(req.user, dto);
  }

  @ApiOperation({ summary: "Update a custom provider" })
  @Permissions(AI_MANAGE)
  @Patch("providers/:id")
  async updateProvider(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateProviderDto,
  ) {
    return this.svc.updateProvider(req.user, id, dto);
  }

  @ApiOperation({ summary: "Delete a custom provider" })
  @Permissions(AI_MANAGE)
  @Delete("providers/:id")
  async deleteProvider(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.svc.deleteProvider(req.user, id);
  }

  @ApiOperation({ summary: "Activate or deactivate an integration" })
  @Permissions(AI_MANAGE)
  @Post("providers/:providerId/active")
  async toggleProviderActive(
    @Req() req: any,
    @Param("providerId", ParseUUIDPipe) providerId: string,
    @Body() dto: { isActive: boolean },
  ) {
    return this.svc.toggleProviderActive(req.user, providerId, dto);
  }

  // ──────────────────────────── 3. MODELS — Combined ────────────────────────────

  @ApiOperation({ summary: "List all models across accessible providers" })
  @Permissions(AI_PERMISSION_CHAT)
  @Get("models")
  async listModels(@Req() req: any, @Query() query: ListModelsQueryDto) {
    return this.svc.listModels(req.user, query);
  }

  @ApiOperation({ summary: "Get a single model by ID" })
  @Permissions(AI_PERMISSION_CHAT)
  @Get("models/:id")
  async getModel(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.getModel(req.user, id);
  }

  // ──────────────────────────── 4. MODELS — Custom CRUD ────────────────────────────

  @ApiOperation({ summary: "Add a custom model to a provider" })
  @Permissions(AI_MANAGE)
  @Post("models")
  async createModel(@Req() req: any, @Body() dto: CreateModelDto) {
    return this.svc.createModel(req.user, dto);
  }

  @ApiOperation({ summary: "Export models as Excel (super_admin only)" })
  @Permissions(AI_MANAGE)
  @Get("models/export")
  async exportModels(
    @Req() req: any,
    @Query() query: ExportModelsQueryDto,
    @Res() res: Response,
  ) {
    this.ensureSuperAdmin(req.user);
    const data = await this.svc.exportModels(req.user, query);
    const buffer = await this.exportSvc.models(data);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=ai_models_export_${Date.now()}.xlsx`,
    );
    return res.send(buffer);
  }

  @ApiOperation({ summary: "Update a custom model" })
  @Permissions(AI_MANAGE)
  @Patch("models/:id")
  async updateModel(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateModelDto,
  ) {
    return this.svc.updateModel(req.user, id, dto);
  }

  @ApiOperation({ summary: "Delete a custom model" })
  @Permissions(AI_MANAGE)
  @Delete("models/:id")
  async deleteModel(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.deleteModel(req.user, id);
  }

  @ApiOperation({ summary: "Activate or deactivate a model" })
  @Permissions(AI_MANAGE)
  @Post("models/:id/active")
  async toggleModelActive(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: { isActive: boolean },
  ) {
    return this.svc.toggleModelActive(req.user, id, dto);
  }

  // ──────────────────────────── 5. INTEGRATIONS ────────────────────────────

  @ApiOperation({ summary: "List tenant integrations (credentials status)" })
  @Permissions(AI_PERMISSION_CHAT)
  @Get("integrations")
  async listIntegrations(
    @Req() req: any,
    @Query() query: ListIntegrationsQueryDto,
  ) {
    return this.svc.listIntegrations(req.user, query);
  }

  @ApiOperation({ summary: "Get integration details for a specific provider" })
  @Permissions(AI_PERMISSION_CHAT)
  @Get("integrations/:providerId")
  async getIntegration(
    @Req() req: any,
    @Param("providerId", ParseUUIDPipe) providerId: string,
  ) {
    return this.svc.getIntegration(req.user, providerId);
  }

  @ApiOperation({ summary: "Set or update API key credentials for a provider" })
  @Permissions(AI_MANAGE)
  @Post("integrations/:providerId/credentials")
  async setCredentials(
    @Req() req: any,
    @Param("providerId", ParseUUIDPipe) providerId: string,
    @Body() dto: SetCredentialsDto,
  ) {
    return this.svc.setCredentials(req.user, providerId, dto);
  }

  @ApiOperation({ summary: "Test/validate stored credentials for a provider" })
  @Permissions(AI_MANAGE)
  @Post("integrations/:providerId/test")
  async testCredentials(
    @Req() req: any,
    @Param("providerId", ParseUUIDPipe) providerId: string,
    @Query("modelCode") modelCode?: string,
  ) {
    return this.svc.testCredentials(req.user, providerId, modelCode);
  }

  @ApiOperation({ summary: "Remove integration (clear credentials)" })
  @Permissions(AI_MANAGE)
  @Delete("integrations/:providerId")
  async deleteIntegration(
    @Req() req: any,
    @Param("providerId", ParseUUIDPipe) providerId: string,
  ) {
    return this.svc.deleteIntegration(req.user, providerId);
  }

  // ──────────────────────────── 6. CHAT (existing) ────────────────────────────

  @ApiOperation({ summary: "Run AI assistant request with tool calling" })
  @Permissions(AI_PERMISSION_CHAT)
  @Post("chat")
  async chat(@Req() req: any, @Body() dto: AiChatRequestDto) {
    return this.orchestrator.chat(req.user, dto.message, {
      conversationId: dto.conversationId,
      provider: dto.provider,
      model: dto.model,
      acceptWriteOperations: dto.acceptWriteOperations,
      enforcePiiMasking: dto.enforcePiiMasking,
      allowedToolNames: dto.allowedToolNames,
      metadata: dto.metadata,
    });
  }

  // ──────────────────────────── 6b. DEFAULT MODEL ────────────────────────────

  @ApiOperation({ summary: "Get current default model" })
  @Permissions(AI_PERMISSION_CHAT)
  @Get("default-model")
  async getDefaultModel(@Req() req: any) {
    return this.svc.getDefaultModel(req.user);
  }

  @ApiOperation({ summary: "Set default model" })
  @Permissions(AI_MANAGE)
  @Put("default-model")
  async setDefaultModel(@Req() req: any, @Body() dto: SetDefaultModelDto) {
    return this.svc.setDefaultModel(req.user, dto);
  }

  @ApiOperation({ summary: "Clear default model" })
  @Permissions(AI_MANAGE)
  @Delete("default-model")
  async clearDefaultModel(@Req() req: any) {
    return this.svc.clearDefaultModel(req.user);
  }

  // ──────────────────────────── 7. AUDIT — Request Summaries (super_admin) ────────────────────────────

  @ApiOperation({ summary: "List AI request summaries (super_admin only)" })
  @Permissions(AI_MANAGE)
  @Get("audit/requests")
  async listRequestSummaries(
    @Req() req: any,
    @Query() query: ListRequestSummariesQueryDto,
  ) {
    // this.ensureSuperAdmin(req.user);
    return this.svc.listRequestSummaries(req.user, query);
  }

  @ApiOperation({
    summary: "Get request summary with full progress (super_admin only)",
  })
  @Permissions(AI_MANAGE)
  @Get("audit/requests/:id")
  async getRequestSummary(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    this.ensureSuperAdmin(req.user);
    return this.svc.getRequestSummary(req.user, id);
  }

  @ApiOperation({
    summary: "Get only progress events for a request (super_admin only)",
  })
  @Permissions(AI_MANAGE)
  @Get("audit/requests/:id/progress")
  async getRequestSummaryProgress(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    this.ensureSuperAdmin(req.user);
    return this.svc.getRequestSummaryProgress(req.user, id);
  }

  @ApiOperation({
    summary: "Export request summaries as Excel (super_admin only)",
  })
  @Permissions(AI_MANAGE)
  @Get("audit/requests/export")
  async exportRequestSummaries(
    @Req() req: any,
    @Query() query: ExportRequestSummariesQueryDto,
    @Res() res: Response,
  ) {
    this.ensureSuperAdmin(req.user);
    const data = await this.svc.exportRequestSummaries(req.user, query);
    const buffer = await this.exportSvc.requestSummaries(data);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=ai_request_summaries_export_${Date.now()}.xlsx`,
    );
    return res.send(buffer);
  }

  // ──────────────────────────── 8. AUDIT — Write Tool Calls (super_admin) ────────────────────────────

  @ApiOperation({ summary: "List write tool call records (super_admin only)" })
  @Permissions(AI_MANAGE)
  @Get("audit/write-calls")
  async listWriteToolCalls(
    @Req() req: any,
    @Query() query: ListWriteToolCallsQueryDto,
  ) {
    this.ensureSuperAdmin(req.user);
    return this.svc.listWriteToolCalls(req.user, query);
  }

  @ApiOperation({
    summary: "Get a single write tool call record (super_admin only)",
  })
  @Permissions(AI_MANAGE)
  @Get("audit/write-calls/:id")
  async getWriteToolCall(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    this.ensureSuperAdmin(req.user);
    return this.svc.getWriteToolCall(req.user, id);
  }

  @ApiOperation({
    summary: "Retry a failed/stale write tool call (super_admin only)",
  })
  @Permissions(AI_MANAGE)
  @Post("audit/write-calls/:id/retry")
  async retryWriteToolCall(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    this.ensureSuperAdmin(req.user);
    return this.svc.retryWriteToolCall(req.user, id);
  }

  @ApiOperation({
    summary: "Export write tool calls as Excel (super_admin only)",
  })
  @Permissions(AI_MANAGE)
  @Get("audit/write-calls/export")
  async exportWriteToolCalls(
    @Req() req: any,
    @Query() query: ExportWriteToolCallsQueryDto,
    @Res() res: Response,
  ) {
    this.ensureSuperAdmin(req.user);
    const data = await this.svc.exportWriteToolCalls(req.user, query);
    const buffer = await this.exportSvc.writeToolCalls(data);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=ai_write_tool_calls_export_${Date.now()}.xlsx`,
    );
    return res.send(buffer);
  }

  // ──────────────────────────── 9. CONFIG (super_admin) ────────────────────────────

  @ApiOperation({ summary: "Get AI module configuration (super_admin only)" })
  @Permissions(AI_MANAGE)
  @Get("config")
  getConfig(@Req() req: any) {
    this.ensureSuperAdmin(req.user);
    return this.svc.getConfig();
  }

  @ApiOperation({
    summary: "Update AI module configuration (super_admin only)",
  })
  @Permissions(AI_MANAGE)
  @Patch("config")
  async updateConfig(
    @Req() req: any,
    @Body()
    dto: {
      enabled?: boolean;
      defaultProvider?: string;
      maxRoundtrips?: number;
      piiMaskingEnabled?: boolean;
    },
  ) {
    this.ensureSuperAdmin(req.user);
    return this.svc.updateConfig(dto);
  }

  // ──────────────────────────── 10. STATUS & TOOLS (existing, super_admin) ────────────────────────────

  @ApiOperation({
    summary: "Report AI module status and enabled providers (super_admin only)",
  })
  @Permissions(AI_PERMISSION_CHAT)
  @Get("status")
  status(@Req() req: any): AiStatusResponseDto {
    this.ensureSuperAdmin(req.user);
    const baseProviders = this.selector.getAllBaseProviders();
    return {
      enabled: this.config.enabled,
      defaultProvider: this.config.defaultProvider,
      providers: baseProviders.map<AiStatusProviderDto>((p) => ({
        name: p.kind,
        displayName: p.displayName,
        enabled: p.isEnabled(),
        model: p.getConfig().model,
        healthy: p.getHealth().healthy,
      })),
    };
  }

  @ApiOperation({
    summary: "List the tools the current user may invoke (super_admin only)",
  })
  @Permissions(AI_PERMISSION_CHAT)
  @Get("tools")
  async tools(@Req() req: any) {
    this.ensureSuperAdmin(req.user);
    const me = req.user;
    const ctx = new AiToolContext({
      session: {
        sessionId: "status",
        tenantId:
          me?.role?.name === "super_admin"
            ? null
            : me?.role?.name === "admin"
              ? me?.id
              : me?.adminId,
        userId: me?.id,
        userRoleName: me?.role?.name,
        userPermissionNames: me?.role?.permissionNames ?? [],
        enforcePiiMasking: false,
        acceptWriteOperations: false,
      },
      requestId: "status",
    });
    return this.toolRegistry.getToolSpecs(ctx).map((spec) => ({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    }));
  }

  // ──────────────────────────── 11. HEALTH (super_admin) ────────────────────────────

  @ApiOperation({ summary: "Provider health check (super_admin only)" })
  @Permissions(AI_MANAGE)
  @Get("health")
  async health(@Req() req: any) {
    this.ensureSuperAdmin(req.user);
    return this.svc.healthCheck();
  }

  @ApiOperation({
    summary: "Force a health check on a specific provider (super_admin only)",
  })
  @Permissions(AI_MANAGE)
  @Post("health/:providerCode/test")
  async testProviderHealth(
    @Req() req: any,
    @Param("providerCode") providerCode: string,
  ) {
    this.ensureSuperAdmin(req.user);
    return this.svc.testProviderHealth(providerCode);
  }
  // ──────────────────────────── HELPERS ────────────────────────────

  private ensureSuperAdmin(me: any): void {
    if (!me || me.role?.name !== "super_admin") {
      throw new ForbiddenException({
        message: "Only super admins can access this endpoint",
        code: "AI_ADMIN_ONLY",
      });
    }
  }
}
