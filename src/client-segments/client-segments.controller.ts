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
import { ClientSegmentsService } from "./client-segments.service";
import { ClientSegmentTemplatesService } from "./client-segment-templates.service";
import {
  CreateClientSegmentDto,
  UpdateClientSegmentDto,
  PreviewClientSegmentAudienceDto,
  CreateSegmentFromTemplateDto,
  CreateClientSegmentTemplateDto,
  UpdateClientSegmentTemplateDto,
} from "dto/client-segment.dto";

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@RequireSubscription()
@Controller("client-segments")
export class ClientSegmentsController {
  constructor(private readonly service: ClientSegmentsService) {}

  @Permissions("client-segments.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.service.list(req.user, q);
  }

  @Permissions("client-segments.read")
  @Get("stats")
  stats(@Req() req: any) {
    return this.service.stats(req.user);
  }

  @Get("export")
  @Permissions("client-segments.read")
  @Header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  )
  async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.service.exportSegments(req.user, q);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=client-segments-${Date.now()}.xlsx`,
    );
    res.end(buffer);
  }

  @Permissions("client-segments.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.service.get(req.user, id);
  }

  @Permissions("client-segments.create")
  @Post()
  create(@Req() req: any, @Body() dto: CreateClientSegmentDto) {
    return this.service.create(req.user, dto);
  }

  @Permissions("client-segments.update")
  @Patch(":id")
  update(@Req() req: any, @Param("id") id: string, @Body() dto: UpdateClientSegmentDto) {
    return this.service.update(req.user, id, dto);
  }

  @Permissions("client-segments.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.service.remove(req.user, id);
  }

  @Permissions("client-segments.preview")
  @Post("preview")
  preview(@Req() req: any, @Body() dto: PreviewClientSegmentAudienceDto) {
    return this.service.preview(req.user, dto.audienceFilter);
  }

  @Permissions("client-segments.preview")
  @Post("recipients")
  previewRecipients(
    @Req() req: any,
    @Body() dto: PreviewClientSegmentAudienceDto,
    @Query() q: any,
  ) {
    return this.service.previewRecipients(req.user, dto.audienceFilter, q);
  }

  @Permissions("client-segments.read")
  @Get(":id/recipients")
  recipients(@Req() req: any, @Param("id") id: string, @Query() q: any) {
    return this.service.listRecipients(req.user, id, q);
  }

  @Permissions("client-segments.update")
  @Post(":id/refresh-estimate")
  refreshEstimate(@Req() req: any, @Param("id") id: string) {
    return this.service.refreshEstimate(req.user, id);
  }

  @Permissions("client-segments.freeze")
  @Post(":id/freeze")
  freeze(@Req() req: any, @Param("id") id: string) {
    return this.service.freeze(req.user, id);
  }

  @Permissions("client-segments.freeze")
  @Post(":id/unfreeze")
  unfreeze(@Req() req: any, @Param("id") id: string) {
    return this.service.unfreeze(req.user, id);
  }
}

// ──────────────────────────────────────────────────────────────
// Tenant-facing template routes
// ──────────────────────────────────────────────────────────────

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@RequireSubscription()
@Controller("client-segment-templates")
export class ClientSegmentTemplatesController {
  constructor(private readonly service: ClientSegmentTemplatesService) {}

  @Get("admin/stats")
  adminStats(@Req() req: any) {
    return this.service.adminStats(req.user);
  }

  @Get("admin/export")
  @Header(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  )
  async adminExport(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.service.adminExport(req.user, q);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=client-segment-templates-${Date.now()}.xlsx`,
    );
    res.end(buffer);
  }

  @Get("admin")
  adminList(@Req() req: any, @Query() q: any) {
    return this.service.adminList(req.user, q);
  }

  @Get("admin/:id")
  adminGet(@Req() req: any, @Param("id") id: string) {
    return this.service.adminGet(req.user, id);
  }

  @Post("admin")
  adminCreate(@Req() req: any, @Body() dto: CreateClientSegmentTemplateDto) {
    return this.service.adminCreate(req.user, dto);
  }

  @Patch("admin/:id")
  adminUpdate(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: UpdateClientSegmentTemplateDto,
  ) {
    return this.service.adminUpdate(req.user, id, dto);
  }

  @Delete("admin/:id")
  adminDelete(@Req() req: any, @Param("id") id: string) {
    return this.service.adminDelete(req.user, id);
  }

  @Get()
  @Permissions("client-segments.read")
  list(@Req() req: any, @Query() q: any) {
    return this.service.listActive(q);
  }

  @Get(":id")
  @Permissions("client-segments.read")
  get(@Req() req: any, @Param("id") id: string) {
    return this.service.getActive(id);
  }

  @Post(":id/create-segment")
  @Permissions("client-segments.create")
  createFromTemplate(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: CreateSegmentFromTemplateDto,
  ) {
    return this.service.createSegmentFromTemplate(req.user, id, dto);
  }
}
