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
import { PermissionsGuard } from "common/permissions.guard";
import { Permissions } from "common/permissions.decorator";
import { RequireSubscription } from "common/require-subscription.decorator";
import { SubscriptionGuard } from "common/subscription.guard";
import { SupportTicketService } from "./support_ticket.service";
import {
  supportTicketFilesOptions,
  streamAttachmentFile,
} from "./support-ticket-upload.config";
import {
  CancelTicketDto,
  CreateSupportTicketDto,
  ReplySupportTicketDto,
  UpdateMessageDto,
} from "dto/support_tickets.dto";

@UseGuards(JwtAuthGuard, PermissionsGuard, SubscriptionGuard)
@RequireSubscription()
@Controller("support-tickets")
export class SupportTicketController {
  constructor(private readonly supportTicketService: SupportTicketService) {}

  @Permissions("support_tickets.create")
  @Post()
  @UseInterceptors(FilesInterceptor("files", 10, supportTicketFilesOptions))
  create(
    @Req() req: any,
    @Body() dto: CreateSupportTicketDto,
    @UploadedFiles() files?: any[],
  ) {
    return this.supportTicketService.create(req.user, dto, files || []);
  }

  @Permissions("support_tickets.read")
  @Get()
  list(@Req() req: any, @Query() q: any) {
    return this.supportTicketService.list(req.user, q);
  }

  @Permissions("support_tickets.read")
  @Get("statistics")
  stats(@Req() req: any) {
    return this.supportTicketService.getStats(req.user);
  }

  @Permissions("support_tickets.export")
  @Get("export")
  async export(@Req() req: any, @Query() q: any, @Res() res: Response) {
    const buffer = await this.supportTicketService.exportTenantTickets(
      req.user,
      q,
    );

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

  @Permissions("support_tickets.read")
  @Get(":ticketId")
  get(@Req() req: any, @Param("ticketId") ticketId: string) {
    return this.supportTicketService.get(req.user, ticketId);
  }

  @Permissions("support_tickets.read")
  @Get(":ticketId/messages")
  getMessages(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Query() q: any,
  ) {
    return this.supportTicketService.getMessages(req.user, ticketId, q);
  }

  @Permissions("support_tickets.reply")
  @Post(":ticketId/messages")
  @UseInterceptors(FilesInterceptor("files", 10, supportTicketFilesOptions))
  reply(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Body() dto: ReplySupportTicketDto,
    @UploadedFiles() files?: any[],
  ) {
    return this.supportTicketService.reply(
      req.user,
      ticketId,
      dto,
      files || [],
    );
  }

  @Permissions("support_tickets.reply")
  @Patch(":ticketId/messages/:messageId")
  updateMessage(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Param("messageId") messageId: string,
    @Body() dto: UpdateMessageDto,
  ) {
    return this.supportTicketService.updateMessage(
      req.user,
      ticketId,
      messageId,
      dto,
    );
  }

  @Permissions("support_tickets.reply")
  @Delete(":ticketId/messages/:messageId")
  deleteMessage(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Param("messageId") messageId: string,
  ) {
    return this.supportTicketService.deleteMessage(
      req.user,
      ticketId,
      messageId,
    );
  }

  // @Permissions("support_tickets.reply")
  // @Post(":ticketId/messages/:messageId/attachments")
  // @UseInterceptors(FilesInterceptor("files", 10, supportTicketFilesOptions))
  // addAttachments(
  // 	@Req() req: any,
  // 	@Param("ticketId") ticketId: string,
  // 	@Param("messageId") messageId: string,
  // 	@UploadedFiles() files?: any[],
  // ) {
  // 	return this.supportTicketService.addAttachments(req.user, ticketId, messageId, files || []);
  // }

  // @Permissions("support_tickets.reply")
  // @Delete(":ticketId/messages/:messageId/attachments/:attachmentId")
  // deleteAttachment(
  // 	@Req() req: any,
  // 	@Param("ticketId") ticketId: string,
  // 	@Param("messageId") messageId: string,
  // 	@Param("attachmentId") attachmentId: string,
  // ) {
  // 	return this.supportTicketService.deleteAttachment(
  // 		req.user,
  // 		ticketId,
  // 		messageId,
  // 		attachmentId,
  // 	);
  // }

  @Permissions("support_tickets.read")
  @Patch(":ticketId/read")
  markRead(@Req() req: any, @Param("ticketId") ticketId: string) {
    return this.supportTicketService.markRead(req.user, ticketId);
  }

  // @Permissions("support_tickets.close")
  // @Patch(":ticketId/close")
  // close(@Req() req: any, @Param("ticketId") ticketId: string, @Body() dto: CloseTicketDto) {
  // 	return this.supportTicketService.close(req.user, ticketId, dto);
  // }

  @Permissions("support_tickets.close")
  @Patch(":ticketId/cancel")
  cancel(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Body() dto: CancelTicketDto,
  ) {
    return this.supportTicketService.cancel(req.user, ticketId, dto);
  }

  // @Permissions("support_tickets.reopen")
  // @Patch(":ticketId/reopen")
  // reopen(@Req() req: any, @Param("ticketId") ticketId: string, @Body() dto: ReopenTicketDto) {
  // 	return this.supportTicketService.reopen(req.user, ticketId, dto);
  // }

  @Permissions("support_tickets.read")
  @Get(":ticketId/activity")
  activity(@Req() req: any, @Param("ticketId") ticketId: string) {
    return this.supportTicketService.getActivity(req.user, ticketId);
  }

  @Permissions("support_tickets.read")
  @Get(":ticketId/attachments/:attachmentId/download")
  async download(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Param("attachmentId") attachmentId: string,
    @Res() res: Response,
  ) {
    const attachment = await this.supportTicketService.getAttachmentForTenant(
      req.user,
      ticketId,
      attachmentId,
    );
    await streamAttachmentFile(res, attachment, "attachment");
  }

  @Permissions("support_tickets.read")
  @Get(":ticketId/attachments/:attachmentId/preview")
  async preview(
    @Req() req: any,
    @Param("ticketId") ticketId: string,
    @Param("attachmentId") attachmentId: string,
    @Res() res: Response,
  ) {
    const attachment = await this.supportTicketService.getAttachmentForTenant(
      req.user,
      ticketId,
      attachmentId,
    );
    await streamAttachmentFile(res, attachment, "inline");
  }
}
