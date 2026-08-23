import {
  Body,
  Controller,
  Delete,
  Get,
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
import { TagsService } from "./tags.service";
import { TagAutomationsService } from "./tag-automations.service";
import { TagsAssignmentService } from "./tags-assignment.service";
import {
  AssignOrderTagDto,
  CreateTagAutomationDto,
  CreateTagDto,
  UpdateTagAutomationDto,
  UpdateTagDto,
} from "dto/tag.dto";

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@RequireSubscription()
@Controller("tags")
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Permissions("tags.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.tagsService.list(req.user, q);
  }

  @Permissions("tags.read", "orders.update")
  @Get("assignable")
  assignable(@Req() req: any) {
    return this.tagsService.listAssignable(req.user);
  }

  @Permissions("tags.read")
  @Get("export")
  async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.tagsService.export(req.user, q);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=tags_${Date.now()}.xlsx`,
    );
    res.send(buffer);
  }

  @Permissions("tags.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.tagsService.get(req.user, id);
  }

  @Permissions("tags.create")
  @Post()
  create(@Req() req: any, @Body() dto: CreateTagDto) {
    return this.tagsService.create(req.user, dto);
  }

  @Permissions("tags.update")
  @Patch(":id")
  update(@Req() req: any, @Param("id") id: string, @Body() dto: UpdateTagDto) {
    return this.tagsService.update(req.user, id, dto);
  }

  @Permissions("tags.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.tagsService.remove(req.user, id);
  }
}

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@RequireSubscription()
@Controller("tag-automations")
export class TagAutomationsController {
  constructor(private readonly automationsService: TagAutomationsService) {}

  @Permissions("tag-automations.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.automationsService.list(req.user, q);
  }

  @Permissions("tag-automations.read")
  @Get("export")
  async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.automationsService.export(req.user, q);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=tag_automations_${Date.now()}.xlsx`,
    );
    res.send(buffer);
  }

  @Permissions("tag-automations.read")
  @Get(":id")
  get(@Req() req: any, @Param("id") id: string) {
    return this.automationsService.get(req.user, id);
  }

  @Permissions("tag-automations.create")
  @Post()
  create(@Req() req: any, @Body() dto: CreateTagAutomationDto) {
    return this.automationsService.create(req.user, dto);
  }

  @Permissions("tag-automations.update")
  @Patch(":id")
  update(
    @Req() req: any,
    @Param("id") id: string,
    @Body() dto: UpdateTagAutomationDto,
  ) {
    return this.automationsService.update(req.user, id, dto);
  }

  @Permissions("tag-automations.delete")
  @Delete(":id")
  remove(@Req() req: any, @Param("id") id: string) {
    return this.automationsService.remove(req.user, id);
  }
}

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@RequireSubscription()
@Controller("orders/:orderId/tags")
export class OrderTagsController {
  constructor(private readonly assignmentService: TagsAssignmentService) {}

  @Permissions("orders.read", "tags.read")
  @Get()
  list(@Req() req: any, @Param("orderId") orderId: string) {
    return this.assignmentService.listOrderTags(req.user, orderId);
  }

  @Permissions("orders.update")
  @Post()
  assign(
    @Req() req: any,
    @Param("orderId") orderId: string,
    @Body() dto: AssignOrderTagDto,
  ) {
    return this.assignmentService.assignManual(req.user, orderId, dto.tagId);
  }

  @Permissions("orders.update")
  @Delete(":tagId")
  remove(
    @Req() req: any,
    @Param("orderId") orderId: string,
    @Param("tagId") tagId: string,
  ) {
    return this.assignmentService.removeManual(req.user, orderId, tagId);
  }
}
