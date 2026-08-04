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
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { Response } from "express";
import { FilesInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { SupportAccessGuard } from "./support-access.guard";
import { SupportTicketService } from "./support_ticket.service";
import {
  supportTicketFilesOptions,
  streamAttachmentFile,
} from "./support-ticket-upload.config";
import {
  AssignSupportTicketDto,
  BulkAssignTicketsDto,
  BulkUpdatePriorityDto,
  BulkUpdateStatusDto,
  CloseTicketDto,
  HoldTicketDto,
  ReplySupportTicketDto,
  ResolveTicketDto,
  UpdateTicketPriorityDto,
  UpdateTicketStatusDto,
  WaitingOnCustomerDto,
} from "dto/support_tickets.dto";

@UseGuards(JwtAuthGuard, SupportAccessGuard)
@Controller("admin/support-tickets")
export class AdminSupportTicketsController {
  constructor(private readonly supportTicketService: SupportTicketService) {}

  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.supportTicketService.adminList(req.user, q);
  }

  @Get("statistics")
  stats(@Req() req: any, @Query() q: any) {
    return this.supportTicketService.adminStats(req.user, q);
  }

  @Get("export")
  async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.supportTicketService.exportTickets(req.user, q);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Support_Tickets_export_${Date.now()}.xlsx`,
    );

    return res.send(buffer);
  }

  @Get("support-users")
  supportUsers(@Req() req: any, @Query() q: any) {
    return this.supportTicketService.supportUsers(req.user, q);
  }

  @Patch("bulk/assign")
  bulkAssign(@Req() req: any, @Body() dto: BulkAssignTicketsDto) {
    return this.supportTicketService.bulkAssign(req.user, dto);
  }

  @Patch("bulk/status")
  bulkStatus(@Req() req: any, @Body() dto: BulkUpdateStatusDto) {
    return this.supportTicketService.bulkStatus(req.user, dto);
  }

  @Patch("bulk/priority")
  bulkPriority(@Req() req: any, @Body() dto: BulkUpdatePriorityDto) {
    return this.supportTicketService.bulkPriority(req.user, dto);
  }

  @Get(":ticketId")
  get(@Req() req: any, @Param("ticketId") ticketId: string) {
    return this.supportTicketService.adminGet(req.user, ticketId);
  }

  @Get(":ticketId/messages")
  getMessages(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Query() q: any,
  ) {
    return this.supportTicketService.adminGetMessages(req.user, ticketId, q);
  }

  @Post(":ticketId/messages")
  @UseInterceptors(FilesInterceptor("files", 10, supportTicketFilesOptions))
  reply(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Body() dto: ReplySupportTicketDto,
    @UploadedFiles() files?: any[],
  ) {
    return this.supportTicketService.adminReply(
      req.user,
      ticketId,
      dto,
      files || [],
    );
  }

  @Patch(":ticketId/assign")
  assign(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Body() dto: AssignSupportTicketDto,
  ) {
    return this.supportTicketService.assign(req.user, ticketId, dto);
  }

  @Patch(":ticketId/unassign")
  unassign(@Req() req: any, @Param("ticketId") ticketId: string) {
    return this.supportTicketService.unassign(req.user, ticketId);
  }

  @Patch(":ticketId/status")
  changeStatus(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Body() dto: UpdateTicketStatusDto,
  ) {
    return this.supportTicketService.changeStatus(req.user, ticketId, dto);
  }

  @Patch(":ticketId/priority")
  changePriority(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Body() dto: UpdateTicketPriorityDto,
  ) {
    return this.supportTicketService.changePriority(req.user, ticketId, dto);
  }

  @Patch(":ticketId/resolve")
  resolve(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Body() dto: ResolveTicketDto,
  ) {
    return this.supportTicketService.resolve(req.user, ticketId, dto);
  }

  @Patch(":ticketId/close")
  close(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Body() dto: CloseTicketDto,
  ) {
    return this.supportTicketService.closeBySupport(req.user, ticketId, dto);
  }

  @Patch(":ticketId/hold")
  hold(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Body() dto: HoldTicketDto,
  ) {
    return this.supportTicketService.hold(req.user, ticketId, dto);
  }

  @Patch(":ticketId/waiting-on-customer")
  waitingOnCustomer(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Body() dto: WaitingOnCustomerDto,
  ) {
    return this.supportTicketService.waitingOnCustomer(req.user, ticketId, dto);
  }

  @Patch(":ticketId/read")
  markRead(@Req() req: any, @Param("ticketId") ticketId: string) {
    return this.supportTicketService.markReadBySupport(req.user, ticketId);
  }

  @Get(":ticketId/activity")
  activity(@Req() req: any, @Param("ticketId") ticketId: string) {
    return this.supportTicketService.getActivityAdmin(req.user, ticketId);
  }

  @Get(":ticketId/attachments/:attachmentId/download")
  async download(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Param("attachmentId") attachmentId: string,
    @Res() res: Response,
  ) {
    const attachment = await this.supportTicketService.getAttachmentForSupport(
      req.user,
      ticketId,
      attachmentId,
    );
    await streamAttachmentFile(res, attachment, "attachment");
  }

  @Get(":ticketId/attachments/:attachmentId/preview")
  async preview(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Param("attachmentId") attachmentId: string,
    @Res() res: Response,
  ) {
    const attachment = await this.supportTicketService.getAttachmentForSupport(
      req.user,
      ticketId,
      attachmentId,
    );
    await streamAttachmentFile(res, attachment, "inline");
  }

  @Delete(":ticketId")
  delete(@Req() req: any, @Param("ticketId") ticketId: string) {
    return this.supportTicketService.delete(req.user, ticketId);
  }
}
