import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { RequireSubscription } from "common/require-subscription.decorator";
import { SubscriptionGuard } from "common/subscription.guard";
import { AgentsService } from "./agents.service";
import {
  CreateAgentDto,
  CreateAgentKnowledgeDto,
  ResetAgentKnowledgeDto,
  UpdateAgentDto,
  UpdateAgentKnowledgeDto,
} from "dto/agent.dto";

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@RequireSubscription()
@Controller("agents")
export class AgentsController {
  constructor(private readonly service: AgentsService) {}

  @Permissions("agents.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.service.list(req.user, q);
  }

  @Permissions("agents.read")
  @Get("stats")
  stats(@Req() req: any) {
    return this.service.stats(req.user);
  }

  @Get("export")
  @Permissions("agents.read")
  @Header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  )
  async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.service.exportAgents(req.user, q);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=agents-${Date.now()}.xlsx`,
    );
    res.end(buffer);
  }

  @Permissions("agents.read")
  @Get("knowledge")
  listKnowledge(@Req() req: any, @Query() q: any) {
    return this.service.listKnowledge(req.user, q);
  }

  @Permissions("agents.read")
  @Get("knowledge/stats")
  knowledgeStats(@Req() req: any) {
    return this.service.knowledgeStats(req.user);
  }

  @Get("knowledge/export")
  @Permissions("agents.read")
  @Header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  )
  async exportKnowledge(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.service.exportKnowledge(req.user, q);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=knowledge-${Date.now()}.xlsx`,
    );
    res.end(buffer);
  }

  @Permissions("agents.read")
  @Get("knowledge/:knowledgeId")
  getKnowledge(@Req() req: any, @Param("knowledgeId") knowledgeId: string) {
    return this.service.getKnowledge(req.user, knowledgeId);
  }

  @Permissions("agents.create")
  @Post("knowledge")
  createKnowledge(@Req() req: any, @Body() dto: CreateAgentKnowledgeDto) {
    return this.service.createKnowledge(req.user, dto);
  }

  @Permissions("agents.update")
  @Patch("knowledge/:knowledgeId")
  updateKnowledge(
    @Req() req: any,
    @Param("knowledgeId") knowledgeId: string,
    @Body() dto: UpdateAgentKnowledgeDto,
  ) {
    return this.service.updateKnowledge(req.user, knowledgeId, dto);
  }

  @Permissions("agents.delete")
  @Delete("knowledge/:knowledgeId")
  removeKnowledge(@Req() req: any, @Param("knowledgeId") knowledgeId: string) {
    return this.service.removeKnowledge(req.user, knowledgeId);
  }

  @Permissions("agents.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.service.get(req.user, id);
  }

  @Permissions("agents.create")
  @Post()
  create(@Req() req: any, @Body() dto: CreateAgentDto) {
    return this.service.create(req.user, dto);
  }

  @Permissions("agents.update")
  @Post(":agentId/knowledge/reset")
  resetAgentKnowledge(
    @Req() req: any,
    @Param("agentId") agentId: string,
    @Body() dto: ResetAgentKnowledgeDto,
  ) {
    return this.service.resetAgentKnowledge(req.user, agentId, dto);
  }

  @Permissions("agents.update")
  @Patch(":id/toggle-active")
  toggleActive(@Req() req: any, @Param("id") id: string) {
    return this.service.toggleActive(req.user, id);
  }

  @Permissions("agents.update")
  @Patch(":id")
  update(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: UpdateAgentDto,
  ) {
    return this.service.update(req.user, id, dto);
  }

  @Permissions("agents.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.service.remove(req.user, id);
  }
}
