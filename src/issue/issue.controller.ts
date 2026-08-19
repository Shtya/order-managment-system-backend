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
import { IssueService } from "./issue.service";

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequireSubscription()
@Controller("issues")
export class IssueController {
  constructor(private readonly issueService: IssueService) {}

  @Permissions("issues.create")
  @Post()
  create(@Req() req: any, @Body() dto: any) {
    return this.issueService.create(req.user, dto);
  }

  @Permissions("issues.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.issueService.list(req.user, q);
  }

  @Permissions("issues.read")
  @Get("board")
  board(@Req() req: any, @Query() q: any) {
    return this.issueService.board(req.user, q);
  }

  @Permissions("issues.read")
  @Get("board/:statusId")
  boardColumn(
    @Req() req: any,
    @Param("statusId") statusId: string,
    @Query() q: any,
  ) {
    return this.issueService.boardColumn(req.user, statusId, q);
  }

  @Permissions("issues.read")
  @Get("statistics")
  stats(@Req() req: any) {
    return this.issueService.getStats(req.user);
  }

  @Permissions("issues.export")
  @Get("export")
  async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.issueService.exportIssues(req.user, q);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Issues_export_${Date.now()}.xlsx`,
    );
    res.send(buffer);
  }

  @Permissions("issues.read", "issues.getOnly")
  @Get("statuses")
  statuses(@Req() req: any, @Query() q: any) {
    return this.issueService.getStatuses(req.user, q);
  }

  @Permissions("issues.statuses.create")
  @Post("statuses")
  createStatus(@Req() req: any, @Body() dto: any) {
    return this.issueService.createStatus(req.user, dto);
  }

  @Permissions("issues.statuses.update")
  @Patch("statuses/:statusId")
  updateStatus(
    @Req() req: any,
    @Param("statusId") statusId: string,
    @Body() dto: any,
  ) {
    return this.issueService.updateStatus(req.user, statusId, dto);
  }

  @Permissions("issues.statuses.delete")
  @Delete("statuses/:statusId")
  removeStatus(@Req() req: any, @Param("statusId") statusId: string) {
    return this.issueService.removeStatus(req.user, statusId);
  }

  @Permissions("issues.read", "issues.getOnly")
  @Get("causes")
  causes(@Req() req: any, @Query() q: any) {
    return this.issueService.getCauses(req.user, q);
  }

  @Permissions("issues.read")
  @Get("causes/list")
  listCauses(@Req() req: any, @Query() q: any) {
    return this.issueService.listCauses(req.user, q);
  }

  @Permissions("issues.export")
  @Get("causes/export")
  async exportCauses(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.issueService.exportCauses(req.user, q);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Causes_export_${Date.now()}.xlsx`,
    );
    res.send(buffer);
  }

  @Permissions("issues.read")
  @Get("causes/statistics")
  causesStats(@Req() req: any) {
    return this.issueService.getCausesStats(req.user);
  }

  @Permissions("issues.causes.create")
  @Post("causes")
  createCause(@Req() req: any, @Body() dto: any) {
    return this.issueService.createCause(req.user, dto);
  }

  @Permissions("issues.causes.update")
  @Patch("causes/:causeId")
  updateCause(
    @Req() req: any,
    @Param("causeId") causeId: string,
    @Body() dto: any,
  ) {
    return this.issueService.updateCause(req.user, causeId, dto);
  }

  @Permissions("issues.causes.delete")
  @Delete("causes/:causeId")
  removeCause(@Req() req: any, @Param("causeId") causeId: string) {
    return this.issueService.removeCause(req.user, causeId);
  }

  @Permissions("issues.read")
  @Get(":issueId")
  get(@Req() req: any, @Param("issueId") issueId: string) {
    return this.issueService.get(req.user, issueId);
  }

  @Permissions("issues.update")
  @Patch(":issueId")
  update(@Req() req: any, @Param("issueId") issueId: string, @Body() dto: any) {
    return this.issueService.update(req.user, issueId, dto);
  }

  @Permissions("issues.delete")
  @Delete(":issueId")
  remove(@Req() req: any, @Param("issueId") issueId: string) {
    return this.issueService.remove(req.user, issueId);
  }

  @Permissions("issues.read")
  @Get(":issueId/messages")
  messages(
    @Req() req: any,
    @Param("issueId") issueId: string,
    @Query() q: any,
  ) {
    return this.issueService.getMessages(req.user, issueId, q);
  }

  @Permissions("issues.reply")
  @Post(":issueId/messages")
  reply(@Req() req: any, @Param("issueId") issueId: string, @Body() dto: any) {
    return this.issueService.reply(req.user, issueId, dto);
  }

  @Permissions("issues.reply")
  @Patch(":issueId/messages/:messageId")
  updateMessage(
    @Req() req: any,
    @Param("issueId") issueId: string,
    @Param("messageId") messageId: string,
    @Body() dto: any,
  ) {
    return this.issueService.updateMessage(req.user, issueId, messageId, dto);
  }

  @Permissions("issues.reply")
  @Delete(":issueId/messages/:messageId")
  deleteMessage(
    @Req() req: any,
    @Param("issueId") issueId: string,
    @Param("messageId") messageId: string,
  ) {
    return this.issueService.deleteMessage(req.user, issueId, messageId);
  }

  @Permissions("issues.read")
  @Patch(":issueId/read")
  markRead(@Req() req: any, @Param("issueId") issueId: string) {
    return this.issueService.markRead(req.user, issueId);
  }

  @Permissions("issues.change_status")
  @Patch(":issueId/status")
  changeStatus(
    @Req() req: any,
    @Param("issueId") issueId: string,
    @Body() dto: any,
  ) {
    return this.issueService.changeStatus(req.user, issueId, dto);
  }

  @Permissions("issues.change_priority")
  @Patch(":issueId/priority")
  changePriority(
    @Req() req: any,
    @Param("issueId") issueId: string,
    @Body() dto: any,
  ) {
    return this.issueService.changePriority(req.user, issueId, dto);
  }

  @Permissions("issues.assign")
  @Post(":issueId/assign")
  assign(@Req() req: any, @Param("issueId") issueId: string, @Body() dto: any) {
    return this.issueService.assign(req.user, issueId, dto);
  }

  @Permissions("issues.read")
  @Get(":issueId/activity")
  activity(@Req() req: any, @Param("issueId") issueId: string) {
    return this.issueService.getActivity(req.user, issueId);
  }
}
